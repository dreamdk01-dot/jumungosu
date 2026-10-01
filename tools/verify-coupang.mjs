#!/usr/bin/env node
// 쿠팡 파트너스 검색 API 실제 응답 확인 도구 (키를 가진 사람이 자기 터미널에서 실행한다).
//
//   export COUPANG_PARTNERS_ACCESS_KEY=...   # 값은 터미널에서만. 채팅·Git·로그에 붙여넣지 않는다.
//   export COUPANG_PARTNERS_SECRET_KEY=...
//   node tools/verify-coupang.mjs --keyword "수건 세트" --confirm [--v1]
//
// - 검색 API 를 정확히 1회만 호출한다(시간당 한도가 작아 반복 실행 금지). --confirm 이 없으면 호출하지 않는다.
// - 출력은 "구조"만이다: 필드 이름, 값의 종류, 상품 URL 의 형태(호스트·경로·쿼리 이름). 키·서명·제휴 태그 값은 출력하지 않는다.
// - 이 출력으로 확인할 것: (1) 인증·경로가 맞는지 (2) 응답 필드 (3) 상품 ID 와 옵션 식별자(itemId/vendorItemId)가 응답에 있는지
//   (4) 가격이 "어느 옵션의" 가격인지 판단할 근거가 있는지 → 없으면 COUPANG_PRICE_REFRESH_ENABLED 를 켜지 않는다.
import { createClient, resolveSearchPath, SEARCH_PATH, SEARCH_PATH_V1, readCredentialsFromEnv, parseCoupangIds } from '../api/_lib/coupang-partners.mjs';

const SENSITIVE_PARAMS = new Set(['lptag', 'traceid', 'subid', 'afid']);

// 응답 한 건에서 구조만 뽑는다. (테스트 대상: 값 자체는 내보내지 않는다)
export function describeUrl(url) {
  try {
    const u = new URL(String(url));
    return { host: u.hostname, path: u.pathname.replace(/\d{5,}/g, '<digits>'), queryNames: [...u.searchParams.keys()].map((k) => (SENSITIVE_PARAMS.has(k.toLowerCase()) ? k + '(값 숨김)' : k)) };
  } catch { return null; }
}

export function summarizeSearchResponse(json) {
  const out = { rCode: json && json.rCode != null ? String(json.rCode) : null, topLevelKeys: json && typeof json === 'object' ? Object.keys(json).sort() : [], itemCount: 0, itemFieldTypes: {}, urlShapes: [], identifiers: {} };
  const list = json && json.data && Array.isArray(json.data.productData) ? json.data.productData : [];
  out.itemCount = list.length;
  const types = {};
  let withProductId = 0, withItemId = 0, withVendorItemId = 0, withOptionInUrl = 0, pricePositive = 0;
  const shapes = new Set();
  for (const it of list) {
    for (const [k, v] of Object.entries(it || {})) { types[k] = types[k] || new Set(); types[k].add(v === null ? 'null' : typeof v); }
    if (it && it.productId != null) withProductId++;
    if (it && typeof it.productPrice === 'number' && it.productPrice > 0) pricePositive++;
    const ids = parseCoupangIds(it && it.productUrl);
    if (ids.itemId) withItemId++;
    if (ids.vendorItemId) withVendorItemId++;
    if (ids.itemId || ids.vendorItemId) withOptionInUrl++;
    const d = describeUrl(it && it.productUrl); if (d) shapes.add(JSON.stringify(d));
    if (it && ('itemId' in it || 'vendorItemId' in it)) out.identifiers.optionFieldsInItem = true;
  }
  out.itemFieldTypes = Object.fromEntries(Object.entries(types).map(([k, v]) => [k, [...v].sort().join('|')]));
  out.urlShapes = [...shapes].slice(0, 3).map((x) => JSON.parse(x));
  Object.assign(out.identifiers, { withProductId, withItemIdInUrl: withItemId, withVendorItemIdInUrl: withVendorItemId, withAnyOptionIdInUrl: withOptionInUrl, withPositivePrice: pricePositive });
  out.verdict = list.length === 0 ? '결과 없음 — 다른 키워드로 다시 보기 전에 시간당 한도를 확인하세요'
    : withOptionInUrl === list.length ? '모든 항목에서 옵션 식별자를 URL 에서 읽을 수 있음(가격이 그 옵션의 것인지는 별도 확인 필요)'
    : withOptionInUrl === 0 ? '옵션 식별자를 응답에서 읽을 수 없음 → 정확한 옵션 가격을 검증할 수 없으므로 가격 자동 갱신을 켜지 마세요'
    : '일부 항목만 옵션 식별자 있음 → 옵션 식별자가 없는 항목은 갱신되지 않음(안전)';
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const get = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const keyword = get('--keyword') || '';
  if (!args.includes('--confirm')) { console.log('호출하지 않았습니다. 검색 API 를 1회 호출하려면 --confirm 을 붙이세요(시간당 한도가 작습니다).'); return; }
  const cred = readCredentialsFromEnv();
  if (!cred.configured) { console.error('환경변수 COUPANG_PARTNERS_ACCESS_KEY / COUPANG_PARTNERS_SECRET_KEY 가 설정돼 있지 않습니다. (값은 출력하지 않습니다)'); process.exit(2); }
  const searchPath = args.includes('--v1') ? SEARCH_PATH_V1 : resolveSearchPath();
  console.log('요청 경로 형태:', searchPath === SEARCH_PATH_V1 ? '.../openapi/v1/products/search' : '.../openapi/products/search', '| 키워드 길이:', keyword.length);
  // 원본 응답 구조를 보려고 클라이언트의 매핑 전 JSON 이 필요해서 fetch 를 감싼다(저장·출력은 요약만).
  let raw = null;
  const wrapped = createClient({ accessKey: cred.accessKey, secretKey: cred.secretKey, searchPath, fetchImpl: async (url, init) => { const r = await fetch(url, init); const c = r.clone(); try { raw = await c.json(); } catch { raw = null; } return r; } });
  try { await wrapped.searchProducts(keyword, { limit: 5 }); }
  catch (e) { console.log('호출 결과: 실패 code=' + (e && e.code) + (e && e.status ? ' status=' + e.status : '')); if (raw) console.log('응답 구조:', JSON.stringify(summarizeSearchResponse(raw), null, 2)); process.exit(1); }
  console.log('호출 결과: 성공'); console.log(JSON.stringify(summarizeSearchResponse(raw), null, 2));
}
if (import.meta.url === `file://${process.argv[1]}`) main();

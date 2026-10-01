// api/_lib/refresh.js
// 검토·승인된 상품의 가격·이미지를 쿠팡 파트너스 검색 API로 "정확히 같은 상품·옵션일 때만" 갱신한다.
// DB 접근은 호출하는 쪽(api/coupang-refresh.js)이 하고, 여기는 모의 클라이언트로 테스트할 수 있게 순수 로직만 둔다.
//
// 지키는 규칙
//  - 상품 ID + 저장된 옵션 ID 가 모두 같을 때만 갱신. 이름이 비슷한 다른 상품은 절대 연결하지 않는다.
//  - 검색 결과에 없다는 이유로, 옵션이 다르다는 이유로 품절·판매중지로 판정하지 않는다("확인 못 함"으로만 기록).
//  - 오류·빈 값은 기존 값을 덮어쓰지 않는다. 가격이 양의 정수가 아니면 가격은 건드리지 않는다.
//  - 평점·리뷰수·리뷰 원문은 이 API가 주는지 확인되지 않았으므로 여기서 갱신하지 않는다.
//  - 호출 한도/차단/키 문제가 나오면 즉시 멈춘다. 이런 "시스템 쪽 실패"는 해당 상품의 실패로 기록하지 않는다.
//  - dryRun(기본 운영값): 호출해서 일치 여부만 확인하고 가격·이미지는 쓰지 않는다. 가격 자동 갱신은
//    "정확한 옵션 가격임을 실제 응답으로 확인했다"고 운영자가 명시적으로 켠 뒤에만(apply) 한다.

import { CoupangError, matchExact, validateKeyword } from './coupang-partners.js';

const HOUR = 60 * 60 * 1000;
export const FAILURE_BACKOFF_BASE_MS = 6 * HOUR;     // 첫 실패 후 재시도 대기
export const FAILURE_BACKOFF_MAX_MS = 72 * HOUR;     // 반복 실패해도 최대 3일마다 다시 한 번은 시도
export const SUCCESS_MIN_INTERVAL_MS = 6 * HOUR;     // 방금 확인된 상품은 호출 예산을 쓰지 않는다
const OK_STATUSES = new Set(['updated', 'checked']);

// 호출을 멈춰야 하는 오류들(상품 문제가 아니라 계정·한도·네트워크·응답 형식 문제)
const STOP_CODES = new Set(['keys_missing', 'rate_limited', 'blocked', 'timeout', 'http_error', 'api_error', 'bad_response']);

export function backoffMs(failures) {
  const n = Math.max(1, Number(failures) || 1);
  return Math.min(FAILURE_BACKOFF_MAX_MS, FAILURE_BACKOFF_BASE_MS * 2 ** (n - 1));
}

function ts(v) { const t = v ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; }

// 호출 전에 상품을 분류한다. eligible=false 인 이유:
//   not_approved       승인되지 않은 상품(대상 아님)
//   needs_fix          쿠팡 상품·옵션 식별자가 없어 "정확한 옵션"을 확인할 수 없음 → 호출하지 않고 관리자에게 보완 요청
//   cooldown           최근에 실패해서 재시도 대기 중
//   recently_checked   최근에 성공적으로 확인됨
export function classifyForRefresh(p, nowMs) {
  if (!p || p.reviewState !== 'approved') return { eligible: false, reason: 'not_approved' };
  if (!p.coupangProductId) return { eligible: false, reason: 'needs_fix', detail: 'no_product_id' };
  if (!p.coupangItemId && !p.coupangVendorItemId) return { eligible: false, reason: 'needs_fix', detail: 'no_option_id' };
  const last = ts(p.lastRefreshAt);
  if (last != null) {
    if (OK_STATUSES.has(String(p.lastRefreshStatus || '').split(':')[0])) {
      if (nowMs - last < SUCCESS_MIN_INTERVAL_MS) return { eligible: false, reason: 'recently_checked' };
    } else if (nowMs - last < backoffMs(p.refreshFailures)) {
      return { eligible: false, reason: 'cooldown' };
    }
  }
  return { eligible: true, reason: 'ok' };
}

// 대상 선정: 한 번도 시도하지 않은 상품 → 마지막 시도가 오래된 상품 순.
// (예전에는 "가격 확인일이 오래된 순"이라, 계속 실패해 확인일이 비어 있는 상품이 매번 먼저 뽑혀 다른 상품이 밀렸다.)
export function planRefresh(products, maxCount, nowMs = Date.now()) {
  const plan = { targets: [], needsFix: [], cooling: [], recent: [] };
  const eligible = [];
  for (const p of products || []) {
    const c = classifyForRefresh(p, nowMs);
    if (c.eligible) eligible.push(p);
    else if (c.reason === 'needs_fix') plan.needsFix.push({ id: p.id, detail: c.detail });
    else if (c.reason === 'cooldown') plan.cooling.push(p.id);
    else if (c.reason === 'recently_checked') plan.recent.push(p.id);
  }
  eligible.sort((a, b) => {
    const la = ts(a.lastRefreshAt), lb = ts(b.lastRefreshAt);
    if (la == null && lb != null) return -1;
    if (la != null && lb == null) return 1;
    if (la != null && lb != null && la !== lb) return la - lb;
    const pa = ts(a.priceCheckedAt) ?? 0, pb = ts(b.priceCheckedAt) ?? 0;
    if (pa !== pb) return pa - pb;
    return String(a.id).localeCompare(String(b.id));
  });
  plan.targets = eligible.slice(0, Math.max(0, maxCount));
  return plan;
}

export function pickRefreshTargets(products, maxCount, nowMs = Date.now()) {
  return planRefresh(products, maxCount, nowMs).targets;
}

export function keywordFor(product) {
  const raw = (product.searchKeyword || product.name || '').toString();
  const trimmed = raw.replace(/\s+/g, ' ').trim().slice(0, 80);
  return validateKeyword(trimmed);
}

// 결과 outcome:
//   updated          정확히 일치 → 가격/이미지 갱신(apply 모드)
//   checked          정확히 일치 → 확인만 함(dryRun, 데이터는 쓰지 않음). observed 에 응답값
//   not_found        검색 결과에 같은 상품 ID 없음 (품절 아님)
//   option_mismatch  같은 상품이지만 옵션이 다름 (품절 아님)
//   skipped          검색어 문제/쓸 값 없음
//   error            호출 한도·차단·네트워크 등 시스템 쪽 문제 → 상품 실패로 기록하지 않는다(attribute:false)
export async function refreshProducts({ products, client, maxCalls = 3, dryRun = true, now = () => new Date() }) {
  const plan = planRefresh(products, maxCalls, now().getTime());
  const results = [];
  let stopped = null;

  for (const p of plan.targets) {
    let keyword;
    try {
      keyword = keywordFor(p);
    } catch {
      results.push({ id: p.id, outcome: 'skipped', reason: 'invalid_keyword', patch: null, attribute: true });
      continue;
    }

    let found;
    try {
      found = await client.searchProducts(keyword, { limit: 10 });
    } catch (e) {
      const code = e instanceof CoupangError ? e.code : 'unknown';
      if (code === 'invalid_input') { results.push({ id: p.id, outcome: 'skipped', reason: 'invalid_input', patch: null, attribute: true }); continue; }
      results.push({ id: p.id, outcome: 'error', reason: code, patch: null, attribute: false });
      if (STOP_CODES.has(code) || code === 'unknown') { stopped = { code, message: e && e.message ? String(e.message).slice(0, 200) : '' }; break; }
      continue;
    }

    const stored = { productId: p.coupangProductId, itemId: p.coupangItemId || null, vendorItemId: p.coupangVendorItemId || null };
    const candidates = found.items.filter((it) => it.productId === String(stored.productId));
    if (!candidates.length) {
      results.push({ id: p.id, outcome: 'not_found', reason: 'not_in_search_results', patch: null, attribute: true });
      continue;
    }

    let exact = null;
    let lastReason = 'product_id_mismatch';
    for (const c of candidates) {
      const m = matchExact(stored, c);
      if (m.ok) { exact = c; break; }
      lastReason = m.reason;
    }
    if (!exact) {
      results.push({ id: p.id, outcome: 'option_mismatch', reason: lastReason, patch: null, attribute: true });
      continue;
    }

    const observed = {
      price: typeof exact.price === 'number' && exact.price > 0 ? exact.price : null,
      imageUrl: exact.image || null,
    };
    if (dryRun) {
      results.push({ id: p.id, outcome: 'checked', reason: 'exact', patch: null, observed, attribute: true });
      continue;
    }

    const patch = {};
    if (observed.price != null) patch.price = observed.price;
    if (observed.imageUrl) patch.imageUrl = observed.imageUrl;
    if (patch.price == null && patch.imageUrl == null) {
      results.push({ id: p.id, outcome: 'skipped', reason: 'no_usable_fields', patch: null, attribute: true });
      continue;
    }
    // 가격 확인 시각은 "쿠팡 응답을 받은 시각"(캐시 적중이면 그 응답을 받은 당시 시각)이다. 지금 시각으로 덮지 않는다.
    // 이미지만 바뀌었다면 가격 확인일은 건드리지 않는다(거짓 신선도 방지).
    if (patch.price != null) patch.priceCheckedAt = found.fetchedAt || now().toISOString();
    results.push({ id: p.id, outcome: 'updated', reason: 'exact', patch, attribute: true });
  }

  return { results, stopped, attempted: plan.targets.length, plan: { needsFix: plan.needsFix, cooling: plan.cooling, recent: plan.recent } };
}

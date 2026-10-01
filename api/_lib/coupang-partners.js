// api/_lib/coupang-partners.js
//
// 쿠팡 파트너스(제휴) Open API 서버 클라이언트.  ※ 판매자(Wing)용 Open API와는 다른 API다.
//
// ⚠ 검증 상태 (2026-10-01 기준)
//   - 아래 인증 방식·엔드포인트·응답 필드는 "쿠팡 파트너스 공식 문서 원문"이 아니라,
//     같은 API를 쓰는 공개 SDK/문서 정리를 근거로 작성했다. 공식 문서 원문 대조와
//     실제 키로 한 호출 검증은 아직 하지 않았다. → README의 "검증 체크리스트" 참고.
//   - 검증 전에는 COUPANG_REFRESH_ENABLED=true 로 켜지 않는다(기본 꺼짐).
//
// 이 파일은 브라우저에 절대 내려가지 않는다(api/_lib 는 Vercel 함수/정적 파일로 노출되지 않음).
// Access Key / Secret Key 는 환경변수로만 읽고, 로그·에러 메시지·응답에 넣지 않는다.

import crypto from 'node:crypto';

export const BASE_URL = 'https://api-gateway.coupang.com';
const API_PREFIX = '/v2/providers/affiliate_open_api/apis/openapi';
export const SEARCH_PATH = `${API_PREFIX}/products/search`;
// 자료마다 `/products/search` 와 `/v1/products/search` 두 형태가 보여서(공식 문서 미확인) 환경변수로 고를 수 있게 한다.
// 임의 경로를 넣을 수 없도록 두 형태만 허용한다. 기본값은 SEARCH_PATH.
export const SEARCH_PATH_V1 = `${API_PREFIX}/v1/products/search`;
export function resolveSearchPath(env = process.env) {
  const v = env.COUPANG_PARTNERS_SEARCH_PATH;
  if (!v) return SEARCH_PATH;
  if (v === SEARCH_PATH || v === SEARCH_PATH_V1) return v;
  throw new CoupangError('invalid_input', 'COUPANG_PARTNERS_SEARCH_PATH 값이 허용된 경로가 아닙니다.');
}
export const DEEPLINK_PATH = `${API_PREFIX}/v1/deeplink`;

// 공개 정리글 기준: 상품 검색 API는 시간당 10회, 초과하면 차단(반복 시 제한). 여유를 두고 8회로 잡는다.
export const SEARCH_HOURLY_LIMIT_DOC = 10;
export const SEARCH_HOURLY_BUDGET_DEFAULT = 8;
export const SEARCH_MAX_LIMIT = 10;        // 1회 검색 결과 수 상한(공개 정리글 기준)
export const DEFAULT_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------
// 오류 종류 — 호출하는 쪽이 "왜 못 했는지"를 구분해서 화면/운영자에게 알릴 수 있게 한다.
// ---------------------------------------------------------------
export class CoupangError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'CoupangError';
    this.code = code;          // keys_missing | invalid_input | timeout | http_error | api_error | rate_limited | blocked | bad_response
    Object.assign(this, extra || {});
  }
}

// ---------------------------------------------------------------
// 인증: Authorization: CEA algorithm=HmacSHA256, access-key=..., signed-date=yyMMddTHHmmssZ, signature=...
//   signature = HMAC-SHA256(secretKey, signedDate + METHOD + path + query)  (query 에는 '?' 를 넣지 않는다)
//   signed-date 는 UTC(GMT) 기준.
// ---------------------------------------------------------------
export function signedDateUtc(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const yy = String(now.getUTCFullYear()).slice(-2);
  return `${yy}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

export function buildAuthorization({ method, path, query = '', accessKey, secretKey, now = new Date() }) {
  if (!accessKey || !secretKey) throw new CoupangError('keys_missing', '쿠팡 파트너스 API 키가 설정되지 않았습니다.');
  const signedDate = signedDateUtc(now);
  const message = `${signedDate}${String(method).toUpperCase()}${path}${query}`;
  const signature = crypto.createHmac('sha256', secretKey).update(message).digest('hex');
  return `CEA algorithm=HmacSHA256, access-key=${accessKey}, signed-date=${signedDate}, signature=${signature}`;
}

// ---------------------------------------------------------------
// 입력 검증
// ---------------------------------------------------------------
export function validateKeyword(keyword) {
  const k = String(keyword == null ? '' : keyword).replace(/\s+/g, ' ').trim();
  if (k.length < 2 || k.length > 100) throw new CoupangError('invalid_input', '검색어는 2~100자여야 합니다.');
  if (/[\u0000-\u001f]/.test(k)) throw new CoupangError('invalid_input', '검색어에 제어 문자가 있습니다.');
  return k;
}

export function clampLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return SEARCH_MAX_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export function validateSubId(subId) {
  if (subId == null || subId === '') return null;
  const s = String(subId);
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(s)) throw new CoupangError('invalid_input', 'subId 형식이 올바르지 않습니다.');
  return s;
}

// ---------------------------------------------------------------
// 쿠팡 상품 URL → 식별자.  .../vp/products/{productId}?itemId=..&vendorItemId=..
// ---------------------------------------------------------------
export function parseCoupangIds(url) {
  const out = { productId: null, itemId: null, vendorItemId: null };
  if (!url) return out;
  try {
    const u = new URL(String(url));
    const m = /\/vp\/products\/(\d+)/.exec(u.pathname);
    if (m) out.productId = m[1];
    else if (/^\d+$/.test(u.searchParams.get('pageKey') || '')) out.productId = u.searchParams.get('pageKey');   // link.coupang.com/re/... 형식
    out.itemId = u.searchParams.get('itemId') || null;
    out.vendorItemId = u.searchParams.get('vendorItemId') || null;
  } catch { /* 형식이 이상하면 전부 null */ }
  return out;
}

// ---------------------------------------------------------------
// 응답 매핑 — 필드가 없거나 이상하면 "없음(null)"으로 두고, 0원·품절 같은 값을 만들어 내지 않는다.
// 이 API가 평점·리뷰수·리뷰 원문·재고/판매가능 여부를 주는지는 확인되지 않았으므로 여기서 읽지 않는다.
// ---------------------------------------------------------------
function positiveInt(v) {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '')) : v;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function httpsUrlOrNull(v) {
  try {
    const u = new URL(String(v));
    return u.protocol === 'https:' ? u.toString() : null;
  } catch { return null; }
}

export function mapSearchResponse(json) {
  if (!json || typeof json !== 'object') throw new CoupangError('bad_response', '응답 형식이 올바르지 않습니다.');
  // rCode "0" 이 성공. 그 외는 쿠팡이 알려준 오류.
  if (String(json.rCode) !== '0') {
    throw new CoupangError('api_error', `쿠팡 API 오류 응답 (rCode=${String(json.rCode).slice(0, 20)})`, { rCode: String(json.rCode) });
  }
  const list = json.data && Array.isArray(json.data.productData) ? json.data.productData : null;
  if (!list) throw new CoupangError('bad_response', '응답에 productData 목록이 없습니다.');
  return list.map((it) => ({
    productId: it && it.productId != null ? String(it.productId) : null,
    name: it && typeof it.productName === 'string' ? it.productName : null,
    price: positiveInt(it && it.productPrice),
    image: httpsUrlOrNull(it && it.productImage),
    url: httpsUrlOrNull(it && it.productUrl),
    isRocket: it && typeof it.isRocket === 'boolean' ? it.isRocket : null,
    isFreeShipping: it && typeof it.isFreeShipping === 'boolean' ? it.isFreeShipping : null,
    categoryName: it && typeof it.categoryName === 'string' ? it.categoryName : null,
  })).filter((x) => x.productId);
}

// ---------------------------------------------------------------
// 정확 일치 — 상품·옵션이 같을 때만 true. 비슷한 이름의 다른 상품은 연결하지 않는다.
//   stored: { productId, itemId, vendorItemId }  (우리 DB에 저장된 식별자)
//   apiItem: mapSearchResponse 결과 한 건
// ---------------------------------------------------------------
export function matchExact(stored, apiItem) {
  if (!stored || !stored.productId) return { ok: false, reason: 'no_stored_product_id' };
  if (!apiItem || !apiItem.productId) return { ok: false, reason: 'no_api_product_id' };
  if (String(stored.productId) !== String(apiItem.productId)) return { ok: false, reason: 'product_id_mismatch' };

  // 옵션(itemId/vendorItemId)이 저장돼 있으면 API 상품 URL의 값과 같아야 한다.
  // 저장된 옵션이 없으면 "같은 옵션인지 확인할 수 없다"로 보고 갱신하지 않는다.
  if (!stored.itemId && !stored.vendorItemId) return { ok: false, reason: 'option_not_stored' };
  const ids = parseCoupangIds(apiItem.url);
  if (stored.itemId) {
    if (!ids.itemId) return { ok: false, reason: 'option_not_in_api_url' };
    if (String(stored.itemId) !== String(ids.itemId)) return { ok: false, reason: 'item_id_mismatch' };
  }
  if (stored.vendorItemId) {
    if (!ids.vendorItemId) return { ok: false, reason: 'option_not_in_api_url' };
    if (String(stored.vendorItemId) !== String(ids.vendorItemId)) return { ok: false, reason: 'vendor_item_id_mismatch' };
  }
  return { ok: true, reason: 'exact' };
}

// ---------------------------------------------------------------
// 호출 제한 보호 — 쿠팡 API를 부르기 "전에" 예약하고, 한도를 넘기면 부르지 않는다.
//   store 인터페이스: countSince(endpoint, sinceMs) / record(endpoint, atMs) / blockedUntil()
//   (운영: Supabase 테이블 기반, 테스트: 메모리 기반)
// ---------------------------------------------------------------
export function createUsageGuard(store, { hourlyBudget = SEARCH_HOURLY_BUDGET_DEFAULT, blockHours = 24, now = () => Date.now() } = {}) {
  return {
    async reserve(endpoint, count = 1) {
      const t = now();
      const until = await store.blockedUntil();
      if (until && until > t) {
        throw new CoupangError('blocked', '쿠팡이 이전 호출을 제한해 호출을 중단한 상태입니다.', { blockedUntil: new Date(until).toISOString() });
      }
      const used = await store.countSince(endpoint, t - 60 * 60 * 1000);
      if (used + count > hourlyBudget) {
        throw new CoupangError('rate_limited', `시간당 호출 예산(${hourlyBudget}회)을 넘기게 되어 호출하지 않았습니다.`, { used, hourlyBudget });
      }
      for (let i = 0; i < count; i++) await store.record(endpoint, t);
      return { used: used + count, hourlyBudget };
    },
    async markBlocked() {
      await store.markBlocked(now() + blockHours * 60 * 60 * 1000);
    },
  };
}

export function createMemoryUsageStore() {
  const calls = [];
  let blocked = 0;
  return {
    async countSince(endpoint, sinceMs) { return calls.filter((c) => c.endpoint === endpoint && c.at >= sinceMs).length; },
    async record(endpoint, atMs) { calls.push({ endpoint, at: atMs }); },
    async blockedUntil() { return blocked; },
    async markBlocked(untilMs) { blocked = untilMs; },
    _calls: calls,
  };
}

// ---------------------------------------------------------------
// 짧은 메모리 캐시 — 같은 키워드를 연달아 요청해도 쿠팡 호출을 반복하지 않는다.
// (서버리스 인스턴스마다 따로라 "호출 한도"의 대체재는 아니고, 보조 수단이다.)
// ---------------------------------------------------------------
export function createTtlCache(ttlMs, now = () => Date.now(), maxEntries = 100) {
  const map = new Map();
  return {
    get(key) {
      const e = map.get(key);
      if (!e) return undefined;
      if (e.exp <= now()) { map.delete(key); return undefined; }
      return e.val;
    },
    set(key, val) {
      if (map.size >= maxEntries) map.delete(map.keys().next().value);
      map.set(key, { val, exp: now() + ttlMs });
    },
    size() { return map.size; },
  };
}

// ---------------------------------------------------------------
// 클라이언트
// ---------------------------------------------------------------
export function createClient({
  accessKey, secretKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  guard = null,
  cache = null,
  now = () => new Date(),
  baseUrl = BASE_URL,
  searchPath = SEARCH_PATH,
} = {}) {
  async function request(method, path, query, body) {
    const auth = buildAuthorization({ method, path, query, accessKey, secretKey, now: now() });
    const url = `${baseUrl}${path}${query ? `?${query}` : ''}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: auth, 'Content-Type': 'application/json;charset=UTF-8' },
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new CoupangError('timeout', `쿠팡 API 응답 시간 초과(${timeoutMs}ms)`);
      throw new CoupangError('http_error', '쿠팡 API에 연결하지 못했습니다.');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 403 || res.status === 429) {
      // 호출 제한에 걸린 신호. 이후 호출을 멈춰서 반복 위반(= 계정 제한)을 피한다.
      if (guard) await guard.markBlocked();
      throw new CoupangError('blocked', `쿠팡이 호출을 거절했습니다(HTTP ${res.status}). 한동안 호출을 중단합니다.`, { status: res.status });
    }
    if (!res.ok) throw new CoupangError('http_error', `쿠팡 API HTTP ${res.status}`, { status: res.status });

    let json;
    try { json = await res.json(); } catch { throw new CoupangError('bad_response', '응답을 JSON으로 읽지 못했습니다.'); }
    return json;
  }

  return {
    async searchProducts(keyword, { limit = SEARCH_MAX_LIMIT, subId = null } = {}) {
      const k = validateKeyword(keyword);
      const lim = clampLimit(limit);
      const sid = validateSubId(subId);
      const cacheKey = `search|${k}|${lim}|${sid || ''}`;
      if (cache) {
        const hit = cache.get(cacheKey);
        // fetchedAt = 쿠팡 응답을 실제로 받은 시각. 캐시 적중이어도 이 시각을 그대로 넘겨,
        // 호출하는 쪽이 "가격 확인 시각"을 지금으로 속이지 않게 한다.
        if (hit) return { items: hit.items, fromCache: true, fetchedAt: hit.fetchedAt };
      }
      if (guard) await guard.reserve('search', 1);
      const params = new URLSearchParams({ keyword: k, limit: String(lim) });
      if (sid) params.set('subId', sid);
      const json = await request('GET', searchPath, params.toString(), null);
      const items = mapSearchResponse(json);
      const fetchedAt = now().toISOString();
      if (cache) cache.set(cacheKey, { items, fetchedAt });
      return { items, fromCache: false, fetchedAt };
    },
  };
}

// 환경변수에서 키를 읽는다. 값 자체는 어디에도 출력하지 않는다.
export function readCredentialsFromEnv(env = process.env) {
  const accessKey = env.COUPANG_PARTNERS_ACCESS_KEY || '';
  const secretKey = env.COUPANG_PARTNERS_SECRET_KEY || '';
  return { accessKey, secretKey, configured: Boolean(accessKey && secretKey) };
}

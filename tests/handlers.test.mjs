import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import products, { toPublicProduct, isPublishable } from '../api/situation-products.js';
import refresh from '../api/coupang-refresh.js';

const SECRET = 'HANDLER_SECRET_MUST_NOT_LEAK';
const ACCESS = 'HANDLER_ACCESS_MUST_NOT_LEAK';
const SRK = 'SERVICE_ROLE_MUST_NOT_LEAK';
const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };

function mockRes() {
  const r = { headers: {}, statusCode: 200, body: undefined };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const req = (o) => Object.assign({ method: 'GET', headers: {} }, o);
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (body === undefined ? '' : JSON.stringify(body)) });

beforeEach(() => {
  for (const k of Object.keys(process.env)) if (/^(SUPABASE|COUPANG|ADMIN_EMAILS)/.test(k)) delete process.env[k];
});
afterEach(() => { globalThis.fetch = realFetch; Object.assign(process.env, savedEnv); });

// ---------- situation-products ----------
const row = (o) => Object.assign({
  id: 'u1', name: '핸드블렌더', category: '주방', price: 57500, price_checked_at: '2026-09-30T01:00:00Z', image_url: null,
  affiliate_url: 'https://link.coupang.com/a/abc', situations: ['housewarming'], subtypes: [], recipients: ['friend'], exclude_tags: [],
  reason: '설거지 부담이 적은 선물', caution: '전압 확인', rating: 4.5, review_count: 864, review_checked_at: '2026-09-30', review_verified_at: '2026-09-29', reviewed_at: '2026-09-30T02:00:00Z',
  review_read_count: 37, review_basis: '내부 검토 근거 원문', review_verified_by: 'master@example.com',
  // 아래는 응답에 나가면 안 되는 내부 필드
  reviewed_by: 'admin@example.com', coupang_product_id: '123', last_refresh_status: 'x',
}, o);

test('situation-products: GET 이외는 405', async () => {
  const res = mockRes(); await products(req({ method: 'POST' }), res);
  assert.equal(res.statusCode, 405);
});

test('situation-products: 외부 Referer 는 403', async () => {
  const res = mockRes(); await products(req({ headers: { referer: 'https://evil.example/x' } }), res);
  assert.equal(res.statusCode, 403);
});

test('situation-products: 환경변수 없으면 503 not_configured', async () => {
  const res = mockRes(); await products(req(), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'not_configured');
});

test('situation-products: 승인 상품만 질의하고 내부 필드는 응답에서 뺀다', async () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = SRK;
  let seenUrl;
  globalThis.fetch = async (url) => { seenUrl = url; return resp(200, [row()]); };
  const res = mockRes(); await products(req({ headers: { referer: 'https://www.jumungosu.com/shopping' } }), res);
  assert.equal(res.statusCode, 200);
  assert.match(seenUrl, /review_state=eq\.approved/);
  assert.match(seenUrl, /affiliate_url=not\.is\.null/);
  assert.match(seenUrl, /review_verified_at=not\.is\.null/);   // 상품평 검토 기록이 있는 것만 질의
  assert.equal(res.body.products[0].reviewVerifiedAt, '2026-09-29');
  const p = res.body.products[0];
  assert.equal(p.price, 57500); assert.equal(p.affiliateUrl, 'https://link.coupang.com/a/abc'); assert.equal(p.reviewState, 'approved');
  const json = JSON.stringify(res.body);
  for (const leak of ['reviewed_by', 'admin@example.com', 'coupang_product_id', 'last_refresh', SRK, '내부 검토 근거 원문', 'review_basis', 'review_read_count', 'master@example.com']) assert.ok(!json.includes(leak), leak);
  assert.match(res.headers['Cache-Control'], /s-maxage=60/);
});

test('situation-products: 확인일 없는 평점·리뷰수는 내려주지 않는다 / 가격 0·음수는 null', () => {
  const p = toPublicProduct(row({ review_checked_at: null }));
  assert.equal(p.rating, null); assert.equal(p.reviewCount, null);
  assert.equal(toPublicProduct(row({ price: 0 })).price, null);
  assert.equal(toPublicProduct(row({ price: null })).price, null);
});

test('situation-products: 테이블 없음(404)은 503 table_missing, 그 외 실패는 502, 둘 다 캐시하지 않는다', async () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = SRK;
  globalThis.fetch = async () => resp(404, { message: 'relation does not exist' });
  let res = mockRes(); await products(req(), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'table_missing'); assert.equal(res.headers['Cache-Control'], 'no-store');
  globalThis.fetch = async () => resp(500, { message: 'boom' });
  res = mockRes(); await products(req(), res);
  assert.equal(res.statusCode, 502); assert.equal(res.body.error, 'upstream_error');
  assert.ok(!JSON.stringify(res.body).includes(SRK));
});

test('situation-products: 승인 상품이 0개면 빈 배열(오류 아님)', async () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = SRK;
  globalThis.fetch = async () => resp(200, []);
  const res = mockRes(); await products(req(), res);
  assert.equal(res.statusCode, 200); assert.deepEqual(res.body.products, []);
});

// ---------- coupang-refresh ----------
function envAll() {
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = SRK;
  process.env.ADMIN_EMAILS = 'Admin@Example.com, other@example.com';
  process.env.COUPANG_PARTNERS_ACCESS_KEY = ACCESS; process.env.COUPANG_PARTNERS_SECRET_KEY = SECRET;
  process.env.COUPANG_REFRESH_ENABLED = 'true';
  process.env.COUPANG_PRICE_REFRESH_ENABLED = 'true';   // 기본(dry-run)이 아니라 저장 모드
}
const adminReq = () => req({ method: 'POST', headers: { authorization: 'Bearer user-token' } });

test('coupang-refresh: POST 이외 405 / 기본은 꺼짐(503 refresh_disabled)', async () => {
  let res = mockRes(); await refresh(req({ method: 'GET' }), res); assert.equal(res.statusCode, 405);
  res = mockRes(); await refresh(adminReq(), res); assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'refresh_disabled');
});

test('coupang-refresh: 로그인 토큰이 없거나 관리자가 아니면 401, 쿠팡은 호출하지 않는다', async () => {
  envAll();
  let coupangCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('coupang.com')) coupangCalls++;
    if (String(url).includes('/auth/v1/user')) return resp(200, { email: 'stranger@example.com' });
    return resp(200, []);
  };
  let res = mockRes(); await refresh(req({ method: 'POST' }), res); assert.equal(res.statusCode, 401);
  res = mockRes(); await refresh(adminReq(), res); assert.equal(res.statusCode, 401);
  assert.equal(coupangCalls, 0);
});

test('coupang-refresh: 키 미설정이면 503 keys_missing (값·이름 노출 없음)', async () => {
  envAll(); delete process.env.COUPANG_PARTNERS_SECRET_KEY;
  globalThis.fetch = async (url) => String(url).includes('/auth/v1/user') ? resp(200, { email: 'admin@example.com' }) : resp(200, []);
  const res = mockRes(); await refresh(adminReq(), res);
  assert.equal(res.statusCode, 503); assert.equal(res.body.error, 'keys_missing');
  assert.ok(!JSON.stringify(res.body).includes(ACCESS));
});

test('coupang-refresh: 정상 경로 — 정확 일치만 가격 갱신, 응답·로그에 키가 없다', async () => {
  envAll();
  const logs = []; const origErr = console.error; console.error = (...a) => logs.push(a.join(' '));
  const patches = []; const inserts = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return resp(200, { email: 'ADMIN@example.com' });
    if (u.includes('coupang_api_calls') && (!init.method || init.method === 'GET')) return resp(200, []);   // 호출 기록 없음, 차단 없음
    if (u.includes('coupang_api_calls') && init.method === 'POST') { inserts.push(JSON.parse(init.body)); return resp(201, undefined); }
    if (u.includes('/rest/v1/situation_products') && (!init.method || init.method === 'GET')) {
      return resp(200, [{ id: 'p1', name: '핸드블렌더 세트', search_keyword: null, price_checked_at: null, review_state: 'approved', coupang_product_id: '100', coupang_item_id: '11', coupang_vendor_item_id: '22' }]);
    }
    if (u.includes('/rest/v1/situation_products') && init.method === 'PATCH') { patches.push({ url: u, body: JSON.parse(init.body) }); return resp(204, undefined); }
    if (u.startsWith('https://api-gateway.coupang.com')) {
      assert.match(init.headers.Authorization, /^CEA algorithm=HmacSHA256, access-key=/);
      return resp(200, { rCode: '0', data: { productData: [{ productId: 100, productName: '핸드블렌더 세트', productPrice: 57500, productImage: 'https://img.example/b.jpg', productUrl: 'https://www.coupang.com/vp/products/100?itemId=11&vendorItemId=22' }] } });
    }
    throw new Error('예상 밖 호출: ' + u);
  };
  try {
    const res = mockRes(); await refresh(adminReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.updated, 1);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].body.price, 57500);
    assert.equal(patches[0].body.image_url, 'https://img.example/b.jpg');
    assert.ok(patches[0].body.price_checked_at);
    assert.equal(inserts.filter((i) => i.endpoint === 'search').length, 1);    // 호출 1건 기록
    const everything = JSON.stringify(res.body) + logs.join('\n');
    for (const leak of [SECRET, ACCESS, SRK]) assert.ok(!everything.includes(leak));
  } finally { console.error = origErr; }
});

test('coupang-refresh: 시간당 예산을 이미 쓴 상태면 쿠팡을 부르지 않고 429', async () => {
  envAll(); process.env.COUPANG_SEARCH_HOURLY_BUDGET = '2';
  let coupangCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return resp(200, { email: 'admin@example.com' });
    if (u.includes('endpoint=eq.blocked')) return resp(200, []);
    if (u.includes('coupang_api_calls') && (!init.method || init.method === 'GET')) return resp(200, [{ id: 1 }, { id: 2 }]);  // 이미 2회 사용
    if (u.includes('/rest/v1/situation_products') && (!init.method || init.method === 'GET')) return resp(200, [{ id: 'p1', name: '다른 상품 이름 테스트', review_state: 'approved', coupang_product_id: '100', coupang_item_id: '11' }]);
    if (u.includes('/rest/v1/situation_products') && init.method === 'PATCH') return resp(204, undefined);
    if (u.startsWith('https://api-gateway.coupang.com')) coupangCalls++;
    return resp(200, {});
  };
  const origErr = console.error; console.error = () => {};
  try {
    const res = mockRes(); await refresh(adminReq(), res);
    assert.equal(coupangCalls, 0);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.stopped.code, 'rate_limited');
    assert.equal(res.body.updated, 0);
  } finally { console.error = origErr; }
});

// ---------- 서버 2차 방어: DB 제약을 우회해 들어온 데이터도 내보내지 않는다 ----------
test('situation-products: 검토 기록 없는 행·구분 없는 돌잔치 행은 응답에서 제외', async () => {
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = SRK;
  globalThis.fetch = async () => resp(200, [
    row({ id: 'ok1' }),
    row({ id: 'noreview', review_verified_at: null }),
    row({ id: 'dolnone', situations: ['dol'], subtypes: [] }),
    row({ id: 'dolok', situations: ['dol'], subtypes: ['attend'] }),
    row({ id: 'dolmix', situations: ['dol', 'housewarming'], subtypes: [] }),
  ]);
  const res = mockRes(); await products(req(), res);
  assert.deepEqual(res.body.products.map((p) => p.id).sort(), ['dolok', 'ok1']);
  assert.equal(isPublishable(toPublicProduct(row())), true);
  assert.equal(isPublishable(toPublicProduct(row({ review_verified_at: null }))), false);
});

// ---------- 갱신 API: dry-run / 보완 필요 / 실패 기록 ----------
function refreshFetch(opts) {
  const log = { patches: [], inserts: [], coupang: 0 };
  const rows = opts.rows;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/auth/v1/user')) return resp(200, { email: 'admin@example.com' });
    if (u.includes('coupang_api_calls') && init.method === 'POST') { log.inserts.push(JSON.parse(init.body)); return resp(201, undefined); }
    if (u.includes('coupang_api_calls')) return resp(200, []);
    if (u.includes('/rest/v1/situation_products') && init.method === 'PATCH') { log.patches.push({ url: u, body: JSON.parse(init.body) }); return resp(204, undefined); }
    if (u.includes('/rest/v1/situation_products')) return resp(200, rows);
    if (u.startsWith('https://api-gateway.coupang.com')) { log.coupang++; return opts.coupang(u, init); }
    throw new Error('예상 밖 호출: ' + u);
  };
  return log;
}
const dbRow = (o) => Object.assign({ id: 'p1', name: '핸드블렌더 세트', search_keyword: null, price_checked_at: null, review_state: 'approved', coupang_product_id: '100', coupang_item_id: '11', coupang_vendor_item_id: '22', last_refresh_at: null, last_refresh_status: null, refresh_failures: 0 }, o);
const okCoupang = () => resp(200, { rCode: '0', data: { productData: [{ productId: 100, productName: 'x', productPrice: 57500, productImage: 'https://img.example/b.jpg', productUrl: 'https://www.coupang.com/vp/products/100?itemId=11&vendorItemId=22' }] } });

test('coupang-refresh: 가격 갱신 플래그가 없으면 dry_run — 호출하지만 가격·이미지는 저장하지 않는다', async () => {
  envAll(); delete process.env.COUPANG_PRICE_REFRESH_ENABLED;
  const log = refreshFetch({ rows: [dbRow({ name: '드라이런 전용 상품' })], coupang: okCoupang });
  const res = mockRes(); await refresh(adminReq(), res);
  assert.equal(res.statusCode, 200); assert.equal(res.body.mode, 'dry_run');
  assert.equal(log.coupang, 1); assert.equal(res.body.checked, 1); assert.equal(res.body.updated, 0);
  assert.equal(res.body.results[0].observedPrice, 57500);          // 운영자가 비교할 수 있게 보여주기만
  const b = log.patches[0].body;
  assert.equal(b.last_refresh_status, 'checked');
  assert.ok(!('price' in b) && !('image_url' in b) && !('price_checked_at' in b), '데이터 컬럼은 쓰지 않는다');
});

test('coupang-refresh: 옵션 식별자 없는 승인 상품은 호출 없이 needsFix 로 보고', async () => {
  envAll();
  const log = refreshFetch({ rows: [dbRow({ id: 'x', coupang_item_id: null, coupang_vendor_item_id: null }), dbRow({ id: 'y', coupang_product_id: null, coupang_item_id: null, coupang_vendor_item_id: null })], coupang: okCoupang });
  const res = mockRes(); await refresh(adminReq(), res);
  assert.equal(log.coupang, 0); assert.equal(res.body.needsFix, 2); assert.equal(res.body.attempted, 0);
  assert.equal(log.patches.length, 0);
});

test('coupang-refresh: 검색 결과 없음 → 실패 횟수+1, 가격·상태는 품절로 바꾸지 않는다 / 다음 실행에서는 대기', async () => {
  envAll();
  const empty = () => resp(200, { rCode: '0', data: { productData: [] } });
  const log = refreshFetch({ rows: [dbRow({ name: '검색결과 없음 전용 상품', refresh_failures: 1, last_refresh_at: new Date(Date.now() - 7 * 3600 * 1000).toISOString(), last_refresh_status: 'not_found:not_in_search_results' })], coupang: empty });
  let res = mockRes(); await refresh(adminReq(), res);
  assert.equal(log.coupang, 1);
  const b = log.patches[0].body;
  assert.equal(b.last_refresh_status, 'not_found:not_in_search_results'); assert.equal(b.refresh_failures, 2);
  assert.ok(!('price' in b) && !('image_url' in b));
  assert.ok(!/sold|품절|stock/i.test(JSON.stringify(b)));
  // 방금 실패한 상태로 다시 실행하면 대기 중이라 호출하지 않는다
  const log2 = refreshFetch({ rows: [dbRow({ name: '검색결과 없음 전용 상품', refresh_failures: 2, last_refresh_at: new Date().toISOString(), last_refresh_status: 'not_found:not_in_search_results' })], coupang: empty });
  res = mockRes(); await refresh(adminReq(), res);
  assert.equal(log2.coupang, 0); assert.equal(res.body.cooling, 1);
});

test('coupang-refresh: 쿠팡이 403(차단)을 줘도 그 상품을 실패로 기록하지 않는다', async () => {
  envAll();
  const log = refreshFetch({ rows: [dbRow({ name: '차단 시나리오 전용 상품' })], coupang: () => resp(403, { message: 'limit' }) });
  const origErr = console.error; console.error = () => {};
  try {
    const res = mockRes(); await refresh(adminReq(), res);
    assert.equal(res.body.stopped.code, 'blocked');
    assert.equal(log.patches.length, 0, '시스템 쪽 실패라 상품 행을 건드리면 안 된다');
    assert.ok(log.inserts.some((i) => i.endpoint === 'blocked'));
  } finally { console.error = origErr; }
});

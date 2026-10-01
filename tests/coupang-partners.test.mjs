import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as C from '../api/_lib/coupang-partners.js';
import { refreshProducts, pickRefreshTargets } from '../api/_lib/refresh.js';

const ACCESS = 'TEST_ACCESS_KEY_1234';
const SECRET = 'TEST_SECRET_KEY_ABCDEFG_DO_NOT_LEAK';
const FIXED = new Date(Date.UTC(2026, 9, 1, 3, 4, 5)); // 2026-10-01 03:04:05Z

// ---------- 인증 ----------
test('서명 시각: UTC yymmddTHHMMSSZ', () => {
  assert.equal(C.signedDateUtc(FIXED), '261001T030405Z');
  assert.equal(C.signedDateUtc(new Date(Date.UTC(2027, 0, 9, 23, 59, 59))), '270109T235959Z');
});

test('서명: signedDate+METHOD+path+query 의 HMAC-SHA256(hex) 를 CEA 헤더에 넣는다', () => {
  const path = '/v2/providers/affiliate_open_api/apis/openapi/products/search';
  const query = 'keyword=%EB%8F%8C&limit=5';
  const h = C.buildAuthorization({ method: 'get', path, query, accessKey: ACCESS, secretKey: SECRET, now: FIXED });
  const expected = crypto.createHmac('sha256', SECRET).update('261001T030405Z' + 'GET' + path + query).digest('hex');
  assert.equal(h, `CEA algorithm=HmacSHA256, access-key=${ACCESS}, signed-date=261001T030405Z, signature=${expected}`);
  assert.ok(!h.includes(SECRET), '헤더에 시크릿 키 원문이 들어가면 안 된다');
});

test('키가 없으면 keys_missing, 메시지에 키 값이 없다', () => {
  for (const [a, s] of [['', ''], [ACCESS, ''], ['', SECRET]]) {
    try { C.buildAuthorization({ method: 'GET', path: '/x', accessKey: a, secretKey: s }); assert.fail('throw 해야 함'); }
    catch (e) { assert.equal(e.code, 'keys_missing'); assert.ok(!e.message.includes(SECRET)); }
  }
  assert.deepEqual(C.readCredentialsFromEnv({}), { accessKey: '', secretKey: '', configured: false });
  assert.equal(C.readCredentialsFromEnv({ COUPANG_PARTNERS_ACCESS_KEY: 'a', COUPANG_PARTNERS_SECRET_KEY: 'b' }).configured, true);
});

// ---------- 입력 검증 ----------
test('입력 검증', () => {
  assert.equal(C.validateKeyword('  돌잔치   선물 '), '돌잔치 선물');
  assert.throws(() => C.validateKeyword('a'), (e) => e.code === 'invalid_input');
  assert.throws(() => C.validateKeyword('x'.repeat(101)), (e) => e.code === 'invalid_input');
  assert.throws(() => C.validateKeyword('ab\u0000c'), (e) => e.code === 'invalid_input');
  assert.throws(() => C.validateKeyword(null), (e) => e.code === 'invalid_input');
  assert.equal(C.clampLimit(100), 10);
  assert.equal(C.clampLimit(0), 1);
  assert.equal(C.clampLimit('abc'), 10);
  assert.equal(C.validateSubId(''), null);
  assert.equal(C.validateSubId('situation_dol'), 'situation_dol');
  assert.throws(() => C.validateSubId('bad id!'), (e) => e.code === 'invalid_input');
});

// ---------- 응답 매핑 ----------
const okBody = (items) => ({ rCode: '0', rMessage: '', data: { productData: items } });

test('매핑: 정상 응답', () => {
  const r = C.mapSearchResponse(okBody([{ productId: 123, productName: '수건 세트', productPrice: 19800, productImage: 'https://img.example/a.jpg', productUrl: 'https://www.coupang.com/vp/products/123?itemId=1&vendorItemId=2', isRocket: true, isFreeShipping: false, categoryName: '생활' }]));
  assert.deepEqual(r[0], { productId: '123', name: '수건 세트', price: 19800, image: 'https://img.example/a.jpg', url: 'https://www.coupang.com/vp/products/123?itemId=1&vendorItemId=2', isRocket: true, isFreeShipping: false, categoryName: '생활' });
});

test('매핑: 이상한 값은 0원·품절로 바꾸지 않고 null 로 둔다', () => {
  const r = C.mapSearchResponse(okBody([
    { productId: 1, productName: 'a', productPrice: 0 },
    { productId: 2, productName: 'b', productPrice: -5 },
    { productId: 3, productName: 'c', productPrice: 'abc' },
    { productId: 4, productName: 'd', productPrice: '12,300', productImage: 'http://insecure/x.jpg' },
    { productId: 5, productName: 'e' },
    { productName: 'id 없음', productPrice: 1000 },
  ]));
  assert.deepEqual(r.map((x) => x.price), [null, null, null, 12300, null]);
  assert.equal(r[3].image, null);             // https 가 아니면 쓰지 않음
  assert.equal(r.length, 5);                  // productId 없는 항목은 버림
  for (const x of r) { assert.ok(!('soldOut' in x) && !('inStock' in x)); }
});

test('매핑: 오류 응답/형식 불일치는 던진다', () => {
  assert.throws(() => C.mapSearchResponse({ rCode: '400', rMessage: 'bad' }), (e) => e.code === 'api_error');
  assert.throws(() => C.mapSearchResponse({ rCode: '0', data: {} }), (e) => e.code === 'bad_response');
  assert.throws(() => C.mapSearchResponse(null), (e) => e.code === 'bad_response');
  assert.deepEqual(C.mapSearchResponse(okBody([])), []);  // 빈 결과는 오류가 아님
});

// ---------- 정확 일치 ----------
test('식별자 파싱', () => {
  assert.deepEqual(C.parseCoupangIds('https://www.coupang.com/vp/products/7505545386?itemId=19655683827&vendorItemId=88354162553&sourceType=x'),
    { productId: '7505545386', itemId: '19655683827', vendorItemId: '88354162553' });
  assert.deepEqual(C.parseCoupangIds('not a url'), { productId: null, itemId: null, vendorItemId: null });
});

test('정확 일치: 상품ID와 옵션이 모두 같을 때만 ok', () => {
  const api = { productId: '100', url: 'https://www.coupang.com/vp/products/100?itemId=11&vendorItemId=22' };
  assert.equal(C.matchExact({ productId: '100', itemId: '11', vendorItemId: '22' }, api).ok, true);
  assert.equal(C.matchExact({ productId: '100', itemId: '11' }, api).ok, true);
  assert.equal(C.matchExact({ productId: '101', itemId: '11' }, api).reason, 'product_id_mismatch');
  assert.equal(C.matchExact({ productId: '100', itemId: '99' }, api).reason, 'item_id_mismatch');
  assert.equal(C.matchExact({ productId: '100', itemId: '11', vendorItemId: '99' }, api).reason, 'vendor_item_id_mismatch');
  assert.equal(C.matchExact({ productId: '100' }, api).reason, 'option_not_stored');            // 옵션 미저장 → 갱신 안 함
  assert.equal(C.matchExact({ productId: '100', itemId: '11' }, { productId: '100', url: 'https://www.coupang.com/vp/products/100' }).reason, 'option_not_in_api_url');
  assert.equal(C.matchExact(null, api).ok, false);
});

// ---------- 호출 한도 ----------
test('호출 한도: 예산을 넘기면 쿠팡을 호출하지 않는다', async () => {
  let t = 1_000_000;
  const store = C.createMemoryUsageStore();
  const guard = C.createUsageGuard(store, { hourlyBudget: 3, now: () => t });
  await guard.reserve('search'); await guard.reserve('search'); await guard.reserve('search');
  await assert.rejects(() => guard.reserve('search'), (e) => e.code === 'rate_limited');
  t += 61 * 60 * 1000;                                         // 1시간 지나면 다시 가능
  await guard.reserve('search');
  assert.equal(store._calls.length, 4);
});

test('호출 한도: 한 번에 여러 건 예약도 한도를 넘으면 전부 거절(일부만 기록하지 않음)', async () => {
  const store = C.createMemoryUsageStore();
  const guard = C.createUsageGuard(store, { hourlyBudget: 2 });
  await assert.rejects(() => guard.reserve('search', 3), (e) => e.code === 'rate_limited');
  assert.equal(store._calls.length, 0);
});

// ---------- 클라이언트 ----------
const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

test('클라이언트: 요청 URL·헤더, 시크릿이 URL/본문에 없음', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return jsonRes(200, okBody([{ productId: 1, productName: 'a', productPrice: 1000 }])); };
  const c = C.createClient({ accessKey: ACCESS, secretKey: SECRET, fetchImpl, now: () => FIXED });
  const r = await c.searchProducts('돌잔치 선물', { limit: 50, subId: 'situation_dol' });
  assert.equal(r.items.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.origin, 'https://api-gateway.coupang.com');
  assert.equal(u.pathname, C.SEARCH_PATH);
  assert.equal(u.searchParams.get('keyword'), '돌잔치 선물');
  assert.equal(u.searchParams.get('limit'), '10');            // 상한으로 줄임
  assert.equal(u.searchParams.get('subId'), 'situation_dol');
  assert.match(calls[0].init.headers.Authorization, /^CEA algorithm=HmacSHA256, access-key=TEST_ACCESS_KEY_1234, signed-date=261001T030405Z, signature=[0-9a-f]{64}$/);
  assert.ok(!calls[0].url.includes(SECRET) && !String(calls[0].init.body || '').includes(SECRET));
});

test('클라이언트: 서명 대상 query 가 실제 요청 query 와 같다', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, auth: init.headers.Authorization }; return jsonRes(200, okBody([])); };
  const c = C.createClient({ accessKey: ACCESS, secretKey: SECRET, fetchImpl, now: () => FIXED });
  await c.searchProducts('수건 세트', { limit: 5 });
  const query = new URL(seen.url).search.slice(1);
  const sig = crypto.createHmac('sha256', SECRET).update('261001T030405Z' + 'GET' + C.SEARCH_PATH + query).digest('hex');
  assert.ok(seen.auth.endsWith('signature=' + sig));
});

test('클라이언트: 403/429 는 blocked 로 기록하고 이후 호출을 막는다', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return jsonRes(403, { message: 'rate limit' }); };
  const store = C.createMemoryUsageStore();
  const guard = C.createUsageGuard(store, { hourlyBudget: 8 });
  const c = C.createClient({ accessKey: ACCESS, secretKey: SECRET, fetchImpl, guard });
  await assert.rejects(() => c.searchProducts('돌잔치 선물'), (e) => e.code === 'blocked');
  await assert.rejects(() => c.searchProducts('집들이 선물'), (e) => e.code === 'blocked');
  assert.equal(n, 1, '차단 이후에는 쿠팡을 다시 호출하지 않아야 한다');
});

test('클라이언트: 5xx / 연결 실패 / JSON 아님', async () => {
  const mk = (fetchImpl) => C.createClient({ accessKey: ACCESS, secretKey: SECRET, fetchImpl });
  await assert.rejects(() => mk(async () => jsonRes(500, {})).searchProducts('수건 세트'), (e) => e.code === 'http_error' && e.status === 500);
  await assert.rejects(() => mk(async () => { throw new TypeError('network'); }).searchProducts('수건 세트'), (e) => e.code === 'http_error');
  await assert.rejects(() => mk(async () => ({ ok: true, status: 200, json: async () => { throw new Error('x'); } })).searchProducts('수건 세트'), (e) => e.code === 'bad_response');
});

test('클라이언트: 타임아웃', async () => {
  const fetchImpl = (url, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); }); });
  const c = C.createClient({ accessKey: ACCESS, secretKey: SECRET, fetchImpl, timeoutMs: 30 });
  await assert.rejects(() => c.searchProducts('수건 세트'), (e) => e.code === 'timeout');
});

test('클라이언트: 키 없이 호출하면 keys_missing, 네트워크는 타지 않는다', async () => {
  let n = 0;
  const c = C.createClient({ accessKey: '', secretKey: '', fetchImpl: async () => { n++; return jsonRes(200, okBody([])); } });
  await assert.rejects(() => c.searchProducts('수건 세트'), (e) => e.code === 'keys_missing');
  assert.equal(n, 0);
});

test('클라이언트: 캐시 적중 시 쿠팡 호출도 호출 예산 소모도 없다', async () => {
  let n = 0;
  const fetchImpl = async () => { n++; return jsonRes(200, okBody([{ productId: 1, productName: 'a', productPrice: 1000 }])); };
  const store = C.createMemoryUsageStore();
  const c = C.createClient({ accessKey: ACCESS, secretKey: SECRET, fetchImpl, guard: C.createUsageGuard(store, { hourlyBudget: 8 }), cache: C.createTtlCache(60_000) });
  const a = await c.searchProducts('수건 세트'); const b = await c.searchProducts('수건   세트');
  assert.equal(a.fromCache, false); assert.equal(b.fromCache, true);
  assert.equal(n, 1); assert.equal(store._calls.length, 1);
});

test('TTL 캐시: 만료', () => {
  let t = 0; const cache = C.createTtlCache(1000, () => t);
  cache.set('k', 1); assert.equal(cache.get('k'), 1);
  t = 1001; assert.equal(cache.get('k'), undefined);
});

// ---------- 갱신(refresh) ----------
const prod = (o) => Object.assign({ id: 'p1', name: '핸드블렌더 세트', reviewState: 'approved', coupangProductId: '100', coupangItemId: '11', coupangVendorItemId: '22', priceCheckedAt: null }, o);
const apiItem = (o) => Object.assign({ productId: '100', name: 'x', price: 55000, image: 'https://img.example/p.jpg', url: 'https://www.coupang.com/vp/products/100?itemId=11&vendorItemId=22' }, o);
const fakeClient = (items, err, fetchedAt) => ({ calls: 0, async searchProducts() { this.calls++; if (err) throw err; return { items, fromCache: false, fetchedAt }; } });
const NOW = () => new Date('2026-10-01T00:00:00Z');

test('갱신: 정확히 일치하면 가격·이미지·가격확인일을 갱신', async () => {
  const r = await refreshProducts({ products: [prod()], client: fakeClient([apiItem()]), now: NOW, dryRun: false });
  assert.equal(r.results[0].outcome, 'updated');
  assert.deepEqual(r.results[0].patch, { price: 55000, imageUrl: 'https://img.example/p.jpg', priceCheckedAt: '2026-10-01T00:00:00.000Z' });
});

test('갱신: 이름이 비슷해도 상품ID가 다르면 연결하지 않는다 / 결과에 없어도 품절로 보지 않는다', async () => {
  let r = await refreshProducts({ products: [prod()], client: fakeClient([apiItem({ productId: '999', name: '핸드블렌더 세트' })]), now: NOW });
  assert.equal(r.results[0].outcome, 'not_found'); assert.equal(r.results[0].patch, null);
  r = await refreshProducts({ products: [prod()], client: fakeClient([]), now: NOW });
  assert.equal(r.results[0].outcome, 'not_found');
  assert.ok(!JSON.stringify(r).match(/sold|품절|stock/i));
});

test('갱신: 같은 상품이어도 옵션이 다르면 갱신하지 않는다', async () => {
  const r = await refreshProducts({ products: [prod()], client: fakeClient([apiItem({ url: 'https://www.coupang.com/vp/products/100?itemId=99&vendorItemId=22' })]), now: NOW });
  assert.equal(r.results[0].outcome, 'option_mismatch'); assert.equal(r.results[0].reason, 'item_id_mismatch'); assert.equal(r.results[0].patch, null);
});

// [동작 변경] 이전: 옵션 ID 가 없으면 쿠팡을 호출한 뒤 option_not_stored 로 거절 → 이제: 호출 전에 제외하고 "보완 필요"로 센다.
test('갱신: 옵션 ID 가 저장돼 있지 않으면 쿠팡을 호출하지 않고 보완 필요로 분류', async () => {
  const client = fakeClient([apiItem()]);
  const r = await refreshProducts({ products: [prod({ coupangItemId: null, coupangVendorItemId: null })], client, now: NOW, dryRun: false });
  assert.equal(client.calls, 0, '호출 예산을 쓰면 안 된다');
  assert.equal(r.results.length, 0);
  assert.deepEqual(r.plan.needsFix, [{ id: 'p1', detail: 'no_option_id' }]);
});

test('갱신: 가격이 비정상(null)이면 가격·가격확인일을 건드리지 않는다(이미지만 갱신)', async () => {
  const r = await refreshProducts({ products: [prod()], client: fakeClient([apiItem({ price: null })]), now: NOW, dryRun: false });
  assert.equal(r.results[0].outcome, 'updated');
  assert.deepEqual(r.results[0].patch, { imageUrl: 'https://img.example/p.jpg' });
  const r2 = await refreshProducts({ products: [prod()], client: fakeClient([apiItem({ price: null, image: null })]), now: NOW, dryRun: false });
  assert.equal(r2.results[0].outcome, 'skipped'); assert.equal(r2.results[0].patch, null);
});

test('갱신: 오류가 나면 즉시 멈추고 남은 상품은 건드리지 않는다', async () => {
  const client = fakeClient([], new C.CoupangError('rate_limited', 'x'));
  const r = await refreshProducts({ products: [prod({ id: 'a' }), prod({ id: 'b' }), prod({ id: 'c' })], client, maxCalls: 3, now: NOW });
  assert.equal(client.calls, 1);
  assert.equal(r.stopped.code, 'rate_limited');
  assert.equal(r.results.length, 1); assert.equal(r.results[0].patch, null);
});

test('갱신 대상: 승인 + 쿠팡ID 있음 + 확인일 오래된 순, 최대 개수', () => {
  const list = [
    prod({ id: 'new', priceCheckedAt: '2026-09-30T00:00:00Z' }),
    prod({ id: 'never', priceCheckedAt: null }),
    prod({ id: 'old', priceCheckedAt: '2026-09-01T00:00:00Z' }),
    prod({ id: 'draft', reviewState: 'draft' }),
    prod({ id: 'noid', coupangProductId: null }),
  ];
  assert.deepEqual(pickRefreshTargets(list, 2).map((p) => p.id), ['never', 'old']);
  assert.deepEqual(pickRefreshTargets(list, 0), []);
});

test('갱신: 가격 확인 시각은 응답을 받은 시각(캐시 적중이어도 당시 시각)이다', async () => {
  const r = await refreshProducts({ products: [prod()], client: fakeClient([apiItem()], null, '2026-09-30T23:30:00.000Z'), now: NOW, dryRun: false });
  assert.equal(r.results[0].patch.priceCheckedAt, '2026-09-30T23:30:00.000Z');
});

test('클라이언트: 캐시 적중 시 fetchedAt 은 최초 응답 시각 그대로', async () => {
  let clock = new Date('2026-10-01T00:00:00Z');
  const fetchImpl = async () => jsonRes(200, okBody([{ productId: 1, productName: 'a', productPrice: 1000 }]));
  const c = C.createClient({ accessKey: ACCESS, secretKey: SECRET, fetchImpl, cache: C.createTtlCache(3_600_000), now: () => clock });
  const a = await c.searchProducts('수건 세트');
  clock = new Date('2026-10-01T00:20:00Z');
  const b = await c.searchProducts('수건 세트');
  assert.equal(a.fetchedAt, '2026-10-01T00:00:00.000Z');
  assert.equal(b.fromCache, true); assert.equal(b.fetchedAt, '2026-10-01T00:00:00.000Z');
});

// ================= 갱신 대상 선정 (실패 상품 반복 선택 방지) =================
import { planRefresh, classifyForRefresh, backoffMs, FAILURE_BACKOFF_BASE_MS, SUCCESS_MIN_INTERVAL_MS } from '../api/_lib/refresh.js';
const H = 3600 * 1000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
const at = (hoursAgo) => new Date(T0 - hoursAgo * H).toISOString();

test('재시도 간격: 실패 횟수에 따라 늘어나고 상한이 있다', () => {
  assert.equal(backoffMs(0), FAILURE_BACKOFF_BASE_MS);
  assert.equal(backoffMs(1), 6 * H);
  assert.equal(backoffMs(2), 12 * H);
  assert.equal(backoffMs(3), 24 * H);
  assert.equal(backoffMs(99), 72 * H);
});

test('분류: 최근 실패는 대기, 대기 시간이 지나면 다시 대상, 성공 직후는 건너뜀', () => {
  const fail = (h, n) => prod({ lastRefreshAt: at(h), lastRefreshStatus: 'not_found:not_in_search_results', refreshFailures: n });
  assert.equal(classifyForRefresh(fail(1, 1), T0).reason, 'cooldown');
  assert.equal(classifyForRefresh(fail(7, 1), T0).eligible, true);        // 6시간 지남
  assert.equal(classifyForRefresh(fail(7, 2), T0).reason, 'cooldown');    // 2회 실패는 12시간
  assert.equal(classifyForRefresh(fail(13, 2), T0).eligible, true);
  assert.equal(classifyForRefresh(prod({ lastRefreshAt: at(1), lastRefreshStatus: 'updated' }), T0).reason, 'recently_checked');
  assert.equal(classifyForRefresh(prod({ lastRefreshAt: at(1), lastRefreshStatus: 'checked' }), T0).reason, 'recently_checked');
  assert.equal(classifyForRefresh(prod({ lastRefreshAt: at(SUCCESS_MIN_INTERVAL_MS / H + 1), lastRefreshStatus: 'updated' }), T0).eligible, true);
  assert.equal(classifyForRefresh(prod({ reviewState: 'draft' }), T0).reason, 'not_approved');
});

test('선정: 계속 실패하는 상품이 매번 먼저 뽑혀 다른 상품을 밀어내지 않는다', () => {
  // 예전 정렬(가격 확인일 오름차순)에서는 priceCheckedAt 이 null 인 실패 상품 A 가 항상 맨 앞이었다.
  const A = prod({ id: 'A', priceCheckedAt: null, lastRefreshAt: at(2), lastRefreshStatus: 'not_found:x', refreshFailures: 1 });
  const B = prod({ id: 'B', priceCheckedAt: '2026-09-20T00:00:00Z' });
  const C = prod({ id: 'C', priceCheckedAt: '2026-09-25T00:00:00Z' });
  assert.deepEqual(planRefresh([A, B, C], 1, T0).targets.map((p) => p.id), ['B']);   // A 는 대기 중이라 B 에게 기회가 간다
  assert.deepEqual(planRefresh([A, B, C], 1, T0).cooling, ['A']);
  // 대기가 끝난 뒤에는 A 도 돌아오지만, 한 번도 시도하지 않은 상품이 먼저다
  const later = T0 + 7 * H;
  assert.deepEqual(planRefresh([A, B, C], 3, later).targets.map((p) => p.id), ['B', 'C', 'A']);
});

test('선정: 시도한 적 없는 상품 → 마지막 시도가 오래된 상품 순, 동률이면 결정적', () => {
  const l = [
    prod({ id: 'n2', lastRefreshAt: null }), prod({ id: 'n1', lastRefreshAt: null }),
    prod({ id: 'old', lastRefreshAt: at(30), lastRefreshStatus: 'updated' }), prod({ id: 'mid', lastRefreshAt: at(20), lastRefreshStatus: 'updated' }),
  ];
  assert.deepEqual(planRefresh(l, 10, T0).targets.map((p) => p.id), ['n1', 'n2', 'old', 'mid']);
});

test('선정: 쿠팡 상품 ID·옵션 ID 가 없는 승인 상품은 호출 전에 제외하고 보완 필요로 알린다', () => {
  const l = [prod({ id: 'ok' }), prod({ id: 'noprod', coupangProductId: null }), prod({ id: 'noopt', coupangItemId: null, coupangVendorItemId: null }), prod({ id: 'vendoronly', coupangItemId: null })];
  const plan = planRefresh(l, 10, T0);
  assert.deepEqual(plan.targets.map((p) => p.id).sort(), ['ok', 'vendoronly']);   // 옵션 식별자 중 하나라도 있으면 대상
  assert.deepEqual(plan.needsFix.map((x) => x.id).sort(), ['noopt', 'noprod']);
});

test('갱신 실행: 대기 중·보완 필요 상품에는 호출이 나가지 않는다', async () => {
  const client = fakeClient([apiItem()]);
  const l = [
    prod({ id: 'cool', lastRefreshAt: new Date(T0 - 1 * H).toISOString(), lastRefreshStatus: 'option_mismatch:item_id_mismatch', refreshFailures: 1 }),
    prod({ id: 'fix', coupangItemId: null, coupangVendorItemId: null }),
    prod({ id: 'go' }),
  ];
  const r = await refreshProducts({ products: l, client, maxCalls: 5, now: () => new Date(T0) });
  assert.equal(client.calls, 1);
  assert.deepEqual(r.results.map((x) => x.id), ['go']);
  assert.equal(r.plan.cooling.length, 1); assert.equal(r.plan.needsFix.length, 1);
});

test('갱신: 검색 결과 없음·옵션 불일치는 실패로만 기록하고 품절·가격 변경으로 쓰지 않는다', async () => {
  for (const items of [[], [apiItem({ url: 'https://www.coupang.com/vp/products/100?itemId=99&vendorItemId=22' })]]) {
    const r = await refreshProducts({ products: [prod()], client: fakeClient(items), now: NOW, dryRun: false });
    assert.equal(r.results[0].patch, null);
    assert.ok(['not_found', 'option_mismatch'].includes(r.results[0].outcome));
    assert.ok(!/sold|soldout|품절|stock|price/i.test(JSON.stringify(r.results[0])));
  }
});

test('갱신: 호출 한도·차단 같은 시스템 오류는 상품의 실패로 기록하지 않는다(attribute:false)', async () => {
  const client = fakeClient([], new C.CoupangError('blocked', 'x'));
  const r = await refreshProducts({ products: [prod({ id: 'a' }), prod({ id: 'b' })], client, maxCalls: 2, now: () => new Date(T0) });
  assert.equal(client.calls, 1);
  assert.equal(r.results[0].attribute, false);
  assert.equal(r.stopped.code, 'blocked');
});

test('갱신: 기본(dryRun)은 일치 여부만 확인하고 가격·이미지를 쓰지 않는다', async () => {
  const r = await refreshProducts({ products: [prod()], client: fakeClient([apiItem()]), now: NOW });
  assert.equal(r.results[0].outcome, 'checked');
  assert.equal(r.results[0].patch, null);
  assert.equal(r.results[0].observed.price, 55000);
});

// ================= 검색 경로 설정 / 식별자 형식 / 검증 도구 =================
import { summarizeSearchResponse, describeUrl } from '../tools/verify-coupang.mjs';

test('검색 경로: 기본값과 허용된 두 형태만, 임의 경로는 거부', () => {
  assert.equal(C.resolveSearchPath({}), C.SEARCH_PATH);
  assert.equal(C.resolveSearchPath({ COUPANG_PARTNERS_SEARCH_PATH: C.SEARCH_PATH_V1 }), C.SEARCH_PATH_V1);
  assert.throws(() => C.resolveSearchPath({ COUPANG_PARTNERS_SEARCH_PATH: '/v2/providers/seller_api/apis/api/v1/marketplace/seller-products' }), (e) => e.code === 'invalid_input');
  assert.throws(() => C.resolveSearchPath({ COUPANG_PARTNERS_SEARCH_PATH: 'https://evil.example/x' }), (e) => e.code === 'invalid_input');
});

test('클라이언트: searchPath 로 고른 경로로 요청하고 그 경로로 서명한다', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, auth: init.headers.Authorization }; return jsonRes(200, okBody([])); };
  const c = C.createClient({ accessKey: ACCESS, secretKey: SECRET, fetchImpl, now: () => FIXED, searchPath: C.SEARCH_PATH_V1 });
  await c.searchProducts('수건 세트', { limit: 5 });
  const u = new URL(seen.url);
  assert.equal(u.pathname, C.SEARCH_PATH_V1);
  const sig = crypto.createHmac('sha256', SECRET).update('261001T030405Z' + 'GET' + C.SEARCH_PATH_V1 + u.search.slice(1)).digest('hex');
  assert.ok(seen.auth.endsWith('signature=' + sig));
});

test('식별자: link.coupang.com 형식(pageKey=상품 ID)도 읽는다 — 어느 형식이 실제로 오는지는 실제 호출로 확인 필요', () => {
  assert.deepEqual(C.parseCoupangIds('https://link.coupang.com/re/AFFSDP?lptag=AF1&pageKey=319834306&itemId=1023216541&vendorItemId=70064597513&traceid=V0'),
    { productId: '319834306', itemId: '1023216541', vendorItemId: '70064597513' });
  // 옵션이 URL 에 없으면 정확 일치 갱신이 거절된다(안전한 쪽)
  assert.equal(C.matchExact({ productId: '319834306', itemId: '1' }, { productId: '319834306', url: 'https://link.coupang.com/re/AFFSDP?pageKey=319834306' }).reason, 'option_not_in_api_url');
});

test('검증 도구: 응답 구조만 요약하고 제휴 태그·키 값은 내보내지 않는다', () => {
  const json = { rCode: '0', data: { productData: [
    { productId: 1, productName: 'a', productPrice: 1000, productUrl: 'https://link.coupang.com/re/AFFSDP?lptag=AF999SECRETTAG&pageKey=12345678&itemId=11&vendorItemId=22&traceid=TRACE123' },
    { productId: 2, productName: 'b', productPrice: 2000, productUrl: 'https://link.coupang.com/re/AFFSDP?lptag=AF999SECRETTAG&pageKey=87654321' },
  ] } };
  const s = summarizeSearchResponse(json);
  const text = JSON.stringify(s);
  assert.equal(s.itemCount, 2); assert.equal(s.identifiers.withAnyOptionIdInUrl, 1);
  assert.match(s.verdict, /일부 항목만 옵션 식별자/);
  for (const leak of ['AF999SECRETTAG', 'TRACE123', '12345678']) assert.ok(!text.includes(leak), leak + ' 노출');
  assert.ok(text.includes('lptag(값 숨김)'));
  assert.match(summarizeSearchResponse({ rCode: '0', data: { productData: [{ productId: 1, productPrice: 5, productUrl: 'https://www.coupang.com/vp/products/1' }] } }).verdict, /가격 자동 갱신을 켜지 마세요/);
  assert.deepEqual(describeUrl('not a url'), null);
});

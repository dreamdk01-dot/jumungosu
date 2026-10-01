import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

function loadSearch() {
  const mod = { exports: {} };
  new Function('module', fs.readFileSync(path.join(ROOT, 'situation-search.js'), 'utf8'))(mod);
  return mod.exports;
}
const S = loadSearch();

// ---- 기존 기능 보존: seo-shopping.js 가 app.html 에서 읽는 상품 배열은 한 글자도 바뀌면 안 된다 ----
test('AUTUMN_GIFT_PRODUCTS 배열 블록이 baseline 과 동일(seo-shopping.js 파싱 형식 보존)', () => {
  const m = html.match(/const AUTUMN_GIFT_PRODUCTS = \[\n([\s\S]*?)\n {2}\];/);
  assert.ok(m, '배열을 못 찾음');
  assert.equal(crypto.createHash('md5').update(m[1]).digest('hex'), '26cca5b7e627d0669c0f730130d209dd');
});

test('seo-shopping.js 의 실제 파서로 baseline 과 같은 결과(188건, 중복 제거 186건)', async () => {
  const prev = process.cwd();
  process.chdir(ROOT);                       // 파서가 process.cwd()/app.html 을 읽는다
  try {
    const mod = await import('../api/seo-shopping.js');
    const list = mod.parseProducts();
    assert.equal(list.length, 188);
    assert.equal(mod.dedupeByNameUrl(list).length, 186);
    assert.equal(list[list.length - 1].name, '도깨비방망이 핸드블렌더 세트');
  } finally { process.chdir(prev); }
});

// 참고: home.js 가 문자열로 찾는 앵커 7개 중 5개(best3-list-mobile, best3-list, best3-updated-badge, today-brand-links,
// today-brand-links-section)는 업로드된 원본 app.html 에도 이미 정확히 일치하지 않았다(home.js 는 못 찾으면 조용히
// 건너뜀). 이 작업과 무관한 기존 상태이므로 여기서는 "원본에서 일치하던 것"만 그대로 남아 있는지 확인한다.
// README '알려진 문제' 참고.
test('home.js 앵커 중 원본에서 일치하던 것은 그대로 남아 있다', () => {
  for (const anchor of [
    '<div id="discount-list" class="grid sm:grid-cols-2 gap-4"></div>',
    '<span id="result-count">0</span>',
  ]) assert.ok(html.includes(anchor), '앵커 없음: ' + anchor);
  assert.match(html, /<p\b[^>]*\bid="discount-list-updated"[^>]*><\/p>/);
});

test('기존 라우팅·화면 요소가 남아 있다', () => {
  for (const id of ['page-shopping', 'shopping-view-intro', 'shopping-view-chuseok', 'shopping-chuseok-body', 'page-shopping-intro-title', 'page-hotdeals', 'hotdeals-filter-root', 'page-admin', 'page-home']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  assert.ok(html.includes('function enterShoppingChuseok()'));
  assert.ok(html.includes('function hotdealsAffiliateDisclosureHtml()'));
  assert.ok(html.includes("trackFunnelEvent('partner_click'"));            // 기존 핫딜 클릭 추적
  assert.ok(html.includes("const PAGES = ['home', 'board', 'auth', 'admin', 'about', 'membership', 'privacy', 'terms', 'partner', 'shopping', 'hotdeals'];"));
});

// ---- 새 화면 ----
test('쇼핑 첫 화면 문구·검색 예시·상황 버튼 6개(모듈의 상황 목록과 일치)', () => {
  assert.ok(html.includes('어떤 상황에 필요한 물건을 찾으세요?'));
  assert.ok(html.includes('placeholder="예) 친구 아이 돌잔치 선물, 5만원 이하"'));
  assert.equal(S.SITUATIONS.length, 6);
  const intro = html.slice(html.indexOf('id="shopping-view-intro"'), html.indexOf('id="shopping-view-chuseok"'));
  for (const s of S.SITUATIONS) {
    assert.ok(intro.includes(`onclick="pickSituation('${s.id}')"`), s.id);
    assert.ok(intro.includes(`>${s.label}<`), s.label);
  }
  assert.equal((intro.match(/onclick="pickSituation\(/g) || []).length, 6);
  assert.ok(!intro.includes('준비 중)'), '옛 "(준비 중)" 문구가 남아 있음');
  assert.ok(!intro.includes('추석 선물 찾기'));
});

test('검색 모듈 스크립트가 컨트롤러보다 먼저 로드된다', () => {
  const a = html.indexOf('<script src="/situation-search.js');
  const b = html.indexOf('function loadSituationProducts');
  assert.ok(a > 0 && b > a);
});

test('이전 화면 문구가 SEO·본문에 과장 없이 바뀌었다', () => {
  assert.ok(!html.includes('맞춤 쇼핑 (준비 중) - 조건에 맞는 선물 찾기'));
  assert.ok(html.includes('직접 검토한 상품만 보여드립니다'));
  assert.ok(!/AI\s*(가|로)?\s*(추천|분석)/.test(html.slice(html.indexOf('id="shopping-view-intro"'), html.indexOf('id="shopping-view-chuseok"'))), 'AI 추천처럼 보이는 문구 금지');
});

test('공개 플래그는 꺼져 있고(기본), 켜지기 전엔 상단 메뉴가 기존대로 쇼핑핫딜로 간다', () => {
  assert.match(html, /const SITUATION_SHOPPING_PUBLIC = false;/);
  assert.match(html, /function shoppingNavTab\(\)\{ return SITUATION_SHOPPING_PUBLIC \? 'shopping' : 'hotdeals'; \}/);
  assert.ok(html.includes('id="tab-shopping-dropdown-btn" onclick="switchTab(shoppingNavTab())"'));
});

test('쿠팡 파트너스 고지·제휴 링크 속성이 새 화면에도 적용된다', () => {
  const ctrl = html.slice(html.indexOf('function sitProductCardHtml'), html.indexOf('function sitSummaryHtml'));
  assert.ok(ctrl.includes('rel="noopener sponsored"'));
  assert.ok(ctrl.includes('target="_blank"'));
  assert.ok(html.includes('function sitDisclosureHtml()'));
  assert.ok(/이 포스팅은 쿠팡 파트너스 활동의 일환으로/.test(html));
});

test('추적: 원문 검색어를 서버로 보내지 않는다 / 상황 선택·결과 없음·상품 클릭을 구분한다', () => {
  const ctrl = html.slice(html.indexOf('// ---- 추적'), html.indexOf('// ---- URL 상태'));
  for (const ev of ['situation_select', 'situation_no_result', 'situation_product_click']) assert.ok(ctrl.includes(`'${ev}'`), ev);
  assert.ok(ctrl.includes("trackFunnelEvent('partner_click'"));
  // 추적 블록 안에서 입력창 값/원문을 참조하지 않는다
  assert.ok(!/situation-input|\.value|rawText|query\b/.test(ctrl));
  // 컨트롤러 전체에서도 입력 원문은 submitSituationSearch 안에서만 읽고 추적 함수로 넘기지 않는다
  const submit = html.slice(html.indexOf('function submitSituationSearch'), html.indexOf('function pickSituation'));
  assert.ok(!/sitTrack|trackFunnelEvent/.test(submit));
});

test('렌더링 입력은 이스케이프하고, 링크·이미지는 https 만 허용', () => {
  const card = html.slice(html.indexOf('function sitProductCardHtml'), html.indexOf('function sitSummaryHtml'));
  for (const field of ['p.name', 'p.reason', 'p.caution', 'p.affiliateUrl']) {
    assert.ok(new RegExp('escapeHtml\\(' + field.replace('.', '\\.') + '\\)').test(card), field + ' 이스케이프 누락');
  }
  assert.ok(card.includes('sitSafeHttps(p.imageUrl)'));
  assert.match(html, /p\.affiliateUrl\.indexOf\('https:\/\/'\) === 0/);
});

test('가짜 데이터 금지: 컨트롤러에 예시 상품·가짜 가격/리뷰 상수가 없다', () => {
  const ctrl = html.slice(html.indexOf('// ================= 상황별 쇼핑 (2026-10)'), html.indexOf('// ================= 맞춤 쇼핑 (추석 V1)'));
  assert.ok(!/price:\s*\d{3,}/.test(ctrl.replace(/SIT_BUDGET_PRESETS[\s\S]*?\];/, '')), '하드코딩된 상품 가격');
  assert.ok(!/리뷰\s*\d+개/.test(ctrl.replace(/'리뷰 '/g, '')));
});

test('관리자 패널: 마스터만 저장, 매니저는 조회만', () => {
  const adm = html.slice(html.indexOf('// ================= 관리자: 상황별 쇼핑 상품 검토'), html.indexOf('// ================= 맞춤 쇼핑 (추석 V1)'));
  assert.ok(/async function adminSitSave\(\)\{\s*if \(!isAdminUser\(\)\) return;/.test(adm));
  assert.ok(/async function adminSitRefresh\(\)\{\s*if \(!isAdminUser\(\)\) return;/.test(adm));
  assert.ok(adm.includes("admin_list_situation_products") && adm.includes("admin_save_situation_product") && adm.includes("admin_get_situation_stats"));
  assert.ok(html.includes('adminSitLoad();               // 상황별 쇼핑 상품 검토'));
});

test('이 작업이 만든 파일 어디에도 비밀값 형태 문자열이 없다', () => {
  const files = ['situation-search.js', 'api/_lib/coupang-partners.js', 'api/_lib/refresh.js', 'api/_lib/supabase-rest.js', 'api/situation-products.js', 'api/coupang-refresh.js', 'supabase/migrations/20261001000000_situation_products.sql']
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\./.test(files), 'JWT 형태 문자열');
  assert.ok(!/(secret|access)[_-]?key\s*[:=]\s*['"][A-Za-z0-9+/=_-]{16,}['"]/i.test(files), '키 하드코딩');
  assert.ok(!/service_role\s*[:=]\s*['"][^'"]{20,}['"]/.test(files));
  // 브라우저로 내려가는 app.html 에 서버 전용 환경변수 이름이 노출되지 않는다
  assert.ok(!/COUPANG_PARTNERS_(ACCESS|SECRET)_KEY|SUPABASE_SERVICE_ROLE_KEY/.test(html));
});

// ================= 2차 보완: 상품평 검토 / 돌잔치 구분 / 문서 정확성 =================
const adminBlock = () => html.slice(html.indexOf('// ================= 관리자: 상황별 쇼핑 상품 검토'), html.indexOf('// ================= 맞춤 쇼핑 (추석 V1)'));
const readText = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('관리자 화면: 상품평 검토 기록 입력란과 승인 검증(검토일·읽은 수·근거·돌잔치 구분·카테고리 기준)', () => {
  const adm = adminBlock();
  for (const id of ["'review-verified-date'", "'review-read-count'", "'review-basis'"]) assert.ok(adm.includes(id), id);
  for (const msg of ['승인하려면 상품평을 직접 읽고 검토한 기록', '검토 근거를 10자 이상', '돌잔치 상품은 참석 선물/답례품을 하나 이상 선택해야 승인']) assert.ok(adm.includes(msg), msg);
  assert.ok(adm.includes('adminSit.thresholds.filter(t => t.category === val(\'category\'))'));       // 카테고리 기준 사전 검사
  assert.ok(/review_verified_at: rvDate \|\| null, review_read_count: rvCount, review_basis: rvBasis \|\| null/.test(adm));
  assert.ok(!adm.includes('review_verified_by:'), '검토자는 서버가 채우므로 클라이언트가 보내지 않는다');
});

test('관리자 화면: 검토 근거를 시스템이 미리 채우거나 만들어 넣지 않는다', () => {
  const adm = adminBlock();
  // 입력란 초기값은 저장된 값(base.*)뿐이다
  assert.ok(adm.includes("adminSitField('review-basis', '검토 근거 (직접 확인한 내용을 본인 문장으로, 10자 이상)', base.review_basis,"));
  // 기존 쇼핑핫딜 불러오기는 검토 기록을 채우지 않는다
  const legacy = adm.slice(adm.indexOf('function adminSitImportLegacy'), adm.indexOf('async function adminSitSave'));
  assert.ok(!/review_verified|review_read_count|review_basis|rating|reviews/.test(legacy.replace("p.rating != null ? '평점 ' + p.rating : ''", '').replace("p.reviews != null ? '리뷰 ' + p.reviews : ''", '')), '불러오기가 검토 기록을 채움');
  // 자동 생성 문구 패턴 금지
  assert.ok(!/review_basis\s*[:=]\s*['"`][^'"`]{10,}/.test(adm), '검토 근거 하드코딩');
});

test('카테고리 기준 문구: 방문자 화면에서 검증된 기준으로 소개하지 않는다 / 기본 기준 없음', () => {
  const adm = adminBlock();
  assert.ok(adm.includes("방문자 화면에서는 '검증된 기준'으로 소개하지 않아요"));
  const card = html.slice(html.indexOf('function sitProductCardHtml'), html.indexOf('function sitSummaryHtml'));
  assert.ok(!/기준|threshold|min_rating|검증된/.test(card), '방문자 카드에 기준·검증 표현');
  // 기본 기준(시드) 금지: category_review_thresholds 에 넣는 insert 는 관리자 RPC 의 입력값(p ->> ...)만 쓴다. 리터럴 값 삽입 없음.
  const sql0 = readText('supabase/migrations/20261002000000_review_verification.sql').replace(/--.*$/gm, '');
  const inserts = [...sql0.matchAll(/insert into public\.category_review_thresholds[^;]*;/gi)].map((m) => m[0]);
  assert.equal(inserts.length, 1);
  assert.ok(/values \(btrim\(p ->> 'category'\)/.test(inserts[0]), '리터럴 값 삽입(기본 기준 시드)');
});

test('방문자 카드: 상품평 검토일 한 줄만, 읽은 수·근거는 노출하지 않는다', () => {
  const card = html.slice(html.indexOf('function sitProductCardHtml'), html.indexOf('function sitSummaryHtml'));
  assert.ok(card.includes('운영자가 상품평을 직접 읽고 확인'));
  assert.ok(!/review_basis|reviewBasis|readCount|review_read_count/.test(card));
  assert.ok(!/review_basis|review_read_count/.test(readText('api/situation-products.js').replace(/\/\/.*$/gm, '')), '공개 API 가 내부 검토 기록을 내려줌');
});

test('마이그레이션 2: 승인 조건·돌잔치 구분·기준 트리거·헬퍼 권한 회수가 들어 있다', () => {
  const sqlRaw = readText('supabase/migrations/20261002000000_review_verification.sql');
  const sql = sqlRaw.replace(/--.*$/gm, '');   // 주석 제외(주석에는 설명용으로 RETURNS TABLE 같은 말이 나온다)
  for (const frag of ['situation_products_review_verified_complete', 'situation_products_approved_requirements', 'review_verified_at is not null',
    'situation_products_dol_subtype_required', "'dol' = any (situations)", 'cardinality(subtypes) >= 1',
    'category_review_thresholds', 'situation_products_enforce_thresholds', 'refresh_failures',
    'revoke all on function public.is_site_admin() from public, anon, authenticated',
    'revoke all on function public.is_site_master() from public, anon, authenticated']) assert.ok(sql.includes(frag), frag);
  assert.ok(!/returns table/i.test(sql), 'RETURNS TABLE 사용 금지(별칭 충돌 방지)');
  // 모든 UPDATE/DELETE 대상에 별칭
  for (const m of sql.matchAll(/\b(update|delete from) public\.\w+(?: as (\w+))?/gi)) assert.ok(m[2], '별칭 없는 ' + m[0]);
});

test('DB 테스트(임시 Postgres): RUN_DB_TESTS=1 일 때만 실행', { skip: process.env.RUN_DB_TESTS !== '1' }, async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('bash', [path.join(ROOT, 'tools/db-test/run.sh')], { encoding: 'utf8' });
  assert.equal(r.status, 0, (r.stdout || '') + (r.stderr || ''));
  assert.ok(/DB 테스트 통과/.test(r.stdout));
});

test('문서 정확성: 공개 스위치는 app.html 상수이며 Vercel 환경변수가 아니다', () => {
  assert.match(html, /const SITUATION_SHOPPING_PUBLIC = false;/);
  assert.ok(!/process\.env\.SITUATION_SHOPPING_PUBLIC/.test(html + readText('api/situation-products.js') + readText('api/coupang-refresh.js')));
  assert.ok(!readText('.env.example').includes('SITUATION_SHOPPING_PUBLIC'), '.env.example 에 공개 스위치가 있으면 환경변수로 오해한다');
  for (const f of ['README.md', 'HANDOFF.md']) {
    const doc = readText(f);
    assert.ok(/JavaScript 상수|app\.html 안의 .*상수|app\.html.*상수/.test(doc), f + ': app.html 상수라는 설명 없음');
    assert.ok(doc.includes('환경변수가 아니'), f + ': 환경변수가 아니라는 명시 없음');
    // 환경변수 표/목록에 스위치를 넣은 줄이 없어야 한다
    assert.ok(!/^\s*[-|].*SITUATION_SHOPPING_PUBLIC.*(Settings|Environment Variables|환경변수로)/m.test(doc.replace(/환경변수가 아니/g, '')));
  }
});

test('문서 정확성: 쿠팡 API 검증 상태를 사실대로(공식 확인·실호출 없음 / 자료 간 모순 명시)', () => {
  const doc = readText('README.md') + readText('HANDOFF.md');
  assert.ok(doc.includes('공식 문서 확인') && doc.includes('실제 호출 성공') && doc.includes('모의 테스트'));
  assert.ok(doc.includes('자료마다 다름'));
  assert.ok(!/(공식 문서(로|를) 확인(했|완료)|실제 호출(에) 성공(했|완료)|검증 완료)/.test(doc.replace(/확인하지 못|확인되지|확인하세요|확인할/g, '')), '검증하지 않은 것을 검증했다고 씀');
});

// ================= Preview 500(FUNCTION_INVOCATION_FAILED) 재발 방지 =================
// 원인(재현): 이 프로젝트는 package.json 이 없어 Vercel 이 api/*.js 를 ESM→CommonJS 로 변환한다. 이때 .mjs 는 변환되지 않고 ESM 으로 남아,
// 변환된 CJS 함수가 require('./_lib/x.mjs') 를 하게 되는데 require(esm) 이 안 되는 런타임에서는 ERR_REQUIRE_ESM 으로 함수 로딩 단계에서 죽는다.
// 기존 운영 함수는 .js → .js(./seo.js)만 쓴다. 새 서버 모듈도 같은 방식(.js)으로 둔다.
test('api/ 아래에 .mjs 파일이 없고, 함수가 .mjs 를 import 하지 않는다', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(path.join(ROOT, 'api'));
  assert.deepEqual(files.filter((f) => f.endsWith('.mjs')), []);
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/['"`][^'"`\n]*\.mjs['"`]/.test(src), path.relative(ROOT, f) + ' 가 .mjs 를 참조');
  }
});

test('package.json 을 새로 만들지 않는다(운영은 package.json 없이 CJS 변환 방식으로 배포 중 — 추가하면 기존 함수의 빌드 방식이 바뀐다)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'package.json')));
});

test('모듈 로딩에 실패해도 함수가 죽지 않고 오류 코드가 담긴 JSON(500)을 돌려준다', async () => {
  const os = await import('node:os');
  for (const [file, extra] of [['situation-products.js', { method: 'GET', headers: {} }], ['coupang-refresh.js', { method: 'POST', headers: { authorization: 'Bearer x' } }]]) {
    // _lib 가 없는 임시 폴더에 함수만 복사해서 일부러 로딩을 실패시킨다
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnload-'));
    const dest = path.join(dir, file.replace(/\.js$/, '.mjs'));
    fs.copyFileSync(path.join(ROOT, 'api', file), dest);
    const mod = await import(dest);
    const prevFlag = process.env.COUPANG_REFRESH_ENABLED; process.env.COUPANG_REFRESH_ENABLED = 'true';
    const res = { code: 200, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    const origErr = console.error; console.error = () => {};
    try { await mod.default(extra, res); } finally { console.error = origErr; if (prevFlag === undefined) delete process.env.COUPANG_REFRESH_ENABLED; else process.env.COUPANG_REFRESH_ENABLED = prevFlag; }
    assert.equal(res.code, 500, file);
    assert.equal(res.body.error, 'module_load_failed', file);
    assert.ok(typeof res.body.code === 'string', file + ': 오류 코드가 JSON 에 있어야 한다');
    assert.ok(!/\/|\\/.test(JSON.stringify(res.body)), '서버 경로가 응답에 노출되면 안 된다');
  }
});

test('함수 파일에 서버 전용 모듈의 정적 import 가 남아 있지 않다(요청 시점 로딩)', () => {
  for (const f of ['api/situation-products.js', 'api/coupang-refresh.js']) {
    const src = readText(f);
    assert.ok(!/^import .* from '\.\/_lib\//m.test(src), f + ': 정적 import');
    assert.ok(/import\('\.\/_lib\//.test(src), f + ': 동적 import 없음');
  }
});

// 대표이미지(이니셜) 자동 표시 규칙 검증.
// 같은 규칙이 app.html(브라우저)과 api/seo.js(서버 렌더링)에 복사돼 있으므로, 두 구현의 코드가 같은지와 같은 표에서 같은 결과를 내는지를 본다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapRecord, brandInitialText, hasBadgeText } from '../api/seo.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const BEGIN = '// [BRAND_INITIALS_BEGIN]', END = '// [BRAND_INITIALS_END]';
const blockOf = (src) => src.slice(src.indexOf(BEGIN), src.indexOf(END) + END.length);
const normalizeIndent = (s) => s.split('\n').map((l) => l.trim()).join('\n');

const appSrc = read('app.html'), seoSrc = read('api/seo.js');
const appFns = new Function(blockOf(appSrc) + '\nreturn { brandInitialText, hasBadgeText };')();   // 브라우저용 구현
const seoFns = { brandInitialText, hasBadgeText };                                                 // 서버용 구현(실제 import)

// [입력(대표이미지, 브랜드명), 기대 표시, 설명]
const CASES = [
  // --- 요청 예시(대표이미지 비어 있음 → 브랜드명 앞 두 글자) ---
  [undefined, '바른치킨', '바른', '값 없음(키 자체가 없음) — 에어테이블이 빈 칸을 내려보내는 방식'],
  [null, '꾸브라꼬치킨', '꾸브', 'null'],
  ['', '반올림피자', '반올', '빈 문자열'],
  ['   ', '7번가피자', '7번', '일반 공백만'],
  ['\u3000\u3000', '기영이숯불두마리치킨', '기영', '전각 공백만'],
  [' \u3000 \t\n', '바른치킨', '바른', '일반·전각 공백·탭·줄바꿈 섞임'],
  ['\u200B\uFEFF', '바른치킨', '바른', '제로폭 문자·BOM 만'],
  // --- 기존 입력값은 그대로 ---
  ['바른', '바른치킨', '바른', '직접 입력(브랜드명 앞 두 글자와 같음)'],
  ['맛집', '바른치킨', '맛집', '직접 입력(브랜드명과 다른 문구)'],
  ['BH', 'BHC', 'BH', '직접 입력 영문(실제 데이터)'],
  ['KFC', 'KFC', 'KF', '세 글자 입력 → 기존처럼 앞 두 글자까지만'],
  [' 꾸브 ', '꾸브라꼬치킨', '꾸브', '입력값 앞뒤 공백 제거'],
  ['\u3000꾸브\u3000', '아무거나', '꾸브', '입력값 앞뒤 전각 공백 제거'],
  ['맛', '바른치킨', '맛', '입력값이 한 글자면 한 글자'],
  [7, '바른치킨', '7', '숫자 입력도 값으로 인정'],
  // --- 브랜드명 처리 ---
  [undefined, '  바른치킨  ', '바른', '브랜드명 앞뒤 공백 제거'],
  [undefined, '\u3000바른치킨\u3000', '바른', '브랜드명 앞뒤 전각 공백 제거'],
  [undefined, '반올림피자', '반올', ''],
  [undefined, '7번가피자', '7번', '숫자로 시작'],
  [undefined, '기영이숯불두마리치킨', '기영', ''],
  [undefined, '맘', '맘', '브랜드명이 한 글자면 한 글자'],
  [undefined, '', '?', '브랜드명도 없음'],
  [undefined, null, '?', '브랜드명 null'],
  [undefined, undefined, '?', '브랜드명 undefined'],
  [undefined, '   ', '?', '브랜드명이 공백뿐'],
  ['  ', '\u3000', '?', '둘 다 공백뿐'],
  [undefined, 'BBQ 치킨', 'BB', '영문'],
  // --- 보이는 글자 기준 ---
  [undefined, '🍕피자천국', '🍕피', '이모지는 한 글자(서로게이트 쌍을 쪼개지 않음)'],
  [undefined, '꾸브라꼬치킨'.normalize('NFD'), '꾸브', '자모 분리형(NFD) 한글을 합쳐서(NFC) 두 글자'],
  ['꾸브'.normalize('NFD'), '아무거나', '꾸브', '입력값이 NFD 여도 합쳐서 표시'],
  // --- 글자가 아닌 값은 값이 없는 것으로 ---
  [[{ url: 'https://example.invalid/a.png' }], '바른치킨', '바른', '첨부파일(배열·객체) → 값 없음으로 보고 브랜드명 사용'],
  [{}, '바른치킨', '바른', '객체'],
  [true, '바른치킨', '바른', '참/거짓'],
  [NaN, '바른치킨', '바른', 'NaN'],
];

for (const [label, fns] of [['app.html(브라우저)', appFns], ['api/seo.js(서버)', seoFns]]) {
  test(`${label}: 규칙 표 ${CASES.length}개 사례`, () => {
    for (const [raw, name, want, why] of CASES) assert.equal(fns.brandInitialText(raw, name), want, `${JSON.stringify(raw)} / ${JSON.stringify(name)} (${why})`);
  });
}

test('두 구현의 코드가 글자 그대로 같다(들여쓰기 제외) — 규칙이 한쪽만 바뀌는 일을 막는다', () => {
  assert.equal(normalizeIndent(blockOf(appSrc)), normalizeIndent(blockOf(seoSrc)));
  assert.ok(blockOf(appSrc).includes('function brandInitialText'));
});

test('hasBadgeText: 직접 입력한 값인지(공백·null·첨부파일은 입력으로 보지 않음)', () => {
  for (const [v, want] of [['바른', true], [' 바른 ', true], [7, true], ['', false], ['  ', false], ['\u3000', false], [null, false], [undefined, false], [[{}], false], [true, false]]) {
    assert.equal(appFns.hasBadgeText(v), want, JSON.stringify(v)); assert.equal(seoFns.hasBadgeText(v), want, JSON.stringify(v));
  }
});

// 픽스처 집계(2026-10-03 조회): 캐시의 브랜드명 있는 행은 163행(대표이미지 입력 92·누락 71). 그중 "금액>0 이고 10/3 기준 만료되지 않은" 행이
// 162행(입력 91·누락 71)이며 픽스처는 이 162행이다. 빠진 1행은 '두찜 (브랜드데이)'(종료 10/2, 대표이미지 '두찜' 입력됨).
test('실제 데이터 162행(입력 91·누락 71): 새 규칙의 결과가 이전 동작((입력값 || 브랜드명).slice(0,2))과 모두 같다 — 현재 데이터에서 달라지는 카드가 없다', () => {
  const pairs = JSON.parse(read('tests/fixtures/real-brand-badges-2026-10-03.json'));
  assert.equal(pairs.length, 162); assert.equal(pairs.filter(([, i]) => i === null).length, 71); assert.equal(pairs.filter(([, i]) => i !== null).length, 91);
  const legacy = (img, name) => ((img || '').toString().trim() || name.trim()).slice(0, 2);
  for (const [name, img] of pairs) {
    assert.equal(appFns.brandInitialText(img, name), legacy(img, name), `${name} / ${img}`);
    assert.equal(seoFns.brandInitialText(img, name), legacy(img, name), `${name} / ${img}`);
  }
  // 비어 있는 71행은 전부 브랜드명 앞 두 글자
  for (const [name] of pairs.filter(([, i]) => i === null)) assert.equal(appFns.brandInitialText(undefined, name), [...name.trim()].slice(0, 2).join(''));
});

test('서버 mapRecord: 대표이미지 별칭을 읽고 규칙을 적용한다(BOM 이 붙은 브랜드명 키 포함)', () => {
  const rec = (fields) => ({ id: 'x', fields: { '\ufeff브랜드명': '바른치킨', 플랫폼: '쿠팡이츠', 카테고리: ['치킨'], 할인금액: 3000, ...fields } });
  assert.deepEqual([mapRecord(rec({})).badge, mapRecord(rec({})).badgeManual], ['바른', false]);
  assert.deepEqual([mapRecord(rec({ 대표이미지: '' })).badge, mapRecord(rec({ 대표이미지: '' })).badgeManual], ['바른', false]);
  assert.deepEqual([mapRecord(rec({ 대표이미지: '\u3000 ' })).badge, mapRecord(rec({ 대표이미지: '\u3000 ' })).badgeManual], ['바른', false]);
  assert.deepEqual([mapRecord(rec({ 대표이미지: '맛집' })).badge, mapRecord(rec({ 대표이미지: '맛집' })).badgeManual], ['맛집', true]);
  assert.equal(mapRecord(rec({ 뱃지: '맛집' })).badge, '맛집', '다른 별칭(뱃지)도 인식');
  assert.equal(mapRecord({ id: 'x', fields: { 플랫폼: '쿠팡이츠', 할인금액: 3000 } }), null, '브랜드명이 없는 행은 카드 자체를 만들지 않는다(기존 동작)');
});

test('대표이미지를 계산해서 원본/DB 에 저장하지 않는다(표시 단계 전용)', () => {
  for (const f of ['api/discounts.js', 'api/sync-airtable.js']) assert.ok(!/badge|대표이미지/.test(read(f)), f);
  // app.html 에서 할인 카드의 대표이미지(badge)를 서버로 보내는 코드가 없다.
  // (홈 배너 문구 설정의 'home_promo_badge' 는 이 기능과 무관한 별개 설정이라 제외한다.)
  const withoutPromoBadge = appSrc.replace(/home_promo_badge/g, '');
  assert.ok(!/\b(rpc|insert|upsert|update)\(\s*['"`]?[\w$.]*['"`]?\s*,?\s*\{[^}]*\bbadge\b/.test(withoutPromoBadge));
  assert.ok(!/\.(from)\(['"]discounts?['"]\)/.test(appSrc), '할인 카드를 DB 에 쓰는 코드가 없어야 한다');
  assert.ok(!/대표이미지[^\n]*(fetch|rpc|insert|upsert)/.test(appSrc.replace(/\/\/.*$/gm, '')));
});

test('이니셜을 만드는 코드는 공통 함수 하나뿐이다(옛 방식 slice(0,2) 가 남아 있지 않다)', () => {
  assert.ok(!/badgeRaw/.test(appSrc));
  assert.ok(!/r\.name\.slice\(0, 2\)/.test(appSrc));
  assert.ok(!/group\.badge\.slice/.test(appSrc));
  assert.match(appSrc, /badge: brandInitialText\(badgeField, name\)/);
  assert.match(appSrc, /\$\{escapeHtml\(group\.badge\)\}/);
  const home = read('api/home.js');
  assert.ok(!/\(d\.name \|\| ''\)\.slice\(0, 2\)/.test(home));
  assert.match(home, /brandInitialText\(null, d\.name\)/);
});

// ================= 서버 렌더링(api/home.js BEST3 카드) 끝까지 실행 =================
test('서버 렌더링: home.js BEST3 카드의 이니셜이 같은 규칙으로 나온다(비어 있음·전각 공백·입력값)', async () => {
  const { execFileSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-ssr-'));
  // home.js 는 process.cwd()/app.html 을 템플릿으로 읽는다 → 필요한 빈 태그(앵커)만 가진 최소 템플릿을 둔다.
  fs.writeFileSync(path.join(dir, 'app.html'), '<html><body>\n<div id="discount-list" class="grid sm:grid-cols-2 gap-4"></div>\n<div id="best3-list-mobile" class="sm:hidden space-y-2"></div>\n<div id="best3-list" class="contents"></div>\n</body></html>');
  const script = `
    const rec = (n, a, img) => ({ id: n, fields: { '\\ufeff브랜드명': n, 플랫폼: '쿠팡이츠', 카테고리: ['치킨'], 할인금액: a, 종료일: '2099-12-31', ...(img === undefined ? {} : { 대표이미지: img }) } });
    const records = [rec('바른치킨', 9000), rec('꾸브라꼬치킨', 8000, '맛집'), rec('반올림피자', 7000, '\\u3000\\u3000'), rec('기영이숯불두마리치킨', 1000)];
    process.env.SUPABASE_URL = 'https://mock.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock';
    globalThis.fetch = async (u) => String(u).includes('cached_airtable_records') ? { ok: true, status: 200, json: async () => [{ records }], text: async () => '' } : { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    const { default: handler } = await import(${JSON.stringify(path.join(ROOT, 'api/home.js'))});
    const res = { code: 200, body: '', setHeader() {}, status(c) { this.code = c; return this; }, end(b) { this.body = b; return this; }, send(b) { this.body = b; return this; } };
    await handler({ headers: {}, url: '/' }, res);
    process.stdout.write(JSON.stringify({ code: res.code, body: res.body }));
  `;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  assert.equal(out.code, 200);
  const desktop = out.body.slice(out.body.indexOf('<div id="best3-list"'), out.body.indexOf('</body>'));
  const squares = [...desktop.matchAll(/flex items-center justify-center font-bold"[^>]*>([^<]*)<\/div>/g)].map((m) => m[1]);
  assert.deepEqual(squares, ['바른', '맛집', '반올'], '금액 순 상위 3개 카드의 이니셜: 값 없음→바른, 입력값→맛집, 전각 공백만→반올');
});

// ================= 검증용 파일 배포 제외(설정 존재 확인) =================
test('tests/ 와 tools/ (검증용 테스트·도구·픽스처)는 배포에서 제외된다(.vercelignore + vercel.json redirects)', () => {
  const v = JSON.parse(read('vercel.json'));
  assert.deepEqual(v.redirects, [{ source: '/(tests|tools)(/.*)?', destination: '/', permanent: false }]);
  const lines = read('.vercelignore').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['/tests', '/tools']);
  const re = new RegExp('^' + v.redirects[0].source + '$');
  for (const p of ['/tests/fixtures/real-brand-badges-2026-10-03.json', '/tools/verify-real-cache/badges_real.py']) assert.ok(re.test(p), p);
  for (const p of ['/', '/api/seo', '/today-chicken-discount', '/sitemap.xml']) assert.ok(!re.test(p), p);
});

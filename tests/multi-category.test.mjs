// 다중 카테고리 브랜드(맘스터치 = 버거·치킨) 처리 검증. 실제 운영 캐시에서 뽑은 레코드(tests/fixtures)로
// 운영 코드(api/seo.js, app.html)를 그대로 실행한다. 순위 기대값은 구현을 재사용하지 않고 이 파일 안에서 따로 계산한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderSeo, SEO_BRANCH, resolveBaseline, FIXTURE, TODAY, ROOT, rankedList, navSections, hrefs, h2s, breadcrumb, decode } from './helpers/seo-render.mjs';

// 수정 전 seo.js(비교 기준). 머지 후 main 에서는 기준이 이미 수정본이라 "이전 방식" 대조 테스트는 건너뛴다.
const SEO_MAIN = resolveBaseline();
const OLD_BASELINE = !!SEO_MAIN && !fs.readFileSync(SEO_MAIN, 'utf8').includes('rankBrandsForCategory');

const BOM = '\ufeff';
const APP_BY_KOR = { 배달의민족: 'baemin', 요기요: 'yogiyo', 쿠팡이츠: 'coupang', 땡겨요: 'ddangyo' };
const APP_ORDER = ['baemin', 'yogiyo', 'coupang', 'ddangyo'];
const APP_SHORT = { baemin: '배민', yogiyo: '요기요', coupang: '쿠팡이츠', ddangyo: '땡겨요' };
const ALIASES = { bhc: 'BHC', bhc치킨: 'BHC', bbq: 'BBQ', bbq치킨: 'BBQ', 오븐마루: '오븐마루', 오븐마루치킨: '오븐마루' };
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- 독립 기대값 계산(오라클) ----
function liveRows(records) {
  return records.map((r) => {
    const f = r.fields;
    return { name: f[BOM + '브랜드명'], app: APP_BY_KOR[f['플랫폼']], cats: f['카테고리'], amount: f['할인금액'], start: f['시작일'] || null, end: f['종료일'] || null };
  }).filter((d) => (!d.start || d.start <= TODAY) && (!d.end || d.end >= TODAY));
}
function expectedRanking(records, category) {
  const best = new Map();
  for (const d of liveRows(records).filter((x) => x.cats.includes(category))) {
    const c = d.name.trim().toLowerCase().replace(/\s+/g, '');
    const key = ALIASES[c] || c, shown = ALIASES[c] || d.name.trim();
    const cur = best.get(key);
    // 같은 브랜드의 대표 행(명세): 금액 큰 순 → 앱 순서(배민, 요기요, 쿠팡이츠, 땡겨요) → 종료일 빠른 순. 캐시 행 순서는 쓰지 않는다.
    const better = !cur || d.amount > cur.amount
      || (d.amount === cur.amount && (APP_ORDER.indexOf(d.app) < APP_ORDER.indexOf(cur.app)
        || (d.app === cur.app && cmp(d.end || '9999-99-99', cur.end || '9999-99-99') < 0)));
    if (better) best.set(key, { name: shown, amount: d.amount, app: d.app, end: d.end });
  }
  return [...best.values()].sort((a, b) => b.amount - a.amount || cmp(a.name, b.name));
}
const brandOf = (label) => label.replace(/ \((배민|요기요|쿠팡이츠|땡겨요)\)$/, '');

const PAGES = { chicken: 'today-chicken-discount', pizza: 'today-pizza-discount', burger: 'today-burger-discount' };
const CATEGORY = { chicken: '치킨', pizza: '피자', burger: '버거' };

// ================= 카테고리 SEO 목록: 브랜드별 묶음 · 최대 할인금액 순 · 동점 고정 =================
for (const key of ['chicken', 'pizza', 'burger']) {
  test(`${PAGES[key]}: 브랜드별로 묶고 브랜드별 최대 금액 순(독립 계산과 일치), 브랜드 중복 없음`, async () => {
    const html = await renderSeo(SEO_BRANCH, PAGES[key]);
    const list = rankedList(html);
    const want = expectedRanking(FIXTURE, CATEGORY[key]).slice(0, 15);
    assert.deepEqual(list.map((r) => [brandOf(r.name), r.amount]), want.map((w) => [w.name, w.amount]));
    assert.deepEqual(list.map((r) => APP_SHORT[want[list.indexOf(r)].app]), list.map((r) => r.name.match(/\(([^)]+)\)$/)[1]));   // 대표 앱도 일치
    assert.equal(new Set(list.map((r) => brandOf(r.name))).size, list.length, '같은 브랜드가 두 번 나옴');
    // 정렬 불변식: 금액 내림차순, 동점은 브랜드명 오름차순
    for (let i = 1; i < list.length; i++) {
      assert.ok(list[i - 1].amount >= list[i].amount);
      if (list[i - 1].amount === list[i].amount) assert.ok(cmp(brandOf(list[i - 1].name), brandOf(list[i].name)) < 0, `동점 순서: ${list[i - 1].name} / ${list[i].name}`);
    }
  });
}

test('치킨 페이지: 15개로 자른 경우에만 "상위 15개 브랜드"를 제목에 쓰고, 전체 브랜드 수·홈 링크를 보여준다', async () => {
  const html = await renderSeo(SEO_BRANCH, PAGES.chicken);
  const total = expectedRanking(FIXTURE, '치킨').length;
  assert.ok(total > 15);
  assert.ok(h2s(html).includes('오늘 치킨 할인 상위 15개 브랜드'), h2s(html).join(' | '));
  assert.match(html, new RegExp(`전체 ${total}개 브랜드 중`));
  const link = html.match(/<a href="(\/\?category=[^"]+)"[^>]*>([^<]*)<\/a>/);
  assert.equal(link[1], '/?category=%EC%B9%98%ED%82%A8');
  assert.equal(decodeURIComponent(link[1].split('=')[1]), '치킨');
  assert.match(link[2], new RegExp(`치킨 할인 전체 ${total}개 브랜드 보기`));
  assert.match(html, new RegExp(`현재 확인된 치킨 할인 브랜드는 총 ${total}곳입니다`), '요약 문구의 브랜드 수가 목록/홈과 같아야 한다');
});

test('버거 페이지: 6개 전부 보여주므로 "상위"를 쓰지 않는다(전체 개수 표기) + 홈 링크', async () => {
  const html = await renderSeo(SEO_BRANCH, PAGES.burger);
  const total = expectedRanking(FIXTURE, '버거').length;
  assert.ok(total <= 15);
  assert.ok(h2s(html).includes(`오늘 햄버거 할인 ${total}개 브랜드`), h2s(html).join(' | '));
  assert.ok(!h2s(html).some((t) => t.includes('상위')));
  assert.match(html, /<a href="\/\?category=%EB%B2%84%EA%B1%B0"/);
  assert.equal(rankedList(html).filter((r) => r.name.startsWith('맘스터치')).length, 1, '맘스터치는 브랜드 하나로 한 번만');
});

test('홈 링크의 category 값은 홈 카테고리 필터(CATEGORIES)에 실제로 있는 이름이다', async () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const cats = new Function('return ' + app.match(/const CATEGORIES = (\[[^\]]*\])/)[1])();
  for (const key of Object.values(PAGES)) {
    const html = await renderSeo(SEO_BRANCH, key);
    const v = decodeURIComponent(html.match(/href="\/\?category=([^"]+)"/)[1]);
    assert.ok(cats.includes(v), `${key} → ${v}`);
  }
});

test('동점 순서가 캐시(레코드) 순서에 흔들리지 않는다: 레코드를 20번 섞어도 세 카테고리 페이지가 완전히 같다', async () => {
  let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const base = {};
  for (const k of Object.values(PAGES)) base[k] = rankedList(await renderSeo(SEO_BRANCH, k));
  for (let n = 0; n < 20; n++) {
    const shuffled = FIXTURE.slice();
    for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
    for (const k of Object.values(PAGES)) assert.deepEqual(rankedList(await renderSeo(SEO_BRANCH, k, shuffled)), base[k], `${k} (셔플 ${n})`);
  }
});

test('[대조] 이전 방식(행 단위 상위 15)은 순서에 따라 맘스터치가 빠질 수 있었다 — 같은 데이터를 정렬해 넣으면 결과가 달라진다', { skip: !OLD_BASELINE && '수정 전 seo.js 기준을 찾을 수 없음(머지 후 main 이면 정상)' }, async () => {
  const sorted = FIXTURE.slice().sort((a, b) => cmp(a.fields['플랫폼'] + a.fields[BOM + '브랜드명'], b.fields['플랫폼'] + b.fields[BOM + '브랜드명']));
  const before = rankedList(await renderSeo(SEO_MAIN, PAGES.chicken, sorted)).some((r) => r.name.startsWith('맘스터치'));
  const after = rankedList(await renderSeo(SEO_BRANCH, PAGES.chicken, sorted)).some((r) => r.name.startsWith('맘스터치'));
  assert.equal(before, false, '이전 방식은 정렬된 입력에서 맘스터치가 탈락했다');
  assert.equal(after, true, '수정본은 입력 순서와 무관하게 포함된다');
});

// ================= 맘스터치: 버거·치킨 양쪽 =================
test('맘스터치 상세페이지: 버거·치킨 섹션과 전체 보기 링크를 모두 제공, 경로 표시는 대표 카테고리(버거)', async () => {
  const html = await renderSeo(SEO_BRANCH, 'momstouch-discount');
  assert.deepEqual(breadcrumb(html), ['홈', '오늘 햄버거 할인·쿠폰 비교', '오늘 맘스터치 할인·쿠폰 비교']);
  const titles = h2s(html);
  assert.ok(titles.includes('오늘의 버거 할인') && titles.includes('오늘의 치킨 할인'), titles.join(' | '));
  const rel = html.slice(html.indexOf('함께 보면 좋아요'));
  const relHrefs = hrefs(rel.slice(0, rel.indexOf('</section>')));
  for (const h of ['/today-burger-discount', '/today-chicken-discount', '/chicken-app-compare']) assert.ok(relHrefs.includes(h), h);
  assert.equal(new Set(relHrefs).size, relHrefs.length, '관련 링크 중복');
  // 형제 브랜드 섹션: 버거 쪽에는 버거 브랜드, 치킨 쪽에는 치킨 브랜드, 자기 자신은 제외, 중복 없음
  const section = (title) => { const i = html.indexOf(`>${title}</h2>`); return hrefs(html.slice(i, html.indexOf('</section>', i))); };
  const burger = section('오늘의 버거 할인'), chicken = section('오늘의 치킨 할인');
  assert.ok(burger.includes('/lotteria-discount') && burger.includes('/mcdonald-discount') && burger.includes('/burgerking-discount'));
  assert.ok(chicken.includes('/bbq-discount') && chicken.includes('/bhc-discount'));
  for (const list of [burger, chicken]) { assert.ok(!list.includes('/momstouch-discount')); assert.equal(new Set(list).size, list.length); }
});

test('BreadcrumbList 는 맘스터치도 버거 하나뿐(날마다 바뀌지 않음) — 오늘 맘스터치 행이 없는 날에도 동일', async () => {
  const noMom = FIXTURE.filter((r) => !String(r.fields[BOM + '브랜드명']).includes('맘스터치'));
  assert.deepEqual(breadcrumb(await renderSeo(SEO_BRANCH, 'momstouch-discount', noMom)), ['홈', '오늘 햄버거 할인·쿠폰 비교', '오늘 맘스터치 할인·쿠폰 비교']);
  // 오늘 행이 없을 때의 안내 링크는 두 카테고리 모두
  const empty = await renderSeo(SEO_BRANCH, 'momstouch-discount', noMom);
  assert.match(empty, /오늘 확인 가능한 햄버거 할인 전체 보기/); assert.match(empty, /오늘 확인 가능한 치킨 할인 전체 보기/);
});

test('치킨·버거 종합 페이지의 브랜드 링크 목록에 맘스터치가 각각 정확히 한 번(피자 페이지에는 없음)', async () => {
  const brandChips = (html) => { const i = html.indexOf('앱/브랜드별로 자세히 보기'); return hrefs(html.slice(i, html.indexOf('</section>', i))); };
  for (const key of ['chicken', 'burger']) {
    const list = brandChips(await renderSeo(SEO_BRANCH, PAGES[key]));
    assert.equal(list.filter((h) => h === '/momstouch-discount').length, 1, `${key}`);
    assert.equal(new Set(list).size, list.length, `${key} 링크 중복`);
  }
  assert.ok(!brandChips(await renderSeo(SEO_BRANCH, PAGES.pizza)).includes('/momstouch-discount'));
});

test('SEO 푸터: 맘스터치가 치킨·햄버거 그룹 양쪽에 있고, 각 그룹 안에서 링크가 중복되지 않는다(전체 페이지)', async () => {
  const keys = [...fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8').matchAll(/\/api\/seo\?page=([a-z0-9-]+)/g)].map((m) => m[1]);
  assert.ok(keys.length >= 38, `페이지 ${keys.length}개`);
  for (const k of keys) {
    const sec = navSections(await renderSeo(SEO_BRANCH, k));
    const chicken = sec['🍗 오늘 치킨 할인'], burger = sec['🍔 오늘 햄버거 할인'];
    assert.equal(chicken.filter((h) => h === '/momstouch-discount').length, 1, `${k} 치킨 그룹`);
    assert.equal(burger.filter((h) => h === '/momstouch-discount').length, 1, `${k} 햄버거 그룹`);
    for (const [title, list] of Object.entries(sec)) assert.equal(new Set(list).size, list.length, `${k} / ${title} 중복`);
  }
});

// ================= 기존 단일 카테고리 브랜드 · 다른 페이지는 그대로 =================
test('기존 단일 카테고리 브랜드 페이지(bbq/도미노/버거킹): 대표·섹션이 하나씩, 형제 목록에 맘스터치가 해당 카테고리로 추가', async () => {
  const cases = [['bbq-discount', '오늘 치킨 할인·쿠폰 비교', '오늘의 치킨 할인', true], ['dominopizza-discount', '오늘 피자 할인·쿠폰 비교', '오늘의 피자 할인', false], ['burgerking-discount', '오늘 햄버거 할인·쿠폰 비교', '오늘의 버거 할인', true]];
  for (const [page, crumb, sectionTitle, hasMom] of cases) {
    const html = await renderSeo(SEO_BRANCH, page);
    assert.equal(breadcrumb(html)[1], crumb, page);
    const crossTitles = h2s(html).filter((t) => /^오늘의 .+ 할인$/.test(t) && !t.includes('체크포인트'));
    assert.deepEqual(crossTitles, [sectionTitle], `${page} 섹션은 하나`);
    const i = html.indexOf(`>${sectionTitle}</h2>`); const sib = hrefs(html.slice(i, html.indexOf('</section>', i)));
    assert.equal(sib.includes('/momstouch-discount'), hasMom, `${page} 형제 목록`);
    assert.equal(new Set(sib).size, sib.length);
  }
});

test('[전체 페이지 대조] 수정 전과 수정본: 맘스터치 링크만 빼면 바뀌는 페이지는 의도한 것뿐이다', { skip: !SEO_MAIN && '수정 전 seo.js 기준을 찾을 수 없음' }, async () => {
  const keys = [...fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8').matchAll(/\/api\/seo\?page=([a-z0-9-]+)/g)].map((m) => m[1]);
  const strip = (h) => h.replace(/<a href="\/momstouch-discount"[^>]*>[^<]*<\/a>/g, '');
  const changed = [];
  for (const k of keys) {
    const before = strip(await renderSeo(SEO_MAIN, k)), after = strip(await renderSeo(SEO_BRANCH, k));
    if (before !== after) changed.push(k);
  }
  // 의도한 변경: 카테고리 종합 3페이지(브랜드 순위·제목·링크, 버거 페이지의 브랜드 링크 영역) + 맘스터치 상세
  const allowed = ['momstouch-discount', 'today-burger-discount', 'today-chicken-discount', 'today-pizza-discount'];
  assert.ok(changed.every((k) => allowed.includes(k)), `의도하지 않은 변경: ${changed.filter((k) => !allowed.includes(k)).join(', ')}`);
  if (OLD_BASELINE) assert.deepEqual(changed.sort(), allowed.slice().sort());   // 수정 전 기준일 때는 정확히 이 4개가 바뀐다
});

// ================= 홈(app.html) 정적 확인 =================
test('홈 푸터: 맘스터치가 치킨·햄버거 그룹에 각각 한 번, ?category 딥링크 처리 함수가 있다', () => {
  const app = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const group = (title) => { const i = app.indexOf(title); return app.slice(i, app.indexOf('</div>\n        </div>', i)); };
  const count = (s) => (s.match(/href="\/momstouch-discount"/g) || []).length;
  assert.equal(count(group('🍗 오늘 치킨 할인')), 1);
  assert.equal(count(group('🍔 오늘 햄버거 할인')), 1);
  assert.equal(count(group('🍕 오늘 피자 할인')), 0);
  assert.match(app, /function consumeCategoryDeepLink\(\)/);
  assert.match(app, /const deepLinkCategories = consumeCategoryDeepLink\(\);/);
  assert.match(app, /revealDiscountList\(\);\s*scrollToDiscountListSection\(\);/);
});

test('홈과 SEO 의 BRAND_ALIASES(브랜드 묶음 기준) 표가 같다', () => {
  const grab = (file) => { const s = fs.readFileSync(path.join(ROOT, file), 'utf8'); const i = s.indexOf('const BRAND_ALIASES = {'); return new Function('return ' + s.slice(i + 'const BRAND_ALIASES = '.length, s.indexOf('};', i) + 1))(); };
  assert.deepEqual(grab('api/seo.js'), grab('app.html'));
});

test('BRAND_CATEGORY: 맘스터치만 다중(버거 대표, 치킨), 나머지는 기존처럼 단일 문자열', () => {
  const s = fs.readFileSync(path.join(ROOT, 'api/seo.js'), 'utf8');
  const i = s.indexOf('const BRAND_CATEGORY = {'); const body = s.slice(i, s.indexOf('\n};', i));
  const arrays = [...body.matchAll(/'([a-z0-9-]+)':\s*\[([^\]]*)\]/g)].map((m) => [m[1], m[2].replace(/['\s]/g, '')]);
  assert.deepEqual(arrays, [['momstouch-discount', '버거,치킨']]);
  assert.ok((body.match(/'[a-z0-9-]+-discount':\s*'[^']+'/g) || []).length >= 22);
});

// ================= 중복 방지 로직 자체 검증(정의에 일부러 중복을 넣은 복사본) =================
test('정의에 같은 브랜드가 두 번 들어가도 같은 목록 안에서 링크는 한 번만 나온다(푸터·브랜드 링크·형제 목록)', async () => {
  const os = await import('node:os');
  let src = fs.readFileSync(SEO_BRANCH, 'utf8');
  const dupFooter = "      ['momstouch-discount', '맘스터치'],   // 치킨·햄버거 두 그룹에 모두 노출(서로 다른 목록이라 중복 아님)\n";
  assert.ok(src.includes(dupFooter));
  src = src.replace(dupFooter, dupFooter + dupFooter);                                                    // 푸터 치킨 그룹에 중복 정의
  src = src.replace("'momstouch-discount': ['버거', '치킨'],", "'momstouch-discount': ['버거', '치킨', '버거', '치킨'],");   // 카테고리 값에 중복 정의
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seo-dup-')), 'seo-dup.mjs');
  fs.writeFileSync(file, src);
  for (const page of ['today-chicken-discount', 'today-burger-discount', 'momstouch-discount', 'bbq-discount']) {
    const html = await renderSeo(file, page);
    for (const [title, list] of Object.entries(navSections(html))) assert.equal(new Set(list).size, list.length, `${page} 푸터 ${title}`);
    for (const t of h2s(html).filter((x) => /^오늘의 .+ 할인$/.test(x))) {
      const i = html.indexOf(`>${t}</h2>`); const sib = hrefs(html.slice(i, html.indexOf('</section>', i)));
      assert.equal(new Set(sib).size, sib.length, `${page} / ${t}`);
    }
  }
  const brandChips = (html) => { const i = html.indexOf('앱/브랜드별로 자세히 보기'); return hrefs(html.slice(i, html.indexOf('</section>', i))); };
  const chips = brandChips(await renderSeo(file, 'today-chicken-discount'));
  assert.equal(chips.filter((h) => h === '/momstouch-discount').length, 1);
  assert.equal(new Set(chips).size, chips.length);
});

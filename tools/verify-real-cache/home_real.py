#!/usr/bin/env python3
"""홈(app.html)을 Chromium 으로 열어, 운영 캐시에서 뽑은 실제 레코드(tests/fixtures)로 검증한다.
  - 카테고리 필터: 모든 카테고리에서 "데이터상 있어야 할 브랜드" == "화면에 나온 브랜드"
  - 다중 카테고리 브랜드가 자기 카테고리 전부에서 보이는지, 같은 브랜드를 합쳐도 행이 버려지지 않는지
  - /?category=… 딥링크(SEO 카테고리 페이지의 "전체 보기" 링크): 필터 선택·목록 펼침·스크롤·주소 정리
  - 홈 푸터: 맘스터치가 치킨/햄버거 그룹에 각각 한 번
외부 CDN·supabase 는 가로채기로 대체한다(실제 연결 확인은 아님). 사용: CHROMIUM_PATH=... python3 tools/verify-real-cache/home_real.py
"""
import json, os, sys
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(globals().get('__file__', '/tmp/prod/tools/verify-real-cache/x.py'))); ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
APP = open(os.path.join(ROOT, 'app.html'), encoding='utf-8').read()
STUB = open(os.path.join(HERE, 'supabase-stub.js'), encoding='utf-8').read()
RECORDS = json.load(open(os.path.join(ROOT, 'tests/fixtures/real-cache-2026-10-03.json'), encoding='utf-8'))
CHROMIUM = os.environ.get('CHROMIUM_PATH') or None
results = []
def check(name, cond, detail=''):
    results.append(bool(cond)); print(('PASS ' if cond else 'FAIL ') + name + ((' — ' + str(detail)[:300]) if (detail and not cond) else ''))

KEYS_JS = "[...document.querySelectorAll('[data-brand-key]')].map(e => e.getAttribute('data-brand-key'))"
EXPECT_JS = """(cats) => { const live = discounts.filter(isDiscountLive); return [...new Set(live.filter(d => cats.some(c => d.category.includes(c))).map(d => brandGroupKey(d.name)))]; }"""

def open_page(browser, viewport, path):
    ctx = browser.new_context(viewport=viewport); pg = ctx.new_page(); pg.set_default_timeout(8000)
    pg.clock.set_fixed_time('2026-10-03T12:00:00+09:00')
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    def handle(route):
        u = route.request.url
        base = u.split('?')[0].split('#')[0].rstrip('/')
        if base == 'https://t.local': return route.fulfill(content_type='text/html; charset=utf-8', body=APP)
        if '/api/discounts' in u: return route.fulfill(content_type='application/json', body=json.dumps({'records': RECORDS, 'updated_at': '2026-10-02T15:50:22Z'}))
        if 'cdn.tailwindcss.com' in u: return route.fulfill(content_type='text/javascript', body='window.tailwind={};')
        if 'supabase-js' in u: return route.fulfill(content_type='text/javascript', body=STUB)
        if 'emailjs' in u: return route.fulfill(content_type='text/javascript', body='window.emailjs={init(){},send(){return Promise.resolve()}};')
        if u.startswith('https://t.local'): return route.fulfill(status=204, body='')
        return route.abort()
    pg.route('**/*', handle)
    pg.goto('https://t.local' + path, wait_until='load'); pg.wait_for_timeout(2200)
    return ctx, pg, errs

def suite(browser, viewport, tag):
    print(f'\n===== {tag} {viewport} =====')
    # ---- A) 기본 홈: 필터 없음, 목록 접힘 ----
    ctx, pg, errs = open_page(browser, viewport, '/')
    live = pg.evaluate("discounts.filter(isDiscountLive).length")
    check(f'[{tag}] 실제 레코드 130행 로드, 오늘 유효 116행', pg.evaluate("discounts.filter(d=>d.source==='airtable').length") == 130 and live == 116, live)
    check(f'[{tag}] 파라미터 없는 홈: 필터 없음 · 전체 목록은 접힌 채(기존 동작 유지)', pg.evaluate("activeCategoryFilters.length") == 0 and pg.evaluate("document.getElementById('discount-list-section').classList.contains('hidden')"))
    # ---- B) 카테고리별 전수 비교 ----
    cats = pg.evaluate("[...new Set(discounts.filter(isDiscountLive).flatMap(d => d.category))].sort()")
    bad = []
    for c in cats:
        pg.evaluate(f"activeCategoryFilters=['{c}']; renderDiscountList();")
        shown = set(pg.evaluate(KEYS_JS)); exp = set(pg.evaluate(EXPECT_JS, [c]))
        if shown != exp: bad.append((c, sorted(exp - shown), sorted(shown - exp)))
    check(f'[{tag}] 카테고리 {len(cats)}개 전부: 데이터상 있어야 할 브랜드 == 화면에 나온 브랜드(누락·초과 0)', not bad, bad)
    # ---- C) 다중 카테고리 브랜드 / 합치기 ----
    multi = pg.evaluate("[...new Map(discounts.filter(d => isDiscountLive(d) && d.category.length > 1).map(d => [d.name + '|' + d.app[0], d])).values()].map(d => [d.name, d.category])")
    miss = []
    for name, cs in multi:
        for c in cs:
            pg.evaluate(f"activeCategoryFilters=['{c}']; renderDiscountList();")
            key = pg.evaluate("(n) => brandGroupKey(n)", name)
            if key not in pg.evaluate(KEYS_JS): miss.append((name, c))
    check(f'[{tag}] 다중 카테고리 행 {len(multi)}개(맘스터치 등)가 자기 카테고리 전부에서 보임', multi and not miss, miss)
    ok_rows = pg.evaluate("(() => { const live = discounts.filter(isDiscountLive); const g = groupDiscountsByBrand(live); return [live.length, g.reduce((n, x) => n + x.badges.length, 0)]; })()")
    check(f'[{tag}] 같은 브랜드를 합쳐도 행이 버려지지 않음(카테고리 정보가 첫 값으로 줄지 않음)', ok_rows[0] == ok_rows[1], ok_rows)
    mom = pg.evaluate("(() => { const out = {}; for (const c of ['버거','치킨']) { activeCategoryFilters=[c]; renderDiscountList(); out[c] = [...document.querySelectorAll('[data-brand-key]')].map(e => e.getAttribute('data-brand-key')).includes('맘스터치'); } return out; })()")
    check(f'[{tag}] 맘스터치: 버거 필터와 치킨 필터 양쪽에 보임', mom == {'버거': True, '치킨': True}, mom)
    pg.evaluate("activeCategoryFilters=[]; renderDiscountList();")
    # ---- D) 홈 푸터 ----
    foot = pg.evaluate("""(() => { const out = {}; document.querySelectorAll('footer p.font-semibold').forEach(p => { const box = p.nextElementSibling; if (!box || box.querySelector('p')) return; const hs = [...box.querySelectorAll('a')].map(a => a.getAttribute('href')); out[p.textContent.trim()] = hs; }); return out; })()""")
    chick = foot.get('🍗 오늘 치킨 할인', []); burg = foot.get('🍔 오늘 햄버거 할인', [])
    check(f'[{tag}] 홈 푸터: 맘스터치가 치킨·햄버거 그룹에 각각 한 번', chick.count('/momstouch-discount') == 1 and burg.count('/momstouch-discount') == 1, (chick, burg))
    check(f'[{tag}] 홈 푸터: 각 그룹 안에서 링크 중복 없음', all(len(set(v)) == len(v) for v in foot.values()), {k: v for k, v in foot.items() if len(set(v)) != len(v)})
    check(f'[{tag}] JS 오류 없음', not errs, errs[:2]); ctx.close()

    # ---- E) /?category= 딥링크 ----
    exp_chicken = None
    for path, want, label in [('/?category=%EC%B9%98%ED%82%A8', ['치킨'], '치킨'), ('/?category=%EB%B2%84%EA%B1%B0%2C%EC%B9%98%ED%82%A8', ['버거', '치킨'], '버거,치킨 둘 다')]:
        ctx, pg, errs = open_page(browser, viewport, path)
        active = pg.evaluate("activeCategoryFilters"); shown = set(pg.evaluate(KEYS_JS)); exp = set(pg.evaluate(EXPECT_JS, want))
        check(f'[{tag}] 딥링크 {label}: 필터 선택됨', sorted(active) == sorted(want), active)
        check(f'[{tag}] 딥링크 {label}: 전체 목록 펼쳐짐 + 해당 카테고리 브랜드만({len(exp)}개 전부)', (not pg.evaluate("document.getElementById('discount-list-section').classList.contains('hidden')")) and shown == exp, (len(shown), len(exp)))
        styles = pg.evaluate("(w) => { const chip = (c) => document.querySelector(`[data-filter-cat='${c}']`); const sel = chip(w[0]).getAttribute('style'); const other = [...document.querySelectorAll('[data-filter-cat]')].find(b => !w.includes(b.getAttribute('data-filter-cat'))).getAttribute('style'); return [sel, other]; }", want)
        check(f'[{tag}] 딥링크 {label}: 칩이 선택 상태로 표시됨', styles[0] != styles[1])
        pg.wait_for_timeout(900)
        top = pg.evaluate("document.getElementById('discount-list-section').getBoundingClientRect().top")
        check(f'[{tag}] 딥링크 {label}: 목록 위치로 스크롤됨(화면 안)', -5 <= top < viewport['height'], top)
        if label == '치킨':
            more = pg.evaluate("(() => { const m = document.getElementById('discount-list-more'); return { main: document.querySelectorAll('#discount-list [data-brand-key]').length, more: m ? m.querySelectorAll('[data-brand-key]').length : -1 }; })()")
            check(f'[{tag}] 딥링크 치킨: 홈은 기존 방식대로 첫 15개 + 더보기(나머지 {len(exp) - 15}개)로 나눠 보여줌', more['main'] == 15 and more['main'] + more['more'] == len(exp), more)
        check(f'[{tag}] 딥링크 {label}: 주소에서 category 만 정리됨', 'category' not in pg.evaluate("location.search"), pg.evaluate("location.href"))
        check(f'[{tag}] 딥링크 {label}: JS 오류 없음', not errs, errs[:2]); ctx.close()
    # 잘못된 값 / 다른 쿼리 보존 / 접힌 칩 자동 펼침
    ctx, pg, _ = open_page(browser, viewport, '/?category=%EC%97%86%EB%8A%94%EA%B0%92')
    check(f'[{tag}] 존재하지 않는 category 값은 무시(필터 없음, 목록 접힘)', pg.evaluate("activeCategoryFilters.length") == 0 and pg.evaluate("document.getElementById('discount-list-section').classList.contains('hidden')")); ctx.close()
    ctx, pg, _ = open_page(browser, viewport, '/?category=%EC%B9%98%ED%82%A8&utm_source=ig&utm_campaign=c1')
    q = pg.evaluate("new URLSearchParams(location.search).toString()")
    check(f'[{tag}] category 외 쿼리(utm_source, utm_campaign)는 그대로 보존', q == 'utm_source=ig&utm_campaign=c1', q); ctx.close()
    ctx, pg, _ = open_page(browser, viewport, '/?category=%EB%B6%84%EC%8B%9D')
    vis = pg.evaluate("(() => { const b = document.querySelector(\"[data-filter-cat='분식']\"); return b && getComputedStyle(b).display !== 'none'; })()")
    check(f'[{tag}] 기본 노출 밖 카테고리(분식) 딥링크: 칩이 접히지 않고 보임(자동 펼침)', vis)
    pg.evaluate("toggleCategoryFilter('분식')")
    check(f'[{tag}] 딥링크 후 칩을 다시 눌러 해제하면 필터가 풀림', pg.evaluate("activeCategoryFilters.length") == 0); ctx.close()

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROMIUM, args=['--no-sandbox'])
    suite(browser, {'width': 1280, 'height': 900}, 'PC')
    suite(browser, {'width': 390, 'height': 844}, '모바일')
    browser.close()
print(f'\n==== 총 {len(results)}개 중 {sum(results)}개 통과, {len(results) - sum(results)}개 실패 ====')
sys.exit(0 if all(results) else 1)

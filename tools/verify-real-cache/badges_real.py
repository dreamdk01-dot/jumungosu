#!/usr/bin/env python3
"""홈 할인 카드의 대표이미지(이니셜) 자동 표시 검증 — 실제 데이터 + 엣지 케이스, PC·모바일.
 - tests/fixtures/real-brand-badges-*.json : 운영 캐시에서 뽑은 실제 (브랜드명, 대표이미지) 162쌍(10/3 기준 유효 행; 입력 91·누락 71)
 - 엣지 케이스: 빈 문자열·공백·전각 공백·제로폭·입력값·이모지·자모 분리형·첨부 객체·같은 브랜드의 입력/빈 행 혼합 등
   (브랜드명에 '테스트' 등을 붙인 시험용 레코드이며 실제 데이터가 아니다)
 - 기대값은 이 파일 안에서 독립적으로 계산한다. 수정 전 코드(--baseline FILE, 기본: git main 의 app.html)와도 비교해
   달라지는 카드를 보여준다.
 외부 CDN·Supabase 는 가로채기로 대체한다(실제 연결 확인이 아님).
 사용: CHROMIUM_PATH=... python3 tools/verify-real-cache/badges_real.py [--baseline FILE] [--shots DIR]
"""
import json, os, subprocess, sys, unicodedata
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(globals().get('__file__', 'x')))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
args = sys.argv[1:]


def opt(name):
    return args[args.index(name) + 1] if name in args else None


APP_NEW = open(os.path.join(ROOT, 'app.html'), encoding='utf-8').read()
base_file = opt('--baseline')
try:
    APP_OLD = open(base_file, encoding='utf-8').read() if base_file else subprocess.check_output(
        ['git', 'show', 'main:app.html'], cwd=ROOT, stderr=subprocess.DEVNULL).decode('utf-8')
except Exception:
    APP_OLD = None
STUB = open(os.path.join(HERE, 'supabase-stub.js'), encoding='utf-8').read()
PAIRS = json.load(open(os.path.join(ROOT, 'tests/fixtures/real-brand-badges-2026-10-03.json'), encoding='utf-8'))
SHOTS = opt('--shots')
TW_CSS = os.environ.get('TW_CSS') or None    # 로컬에서 빌드한 Tailwind CSS 경로(없으면 레이아웃 크기 검사는 건너뜀)
CHROMIUM = os.environ.get('CHROMIUM_PATH') or None
BOM = '\ufeff'
PLAT = ['배달의민족', '요기요', '쿠팡이츠', '땡겨요']
MISSING = object()
results = []


def check(name, cond, detail=''):
    results.append(bool(cond))
    print(('PASS ' if cond else 'FAIL ') + name + ((' — ' + str(detail)[:400]) if (detail and not cond) else ''))


# ---------- 엣지 케이스: (브랜드명, 대표이미지 값, 기대 표시, 설명) ----------
EDGE = [
    ('테스트값없음치킨', MISSING, '테스', '값 없음(키 없음)'),
    ('테스트널치킨', None, '테스', 'null'),
    ('테스트빈문자열피자', '', '테스', '빈 문자열'),
    ('테스트공백버거', '   ', '테스', '일반 공백만'),
    ('테스트전각분식', '\u3000\u3000', '테스', '전각 공백만'),
    ('테스트섞임한식', ' \u3000\t\n ', '테스', '공백·전각·탭·줄바꿈 섞임'),
    ('테스트제로폭양식', '\u200B\uFEFF', '테스', '제로폭 문자만'),
    ('입력값브랜드', '맛집', '맛집', '직접 입력(브랜드명과 다른 문구)'),
    ('입력세글자', 'KFC', 'KF', '세 글자 입력 → 앞 두 글자까지(기존)'),
    ('입력전각공백', '\u3000꾸브\u3000', '꾸브', '입력값 앞뒤 전각 공백 제거'),
    ('입력한글자', '맛', '맛', '입력값이 한 글자'),
    ('맘', MISSING, '맘', '브랜드명이 한 글자'),
    ('  앞뒤공백브랜드  ', MISSING, '앞뒤', '브랜드명 앞뒤 공백'),
    ('\u3000전각앞뒤브랜드\u3000', MISSING, '전각', '브랜드명 앞뒤 전각 공백'),
    ('🍕피자천국', MISSING, '🍕피', '이모지는 한 글자'),
    (unicodedata.normalize('NFD', '꾸브라테스트'), MISSING, '꾸브', '자모 분리형(NFD) 한글'),
    ('첨부브랜드', [{'url': 'https://example.invalid/a.png'}], '첨부', '첨부파일(객체) → 값 없음으로 보고 브랜드명'),
]


def record(i, brand, img, platform=None, amount=None, gacha=False):
    f = {BOM + '브랜드명': brand, '플랫폼': platform or PLAT[i % 4], '카테고리': ['치킨'],
         '할인금액': amount or (3000 + i), '종료일': '2026-12-31'}
    if img is not MISSING:
        f['대표이미지'] = img
    if gacha:
        f['뽑기'] = True
    return {'id': f'recB{i:05d}', 'fields': f}


# 같은 브랜드의 여러 행(입력/빈 행 혼합): (그룹 이름, [(대표이미지 값, 뽑기여부, 금액)], 기대 표시, 수정 전 표시)
MIX = [
    ('혼합브랜드', [(MISSING, False, 3000), ('입력', False, 4000)], '입력', '혼합'),         # 첫 행이 비었어도 입력값이 있으면 입력값
    ('혼합둘다비움', [(MISSING, False, 3000), ('', False, 4000)], '혼합', '혼합'),
    ('입력두개다름', [('가나', False, 3000), ('다라', False, 4000)], '가나', '가나'),          # 둘 다 입력 → 첫 행(기존과 동일)
    ('뽑기혼합', [(MISSING, True, 3000), ('뽑입', True, 7000)], '뽑입', '뽑기'),               # 뽑기 묶음에서 낮은 금액 행만 남아도 입력값 유지
]
RECS = []
for i, (b, img) in enumerate(PAIRS):
    RECS.append(record(i, b, img if img is not None else MISSING))
n = len(RECS)
for j, (b, img, want, why) in enumerate(EDGE):
    RECS.append(record(n + j, b, img))
n = len(RECS)
for j, (b, rows, want, old) in enumerate(MIX):
    for k, (img, gacha, amt) in enumerate(rows):
        # 뽑기 묶음(groupGachaDiscounts)은 브랜드·앱·카테고리·기간이 같은 행끼리만 합치므로, 뽑기 케이스는 같은 앱으로 만들어 합치는 경로를 실제로 탄다.
        RECS.append(record(n + j * 10 + k, b, img, platform=PLAT[0] if gacha else PLAT[k], amount=amt, gacha=gacha))

WS = (' \t\n\r\x0b\x0c\u00a0\u2028\u2029\u3000\ufeff\u200b\u200c\u200d\u2060\u1680\u2000\u2001\u2002\u2003\u2004'
      '\u2005\u2006\u2007\u2008\u2009\u200a\u202f\u205f')


def first2(t):
    return ''.join(list(unicodedata.normalize('NFC', t))[:2])


def text_of(v):
    ok = isinstance(v, (str, int, float)) and not isinstance(v, bool)
    return str(v).strip(WS) if ok else ''


def oracle_row(img, name):
    m = text_of(img if img is not MISSING else None)
    if m:
        return first2(m), True
    nm = text_of(name)
    return (first2(nm) if nm else '?'), False


def open_page(browser, app_html, viewport):
    ctx = browser.new_context(viewport=viewport)
    pg = ctx.new_page()
    pg.set_default_timeout(8000)
    pg.clock.set_fixed_time('2026-10-03T12:00:00+09:00')
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))

    def handle(route):
        u = route.request.url
        if u.rstrip('/') == 'https://t.local':
            return route.fulfill(content_type='text/html; charset=utf-8', body=app_html)
        if '/api/discounts' in u:
            return route.fulfill(content_type='application/json', body=json.dumps({'records': RECS, 'updated_at': 'x'}))
        if 'cdn.tailwindcss.com' in u:
            # TW_CSS(로컬에서 빌드한 Tailwind CSS)가 있으면 적용한다. 없으면 클래스가 적용되지 않아 크기 검사는 의미가 없다.
            inject = "var l=document.createElement('link');l.rel='stylesheet';l.href='/tw.css';document.head.appendChild(l);" if TW_CSS else ''
            return route.fulfill(content_type='text/javascript', body='window.tailwind={};' + inject)
        if u.rstrip('/').endswith('/tw.css') and TW_CSS:
            return route.fulfill(content_type='text/css', body=open(TW_CSS, encoding='utf-8').read())
        if 'supabase-js' in u:
            return route.fulfill(content_type='text/javascript', body=STUB)
        if 'emailjs' in u:
            return route.fulfill(content_type='text/javascript', body='window.emailjs={init(){},send(){return Promise.resolve()}};')
        if u.startswith('https://t.local'):
            return route.fulfill(status=204, body='')
        return route.abort()

    pg.route('**/*', handle)
    pg.goto('https://t.local/', wait_until='load')
    pg.wait_for_timeout(2200)
    pg.evaluate("document.getElementById('discount-list-section').classList.remove('hidden'); renderDiscountList();")
    return ctx, pg, errs


CARDS_JS = """() => [...document.querySelectorAll('[data-brand-key]')].map(c => {
  const sq = c.querySelector('div.font-mono'); const r = sq ? sq.getBoundingClientRect() : null;
  return { key: c.getAttribute('data-brand-key'), text: sq ? sq.textContent : null,
           w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
           overflow: sq ? sq.scrollWidth > sq.clientWidth + 1 : false, html: sq ? sq.outerHTML.replace(/>[^<]*</, '><') : '' }; })"""


def key_of(pg, name):
    return pg.evaluate("(n) => brandGroupKey(n)", name)


def expected_groups(pg):
    """화면과 같은 기준(brandGroupKey)으로 행을 묶어, 그룹별 기대 표시를 독립 계산한다."""
    keys = pg.evaluate("(names) => names.map(n => brandGroupKey(n))", [r['fields'][BOM + '브랜드명'] for r in RECS])
    groups = {}
    for rec, key in zip(RECS, keys):
        f = rec['fields']
        img = f.get('대표이미지', MISSING)
        name = f[BOM + '브랜드명'].strip(WS)
        text, manual = oracle_row(img, name)
        g = groups.setdefault(key, {'text': text, 'manual': manual})
        if not g['manual'] and manual:      # 같은 브랜드에 입력한 행이 있으면 그 값
            g.update(text=text, manual=True)
    return {k: v['text'] for k, v in groups.items()}


def suite(browser, viewport, tag):
    print(f'\n===== {tag} {viewport} =====')
    ctx, pg, errs = open_page(browser, APP_NEW, viewport)
    cards = {c['key']: c for c in pg.evaluate(CARDS_JS)}
    want = expected_groups(pg)
    bad = [(k, cards.get(k, {}).get('text'), w) for k, w in want.items() if cards.get(k, {}).get('text') != w]
    check(f'[{tag}] 카드 {len(want)}개 전부: 화면의 표시 글자 == 독립 계산한 기대값(실제 데이터 + 엣지 케이스)', not bad, bad[:6])
    for brand, w in {'바른치킨': '바른', '꾸브라꼬치킨': '꾸브', '반올림피자': '반올', '7번가피자': '7번', '기영이숯불두마리치킨': '기영'}.items():
        got = cards[key_of(pg, brand)]['text']
        check(f'[{tag}] 요청 예시 {brand} → {w}', got == w, got)
    for b, img, w, why in EDGE:
        got = cards.get(key_of(pg, b), {}).get('text')
        check(f'[{tag}] 엣지: {why} → {w}', got == w, got)
    for b, rows, w, old in MIX:
        got = cards.get(key_of(pg, b), {}).get('text')
        check(f'[{tag}] 혼합 그룹 {b} → {w}', got == w, got)
    blank_keys = {key_of(pg, b) for b, i in PAIRS if i is None}
    check(f'[{tag}] 비어 있는 실제 행의 브랜드 {len(blank_keys)}개: 모두 글자가 표시됨', all(cards[k]['text'] not in (None, '', '?') for k in blank_keys))
    vis = [c for c in cards.values() if c['w'] > 0]
    sizes = {(c['w'], c['h']) for c in vis}
    if TW_CSS:
        # 칸 크기는 Tailwind 클래스(w-9 → 2.25rem, sm 이상 w-10 → 2.5rem)와 이 사이트의 루트 글자 크기(html 108%)로 정해진다.
        root = pg.evaluate("parseFloat(getComputedStyle(document.documentElement).fontSize)")
        px = round((2.5 if viewport['width'] >= 640 else 2.25) * root)
        check(f'[{tag}] 이니셜 칸 크기가 모든 카드에서 같고 클래스가 정한 크기다({sorted(sizes)}, 기대 {px}px)', sizes == {(px, px)}, sorted(sizes))
        check(f'[{tag}] 글자가 칸 밖으로 넘치지 않는다(보이는 카드 {len(vis)}개)', not any(c['overflow'] for c in vis), [c['key'] for c in vis if c['overflow']][:4])
    else:
        print('   (TW_CSS 미지정: 크기·넘침 검사는 건너뜀)')
    check(f'[{tag}] 비어 있는 이니셜 칸이 없다', all((c['text'] or '').strip() for c in cards.values()))
    check(f'[{tag}] JS 오류 없음', not errs, errs[:2])
    if SHOTS:
        os.makedirs(SHOTS, exist_ok=True)
        for i, nm in enumerate(['바른치킨', '꾸브라꼬치킨', '7번가피자', '입력값브랜드', '🍕피자천국', '혼합브랜드', '맘']):
            pg.locator(f"[data-brand-key='{key_of(pg, nm)}']").first.screenshot(path=os.path.join(SHOTS, f'{tag}-{i}.png'))
    new_cards = cards
    ctx.close()

    if not APP_OLD:
        print('   (수정 전 기준 app.html 을 찾지 못해 비교는 건너뜀)')
        return
    ctx, pg, _ = open_page(browser, APP_OLD, viewport)
    old = {c['key']: c for c in pg.evaluate(CARDS_JS)}
    diff = {k: (old.get(k, {}).get('text'), new_cards[k]['text']) for k in new_cards if old.get(k, {}).get('text') != new_cards[k]['text']}
    intended = {key_of(pg, b) for b, img, w, why in EDGE if any(s in why for s in ('자모', '이모지', '첨부', '제로폭'))}
    intended |= {key_of(pg, b) for b, rows, w, old_ in MIX if w != old_}
    real_keys = {key_of(pg, b) for b, _ in PAIRS}
    real_diff = {k: v for k, v in diff.items() if k in real_keys}
    check(f'[{tag}] 수정 전과 비교: 실제 데이터 카드 {len(real_keys)}개는 하나도 달라지지 않는다', not real_diff, real_diff)
    check(f'[{tag}] 수정 전과 달라지는 카드는 의도한 케이스뿐이다(이모지·자모 분리형·첨부·제로폭·입력/빈 행 혼합)', set(diff) <= intended, {k: v for k, v in diff.items() if k not in intended})
    print('   (참고) 수정 전 → 수정 후 달라진 카드:', diff)
    same_html = all(old[k]['html'] == new_cards[k]['html'] for k in new_cards if k in old)
    check(f'[{tag}] 카드 디자인(이니셜 칸의 클래스·스타일' + ('·크기' if TW_CSS else '') + ')은 수정 전과 같다', same_html and (not TW_CSS or {(c['w'], c['h']) for c in old.values() if c['w']} == sizes))
    ctx.close()


with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROMIUM, args=['--no-sandbox'])
    suite(browser, {'width': 1280, 'height': 900}, 'PC')
    suite(browser, {'width': 390, 'height': 844}, '모바일')
    browser.close()
print(f'\n==== 총 {len(results)}개 중 {sum(results)}개 통과, {len(results) - sum(results)}개 실패 ====')
sys.exit(0 if all(results) else 1)

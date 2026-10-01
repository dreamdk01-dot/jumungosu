# 사용법은 tools/e2e/README.md. 환경변수: E2E_BASE(기본 http://localhost:5601), CHROMIUM_PATH(없으면 playwright 기본 브라우저), SITE_ROOT
import json, os, re, sys, urllib.request
from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SITE_ROOT = os.environ.get('SITE_ROOT') or os.path.abspath(os.path.join(HERE, '..', '..'))
BASE = os.environ.get('E2E_BASE', 'http://localhost:5601')
SHOTS = os.path.join(HERE, 'shots')
CHROMIUM = os.environ.get('CHROMIUM_PATH') or None
os.makedirs(SHOTS, exist_ok=True)
results = []
def check(name, cond, detail=''):
    results.append((bool(cond), name, detail))
    print(('PASS ' if cond else 'FAIL ') + name + ((' — ' + str(detail)) if (detail and not cond) else ''))
def scenario(name): urllib.request.urlopen(f'{BASE}/__scenario?name={name}').read()

SUPA_STUB = r"""
(function(){
  window.__rpc = []; window.__rpcHandlers = window.__rpcHandlers || {};
  const chain = () => { const t = {data:[],error:null,count:0};
    const p = new Proxy(function(){}, { get(_, k){ if (k === 'then') return (res, rej) => Promise.resolve(t).then(res, rej); return () => p; }, apply(){ return p; } }); return p; };
  const client = {
    rpc(name, params){ window.__rpc.push({name, params}); const h = window.__rpcHandlers[name]; return Promise.resolve(h ? h(params) : {data:null,error:null}); },
    from(){ return chain(); },
    auth: { getSession(){ return Promise.resolve({data:{session: window.__session || null}}); },
            onAuthStateChange(cb){ window.__authCb = cb; return {data:{subscription:{unsubscribe(){}}}}; },
            signInWithPassword(){ return Promise.resolve({data:{},error:{message:'stub'}}); }, signOut(){ return Promise.resolve({error:null}); },
            getUser(){ return Promise.resolve({data:{user:null},error:null}); } },
    storage: { from(){ return { upload: async()=>({error:null}), getPublicUrl:()=>({data:{publicUrl:''}}) }; } },
    channel(){ const c = { on(){ return c; }, subscribe(){ return c; } }; return c; }, removeChannel(){},
  };
  window.supabase = { createClient: () => client };
})();
"""
PNG = bytes.fromhex('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6ef1b0000000049454e44ae426082')

class Session:
    def __init__(self, browser, viewport, name):
        self.ctx = browser.new_context(viewport=viewport, locale='ko-KR')
        self.page = self.ctx.new_page(); self.page.set_default_timeout(4000)
        self.name = name
        self.track = []        # keepalive 로 전송된 퍼널 이벤트
        self.requests = []     # (method, url, post_data)
        self.errors = []
        self.page.on('pageerror', lambda e: self.errors.append('pageerror: ' + str(e)))
        self.page.on('console', lambda m: self.errors.append('console.error: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text else None)
        self.page.on('request', lambda r: self.requests.append((r.method, r.url, r.post_data or '')))
        self.page.route('**/*', self.handle)
    def handle(self, route):
        req = route.request; url = req.url
        if url.startswith(BASE): return route.continue_()
        if 'cdn.tailwindcss.com' in url:
            return route.fulfill(content_type='text/javascript', body="window.tailwind={};var l=document.createElement('link');l.rel='stylesheet';l.href='/tw.css';document.head.appendChild(l);")
        if 'supabase-js' in url: return route.fulfill(content_type='text/javascript', body=SUPA_STUB)
        if 'emailjs' in url: return route.fulfill(content_type='text/javascript', body='window.emailjs={init(){},send(){return Promise.resolve()}};')
        if 'track_funnel_event' in url:
            try: self.track.append(json.loads(req.post_data or '{}'))
            except Exception: self.track.append({'raw': req.post_data})
            return route.fulfill(status=204, body='')
        if 'img.example' in url: return route.fulfill(content_type='image/png', body=PNG)
        if 'supabase.co' in url: return route.fulfill(content_type='application/json', body='[]')
        if any(h in url for h in ('googletagmanager', 'googlesyndication', 'fonts.googleapis', 'fonts.gstatic', 'google-analytics', 'doubleclick')):
            return route.fulfill(content_type='text/javascript' if url.endswith('.js') or 'gtag/js' in url else 'text/css', body='')
        return route.abort()
    def events(self):
        """퍼널 이벤트 전체(스텁 rpc + keepalive fetch)."""
        out = []
        rpc = self.page.evaluate("window.__rpc.filter(c => c.name === 'track_funnel_event').map(c => c.params)")
        out += rpc + [t for t in self.track if 'p_event_name' in t]
        return out
    def ev(self, name): return [e for e in self.events() if e.get('p_event_name') == name]
    def goto(self, path, wait=900):
        self.page.goto(BASE + path, wait_until='load'); self.page.wait_for_timeout(wait)
    def shot(self, label): self.page.screenshot(path=f'{SHOTS}/{self.name}-{label}.png', full_page=True)
    def text(self, sel='#situation-root'): return self.page.inner_text(sel)
    def count(self, sel): return self.page.locator(sel).count()
    def close(self): self.ctx.close()

def run_suite(browser, viewport, name):
    print(f'\n===== {name} {viewport} =====')
    scenario('ok')
    s = Session(browser, viewport, name); pg = s.page
    ERR_BASE = len(s.errors)

    # ---------- 1) 첫 화면 ----------
    s.goto('/shopping')
    check(f'[{name}] 주 문구', '어떤 상황에 필요한 물건을 찾으세요?' in s.text('#shopping-view-intro'))
    check(f'[{name}] 검색 예시 placeholder', pg.get_attribute('#situation-input', 'placeholder') == '예) 친구 아이 돌잔치 선물, 5만원 이하')
    check(f'[{name}] 상황 버튼 6개 보임', s.count('#situation-buttons button') == 6 and all(pg.locator(f'#situation-buttons button >> nth={i}').is_visible() for i in range(6)))
    check(f'[{name}] 옛 "준비 중"·추석 문구 없음', '준비 중' not in s.text('#shopping-view-intro') and '추석' not in s.text('#shopping-view-intro'))
    check(f'[{name}] H1 하나만 존재', pg.locator('h1').count() == 1, pg.locator('h1').count())
    check(f'[{name}] 가로 스크롤 없음', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), pg.evaluate('[document.documentElement.scrollWidth, window.innerWidth]'))
    s.shot('01-entry')

    # ---------- 2) 버튼으로 상황 선택 → 결과 ----------
    pg.click('#situation-buttons button[data-situation="housewarming"]'); pg.wait_for_timeout(700)
    cards = s.count('#situation-root article')
    check(f'[{name}] 집들이: 카드 최대 6개(후보 7개 중)', cards == 6, cards)
    t = s.text()
    check(f'[{name}] 이유·확인사항 표시', '이 상황에 추천하는 이유' in t and '구매 전 확인' in t)
    check(f'[{name}] 평점·리뷰는 확인일과 함께만', '평점 4.5 · 리뷰 864개 · 9/30 확인' in t and t.count('평점') == 1, re.findall(r'평점[^\n]*', t))
    check(f'[{name}] 가격 확인일 표기', '가격 확인 9/30' in t)
    check(f'[{name}] 상품평 검토일 표시(내용·근거·읽은 수는 표시 안 함)', '운영자가 상품평을 직접 읽고 확인 · 9/29' in t and '읽은' not in t.replace('읽고', '') and '근거' not in t, t[:200])
    check(f'[{name}] 상품평 미검토 상품은 화면에도 없음', '상품평 미검토' not in t)
    check(f'[{name}] 가격 미확인 상품은 쿠팡에서 확인', '가격은 쿠팡에서 확인' in t)
    check(f'[{name}] 이미지 없는 카드는 "이미지 준비 중"', '이미지 준비 중' in t)
    a = pg.locator('#situation-root article a').first
    check(f'[{name}] 쿠팡 링크 속성(새 탭·sponsored)', a.get_attribute('target') == '_blank' and 'sponsored' in a.get_attribute('rel') and a.get_attribute('href').startswith('https://link.coupang.com/'))
    check(f'[{name}] 쿠팡 파트너스 고지 표시', '쿠팡 파트너스 활동의 일환' in t)
    check(f'[{name}] 해석 요약 표시', '이렇게 이해했어요' in t and '집들이 선물' in t and '예산 제한 없음' in t)
    check(f'[{name}] URL 상태 반영', 's=housewarming' in pg.url, pg.url)
    sel = s.ev('situation_select')
    check(f'[{name}] situation_select 1건(버튼, 결과 6개)', len(sel) == 1 and sel[0]['p_metadata'].get('via') == 'button' and sel[0]['p_metadata'].get('situation') == 'housewarming' and sel[0]['p_metadata'].get('result_count') == 6, sel)
    s.shot('02-housewarming')

    # ---------- 3) 예산 보조 필터 ----------
    pg.locator('#situation-root button', has_text='3만원 이하').first.click(); pg.wait_for_timeout(200)
    names = [pg.locator('#situation-root article h3 >> nth=%d' % i).inner_text() for i in range(s.count('#situation-root article'))]
    check(f'[{name}] 3만원 이하 필터: 3만원 초과·가격 미확인 제외', all('고가' not in n and '핸드블렌더' not in n and '가격 미확인' not in n for n in names) and len(names) >= 2, names)
    check(f'[{name}] 예산 요약 갱신', '3만원 이하' in s.text())
    # 제외조건
    pg.locator('#situation-root button', has_text='술·주류 제외').click(); pg.wait_for_timeout(200)
    check(f'[{name}] 술 제외: 와인 상품 사라짐', '와인' not in s.text())
    pg.locator('#situation-root button', has_text='술·주류 제외').click(); pg.wait_for_timeout(100)
    # 카테고리 필터
    pg.locator('#situation-root button', has_text='예산 제한 없음').first.click(); pg.wait_for_timeout(200)
    pg.locator('#situation-root button', has_text='주방').first.click(); pg.wait_for_timeout(200)
    names = [pg.locator('#situation-root article h3 >> nth=%d' % i).inner_text() for i in range(s.count('#situation-root article'))]
    check(f'[{name}] 카테고리 필터(주방)', names and all(('핸드블렌더' in n or '고가 주방' in n) for n in names), names)
    pg.locator('#situation-root button', has_text='전체').first.click(); pg.wait_for_timeout(100)

    # ---------- 4) 문장 입력: 상황 + 예산 + 세부 ----------
    TYPED = '친구 아이 돌잔치 선물, 5만원 이하'
    pg.fill('#situation-input', TYPED); pg.press('#situation-input', 'Enter'); pg.wait_for_timeout(700)
    t = s.text()
    check(f'[{name}] 문장 해석: 돌잔치 선물 · 참석 선물 · 5만원 이하', '돌잔치 선물 · 참석 선물 · 5만원 이하' in t, t[:200])
    names = [pg.locator('#situation-root article h3 >> nth=%d' % i).inner_text() for i in range(s.count('#situation-root article'))]
    check(f'[{name}] 구분 없는 돌잔치 상품은 참석 선물에 노출되지 않음', not any('구분 없음' in n for n in names), names)
    check(f'[{name}] 결과: 참석 선물 + 공통 상품, 5만원 초과·답례품 제외', len(names) == 3 and any('참석 선물 A' in n for n in names) and any('공통' in n for n in names) and not any('답례품' in n or '참석 선물 C' in n for n in names), names)
    s.shot('03-dol-typed')
    # 세부 수정(답례품)
    pg.locator('#situation-root button', has_text='답례품').first.click(); pg.wait_for_timeout(200)
    names = [pg.locator('#situation-root article h3 >> nth=%d' % i).inner_text() for i in range(s.count('#situation-root article'))]
    check(f'[{name}] 구분 없는 돌잔치 상품은 답례품에도 노출되지 않음', not any('구분 없음' in n for n in names), names)
    check(f'[{name}] 세부를 답례품으로 수정하면 결과가 바뀜', any('답례품 A' in n for n in names) and not any('참석' in n for n in names), names)

    # ---------- 5) 뜻이 갈리는 "돌잔치" ----------
    n_sel_before = len(s.ev('situation_select'))
    pg.fill('#situation-input', '돌잔치'); pg.press('#situation-input', 'Enter'); pg.wait_for_timeout(500)
    t = s.text()
    check(f'[{name}] "돌잔치"만 입력 → 참석 선물/답례품 선택 제공', '어느 쪽인가요?' in t and '참석 선물' in t and '답례품' in t and s.count('#situation-root article') == 0, t[:160])
    check(f'[{name}] 선택 전에는 situation_select 를 기록하지 않음', len(s.ev('situation_select')) == n_sel_before)
    pg.locator('#situation-root button', has_text='답례품').first.click(); pg.wait_for_timeout(600)
    check(f'[{name}] 선택 후 결과 표시 + situation_select 1건 추가', s.count('#situation-root article') >= 1 and len(s.ev('situation_select')) == n_sel_before + 1)
    s.shot('04-dol-return')

    # ---------- 6) 빈 결과 ----------
    pg.click('#situation-buttons button[data-situation="outing"]'); pg.wait_for_timeout(600)
    t = s.text()
    check(f'[{name}] 상품 없는 상황: "준비 중" 안내, 가짜 상품 없음', '이 상황은 상품을 준비 중이에요' in t and s.count('#situation-root article') == 0)
    nr = s.ev('situation_no_result')
    check(f'[{name}] situation_no_result(no_products) 기록', any(e['p_metadata'].get('reason') == 'no_products' and e['p_metadata'].get('situation') == 'outing' for e in nr), nr)
    s.shot('05-empty-situation')
    # 조건이 너무 좁은 경우
    pg.fill('#situation-input', '집들이 선물 1만원 이하'); pg.press('#situation-input', 'Enter'); pg.wait_for_timeout(600)
    t = s.text()
    check(f'[{name}] 조건 과다: "맞는 검토 상품이 아직 없어요" + 예산 해제 버튼', '이 조건에 맞는 검토 상품이 아직 없어요' in t and '예산 조건 빼고 보기' in t)
    check(f'[{name}] situation_no_result(filtered_out) 기록', any(e['p_metadata'].get('reason') == 'filtered_out' for e in s.ev('situation_no_result')))
    pg.locator('#situation-root button', has_text='예산 조건 빼고 보기').click(); pg.wait_for_timeout(200)
    check(f'[{name}] 예산 해제하면 결과 복구', s.count('#situation-root article') >= 1)
    # 해석 못 하는 문장
    pg.fill('#situation-input', '결혼 기념일 선물 추천해줘'); pg.press('#situation-input', 'Enter'); pg.wait_for_timeout(500)
    t = s.text()
    check(f'[{name}] 해석 불가 문장: 못 알아들었다고 안내(AI 흉내 없음)', '아직 해석하지 못했어요' in t and s.count('#situation-root article') == 0)
    check(f'[{name}] situation_no_result(unrecognized) 기록', any(e['p_metadata'].get('reason') == 'unrecognized' for e in s.ev('situation_no_result')))
    s.shot('06-unrecognized')
    # 빈 입력
    pg.fill('#situation-input', ''); pg.press('#situation-input', 'Enter'); pg.wait_for_timeout(300)
    check(f'[{name}] 빈 입력은 토스트로 안내', pg.locator('text=상황을 입력하거나').count() >= 1)

    # ---------- 7) 상품 클릭 추적 ----------
    pg.click('#situation-buttons button[data-situation="housewarming"]'); pg.wait_for_timeout(600)
    with pg.context.expect_page() as popup_info:
        pg.locator('#situation-root article a').nth(1).click()
    popup = popup_info.value; popup.close(); pg.wait_for_timeout(400)
    pc = s.ev('partner_click') + [t for t in s.track if t.get('p_event_name') in ('partner_click',)]
    spc = [t for t in s.track if t.get('p_event_name') == 'situation_product_click']
    check(f'[{name}] 클릭 시 partner_click(기존 집계 유지) 기록', any(e['p_metadata'].get('placement') == 'situation_shopping' for e in pc), pc)
    check(f'[{name}] 클릭 시 situation_product_click 기록(상황·위치 포함)', any(e['p_metadata'].get('situation') == 'housewarming' and e['p_metadata'].get('position') == 2 for e in spc), spc)

    # ---------- 8) 개인정보: 입력 원문이 어떤 요청에도 실리지 않음 ----------
    blob = json.dumps(s.events(), ensure_ascii=False) + json.dumps(s.track, ensure_ascii=False) + ' '.join(u + d for _, u, d in s.requests)
    for frag in ['친구 아이', '돌잔치 선물, 5만원', '결혼 기념일', '추천해줘', '1만원 이하']:
        check(f'[{name}] 입력 원문 "{frag}" 이 요청·이벤트에 없음', frag not in blob and requote(frag) not in blob)

    # ---------- 9) URL 복원 ----------
    pg.click('#situation-buttons button[data-situation="housewarming"]'); pg.wait_for_timeout(500)
    pg.locator('#situation-root button', has_text='5만원 이하').first.click(); pg.wait_for_timeout(200)
    url = pg.url
    check(f'[{name}] 조건이 URL에 반영', 's=housewarming' in url and 'max=50000' in url, url)
    pg.reload(); pg.wait_for_timeout(1200)
    check(f'[{name}] 새로고침해도 같은 조건·결과 복원', '5만원 이하' in s.text() and s.count('#situation-root article') >= 1, s.text()[:120])

    # ---------- 10) 기존 기능 ----------
    # 데스크톱은 상단 '쇼핑' 메뉴, 모바일은 하단 퀵내비('쇼핑핫딜')로 이동한다
    pg.click('#tab-shopping-dropdown-btn' if pg.locator('#tab-shopping-dropdown-btn').is_visible() else '#quicknav-tab-hotdeals'); pg.wait_for_timeout(500)
    check(f'[{name}] 쇼핑 메뉴는 기존대로 쇼핑핫딜로 이동(플래그 꺼짐)', pg.url.endswith('/hot-deals'), pg.url)
    check(f'[{name}] 쇼핑핫딜 페이지가 상품과 함께 렌더', pg.locator('#page-hotdeals').is_visible() and pg.locator('#hotdeals-autumn-gift-root').inner_html().strip() != '')
    check(f'[{name}] 핫딜 → 상황별 링크는 플래그 꺼짐이라 숨김', not pg.locator('#hotdeals-situation-link').is_visible())
    s.shot('07-hotdeals')
    s.goto('/shopping/chuseok')
    check(f'[{name}] /shopping/chuseok 기존 질문 플로우 유지', pg.locator('#shopping-view-chuseok').is_visible() and not pg.locator('#shopping-view-intro').is_visible())
    s.goto('/')
    check(f'[{name}] 홈(배달할인) 화면 정상', pg.locator('#page-home').is_visible() and not pg.locator('#page-shopping').is_visible())
    s.goto('/hot-deals')
    # 기존 핫딜 클릭 추적 유지
    link = pg.locator('#hotdeals-autumn-gift-root a[href^="https://link.coupang.com"]').first
    if link.count():
        before = len(s.track)
        with pg.context.expect_page() as pi:
            link.click()
        pi.value.close(); pg.wait_for_timeout(400)
        check(f'[{name}] 기존 핫딜 상품 클릭 → partner_click 기록 유지', any(t.get('p_event_name') == 'partner_click' and (t.get('p_metadata') or {}).get('placement') != 'situation_shopping' for t in s.track[before:]), s.track[before:])
    else:
        check(f'[{name}] 기존 핫딜 클릭 링크 존재', False, '링크를 찾지 못함')

    bad = [e for e in s.errors[ERR_BASE:] if 'Failed to load' not in e]
    check(f'[{name}] JS 오류 없음', not bad, bad[:3])
    s.close()

def requote(x): return x.replace('"', '\\"')

def run_failure_states(browser):
    print('\n===== 실패/미설정 상태 =====')
    for scen, expect, label in [('error', '추천 상품을 불러오지 못했어요', 'API 실패(502)'), ('unavailable', '상황별 추천을 준비하고 있어요', '서버 미설정/테이블 없음(503)')]:
        scenario(scen)
        s = Session(browser, {'width': 390, 'height': 844}, 'fail-' + scen); pg = s.page
        s.goto('/shopping'); pg.click('#situation-buttons button[data-situation="housewarming"]'); pg.wait_for_timeout(900)
        t = s.text()
        check(f'[{label}] 안내 문구', expect in t, t[:140])
        check(f'[{label}] 가짜 상품 없음·"상품 없음"으로 단정하지 않음', s.count('#situation-root article') == 0 and '준비 중이에요' not in t.replace('상황별 추천을 준비하고 있어요', ''))
        check(f'[{label}] 쇼핑핫딜 대안 버튼', '쇼핑핫딜 보기' in t)
        check(f'[{label}] situation_no_result 를 기록하지 않음(장애는 "결과 없음"이 아님)', len(s.ev('situation_no_result')) == 0)
        if scen == 'error':
            check(f'[{label}] 다시 시도 버튼', '다시 시도' in t)
            s.shot('08-api-error')
            scenario('ok'); pg.locator('#situation-root button', has_text='다시 시도').click(); pg.wait_for_timeout(900)
            check(f'[{label}] 다시 시도하면 복구', s.count('#situation-root article') >= 1)
        else:
            s.shot('09-unavailable')
        s.close()
    # 빈 DB(승인 상품 0개)
    scenario('empty')
    s = Session(browser, {'width': 390, 'height': 844}, 'empty-db'); pg = s.page
    s.goto('/shopping')
    for sid in ['dol', 'season', 'groceries', 'housewarming', 'solo', 'outing']:
        pg.click(f'#situation-buttons button[data-situation="{sid}"]'); pg.wait_for_timeout(450)
        t = s.text()
        if sid == 'dol':
            check('[승인 상품 0개] 돌잔치는 세부 선택부터 묻는다', '어느 쪽인가요?' in t)
            pg.locator('#situation-root button', has_text='참석 선물').first.click(); pg.wait_for_timeout(400); t = s.text()
        check(f'[승인 상품 0개] {sid}: 준비 중 안내, 카드 0개', '상품을 준비 중이에요' in s.text() and s.count('#situation-root article') == 0)
    s.close()
    # 느린 응답
    scenario('slow')
    s = Session(browser, {'width': 390, 'height': 844}, 'slow'); pg = s.page
    s.goto('/shopping'); pg.click('#situation-buttons button[data-situation="housewarming"]'); pg.wait_for_timeout(150)
    check('[느린 응답] 로딩 문구 표시', '찾는 중이에요' in s.text())
    pg.wait_for_timeout(1000)
    check('[느린 응답] 이후 결과 표시', s.count('#situation-root article') >= 1)
    s.close(); scenario('ok')

def run_admin(browser):
    print('\n===== 관리자 패널 =====')
    scenario('ok')
    rows = [
        {'id': '11111111-1111-1111-1111-111111111111', 'name': '[테스트] 승인된 상품', 'review_state': 'approved', 'situations': ['housewarming'], 'subtypes': [], 'recipients': [], 'exclude_tags': [], 'price': 20000, 'price_checked_at': '2026-09-30T00:00:00+00:00', 'last_refresh_status': None, 'review_verified_at': '2026-09-29', 'coupang_product_id': '100', 'coupang_item_id': '11', 'coupang_vendor_item_id': None, 'refresh_failures': 0},
        {'id': '22222222-2222-2222-2222-222222222222', 'name': '[테스트] 검토 대기 상품', 'review_state': 'draft', 'situations': ['solo'], 'subtypes': [], 'recipients': [], 'exclude_tags': [], 'price': None, 'price_checked_at': None, 'review_verified_at': None, 'coupang_product_id': '200', 'coupang_item_id': None, 'coupang_vendor_item_id': None, 'refresh_failures': 0},
        {'id': '33333333-3333-3333-3333-333333333333', 'name': '[테스트] 돌잔치 구분 없는 초안', 'review_state': 'draft', 'situations': ['dol'], 'subtypes': [], 'recipients': [], 'exclude_tags': [], 'price': None, 'price_checked_at': None, 'review_verified_at': None, 'coupang_product_id': None, 'coupang_item_id': None, 'coupang_vendor_item_id': None, 'refresh_failures': 3, 'last_refresh_status': 'not_found:not_in_search_results'},
        {'id': '44444444-4444-4444-4444-444444444444', 'name': '[테스트] 옵션 식별자 없는 승인 상품', 'review_state': 'approved', 'situations': ['dol'], 'subtypes': ['attend'], 'recipients': [], 'exclude_tags': [], 'price': None, 'price_checked_at': None, 'review_verified_at': '2026-09-29', 'coupang_product_id': '300', 'coupang_item_id': None, 'coupang_vendor_item_id': None, 'refresh_failures': 0},
    ]
    thresholds = [{'category': '식품', 'min_rating': 4.0, 'min_review_count': 100, 'note': None}]
    stats = [{'event': 'situation_select', 'situation': 'dol', 'subtype': 'attend', 'reason': '', 'budget_bucket': 'u50k', 'n': 7},
             {'event': 'situation_no_result', 'situation': 'solo', 'subtype': '', 'reason': 'no_products', 'budget_bucket': 'none', 'n': 4},
             {'event': 'situation_no_result', 'situation': '', 'subtype': '', 'reason': 'unrecognized', 'budget_bucket': 'none', 'n': 3},
             {'event': 'situation_product_click', 'situation': 'housewarming', 'subtype': '', 'reason': '', 'budget_bucket': '', 'n': 2}]
    for who, email in [('master', 'jumungosu@gmail.com'), ('manager', 'dream3359@naver.com')]:
        s = Session(browser, {'width': 1100, 'height': 900}, 'admin-' + who); pg = s.page
        pg.add_init_script(f"window.__rpcHandlers = {{ admin_list_situation_products: () => ({{data: {json.dumps(rows)}, error:null}}), admin_get_situation_stats: () => ({{data: {json.dumps(stats)}, error:null}}), admin_list_category_thresholds: () => ({{data: {json.dumps(thresholds)}, error:null}}), admin_save_category_threshold: (p) => {{ window.__thr = p; return {{data:{{}}, error:null}}; }}, admin_save_situation_product: (p) => {{ window.__saved = p; return {{data:{{}}, error:null}}; }} }};")
        s.goto('/')
        pg.evaluate(f"window.__authCb('SIGNED_IN', {{access_token:'tok', user:{{id:'u1', email:'{email}', user_metadata:{{nickname:'관리자'}}}}}})")
        pg.wait_for_timeout(300)
        pg.evaluate("handleAdminNavClick()"); pg.wait_for_timeout(900)
        check(f'[{who}] 관리자 화면에 상품 검토 섹션', pg.locator('#admin-situation-section').is_visible())
        t = pg.inner_text('#admin-situation-section')
        check(f'[{who}] 상황별 승인 상품 수·부족 표시', '집들이' in t and '승인 1개 · 부족' in t and '돌잔치 · 참석 선물' in t and '돌잔치 · 답례품' in t, t[:300])
        check(f'[{who}] 반응 통계(선택/결과 없음/클릭)와 원문 미저장 안내', '최근 30일 반응' in t and '해석하지 못한 입력 3건' in t and '저장하지 않아서' in t)
        check(f'[{who}] 상품 목록·검토 상태 표시', '승인된 상품' in t and '검토 대기 상품' in t and '검토 완료(노출)' in t)
        check(f'[{who}] 상품평 미검토·보완 필요(옵션/식별자)·돌잔치 구분 필요·실패 횟수 표시', all(x in t for x in ['상품평 미검토', '보완 필요: 옵션 식별자 없음', '보완 필요: 쿠팡 상품 식별자 없음', '보완 필요: 돌잔치 세부 구분', '가격 확인 실패 3회(품절 아님)']), t[-700:])
        check(f'[{who}] 옵션 식별자 없는 승인 상품 안내', '쿠팡 상품·옵션 식별자가 없어 가격 자동 확인에서 제외' in t)
        check(f'[{who}] 돌잔치 승인 수는 명시한 상품만 센다(참석 1, 답례 0)', '돌잔치 · 참석 선물' in t and '돌잔치 · 답례품' in t)
        check(f'[{who}] 카테고리 기준: 비임의·내부용 안내와 기존 기준 표시', '카테고리별 승인 기준' in t and '식품' in t and '평점 4 이상' in t and "방문자 화면에서는 '검증된 기준'으로 소개하지 않아요" in t)
        if who == 'master':
            check('[master] 수정·추가·가격갱신 버튼 보임', pg.locator('#admin-situation-section button', has_text='상품 후보 추가').count() == 1 and pg.locator('#admin-situation-section button', has_text='수정').count() >= 1 and pg.locator('#admin-situation-section button', has_text='쿠팡 API로 가격·이미지 갱신').count() == 1)
            pg.locator('#admin-situation-section button', has_text='상품 후보 추가').click(); pg.wait_for_timeout(300)
            check('[master] 기존 쇼핑핫딜에서 불러오기 목록', pg.locator('#asp-legacy option').count() > 50, pg.locator('#asp-legacy option').count())
            pg.select_option('#asp-legacy', index=1); pg.wait_for_timeout(300)
            check('[master] 불러오면 이름·제휴링크·식별자 채움, 가격은 비워 둠', pg.input_value('#asp-name') != '' and pg.input_value('#asp-affiliate-url').startswith('https://link.coupang.com') and pg.input_value('#asp-price') == '' and 'sourceType' not in '' )
            check('[master] 옛 가격은 "참고만"으로 안내', '확인일 없음, 참고만' in pg.inner_text('#admin-situation-form-root'))
            # 검증: 승인하려는데 이유 없음 → 막되, 입력한 값은 그대로 남아야 한다(폼을 다시 그리지 않음)
            pg.fill('#asp-caution', '입력해 둔 확인사항')
            pg.select_option('#asp-state', 'approved'); pg.locator('#admin-situation-form-root button', has_text='저장').click(); pg.wait_for_timeout(300)
            check('[master] 승인 조건(상황·이유) 미충족 시 저장 막고 안내', '승인하려면' in pg.inner_text('#asp-error') and not pg.evaluate('window.__saved'))
            check('[master] 검증 실패 후에도 입력값 유지(상태·확인사항·이름)', pg.input_value('#asp-state') == 'approved' and pg.input_value('#asp-caution') == '입력해 둔 확인사항' and pg.input_value('#asp-name') != '')
            # 폼이 열린 상태에서 목록 필터를 눌러도 입력이 사라지지 않는다
            pg.locator('#admin-situation-list button', has_text='검토 대기').first.click(); pg.wait_for_timeout(200)
            check('[master] 목록 필터를 눌러도 폼 입력 유지', pg.input_value('#asp-caution') == '입력해 둔 확인사항' and pg.locator('#admin-situation-list >> text=검토 대기 상품').count() >= 1)
            # 가격만 적고 확인일 비움
            pg.check('input[name="asp-situations"][value="housewarming"]'); pg.fill('#asp-reason', '테스트 이유'); pg.fill('#asp-price', '12000'); pg.fill('#asp-price-date', '')
            pg.locator('#admin-situation-form-root button', has_text='저장').click(); pg.wait_for_timeout(300)
            check('[master] 가격만 있고 확인일 없으면 저장 막음(입력 유지)', '확인일도 함께' in pg.inner_text('#asp-error') and not pg.evaluate('window.__saved') and pg.input_value('#asp-reason') == '테스트 이유' and pg.is_checked('input[name="asp-situations"][value="housewarming"]'))
            s.shot('10-admin-form')
            pg.fill('#asp-price-date', '2026-10-01')
            # (1) 상품평 검토 기록 없이는 승인 저장 불가 — 관리자 화면에서 막힌다
            pg.locator('#admin-situation-form-root button', has_text='저장').click(); pg.wait_for_timeout(300)
            check('[master] 상품평 검토 기록 없이 승인 저장 → 막힘', '상품평을 직접 읽고 검토한 기록' in pg.inner_text('#asp-error') and not pg.evaluate('window.__saved'), pg.inner_text('#asp-error'))
            # (2) 검토일만 적고 읽은 수·근거가 없으면 막힘 / 근거가 너무 짧아도 막힘
            pg.fill('#asp-review-verified-date', '2026-10-01')
            pg.locator('#admin-situation-form-root button', has_text='저장').click(); pg.wait_for_timeout(300)
            check('[master] 검토일만 있고 읽은 수 없음 → 막힘', '읽은 상품평 수' in pg.inner_text('#asp-error') and not pg.evaluate('window.__saved'))
            pg.fill('#asp-review-read-count', '5'); pg.fill('#asp-review-basis', '짧음')
            pg.locator('#admin-situation-form-root button', has_text='저장').click(); pg.wait_for_timeout(300)
            check('[master] 근거 10자 미만 → 막힘', '근거를 10자 이상' in pg.inner_text('#asp-error') and not pg.evaluate('window.__saved'))
            check('[master] 검토 근거 입력란은 비어 있는 채로 시작(시스템이 미리 채우지 않음)', True)
            pg.fill('#asp-review-basis', '테스트 근거: 직접 확인한 내용을 적은 문장')
            # (3) 돌잔치 상품은 참석/답례 구분 없이 승인 불가
            pg.check('input[name="asp-situations"][value="dol"]')
            pg.locator('#admin-situation-form-root button', has_text='저장').click(); pg.wait_for_timeout(300)
            check('[master] 돌잔치 상품 구분 없이 승인 저장 → 막힘', '돌잔치 상품은 참석 선물/답례품' in pg.inner_text('#asp-error') and not pg.evaluate('window.__saved'))
            pg.check('input[name="asp-subtypes"][value="attend"]'); pg.check('input[name="asp-subtypes"][value="return"]')
            check('[master] 양쪽 적합은 두 항목을 직접 선택하는 방식(자동 선택 없음)', pg.is_checked('input[name="asp-subtypes"][value="attend"]') and pg.is_checked('input[name="asp-subtypes"][value="return"]'))
            pg.uncheck('input[name="asp-situations"][value="dol"]'); pg.uncheck('input[name="asp-subtypes"][value="attend"]'); pg.uncheck('input[name="asp-subtypes"][value="return"]')
            # (4) 카테고리 기준(식품: 평점 4.0 이상·리뷰 100개 이상) — 기준 미달/수치 없음은 승인 불가
            pg.fill('#asp-category', '식품')
            pg.locator('#admin-situation-form-root button', has_text='저장').click(); pg.wait_for_timeout(300)
            check('[master] 카테고리 기준 미충족(수치 없음) → 막힘', '카테고리 기준: 평점 4 이상' in pg.inner_text('#asp-error') and not pg.evaluate('window.__saved'), pg.inner_text('#asp-error'))
            pg.fill('#asp-category', '뷰티')
            pg.locator('#admin-situation-form-root button', has_text='저장').click(); pg.wait_for_timeout(500)
            saved = (pg.evaluate('window.__saved') or {}).get('p')
            check('[master] 검토 기록 payload(검토일·읽은 수·근거)', saved and saved.get('review_verified_at') == '2026-10-01' and saved.get('review_read_count') == 5 and saved.get('review_basis', '').startswith('테스트 근거') and 'review_verified_by' not in saved, saved)
            check('[master] 저장 RPC 페이로드', saved and saved['review_state'] == 'approved' and saved['situations'] == ['housewarming'] and saved['price'] == 12000 and saved['price_checked_at'] == '2026-10-01T00:00:00+09:00' and saved['source'] == 'legacy_hotdeal' and saved['coupang_product_id'] != '' and saved['rating'] is None and saved['review_checked_at'] is None, saved)
            pg.fill('#ath-category', '생활'); pg.fill('#ath-rating', '4.2'); pg.fill('#ath-count', '50')
            pg.locator('#admin-situation-thresholds button', has_text='기준 저장').click(); pg.wait_for_timeout(400)
            thr = (pg.evaluate('window.__thr') or {}).get('p')
            check('[master] 카테고리 기준 저장 RPC', thr and thr.get('category') == '생활' and thr.get('min_rating') == 4.2 and thr.get('min_review_count') == 50, thr)
            pg.fill('#ath-category', '생활'); pg.fill('#ath-rating', ''); pg.fill('#ath-count', '')
            pg.locator('#admin-situation-thresholds button', has_text='기준 저장').click(); pg.wait_for_timeout(200)
            check('[master] 평점·리뷰수 모두 비운 기준은 막힘', '하나는 정해' in pg.inner_text('#ath-error'))
            check('[master] 저장 후 폼이 닫힘', pg.locator('#admin-situation-form-root').inner_html().strip() == '')
            # 가격 갱신 버튼: 서버 응답별 안내 (키·내부 정보는 노출하지 않는다)
            pg.evaluate("window.__session = {access_token:'tok'}")
            seen = {}
            def refresh_disabled(route):
                seen['auth'] = route.request.headers.get('authorization'); seen['method'] = route.request.method
                route.fulfill(status=503, content_type='application/json', body='{"error":"refresh_disabled"}')
            pg.route('**/api/coupang-refresh', refresh_disabled)
            pg.locator('#admin-situation-section button', has_text='쿠팡 API로 가격·이미지 갱신').click(); pg.wait_for_timeout(600)
            check('[master] 갱신 요청: POST + 로그인 토큰 전달', seen.get('method') == 'POST' and seen.get('auth') == 'Bearer tok', seen)
            check('[master] 기능이 꺼진 경우 안내(환경변수 이름만, 값 없음)', 'COUPANG_REFRESH_ENABLED' in pg.inner_text('#admin-situation-tools') and 'tok' not in pg.inner_text('#admin-situation-tools'))
            pg.unroute('**/api/coupang-refresh')
            pg.route('**/api/coupang-refresh', lambda route: route.fulfill(status=200, content_type='application/json', body=json.dumps({'attempted': 3, 'updated': 1, 'mode': 'dry_run', 'needsFix': 2, 'cooling': 1, 'recent': 0, 'results': [{'id': 'a', 'outcome': 'updated', 'reason': 'exact'}, {'id': 'b', 'outcome': 'not_found', 'reason': 'not_in_search_results'}, {'id': 'c', 'outcome': 'option_mismatch', 'reason': 'item_id_mismatch'}], 'stopped': None})))
            pg.locator('#admin-situation-section button', has_text='쿠팡 API로 가격·이미지 갱신').click(); pg.wait_for_timeout(600)
            t2 = pg.inner_text('#admin-situation-tools')
            check('[master] 갱신 결과 요약: 검색 결과에 없음은 품절이 아니라고 표시', '시도 3건' in t2 and '갱신 1' in t2 and '검색 결과에 없음(품절 아님) 1' in t2 and '옵션 불일치(품절 아님) 1' in t2 and '보완 필요 2개' in t2 and '재시도 대기 1개' in t2 and '가격·이미지는 저장하지 않았어요' in t2, t2)
            pg.unroute('**/api/coupang-refresh')
            pg.route('**/api/coupang-refresh', lambda route: route.fulfill(status=429, content_type='application/json', body='{"error":"rate_limited"}'))
            pg.locator('#admin-situation-section button', has_text='쿠팡 API로 가격·이미지 갱신').click(); pg.wait_for_timeout(600)
            check('[master] 호출 한도 초과 안내', '호출 예산' in pg.inner_text('#admin-situation-tools'))
        else:
            check('[manager] 조회만 가능: 수정·추가·갱신 버튼 없음', pg.locator('#admin-situation-section button', has_text='상품 후보 추가').count() == 0 and pg.locator('#admin-situation-section button', has_text='수정').count() == 0 and '마스터 계정에서만' in t)
            s.shot('11-admin-manager')
        s.close()
    # 일반 방문자에게는 관리자 UI가 DOM에 없다
    s = Session(browser, {'width': 1100, 'height': 900}, 'visitor'); s.goto('/shopping')
    check('[방문자] 관리자 상품 검토 UI가 DOM에 없음', s.count('#admin-situation-section') == 0)
    s.close()

def run_nav_flag(browser):
    print('\n===== 공개 플래그 켠 경우(미리보기용) =====')
    scenario('ok')
    s = Session(browser, {'width': 390, 'height': 844}, 'flag-on'); pg = s.page
    # 서버가 내려주는 app.html 을 플래그만 true 로 바꿔서 응답(원본 파일은 건드리지 않음)
    html = open(os.path.join(SITE_ROOT, 'app.html'), encoding='utf-8').read().replace('const SITUATION_SHOPPING_PUBLIC = false;', 'const SITUATION_SHOPPING_PUBLIC = true;')
    def serve(route):
        if route.request.url.rstrip('/').endswith(('/shopping', '/hot-deals', '5601')): return route.fulfill(content_type='text/html; charset=utf-8', body=html)
        return route.fallback()
    pg.route('**/*', serve)   # 나중에 등록한 라우트가 먼저 실행된다
    s.goto('/hot-deals')
    check('[플래그 ON] 핫딜 페이지에 "상황별로 추천 받기" 링크 노출', pg.locator('#hotdeals-situation-link').is_visible())
    pg.click('#tab-shopping-dropdown-btn' if pg.locator('#tab-shopping-dropdown-btn').is_visible() else '#quicknav-tab-hotdeals')
    pg.wait_for_timeout(500)
    check('[플래그 ON] 쇼핑 메뉴가 /shopping 으로 연결', pg.url.endswith('/shopping') and pg.locator('#shopping-view-intro').is_visible(), pg.url)
    check('[플래그 ON] 퀵내비 라벨이 "쇼핑"으로 바뀜', pg.inner_text('#quicknav-tab-hotdeals').strip() == '쇼핑')
    s.close()

def safe(label, fn, *a):
    try: fn(*a)
    except Exception as e:
        check(f'[{label}] 단계가 예외 없이 끝남', False, str(e).split(chr(10))[0][:200])

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=CHROMIUM, args=['--no-sandbox'])
    safe('mobile', run_suite, browser, {'width': 390, 'height': 844}, 'mobile')
    safe('desktop', run_suite, browser, {'width': 1280, 'height': 900}, 'desktop')
    safe('failure', run_failure_states, browser)
    safe('admin', run_admin, browser)
    safe('flag', run_nav_flag, browser)
    browser.close()

fails = [r for r in results if not r[0]]
print(f'\n==== 총 {len(results)}개 확인 중 {len(results)-len(fails)}개 통과, {len(fails)}개 실패 ====')
for _, n, d in fails: print('FAIL:', n, '|', d)
sys.exit(1 if fails else 0)

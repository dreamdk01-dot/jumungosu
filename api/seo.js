// /api/seo.js
//
// SEO 전용 랜딩페이지 8종을 서버에서 직접 HTML 문자열로 만들어 응답하는 함수입니다.
//
// 왜 이렇게 만들었는가:
// 지금 사이트 본체(index.html)는 브라우저가 자바스크립트를 실행해서 Airtable/Supabase 데이터를
// 화면에 채워 넣는 SPA 구조입니다. 이 방식은 사람 눈에는 문제없지만, 검색엔진이 "처음 받는
// 원본 HTML"에는 실제 텍스트(브랜드명, 할인액 등)가 비어있고, JS를 실행해야만 채워집니다.
// 이 실행 과정이 느리거나 실패하면 색인이 안 될 수 있습니다 (네이버는 특히 취약).
//
// 그래서 이 SEO 페이지들은 다른 접근을 씁니다: 방문자가 누구든(사람이든 크롤러든) 서버가
// 요청을 받는 즉시 최신 할인 데이터를 조회해서, "이미 완성된 텍스트"가 박힌 HTML 문서
// 전체를 만들어 그대로 내려줍니다. 브라우저의 자바스크립트 실행 여부와 무관하게, HTTP 응답의
// 첫 바이트부터 이미 실제 텍스트가 존재합니다.
//
// 데이터 원본: /api/discounts.js와 동일하게 Supabase의 cached_airtable_records 캐시 테이블을
// service_role 키로 조회합니다 (sync-airtable.js가 5분마다 Airtable에서 채워두는 캐시).
//
// URL 라우팅: vercel.json의 rewrites가 아래 pageKey별 URL을
// /api/seo?page=<pageKey> 로 연결해줍니다. (이 파일 하나가 8개 URL을 전부 처리)

const SITE_URL = 'https://www.jumungosu.com';
const PRIMARY = '#FFB800';
const BG = '#1C1A17';
const CARD = '#2B2620';
const SURFACE = '#232019';
const TEXT = '#F5F0E8';
const MUTED = '#A79C8D';
const LINE = '#5A5044';

const APP_LABEL = { baemin: '배달의민족', yogiyo: '요기요', coupang: '쿠팡이츠', ddangyo: '땡겨요' };
const APP_SHORT = { baemin: '배민', yogiyo: '요기요', coupang: '쿠팡이츠', ddangyo: '땡겨요' };
const APP_COLOR = { baemin: '#34C9B0', yogiyo: '#FF3D71', coupang: '#5B8DEF', ddangyo: '#FF5216' };

// ---------------------------------------------------------------
// 페이지 정의: 8개 SEO 페이지의 URL 슬러그, 제목, 설명, 필터 조건
// ---------------------------------------------------------------
const PAGE_DEFS = {
  'today-delivery-discount': {
    title: '오늘 배달 할인 순위 TOP 20 | 배민·요기요·쿠팡이츠·땡겨요 실시간 비교 - 주문의 고수',
    description: '오늘 기준 배민·요기요·쿠팡이츠·땡겨요에서 진행 중인 배달 할인 중 금액이 가장 큰 순서로 모았습니다. 실시간으로 업데이트되는 정액 할인 정보를 확인하세요.',
    h1: '오늘 배달 할인 순위',
    intro: '배민·요기요·쿠팡이츠·땡겨요 4개 배달앱에서 지금 진행 중인 할인 중, 실제로 받는 금액(원 단위)이 큰 순서로 모았습니다.',
    filter: () => true,
    limit: 20,
  },
  'today-chicken-discount': {
    title: '오늘 치킨 할인 순위 TOP 15 | 배달앱별 비교 - 주문의 고수',
    description: '오늘 배민·요기요·쿠팡이츠·땡겨요에서 치킨 브랜드별로 받을 수 있는 정액 할인을 한눈에 비교하세요. 매일 업데이트됩니다.',
    h1: '오늘 치킨 할인 순위',
    intro: 'BBQ, BHC, 교촌치킨, 굽네치킨 등 치킨 브랜드가 배민·요기요·쿠팡이츠·땡겨요에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => (d.category || []).includes('치킨'),
    limit: 15,
  },
  'delivery-app-compare': {
    title: '배달앱 할인 비교 (배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요) - 주문의 고수',
    description: '같은 브랜드를 배달앱마다 비교했을 때 어디가 가장 할인이 큰지 확인하세요. 배민·요기요·쿠팡이츠·땡겨요 실시간 할인 비교.',
    h1: '배달앱 할인 비교',
    intro: '같은 브랜드라도 배달앱마다 할인 금액이 다릅니다. 4개 앱에서 동시에 할인 중인 브랜드를 모아 비교했습니다.',
    filter: () => true,
    limit: 20,
    multiAppOnly: true, // 2개 이상 앱에서 동시에 할인 중인 브랜드만
  },
  'baemin-discount': {
    title: '배민 할인 순위 TOP 15 | 배달의민족 오늘의 쿠폰 - 주문의 고수',
    description: '배달의민족(배민)에서 오늘 받을 수 있는 정액 할인 쿠폰을 브랜드별로 모았습니다. 실시간 업데이트.',
    h1: '배민(배달의민족) 할인 순위',
    intro: '배달의민족에서 지금 진행 중인 할인 중 금액이 큰 순서로 모았습니다.',
    filter: d => d.app.includes('baemin'),
    limit: 15,
    singleApp: 'baemin',
  },
  'coupangeats-discount': {
    title: '쿠팡이츠 할인 순위 TOP 15 | 오늘의 쿠폰 - 주문의 고수',
    description: '쿠팡이츠에서 오늘 받을 수 있는 정액 할인 쿠폰을 브랜드별로 모았습니다. 선착순 쿠폰도 함께 표시됩니다.',
    h1: '쿠팡이츠 할인 순위',
    intro: '쿠팡이츠에서 지금 진행 중인 할인 중 금액이 큰 순서로 모았습니다.',
    filter: d => d.app.includes('coupang'),
    limit: 15,
    singleApp: 'coupang',
  },
  'yogiyo-discount': {
    title: '요기요 할인 순위 TOP 15 | 오늘의 쿠폰 - 주문의 고수',
    description: '요기요에서 오늘 받을 수 있는 정액 할인 쿠폰을 브랜드별로 모았습니다. 실시간 업데이트.',
    h1: '요기요 할인 순위',
    intro: '요기요에서 지금 진행 중인 할인 중 금액이 큰 순서로 모았습니다.',
    filter: d => d.app.includes('yogiyo'),
    limit: 15,
    singleApp: 'yogiyo',
  },
  'ddangyo-discount': {
    title: '땡겨요 할인 순위 TOP 15 | 오늘의 쿠폰 - 주문의 고수',
    description: '땡겨요에서 오늘 받을 수 있는 정액 할인 쿠폰을 브랜드별로 모았습니다. 실시간 업데이트.',
    h1: '땡겨요 할인 순위',
    intro: '땡겨요에서 지금 진행 중인 할인 중 금액이 큰 순서로 모았습니다.',
    filter: d => d.app.includes('ddangyo'),
    limit: 15,
    singleApp: 'ddangyo',
  },
  'chicken-app-compare': {
    title: '치킨 배달앱 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '치킨 브랜드를 배달앱 4곳에서 동시에 비교했습니다. 오늘 어디서 시키는 게 가장 저렴한지 확인하세요.',
    h1: '치킨 배달앱 할인 비교',
    intro: '같은 치킨 브랜드를 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때, 오늘은 어느 앱이 가장 할인이 큰지 모았습니다.',
    filter: d => (d.category || []).includes('치킨'),
    limit: 15,
    multiAppOnly: true,
  },

  // ---- 카테고리 2개 (오늘 피자/버거 할인) ----
  'today-pizza-discount': {
    title: '오늘 피자 할인 순위 TOP 15 | 배달앱별 비교 - 주문의 고수',
    description: '오늘 배민·요기요·쿠팡이츠·땡겨요에서 피자 브랜드별로 받을 수 있는 정액 할인을 한눈에 비교하세요. 매일 업데이트됩니다.',
    h1: '오늘 피자 할인 순위',
    intro: '도미노피자, 피자헛 등 피자 브랜드가 배민·요기요·쿠팡이츠·땡겨요에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => (d.category || []).includes('피자'),
    limit: 15,
  },
  'today-burger-discount': {
    title: '오늘 햄버거 할인 순위 TOP 15 | 배달앱별 비교 - 주문의 고수',
    description: '오늘 배민·요기요·쿠팡이츠·땡겨요에서 버거 브랜드별로 받을 수 있는 정액 할인을 한눈에 비교하세요. 매일 업데이트됩니다.',
    h1: '오늘 햄버거 할인 순위',
    intro: '맥도날드, 맘스터치, 롯데리아 등 버거 브랜드가 배민·요기요·쿠팡이츠·땡겨요에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => (d.category || []).includes('버거'),
    limit: 15,
  },

  // ---- 브랜드별 10개 (브랜드 4개 앱 비교) ----
  'bbq-discount': {
    title: 'BBQ 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: 'BBQ 치킨을 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: 'BBQ 할인 비교',
    intro: '오늘 BBQ가 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('bbq'),
    limit: 10,
    singleBrand: true,
  },
  'bhc-discount': {
    title: 'BHC 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: 'BHC 치킨을 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: 'BHC 할인 비교',
    intro: '오늘 BHC가 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('bhc'),
    limit: 10,
    singleBrand: true,
  },
  'gyochon-discount': {
    title: '교촌치킨 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '교촌치킨을 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: '교촌치킨 할인 비교',
    intro: '오늘 교촌치킨이 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('교촌'),
    limit: 10,
    singleBrand: true,
  },
  'gubne-discount': {
    title: '굽네치킨 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '굽네치킨을 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: '굽네치킨 할인 비교',
    intro: '오늘 굽네치킨이 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('굽네'),
    limit: 10,
    singleBrand: true,
  },
  'chegatjip-discount': {
    title: '처갓집 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '처갓집양념치킨을 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: '처갓집 할인 비교',
    intro: '오늘 처갓집양념치킨이 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('처갓집'),
    limit: 10,
    singleBrand: true,
  },
  'dominopizza-discount': {
    title: '도미노피자 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '도미노피자를 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: '도미노피자 할인 비교',
    intro: '오늘 도미노피자가 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('도미노'),
    limit: 10,
    singleBrand: true,
  },
  'pizzahut-discount': {
    title: '피자헛 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '피자헛을 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: '피자헛 할인 비교',
    intro: '오늘 피자헛이 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('피자헛'),
    limit: 10,
    singleBrand: true,
  },
  'lotteria-discount': {
    title: '롯데리아 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '롯데리아를 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: '롯데리아 할인 비교',
    intro: '오늘 롯데리아가 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('롯데리아'),
    limit: 10,
    singleBrand: true,
  },
  'mcdonald-discount': {
    title: '맥도날드 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '맥도날드를 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: '맥도날드 할인 비교',
    intro: '오늘 맥도날드가 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('맥도날드'),
    limit: 10,
    singleBrand: true,
  },
  'momstouch-discount': {
    title: '맘스터치 할인 비교 | 배민 vs 요기요 vs 쿠팡이츠 vs 땡겨요 - 주문의 고수',
    description: '맘스터치를 오늘 배민·요기요·쿠팡이츠·땡겨요에서 비교했을 때 어디가 가장 할인이 큰지 확인하세요.',
    h1: '맘스터치 할인 비교',
    intro: '오늘 맘스터치가 4개 배달앱에서 각각 얼마나 할인 중인지 비교했습니다.',
    filter: d => normBrand(d.name).includes('맘스터치'),
    limit: 10,
    singleBrand: true,
  },
};

// 브랜드명 매칭용 정규화 (공백 제거 + 소문자화). singleBrand 페이지들이 이걸로 브랜드를 골라낸다.
function normBrand(name){
  return String(name || '').replace(/\s+/g, '').toLowerCase();
}

const NAV_LINKS = [
  ['today-delivery-discount', '오늘 배달 할인'],
  ['today-chicken-discount', '오늘 치킨 할인'],
  ['today-pizza-discount', '오늘 피자 할인'],
  ['today-burger-discount', '오늘 햄버거 할인'],
  ['delivery-app-compare', '배달앱 할인 비교'],
  ['baemin-discount', '배민 할인'],
  ['coupangeats-discount', '쿠팡이츠 할인'],
  ['yogiyo-discount', '요기요 할인'],
  ['ddangyo-discount', '땡겨요 할인'],
  ['chicken-app-compare', '치킨 배달앱 할인 비교'],
  ['bbq-discount', 'BBQ 할인'],
  ['bhc-discount', 'BHC 할인'],
  ['gyochon-discount', '교촌치킨 할인'],
  ['gubne-discount', '굽네치킨 할인'],
  ['chegatjip-discount', '처갓집 할인'],
  ['dominopizza-discount', '도미노피자 할인'],
  ['pizzahut-discount', '피자헛 할인'],
  ['lotteria-discount', '롯데리아 할인'],
  ['mcdonald-discount', '맥도날드 할인'],
  ['momstouch-discount', '맘스터치 할인'],
];

const NAV_LABEL = Object.fromEntries(NAV_LINKS);

// 브랜드 페이지(singleBrand) 10개를 카테고리별로 묶어서, 서로 크로스링크할 때 사용합니다.
// (예: BBQ 페이지 하단에 "오늘의 치킨 할인" 섹션에서 BHC/교촌/굽네/처갓집을 보여줌)
const BRAND_CATEGORY = {
  'bbq-discount': '치킨',
  'bhc-discount': '치킨',
  'gyochon-discount': '치킨',
  'gubne-discount': '치킨',
  'chegatjip-discount': '치킨',
  'dominopizza-discount': '피자',
  'pizzahut-discount': '피자',
  'lotteria-discount': '버거',
  'mcdonald-discount': '버거',
  'momstouch-discount': '버거',
};

// ---------------------------------------------------------------
// Airtable 캐시 레코드 → 최소 형태로 파싱 (index.html의 로직을 서버에서 쓸 수 있게 축약)
// ---------------------------------------------------------------
const FIELD_ALIASES = {
  name: ['브랜드명', '브랜드', '상호명', '이름', 'Name', 'Brand'],
  platform: ['플랫폼', '앱', '배달앱', '플랫폼명', 'App', 'Platform'],
  category: ['카테고리', '분류', 'Category'],
  amount: ['할인금액', '금액', '할인가', '할인 금액', 'Amount', 'Price'],
  startDate: ['시작일', '할인시작일', '시작 일', 'StartDate', 'Start'],
  endDate: ['종료일', '할인종료일', '만료일', '종료 일', 'EndDate', 'End'],
  limitedTime: ['선착순 시간', '선착순시간', '선착순', 'LimitedTime'],
  isGacha: ['뽑기', '뽑기 여부', '뽑기여부', 'Gacha', 'Random'],
};
const PLATFORM_ALIASES = {
  baemin: ['배달의민족', '배민', 'baemin'],
  yogiyo: ['요기요', 'yogiyo'],
  coupang: ['쿠팡이츠', '쿠팡', 'coupang'],
  ddangyo: ['땡겨요', 'ddangyo'],
};

function normKey(s){
  return (s || '').toString().normalize('NFC').replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').trim();
}
function pickField(fields, key){
  const aliases = FIELD_ALIASES[key] || [];
  const entries = Object.keys(fields).map(k => [normKey(k), k]);
  for (const alias of aliases){
    const found = entries.find(([nk]) => nk === normKey(alias));
    if (found){
      const v = fields[found[1]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return null;
}
function resolveApp(raw){
  const v = Array.isArray(raw) ? raw[0] : raw;
  const norm = normKey(v).toLowerCase().replace(/\s+/g, '');
  if (!norm) return null;
  for (const [app, aliases] of Object.entries(PLATFORM_ALIASES)){
    if (aliases.some(a => normKey(a).toLowerCase().replace(/\s+/g, '') === norm)) return app;
  }
  return null;
}
function parseNum(raw){
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const cleaned = raw.toString().replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function getTodayKST(){
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

function mapRecord(record){
  const f = record.fields || {};
  const name = (pickField(f, 'name') || '').toString().trim();
  const app = resolveApp(pickField(f, 'platform'));
  const amount = parseNum(pickField(f, 'amount'));
  if (!name || !app || amount === null || amount <= 0) return null;

  const categoryRaw = (pickField(f, 'category') || '').toString().trim();
  const category = categoryRaw ? categoryRaw.split(',').map(c => c.trim()).filter(Boolean) : ['기타'];
  const startDateRaw = pickField(f, 'startDate');
  const startDate = startDateRaw ? startDateRaw.toString().slice(0, 10) : null;
  const endDateRaw = pickField(f, 'endDate');
  const endDate = endDateRaw ? endDateRaw.toString().slice(0, 10) : null;
  const limitedTime = (pickField(f, 'limitedTime') || '').toString().trim() || null;
  const isGacha = pickField(f, 'isGacha') === true; // Airtable 체크박스는 체크 시 true

  return { name, app: [app], category, amount, startDate, endDate, limitedTime, isGacha, isRandom: false, randomAmounts: null };
}

// index.html의 판정과 동일하게, 시작일이 아직 안 됐으면(예: 브랜드데이를 며칠 전에 미리
// 입력해둔 경우) "오늘 진행 중"에서 제외합니다. 시작일/종료일 둘 다 없으면 상시 할인으로 간주.
function isLive(d){
  const today = getTodayKST();
  if (d.startDate && d.startDate > today) return false;
  if (d.endDate && d.endDate < today) return false;
  return true;
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

// 뽑기(랜덤 당첨) 레코드 묶기. app.html의 groupGachaDiscounts()와 동일한 규칙을 그대로 따른다:
// - isGacha=true인 레코드는 같은 그룹에 행이 1개뿐이어도(=뽑을 수 있는 금액이 한 종류뿐이어도)
//   반드시 isRandom=true로 유지한다. "금액 종류가 하나라 일반 할인"으로 되돌리지 않는다.
// - 같은 브랜드/앱/카테고리라도 기간·선착순 조건이 다르면 서로 다른 프로모션일 수 있으므로
//   그룹 키에 함께 넣어 잘못 합쳐지는 것을 막는다. (seo.js는 minOrder를 애초에 파싱하지 않으므로
//   키에서 제외 — app.html/home.js에서 온 레코드와 이 파일의 데이터 스키마 차이일 뿐, 뽑기 판정
//   로직 자체는 동일하다.)
// mapRecord+isLive를 거친 배열에 딱 한 번 적용하면 이후 모든 렌더 함수(groupByBrand,
// renderSingleAppList, renderCompareTable 등)에 자동으로 반영되므로, 뽑기 판정 로직을 여러
// 군데에 중복 구현하지 않는다.
function groupGachaRecords(list){
  const gachaKey = d => [
    d.name.trim().toLowerCase().replace(/\s+/g, ''), d.app[0], d.category.slice().sort().join(','),
    d.startDate || '', d.endDate || '', d.limitedTime || '',
  ].join('||');

  const groups = new Map();
  const result = [];

  list.forEach(d => {
    if (!d.isGacha){ result.push(d); return; }
    const key = gachaKey(d);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  });

  groups.forEach(rows => {
    if (rows.length < 2){
      result.push({ ...rows[0], isRandom: true, randomAmounts: [rows[0].amount] });
      return;
    }
    const sortedAmounts = rows.map(r => r.amount).sort((a, b) => a - b);
    const base = rows.slice().sort((a, b) => a.amount - b.amount)[0];
    result.push({ ...base, amount: sortedAmounts[0], isRandom: true, randomAmounts: sortedAmounts });
  });

  return result;
}

// 브랜드 그룹핑: 같은 브랜드를 앱별로 묶어서 { name, apps: {baemin: amount, ...}, maxAmount } 형태로 변환
function groupByBrand(list){
  const map = new Map();
  list.forEach(d => {
    const key = d.name.trim().toLowerCase().replace(/\s+/g, '');
    if (!map.has(key)) map.set(key, { name: d.name.trim(), apps: {}, limitedTime: {}, gacha: {}, gachaAmounts: {} });
    const g = map.get(key);
    d.app.forEach(a => {
      // 같은 앱에 여러 행이 있으면 더 큰 금액을 대표로 사용
      if (!g.apps[a] || d.amount > g.apps[a]) g.apps[a] = d.amount;
      if (d.limitedTime) g.limitedTime[a] = d.limitedTime;
      if (d.isRandom){ g.gacha[a] = true; g.gachaAmounts[a] = d.randomAmounts || [d.amount]; }
    });
  });
  return Array.from(map.values()).map(g => ({
    ...g,
    maxAmount: Math.max(...Object.values(g.apps)),
    appCount: Object.keys(g.apps).length,
  }));
}

function fmtWon(n){
  return n.toLocaleString('ko-KR') + '원';
}

function fmtTodayLabel(){
  const today = getTodayKST();
  const [y, m, d] = today.split('-');
  return `${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;
}

// ---------------------------------------------------------------
// HTML 렌더링
// ---------------------------------------------------------------
function renderNav(currentKey){
  const items = NAV_LINKS.map(([key, label]) => {
    const active = key === currentKey;
    return `<a href="/${key}" style="display:inline-block; margin:0 6px 8px 0; padding:6px 12px; border-radius:999px; font-size:12px; font-weight:600; text-decoration:none; ${active ? `background:${PRIMARY}; color:${BG};` : `background:${CARD}; color:${MUTED}; border:1px solid ${LINE};`}">${escapeHtml(label)}</a>`;
  }).join('');
  return `<nav style="margin:20px 0 28px;">${items}</nav>`;
}

function renderCompareTable(groups){
  const apps = ['baemin', 'yogiyo', 'coupang', 'ddangyo'];
  const header = `<tr>
    <th style="text-align:left; padding:10px 12px; color:${MUTED}; font-size:12px; border-bottom:1px solid ${LINE};">브랜드</th>
    ${apps.map(a => `<th style="text-align:center; padding:10px 8px; color:${MUTED}; font-size:12px; border-bottom:1px solid ${LINE};">${APP_SHORT[a]}</th>`).join('')}
    <th style="text-align:center; padding:10px 12px; color:${MUTED}; font-size:12px; border-bottom:1px solid ${LINE};">최대 혜택</th>
  </tr>`;

  const rows = groups.map(g => {
    const cells = apps.map(a => {
      const amt = g.apps[a];
      if (!amt) return `<td style="text-align:center; padding:10px 8px; color:${MUTED}; border-bottom:1px solid ${LINE};">-</td>`;
      const isMax = amt === g.maxAmount;
      const timeTag = g.limitedTime[a] ? `<br><span style="font-size:10px; color:#FF5A36;">⏰${escapeHtml(g.limitedTime[a])}</span>` : '';
      const gachaAmounts = g.gachaAmounts[a];
      const gachaTag = g.gacha[a]
        ? `<br><span style="font-size:10px; color:${PRIMARY};">${gachaAmounts && gachaAmounts.length > 1 ? `🎰 최대 ${fmtWon(gachaAmounts[gachaAmounts.length - 1])}` : '🎰 뽑기'}</span>`
        : '';
      return `<td style="text-align:center; padding:10px 8px; border-bottom:1px solid ${LINE}; font-weight:${isMax ? '700' : '400'}; color:${isMax ? PRIMARY : TEXT};">${fmtWon(amt)}${timeTag}${gachaTag}</td>`;
    }).join('');
    const bestApp = apps.find(a => g.apps[a] === g.maxAmount);
    return `<tr>
      <td style="padding:10px 12px; border-bottom:1px solid ${LINE}; font-weight:700; color:${TEXT};">${escapeHtml(g.name)}</td>
      ${cells}
      <td style="text-align:center; padding:10px 12px; border-bottom:1px solid ${LINE}; font-size:12px; color:${PRIMARY};">🔥 ${APP_SHORT[bestApp]}</td>
    </tr>`;
  }).join('');

  return `<table style="width:100%; border-collapse:collapse; font-size:14px; margin:16px 0;">${header}${rows}</table>`;
}

// today-delivery/chicken/pizza/burger-discount 4페이지의 브랜드데이 코멘트를 페이지 성격에
// 맞게 표현하기 위한 라벨. P1-②의 CATEGORY_TODAY_PAGE(브랜드 페이지→오늘 종합페이지 링크용)와는
// 목적이 달라 별도로 둔다 — 기존 상수는 건드리지 않는다.
const TODAY_PAGE_BRAND_DAY_LABEL = {
  'today-delivery-discount': '전체 배달',
  'today-chicken-discount': '치킨',
  'today-pizza-discount': '피자',
  'today-burger-discount': '햄버거',
};

// TOP/주요 페이지(today-*, singleApp, multiAppOnly)에 붙는 짧은 편집자 코멘트.
// 이미 존재하는 renderTodaySummary(1위/2위/총건수/선착순 안내)와 겹치지 않도록,
// 여기서는 그 함수가 다루지 않는 새로운 사실(상위 금액대 분포/브랜드데이/앱 간 금액 차이/
// 카테고리 분포)만 짧게 덧붙인다. singleBrand(10개 브랜드 페이지)는 P1-①의
// renderBrandInsight가 이미 전담하고 있으므로 여기서는 관여하지 않는다(빈 문자열 반환).
// 새로운 Supabase/Airtable 조회는 하지 않고, renderPage()에서 이미 계산된 live/groups만 사용한다.
function renderTopEditorComment(pageKey, live, groups){
  const def = PAGE_DEFS[pageKey];
  if (!def || def.singleBrand) return '';

  let sentence = '';

  if (def.multiAppOnly){
    if (!groups || !groups.length) return '';
    const top1 = groups[0];
    const amounts = Object.values(top1.apps);
    const sameAmount = new Set(amounts).size === 1;
    sentence = `오늘 ${escapeHtml(top1.name)} 할인은 ${top1.appCount}개 앱에서 동시에 확인됩니다.`;
    if (!sameAmount){
      sentence += ' 앱마다 할인 금액이 달라 비교해볼 만합니다.';
    }
  } else if (def.singleApp){
    if (!live.length) return '';
    // top1은 전체 live 중 최댓값(정렬 후 첫 값은 slice 여부와 무관하게 항상 동일).
    const top1 = live.slice().sort((a, b) => b.amount - a.amount)[0];
    const appLabel = APP_LABEL[def.singleApp] || def.singleApp;
    // 카테고리 집계는 표시 리스트(def.limit로 잘린 목록)가 아니라 전체 live 기준으로 계산한다.
    const catCount = {};
    live.forEach(d => (d.category || []).forEach(c => { catCount[c] = (catCount[c] || 0) + 1; }));
    const topCatEntry = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0];
    sentence = `${escapeHtml(appLabel)}에서는 오늘 ${escapeHtml(top1.name)} ${fmtWon(top1.amount)} 할인이 가장 큽니다.`;
    if (topCatEntry && topCatEntry[1] >= 2){
      sentence += ` ${escapeHtml(topCatEntry[0])} 카테고리 할인이 ${topCatEntry[1]}건으로 눈에 띕니다.`;
    }
  } else {
    // today-delivery/chicken/pizza/burger-discount
    // "N건" 집계는 표시 리스트(def.limit로 잘린 목록)가 아니라 전체 live 기준으로 계산한다.
    // (표시 리스트 자체의 정렬/노출 개수는 renderPage()의 sorted 변수가 그대로 담당하며 여기서는 건드리지 않음)
    if (!live.length) return '';
    const highCount = live.filter(d => d.amount >= 5000).length;
    const hasBrandDay = live.some(d => /\(브랜드데이\)/.test(d.name));
    const parts = [];
    if (hasBrandDay){
      const label = TODAY_PAGE_BRAND_DAY_LABEL[pageKey];
      parts.push(label
        ? `오늘 ${label} 할인 중에는 브랜드데이 형태의 특별 프로모션도 함께 확인됩니다.`
        : '오늘 확인된 할인 중 일부는 브랜드데이 등 특정 날짜에 진행되는 특별 할인입니다.');
    }
    if (highCount >= 2) parts.push(`5,000원 이상 할인이 ${highCount}건 확인되어 비교해볼 만합니다.`);
    sentence = parts.join(' ');
  }

  if (!sentence) return '';
  return `<section class="top-editor-comment" style="margin:16px 0; padding:14px 16px; background:${SURFACE}; border-radius:8px; border:1px solid ${LINE};">
    <h2 style="font-size:14px; margin:0 0 6px; color:${TEXT};">💡 오늘 눈여겨볼 점</h2>
    <p style="font-size:13px; line-height:1.6; color:${TEXT}; margin:0;">${sentence}</p>
  </section>`;
}

function renderSingleAppList(list){
  const rows = list.map((d, i) => {
    const gachaTag = d.isRandom
      ? `<span style="font-size:11px; color:${PRIMARY}; margin-left:6px;">${Array.isArray(d.randomAmounts) && d.randomAmounts.length > 1 ? `🎰 최대 ${fmtWon(d.randomAmounts[d.randomAmounts.length - 1])}` : '🎰 뽑기'}</span>`
      : '';
    return `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:${i % 2 === 0 ? CARD : SURFACE}; border-radius:8px; margin-bottom:8px;">
      <div>
        <span style="font-family:monospace; color:${MUTED}; font-size:12px; margin-right:8px;">${i + 1}</span>
        <span style="font-weight:700; color:${TEXT};">${escapeHtml(d.name)}</span>
        ${d.limitedTime ? `<span style="font-size:11px; color:#FF5A36; margin-left:6px;">⏰ ${escapeHtml(d.limitedTime)} 선착순</span>` : ''}
        ${gachaTag}
      </div>
      <span style="font-family:monospace; font-weight:700; color:${PRIMARY};">${fmtWon(d.amount)} 할인</span>
    </div>`;
  }).join('');
  return `<div style="margin:16px 0;">${rows}</div>`;
}

// today-delivery/chicken/pizza/burger-discount 4개 페이지 전용 카테고리 라벨.
// PAGE_DEFS의 h1/intro를 재사용하지 않는 이유: 문장 안에 자연스럽게 들어갈 짧은 명사형이 필요해서.
const TODAY_SUMMARY_LABEL = {
  'today-delivery-discount': '배달',
  'today-chicken-discount': '치킨',
  'today-pizza-discount': '피자',
  'today-burger-discount': '햄버거',
};

// today-* 4페이지의 할인 리스트 위에 붙는 "오늘의 OO 할인 하이라이트" 요약.
// 새로운 데이터 집계 로직을 만들지 않고, 브랜드 페이지에서 이미 쓰고 있는 groupByBrand()를
// 그대로 재사용해서 브랜드 판정 기준(브랜드데이 표기 등)이 다른 페이지와 어긋나지 않게 한다.
// live는 이미 mapRecord()+isLive()+해당 카테고리 filter를 거친 배열이라, 존재하지 않는
// 할인이나 조건을 새로 만들어내지 않는다. 데이터가 없으면 빈 문자열을 반환해 자연스럽게 생략한다.
function renderTodaySummary(pageKey, live){
  const label = TODAY_SUMMARY_LABEL[pageKey];
  if (!label || !live.length) return '';

  const groups = groupByBrand(live).sort((a, b) => b.maxAmount - a.maxAmount);
  const top1 = groups[0];
  const bestApp = (g) => PLATFORM_ORDER.find(a => g.apps[a] === g.maxAmount);
  const gachaSuffix = (g, a) => {
    if (!g.gacha || !g.gacha[a]) return '';
    const amounts = g.gachaAmounts && g.gachaAmounts[a];
    return amounts && amounts.length > 1 ? ` (🎰 최대 ${fmtWon(amounts[amounts.length - 1])})` : ' (🎰 뽑기)';
  };

  let sentence = `오늘 ${label} 할인 중 가장 큰 할인은 ${escapeHtml(top1.name)}의 ${APP_LABEL[bestApp(top1)]} ${fmtWon(top1.maxAmount)} 할인입니다${gachaSuffix(top1, bestApp(top1))}.`;

  // 2위가 1위와 다른 브랜드일 때만 언급 (동일 브랜드가 여러 앱에 걸쳐 상위권을 채우는 경우를
  // groupByBrand()가 이미 브랜드 단위로 묶어주므로, 여기서 나오는 2위는 항상 다른 브랜드다)
  const top2 = groups[1];
  if (top2){
    sentence += ` 그다음으로 ${escapeHtml(top2.name)}의 ${APP_LABEL[bestApp(top2)]} ${fmtWon(top2.maxAmount)} 할인이 확인됩니다${gachaSuffix(top2, bestApp(top2))}.`;
  }

  const countSentence = `현재 확인된 ${label} 할인 브랜드는 총 ${groups.length}곳입니다.`;

  // limitedTime 필드가 실제로 존재하는 항목이 하나라도 있을 때만 주의 문구를 붙인다(추측 금지).
  const hasLimitedTime = live.some(d => !!d.limitedTime);
  const limitedNotice = hasLimitedTime
    ? `<p style="font-size:12px; color:${MUTED}; margin:8px 0 0;">일부 할인은 선착순 또는 시간 제한 조건이 있을 수 있으니 주문 전에 조건을 확인하세요.</p>`
    : '';

  return `<section style="margin:16px 0 20px; padding:16px 18px; background:${CARD}; border:1px solid ${LINE}; border-radius:10px;">
    <h2 style="font-size:15px; margin:0 0 8px; color:${TEXT};">오늘의 ${label} 할인 하이라이트</h2>
    <p style="font-size:14px; line-height:1.7; color:${TEXT}; margin:0;">${sentence}</p>
    <p style="font-size:13px; color:${MUTED}; margin:8px 0 0;">${countSentence}</p>
    ${limitedNotice}
  </section>`;
}

async function renderPage(pageKey, discounts){
  const def = PAGE_DEFS[pageKey];
  const canonical = `${SITE_URL}/${pageKey}`;
  const todayLabel = fmtTodayLabel();

  let bodyHtml;
  let extraSectionsHtml = '';
  const live = discounts.filter(isLive).filter(def.filter);

  if (def.multiAppOnly){
    let groups = groupByBrand(live).filter(g => g.appCount >= 2);
    groups.sort((a, b) => b.maxAmount - a.maxAmount);
    groups = groups.slice(0, def.limit);
    bodyHtml = (groups.length
      ? renderCompareTable(groups)
      : `<p style="color:${MUTED};">현재 2개 이상 앱에서 동시에 할인 중인 브랜드가 없어요. 잠시 후 다시 확인해주세요.</p>`)
      + renderTopEditorComment(pageKey, live, groups)
      + renderRelatedLinksSection(pageKey);
  } else if (def.singleBrand){
    // 브랜드 하나만 필터링된 상태 — 앱이 1개뿐이어도(appCount>=2 조건 없이) 그대로 비교표로 보여준다.
    const groups = groupByBrand(live).sort((a, b) => b.maxAmount - a.maxAmount).slice(0, def.limit);
    const brandLabel = (NAV_LABEL[pageKey] || def.h1).replace(/\s*할인.*$/, '') || def.h1;

    // 할인이 없는 날에도 페이지가 비어보이지 않도록: 오늘 할인 하이라이트(또는 없음 안내) +
    // 최근 이력 + 앱별 빈도 + 이용 가이드 + 알림 CTA + 같은 카테고리 크로스링크 + 실시간 제보 CTA를 항상 채워 넣는다.
    bodyHtml = renderTodayHighlight(groups, brandLabel) + renderBrandInsight(pageKey, groups, live) + (groups.length ? renderCompareTable(groups) : '');

    const stats = await fetchBrandStats(pageKey.replace('-discount', ''));
    extraSectionsHtml = [
      renderHistorySection(stats, brandLabel),
      renderPlatformFreqSection(stats, brandLabel),
      renderHowToSection(brandLabel),
      renderNotifyCta(brandLabel),
      renderCrossLinkSection(pageKey),
      renderRelatedLinksSection(pageKey),
      renderReportCta(brandLabel),
    ].join('');
  } else if (def.singleApp){
    const sorted = live.slice().sort((a, b) => b.amount - a.amount).slice(0, def.limit);
    bodyHtml = (sorted.length
      ? renderSingleAppList(sorted)
      : `<p style="color:${MUTED};">현재 진행 중인 할인 정보가 없어요. 잠시 후 다시 확인해주세요.</p>`)
      + renderTopEditorComment(pageKey, live, null)
      + renderRelatedLinksSection(pageKey);
  } else {
    const sorted = live.slice().sort((a, b) => b.amount - a.amount).slice(0, def.limit);
    const summaryHtml = renderTodaySummary(pageKey, live);
    bodyHtml = summaryHtml + (sorted.length
      ? renderSingleAppList(sorted.map(d => ({ ...d, name: `${d.name} (${APP_SHORT[d.app[0]]})` })))
      : `<p style="color:${MUTED};">현재 진행 중인 할인 정보가 없어요. 잠시 후 다시 확인해주세요.</p>`)
      + renderTopEditorComment(pageKey, live, null)
      + renderRelatedLinksSection(pageKey);
  }

  // 구조화 데이터: 이 페이지가 "무엇을 나열하는 목록"인지 구글에 명시
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: def.h1,
    description: def.description,
    url: canonical,
  };

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(def.title)}</title>
<meta name="description" content="${escapeHtml(def.description)}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="주문의 고수">
<meta property="og:title" content="${escapeHtml(def.title)}">
<meta property="og:description" content="${escapeHtml(def.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE_URL}/og-image.png">
<link rel="icon" type="image/png" href="/favicon.png">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  body{ margin:0; background:${BG}; color:${TEXT}; font-family:'Noto Sans KR', -apple-system, sans-serif; }
  a{ color:${PRIMARY}; }
  .wrap{ max-width:720px; margin:0 auto; padding:24px 16px 60px; }
  h1{ font-size:22px; margin:4px 0 8px; }
  table{ display:block; overflow-x:auto; white-space:nowrap; }
  /* 한글이 단어 중간에서 끊기지 않도록 어절 단위로만 줄바꿈. 긴 영문/URL은 필요시 정상적으로
     줄바꿈되게(overflow-wrap) 해서 가로 overflow는 방지한다. 표(td/th)는 제외 — table의
     white-space:nowrap(가로 스크롤 허용)이 기존 의도이므로 그대로 둔다. */
  h1, h2, h3, p, li, a, button{ word-break: keep-all; overflow-wrap: break-word; }
</style>
</head>
<body>
<div class="wrap">
  <a href="/" style="display:inline-flex; align-items:center; gap:6px; margin-bottom:16px; font-weight:700; color:${PRIMARY}; text-decoration:none;">
    <svg width="20" height="20" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <ellipse cx="11" cy="8" rx="5" ry="6.2" stroke="${PRIMARY}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M11 14 L11 29" stroke="${PRIMARY}" stroke-width="2" stroke-linecap="round"/>
      <path d="M18 29 L26 4" stroke="${PRIMARY}" stroke-width="2" stroke-linecap="round"/>
      <path d="M23 29 L31 4" stroke="${PRIMARY}" stroke-width="2" stroke-linecap="round"/>
    </svg>
    주문의 고수
  </a>
  <p style="font-size:12px; color:${MUTED}; margin:0 0 4px;">${escapeHtml(todayLabel)} 기준</p>
  <h1>${escapeHtml(def.h1)}</h1>
  <p style="font-size:14px; line-height:1.6; color:${MUTED}; margin-bottom:8px;">${escapeHtml(def.intro)}</p>
  <p style="font-size:12px; color:${MUTED}; opacity:0.85;">※ 할인 정보는 실시간으로 바뀔 수 있으며, 주문 전 앱에서 한 번 더 확인해주세요.</p>

  ${bodyHtml}
  ${extraSectionsHtml}

  <a href="/" style="display:block; text-align:center; margin:28px 0 8px; padding:14px; background:${PRIMARY}; color:${BG}; font-weight:700; border-radius:8px; text-decoration:none;">전체 브랜드 실시간 비교 보러가기 →</a>

  <p style="font-size:12px; color:${MUTED}; margin-top:32px;">다른 비교도 확인해보세요</p>
  ${renderNav(pageKey)}

  <p style="font-size:11px; color:${MUTED}; opacity:0.7; margin-top:24px;">주문의 고수 · 운영: 문라잇 · <a href="/about" style="color:${MUTED};">서비스 소개</a></p>
</div>
</body>
</html>`;
}

// ---------------------------------------------------------------
// Supabase 캐시 조회 (discounts.js와 동일한 방식)
// ---------------------------------------------------------------
async function fetchCachedRecords(){
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY){
    throw new Error('환경변수(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)가 비어있습니다.');
  }

  const url = `${SUPABASE_URL}/rest/v1/cached_airtable_records?id=eq.1&select=records`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok){
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 조회 오류 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const rows = await res.json();
  const row = rows && rows[0];
  return (row && row.records) || [];
}

// ---------------------------------------------------------------
// 브랜드 할인 이력 통계 조회 (get_brand_discount_stats RPC, service_role로 호출)
// 테이블/RPC가 아직 배포 전이거나 일시 오류가 나도 브랜드 페이지 자체는 깨지지 않도록
// 실패 시 null을 반환하고, 호출부에서 "이력 데이터 준비중" 안내로 대체합니다.
// ---------------------------------------------------------------
async function fetchBrandStats(brandKey){
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_brand_discount_stats`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({ p_brand_key: brandKey }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data || null;
  } catch (e){
    console.warn('[주문의 고수 SEO 페이지] 브랜드 이력 조회 실패 (get_brand_discount_stats RPC 확인 필요)', e);
    return null;
  }
}

// ---------------------------------------------------------------
// 브랜드 페이지 전용 섹션 렌더링
// ---------------------------------------------------------------
const PLATFORM_ORDER = ['baemin', 'yogiyo', 'coupang', 'ddangyo'];

// singleBrand 페이지가 오늘 0건일 때, 실제 데이터가 있는 카테고리 종합 페이지로 안내하기 위한 매핑.
// BRAND_CATEGORY에 실제로 존재하는 값('치킨'/'피자'/'버거')과 정확히 맞췄다(추측으로 만들지 않음).
const CATEGORY_TODAY_PAGE = {
  '치킨': { pageKey: 'today-chicken-discount', label: '치킨' },
  '피자': { pageKey: 'today-pizza-discount', label: '피자' },
  '버거': { pageKey: 'today-burger-discount', label: '햄버거' },
};

// 이름 끝의 "(브랜드데이)" 같은 괄호 프로모션 표기를 떼어낸 기본 브랜드명을 반환.
// 특정 문자열("브랜드데이")을 하드코딩해서 찾지 않고, "이름 (무언가)" 형태 자체를 일반화해서 판정한다.
function baseBrandName(name){
  return name.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

// 브랜드 페이지 전용 "오늘의 할인 체크포인트" — 오늘 실제 live 데이터(groups/live)만 보고
// 그 자리에서 문장을 생성한다. 고정된 브랜드별 문구를 저장해두지 않으므로, 데이터가 바뀌면
// 다음 요청에서 문장도 자동으로 바뀐다. 새로운 Supabase/Airtable 조회는 하지 않는다.
//   groups: groupByBrand(live)의 결과(이미 renderPage에서 계산된 것을 그대로 받음)
//   live:   groups로 묶이기 전의 원본 배열 — "동일 브랜드+동일 앱에 서로 다른 레코드가
//           여러 개 있는지" 판정에는 groups(앱당 최대값 1개로 뭉개짐)로는 알 수 없어서 필요.
function renderBrandInsight(pageKey, groups, live){
  if (!groups.length){
    const categoryPage = CATEGORY_TODAY_PAGE[BRAND_CATEGORY[pageKey]];
    const categoryLinkHtml = categoryPage
      ? `<p style="font-size:13px; margin:8px 0 0;"><a href="/${categoryPage.pageKey}" style="color:${PRIMARY}; font-weight:600; text-decoration:none;">오늘 확인 가능한 ${escapeHtml(categoryPage.label)} 할인 전체 보기 →</a></p>`
      : '';
    return `<section class="brand-insight" style="margin:16px 0; padding:14px 16px; background:${SURFACE}; border-radius:8px; border:1px solid ${LINE};">
      <h2 style="font-size:14px; margin:0 0 4px; color:${TEXT};">오늘의 할인 체크포인트</h2>
      <p style="font-size:13px; color:${MUTED}; margin:0;">현재 확인된 할인은 없지만 할인 정보는 변경될 수 있으니 나중에 다시 확인해보세요.</p>
      ${categoryLinkHtml}
    </section>`;
  }

  // 이 페이지의 모든 그룹(브랜드데이 등 변형 포함)을 합친 전체 앱 집합
  const allApps = new Set();
  groups.forEach(g => Object.keys(g.apps).forEach(a => allApps.add(a)));

  // C. 괄호 프로모션 표기가 붙은 이름과, 그 기본 이름을 공유하는 다른 그룹이 함께 존재하는지
  //    (예: "도미노피자"와 "도미노피자 (브랜드데이)"가 동시에 groups에 있는 경우)
  let promoVariant = null;
  const byBaseName = new Map();
  groups.forEach(g => {
    const base = baseBrandName(g.name);
    if (!byBaseName.has(base)) byBaseName.set(base, new Set());
    byBaseName.get(base).add(g.name);
  });
  for (const [base, names] of byBaseName){
    if (names.size >= 2){ promoVariant = { base, names: [...names] }; break; }
  }

  // B. groups로는 앱당 최대 금액 하나만 남아 사라지는 정보라, 그룹핑 전 live에서
  //    "같은 앱에 금액 또는 선착순 조건이 서로 다른 레코드가 2개 이상"인지 직접 판정한다.
  let sameAppMultiCondition = null;
  if (Array.isArray(live)){
    const byApp = {};
    live.forEach(d => {
      d.app.forEach(a => {
        if (!byApp[a]) byApp[a] = new Set();
        byApp[a].add(`${d.amount}|${d.limitedTime || ''}`);
      });
    });
    for (const [app, conditionSet] of Object.entries(byApp)){
      if (conditionSet.size >= 2){ sameAppMultiCondition = app; break; }
    }
  }

  // D. limitedTime이 실제로 존재하는 값이 있으면 그 값을 그대로 사용 (추측/생성 없음)
  let limitedTimeSample = null;
  if (Array.isArray(live)){
    const found = live.find(d => !!d.limitedTime);
    if (found) limitedTimeSample = found.limitedTime;
  }

  // 우선순위: C(프로모션 동시존재) > B(동일앱 복수조건) > A(여러앱)/E(단일앱) > F는 위에서 이미 처리됨
  let mainSentence = '';
  if (promoVariant){
    const others = promoVariant.names.filter(n => n !== promoVariant.base);
    const otherLabel = others.length ? escapeHtml(others.join(', ')) : escapeHtml(promoVariant.names[0]);
    mainSentence = `오늘 ${escapeHtml(promoVariant.base)}에는 일반 할인 외에 별도 프로모션(${otherLabel})도 함께 진행 중입니다. 아래 비교표에서 이름을 확인하고 원하는 조건을 선택하세요.`;
  } else if (sameAppMultiCondition){
    const appName = escapeHtml(APP_LABEL[sameAppMultiCondition] || sameAppMultiCondition);
    mainSentence = `같은 배달앱(${appName}) 안에서도 할인 금액이나 적용 조건이 다를 수 있으니, 주문 전 쿠폰 조건을 확인하는 것이 좋습니다.`;
  } else if (allApps.size >= 2){
    mainSentence = `오늘은 ${allApps.size}개 배달앱에서 할인을 함께 확인할 수 있어, 앱별 조건을 비교해보고 주문하는 것이 유리할 수 있습니다.`;
  } else if (allApps.size === 1){
    const onlyApp = [...allApps][0];
    const appName = escapeHtml(APP_LABEL[onlyApp] || onlyApp);
    mainSentence = `현재 확인되는 할인은 ${appName}에 집중되어 있으므로, 해당 앱의 쿠폰 적용 조건을 먼저 확인하는 것이 좋습니다.`;
  }

  const limitedNotice = limitedTimeSample
    ? `<p style="font-size:12px; color:${MUTED}; margin:6px 0 0;">${escapeHtml(limitedTimeSample)} 선착순 등 시간 제한 조건이 있을 수 있으니 주문 전에 확인하세요.</p>`
    : '';

  if (!mainSentence && !limitedNotice) return '';

  return `<section class="brand-insight" style="margin:16px 0; padding:14px 16px; background:${SURFACE}; border-radius:8px; border:1px solid ${LINE};">
    <h2 style="font-size:14px; margin:0 0 6px; color:${TEXT};">오늘의 할인 체크포인트</h2>
    ${mainSentence ? `<p style="font-size:13px; line-height:1.6; color:${TEXT}; margin:0;">${mainSentence}</p>` : ''}
    ${limitedNotice}
  </section>`;
}

function renderTodayHighlight(groups, brandLabel){
  if (!groups.length){
    return `<div style="margin:16px 0; padding:20px; text-align:center; background:${CARD}; border:1px dashed ${LINE}; border-radius:10px;">
      <p style="font-size:14px; color:${MUTED}; margin:0 0 4px;">😴 오늘은 ${escapeHtml(brandLabel)} 정액 할인이 없어요.</p>
      <p style="font-size:12px; color:${MUTED}; opacity:0.8; margin:0;">할인은 매일 바뀌니, 내일 다시 확인해보세요!</p>
    </div>`;
  }
  const best = groups[0];
  const bestApp = PLATFORM_ORDER.find(a => best.apps[a] === best.maxAmount);
  const gachaAmounts = best.gachaAmounts && best.gachaAmounts[bestApp];
  const gachaTag = best.gacha && best.gacha[bestApp]
    ? `<span style="font-size:13px; font-weight:700; color:${PRIMARY}; margin-left:8px;">${gachaAmounts && gachaAmounts.length > 1 ? `🎰 최대 ${fmtWon(gachaAmounts[gachaAmounts.length - 1])}` : '🎰 뽑기'}</span>`
    : '';
  return `<div style="margin:16px 0; padding:18px 20px; background:linear-gradient(135deg, ${CARD}, ${SURFACE}); border:1px solid ${PRIMARY}; border-radius:10px;">
    <p style="font-size:12px; color:${MUTED}; margin:0 0 6px;">🔥 현재 가장 큰 할인</p>
    <p style="font-size:20px; font-weight:800; color:${PRIMARY}; margin:0;">${APP_LABEL[bestApp]} ${fmtWon(best.maxAmount)} 할인${gachaTag}</p>
  </div>`;
}

function renderHistorySection(stats, brandLabel){
  if (!stats){
    return `<section style="margin:28px 0;">
      <h2 style="font-size:16px; margin:0 0 10px;">📅 ${escapeHtml(brandLabel)} 최근 할인 이력</h2>
      <p style="font-size:13px; color:${MUTED};">이력 데이터를 준비 중이에요. 조금만 기다려주세요!</p>
    </section>`;
  }
  const { count_7 = 0, count_30 = 0, count_90 = 0, recent = [] } = stats;
  const summary = `<div style="display:flex; gap:8px; margin:10px 0 16px;">
    ${[['최근 7일', count_7], ['최근 30일', count_30], ['최근 90일', count_90]].map(([label, n]) => `
      <div style="flex:1; text-align:center; padding:12px 8px; background:${CARD}; border-radius:8px;">
        <p style="font-size:11px; color:${MUTED}; margin:0 0 4px;">${label}</p>
        <p style="font-size:16px; font-weight:700; color:${TEXT}; margin:0;">${n}일</p>
      </div>`).join('')}
  </div>`;

  const historyRows = recent.length
    ? recent.map(r => `<tr>
        <td style="padding:8px 10px; border-bottom:1px solid ${LINE}; color:${MUTED}; font-size:13px;">${escapeHtml(r.date_kst)}</td>
        <td style="padding:8px 10px; border-bottom:1px solid ${LINE}; font-size:13px;">${escapeHtml(APP_SHORT[r.platform] || r.platform)}</td>
        <td style="padding:8px 10px; border-bottom:1px solid ${LINE}; text-align:right; font-weight:700; color:${PRIMARY}; font-size:13px;">${fmtWon(r.amount)}</td>
      </tr>`).join('')
    : `<tr><td colspan="3" style="padding:12px; color:${MUTED}; font-size:13px;">아직 쌓인 이력이 없어요. 곧 하루하루 데이터가 모입니다.</td></tr>`;

  return `<section style="margin:28px 0;">
    <h2 style="font-size:16px; margin:0 0 4px;">📅 ${escapeHtml(brandLabel)} 최근 할인 이력</h2>
    ${summary}
    <table style="width:100%; border-collapse:collapse; font-size:13px;">
      <thead><tr>
        <th style="text-align:left; padding:8px 10px; color:${MUTED}; font-size:11px; border-bottom:1px solid ${LINE};">날짜</th>
        <th style="text-align:left; padding:8px 10px; color:${MUTED}; font-size:11px; border-bottom:1px solid ${LINE};">앱</th>
        <th style="text-align:right; padding:8px 10px; color:${MUTED}; font-size:11px; border-bottom:1px solid ${LINE};">할인</th>
      </tr></thead>
      <tbody>${historyRows}</tbody>
    </table>
  </section>`;
}

function renderPlatformFreqSection(stats, brandLabel){
  const counts = (stats && stats.platform_counts_30) || {};
  const maxCount = Math.max(1, ...PLATFORM_ORDER.map(a => Number(counts[a]) || 0));
  const bars = PLATFORM_ORDER.map(a => {
    const n = Number(counts[a]) || 0;
    const widthPct = Math.round((n / maxCount) * 100);
    return `<div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
      <span style="width:64px; font-size:12px; color:${MUTED}; flex-shrink:0;">${APP_SHORT[a]}</span>
      <div style="flex:1; height:14px; background:${SURFACE}; border-radius:999px; overflow:hidden;">
        <div style="width:${widthPct}%; height:100%; background:${PRIMARY};"></div>
      </div>
      <span style="width:40px; text-align:right; font-size:12px; color:${TEXT}; flex-shrink:0;">${n}회</span>
    </div>`;
  }).join('');

  return `<section style="margin:28px 0;">
    <h2 style="font-size:16px; margin:0 0 10px;">📊 최근 30일 배달앱별 ${escapeHtml(brandLabel)} 할인 횟수</h2>
    ${bars}
  </section>`;
}

function renderHowToSection(brandLabel){
  const steps = [
    '배달앱(배민·요기요·쿠팡이츠·땡겨요)에서 브랜드명을 검색해요.',
    '가게 화면의 쿠폰함 또는 할인 배너에서 진행 중인 정액 할인을 확인해요.',
    '장바구니/주문서 작성 화면에서 쿠폰을 다운로드하거나 자동 적용해요.',
    '결제 전 최종 할인 금액이 반영됐는지 한 번 더 확인 후 주문해요.',
  ];
  return `<section style="margin:28px 0;">
    <h2 style="font-size:16px; margin:0 0 10px;">💡 ${escapeHtml(brandLabel)} 할인받는 방법</h2>
    <ol style="margin:0; padding-left:20px; font-size:14px; line-height:1.9; color:${TEXT};">
      ${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('')}
    </ol>
  </section>`;
}

function renderNotifyCta(brandLabel){
  return `<section style="margin:28px 0; text-align:center;">
    <button type="button" onclick="alert('🔔 할인 알림 기능은 준비 중이에요. 곧 만나요!')" style="width:100%; padding:14px; background:${SURFACE}; color:${TEXT}; border:1px solid ${PRIMARY}; border-radius:8px; font-weight:700; font-size:14px; cursor:pointer;">🔔 ${escapeHtml(brandLabel)} 할인 알림 받기</button>
  </section>`;
}

function renderCrossLinkSection(currentKey){
  const category = BRAND_CATEGORY[currentKey];
  if (!category) return '';
  const siblings = Object.keys(BRAND_CATEGORY).filter(k => BRAND_CATEGORY[k] === category && k !== currentKey);
  if (!siblings.length) return '';
  const chips = siblings.map(k => `<a href="/${k}" style="display:inline-block; margin:0 6px 8px 0; padding:8px 14px; border-radius:8px; background:${CARD}; border:1px solid ${LINE}; color:${TEXT}; font-size:13px; font-weight:600; text-decoration:none;">${escapeHtml(NAV_LABEL[k] || k)}</a>`).join('');
  return `<section style="margin:28px 0;">
    <h2 style="font-size:16px; margin:0 0 10px;">오늘의 ${escapeHtml(category)} 할인</h2>
    <div>${chips}</div>
  </section>`;
}

// 카테고리(치킨/피자/버거) → 그 카테고리에 속한 singleBrand 페이지 키 목록. BRAND_CATEGORY를
// 거꾸로 뒤집은 것뿐이라 새 데이터를 만들지 않는다.
const CATEGORY_BRAND_PAGES = {};
Object.entries(BRAND_CATEGORY).forEach(([pageKey, category]) => {
  if (!CATEGORY_BRAND_PAGES[category]) CATEGORY_BRAND_PAGES[category] = [];
  CATEGORY_BRAND_PAGES[category].push(pageKey);
});

// 카테고리(치킨) → 앱 비교 페이지. 현재 PAGE_DEFS에 실제로 존재하는 것만 연결한다(피자/버거는
// 전용 앱비교 페이지가 없으므로 링크하지 않음 — 존재하지 않는 URL을 만들어내지 않기 위함).
const CATEGORY_APP_COMPARE_PAGE = { '치킨': 'chicken-app-compare' };

// singleApp 페이지 키 ↔ 앱 코드
const SINGLE_APP_PAGE_BY_APP = { baemin: 'baemin-discount', yogiyo: 'yogiyo-discount', coupang: 'coupangeats-discount', ddangyo: 'ddangyo-discount' };

function linkChip(href, label){
  return `<a href="${href}" style="display:inline-block; margin:0 6px 8px 0; padding:8px 14px; border-radius:8px; background:${CARD}; border:1px solid ${LINE}; color:${TEXT}; font-size:13px; font-weight:600; text-decoration:none;">${escapeHtml(label)}</a>`;
}

// 페이지 유형별로 "의미적으로 강한" 관련 링크만 최소한으로 보강한다. renderNav()가 이미
// 20개 페이지 전체를 매 페이지 하단에 나열하고 있으므로, 여기서는 그것과 겹치지 않게
// "이 페이지 주제와 실제로 관련된" 링크만 소수(최대 4~5개) 추가한다. 대상이 없으면
// 빈 문자열을 반환해 억지로 섹션을 만들지 않는다.
function renderRelatedLinksSection(pageKey){
  const def = PAGE_DEFS[pageKey];
  let title = '';
  let chips = [];

  if (def.singleApp){
    // 앱별 페이지 → 오늘 전체 배달 할인 + 배달앱 비교
    title = '함께 보면 좋아요';
    chips = [
      linkChip('/today-delivery-discount', '오늘 배달 할인 전체 보기'),
      linkChip('/delivery-app-compare', '배달앱 할인 비교'),
    ];
  } else if (def.multiAppOnly){
    // 비교 페이지 → 각 앱 페이지 전체 + 관련 오늘 할인 페이지
    const relatedToday = pageKey === 'chicken-app-compare' ? 'today-chicken-discount' : 'today-delivery-discount';
    title = '앱별로 자세히 보기';
    chips = [
      linkChip(`/${relatedToday}`, `${NAV_LABEL[relatedToday]} 전체 보기`),
      ...Object.values(SINGLE_APP_PAGE_BY_APP).map(k => linkChip(`/${k}`, NAV_LABEL[k])),
    ];
  } else if (def.singleBrand){
    // 브랜드 페이지 → 같은 카테고리 today 종합 페이지 + (있으면) 앱비교 페이지
    const category = BRAND_CATEGORY[pageKey];
    const todayPage = CATEGORY_TODAY_PAGE[category];
    const comparePage = CATEGORY_APP_COMPARE_PAGE[category];
    if (!todayPage && !comparePage) return '';
    title = '함께 보면 좋아요';
    if (todayPage) chips.push(linkChip(`/${todayPage.pageKey}`, `오늘 ${todayPage.label} 할인 전체 보기`));
    if (comparePage) chips.push(linkChip(`/${comparePage}`, NAV_LABEL[comparePage]));
  } else {
    // today-* 4페이지 → 앱별 페이지 4개 + 같은 카테고리 브랜드 페이지(있는 경우만, 최대 5개)
    const label = TODAY_SUMMARY_LABEL[pageKey];
    const brandPages = CATEGORY_BRAND_PAGES[label] || [];
    if (!brandPages.length && pageKey !== 'today-delivery-discount') return '';
    title = '앱/브랜드별로 자세히 보기';
    chips = [
      ...Object.values(SINGLE_APP_PAGE_BY_APP).map(k => linkChip(`/${k}`, NAV_LABEL[k])),
      ...brandPages.slice(0, 5).map(k => linkChip(`/${k}`, NAV_LABEL[k])),
    ];
  }

  if (!chips.length) return '';
  return `<section style="margin:28px 0;">
    <h2 style="font-size:16px; margin:0 0 10px;">${escapeHtml(title)}</h2>
    <div>${chips.join('')}</div>
  </section>`;
}

function renderReportCta(brandLabel){
  return `<section style="margin:28px 0; padding:16px; background:${CARD}; border-radius:10px; text-align:center;">
    <p style="font-size:13px; color:${MUTED}; margin:0 0 10px;">놓친 ${escapeHtml(brandLabel)} 할인이 보이시나요? 실시간으로 제보해주세요.</p>
    <a href="/board" style="display:inline-block; padding:10px 18px; background:#FEE500; color:#1C1A17; border-radius:8px; font-weight:700; font-size:13px; text-decoration:none;">🚨 실시간 할인 제보하기</a>
  </section>`;
}

// sync-airtable.js가 "오늘 어떤 브랜드가 어떤 앱에서 얼마 할인 중인지" 판정할 때
// 이 파일과 동일한 필드 파싱/브랜드 매칭 로직을 그대로 재사용하기 위한 named export.
//
// [추가] fmtWon/escapeHtml/APP_LABEL/NAV_LABEL도 함께 export합니다.
// api/home.js(홈 SSR)가 "오늘 배달 할인 / BEST3 / 오늘 할인 브랜드" 텍스트를 만들 때
// 이미 검증된 이 파일의 표기 규칙(금액 포맷, HTML 이스케이프, 앱 표시명, 페이지 한글 라벨)을
// 그대로 재사용하기 위함이며, 기존 함수의 동작은 전혀 바뀌지 않습니다.
export { PAGE_DEFS, mapRecord, isLive, getTodayKST, fmtWon, escapeHtml, APP_LABEL, NAV_LABEL, groupGachaRecords };

export default async function handler(req, res){
  const pageKey = (req.query.page || '').toString();
  const def = PAGE_DEFS[pageKey];

  if (!def){
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('페이지를 찾을 수 없습니다.');
  }

  try {
    const rawRecords = await fetchCachedRecords();
    const discounts = groupGachaRecords(rawRecords.map(mapRecord).filter(Boolean));
    const html = await renderPage(pageKey, discounts);

    // 60초 동안은 Vercel 엣지 캐시로 응답 → Supabase 조회 없이 즉시 응답, 크롤러가 몰려도 안전
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(html);
  } catch (err){
    console.error('[주문의 고수 SEO 페이지]', err);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).end('일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.');
  }
}

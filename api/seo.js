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
};

const NAV_LINKS = [
  ['today-delivery-discount', '오늘 배달 할인'],
  ['today-chicken-discount', '오늘 치킨 할인'],
  ['delivery-app-compare', '배달앱 할인 비교'],
  ['baemin-discount', '배민 할인'],
  ['coupangeats-discount', '쿠팡이츠 할인'],
  ['yogiyo-discount', '요기요 할인'],
  ['ddangyo-discount', '땡겨요 할인'],
  ['chicken-app-compare', '치킨 배달앱 할인 비교'],
];

// ---------------------------------------------------------------
// Airtable 캐시 레코드 → 최소 형태로 파싱 (index.html의 로직을 서버에서 쓸 수 있게 축약)
// ---------------------------------------------------------------
const FIELD_ALIASES = {
  name: ['브랜드명', '브랜드', '상호명', '이름', 'Name', 'Brand'],
  platform: ['플랫폼', '앱', '배달앱', '플랫폼명', 'App', 'Platform'],
  category: ['카테고리', '분류', 'Category'],
  amount: ['할인금액', '금액', '할인가', '할인 금액', 'Amount', 'Price'],
  endDate: ['종료일', '할인종료일', '만료일', '종료 일', 'EndDate', 'End'],
  limitedTime: ['선착순 시간', '선착순시간', '선착순', 'LimitedTime'],
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
  const endDateRaw = pickField(f, 'endDate');
  const endDate = endDateRaw ? endDateRaw.toString().slice(0, 10) : null;
  const limitedTime = (pickField(f, 'limitedTime') || '').toString().trim() || null;

  return { name, app: [app], category, amount, endDate, limitedTime };
}

function isLive(d){
  const today = getTodayKST();
  return !d.endDate || d.endDate >= today;
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

// 브랜드 그룹핑: 같은 브랜드를 앱별로 묶어서 { name, apps: {baemin: amount, ...}, maxAmount } 형태로 변환
function groupByBrand(list){
  const map = new Map();
  list.forEach(d => {
    const key = d.name.trim().toLowerCase().replace(/\s+/g, '');
    if (!map.has(key)) map.set(key, { name: d.name.trim(), apps: {}, limitedTime: {} });
    const g = map.get(key);
    d.app.forEach(a => {
      // 같은 앱에 여러 행이 있으면 더 큰 금액을 대표로 사용
      if (!g.apps[a] || d.amount > g.apps[a]) g.apps[a] = d.amount;
      if (d.limitedTime) g.limitedTime[a] = d.limitedTime;
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
      return `<td style="text-align:center; padding:10px 8px; border-bottom:1px solid ${LINE}; font-weight:${isMax ? '700' : '400'}; color:${isMax ? PRIMARY : TEXT};">${fmtWon(amt)}${timeTag}</td>`;
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

function renderSingleAppList(list){
  const rows = list.map((d, i) => `
    <div style="display:flex; align-items:center; justify-content:space-between; padding:12px; background:${i % 2 === 0 ? CARD : SURFACE}; border-radius:8px; margin-bottom:8px;">
      <div>
        <span style="font-family:monospace; color:${MUTED}; font-size:12px; margin-right:8px;">${i + 1}</span>
        <span style="font-weight:700; color:${TEXT};">${escapeHtml(d.name)}</span>
        ${d.limitedTime ? `<span style="font-size:11px; color:#FF5A36; margin-left:6px;">⏰ ${escapeHtml(d.limitedTime)} 선착순</span>` : ''}
      </div>
      <span style="font-family:monospace; font-weight:700; color:${PRIMARY};">${fmtWon(d.amount)} 할인</span>
    </div>`).join('');
  return `<div style="margin:16px 0;">${rows}</div>`;
}

function renderPage(pageKey, discounts){
  const def = PAGE_DEFS[pageKey];
  const canonical = `${SITE_URL}/${pageKey}`;
  const todayLabel = fmtTodayLabel();

  let bodyHtml;
  const live = discounts.filter(isLive).filter(def.filter);

  if (def.multiAppOnly){
    let groups = groupByBrand(live).filter(g => g.appCount >= 2);
    groups.sort((a, b) => b.maxAmount - a.maxAmount);
    groups = groups.slice(0, def.limit);
    bodyHtml = groups.length
      ? renderCompareTable(groups)
      : `<p style="color:${MUTED};">현재 2개 이상 앱에서 동시에 할인 중인 브랜드가 없어요. 잠시 후 다시 확인해주세요.</p>`;
  } else if (def.singleApp){
    const sorted = live.slice().sort((a, b) => b.amount - a.amount).slice(0, def.limit);
    bodyHtml = sorted.length
      ? renderSingleAppList(sorted)
      : `<p style="color:${MUTED};">현재 진행 중인 할인 정보가 없어요. 잠시 후 다시 확인해주세요.</p>`;
  } else {
    const sorted = live.slice().sort((a, b) => b.amount - a.amount).slice(0, def.limit);
    bodyHtml = sorted.length
      ? renderSingleAppList(sorted.map(d => ({ ...d, name: `${d.name} (${APP_SHORT[d.app[0]]})` })))
      : `<p style="color:${MUTED};">현재 진행 중인 할인 정보가 없어요. 잠시 후 다시 확인해주세요.</p>`;
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

export default async function handler(req, res){
  const pageKey = (req.query.page || '').toString();
  const def = PAGE_DEFS[pageKey];

  if (!def){
    res.status(404).setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('페이지를 찾을 수 없습니다.');
  }

  try {
    const rawRecords = await fetchCachedRecords();
    const discounts = rawRecords.map(mapRecord).filter(Boolean);
    const html = renderPage(pageKey, discounts);

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

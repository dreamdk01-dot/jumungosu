// /api/seo-shopping.js
//
// 추석 선물세트 쇼핑 SEO 랜딩페이지 10종을 서버에서 직접 HTML 문자열로 만들어 응답합니다.
// (기존 api/seo.js — 배달 할인 SEO 8종 — 와 같은 목적, 같은 SSR 방식이지만 완전히 별도 파일입니다.
//  이유: 배달 할인 SEO 시스템(seo.js)을 수정 없이 그대로 보존하기 위해서입니다. escapeHtml/
//  getTodayKST 등 순수 유틸리티만 seo.js에서 그대로 import해서 재사용하고, 배달 할인 관련 로직
//  (PAGE_DEFS, mapRecord, isLive, groupByBrand 등)은 전혀 건드리지 않습니다.)
//
// 상품 데이터 원본 — 매우 중요:
// 이 사이트는 지금 "추석 선물세트" 상품 DB를 Supabase가 아니라 app.html 안의
// `const AUTUMN_GIFT_PRODUCTS = [ ... ]` 자바스크립트 배열 하나로만 관리합니다(운영자가 Excel을
// 수동으로 채워 넣고, 그 내용을 그대로 이 배열에 동기화하는 방식 — /hot-deals 페이지가 이 배열을
// 그대로 읽어서 렌더링합니다). 이 SEO 페이지들도 "별도 상품 DB를 복제하지 않는다"는 요구사항을
// 지키기 위해, 새로운 배열을 만들지 않고 대신 home.js가 이미 하고 있는 것과 같은 방식으로
// app.html 파일을 디스크에서 직접 읽어(fs.readFileSync) 그 안의 AUTUMN_GIFT_PRODUCTS 배열
// 텍스트만 정규식으로 추출해 파싱합니다. 즉 "진짜 단일 원본"은 여전히 app.html 하나뿐이고,
// 이 파일은 그 원본을 요청마다(콜드스타트 시 1회, 이후 warm 인스턴스 동안은 캐시) 다시 읽어
// 파싱만 할 뿐 데이터를 별도로 보관하지 않습니다. app.html의 AUTUMN_GIFT_PRODUCTS 스키마가
// 구조적으로 바뀌면(필드 추가/삭제가 아니라 배열 선언 형태 자체가 바뀌면) 이 파싱이 깨질 수 있다는
// 점은 이 방식의 트레이드오프입니다(완료 보고에 명시).
//
// iframe 재로드 방지:
// 이 페이지들은 /hot-deals와 달리 클라이언트 필터가 없는 "고정된 조건의 SSR 페이지"라서,
// 페이지가 한 번 로드되면 그 안의 쿠팡 iframe도 그때 한 번만 존재합니다(필터를 눌러서 DOM이
// 다시 그려지는 상황 자체가 없음). 다만 상품이 많은 페이지(허브 등)에서 수십~백 개의 iframe이
// 한꺼번에 동시 요청되는 것 자체가 부담이 될 수 있어, /hot-deals에서 이미 검증된 것과 같은
// 기법(빈 슬롯 + IntersectionObserver 지연 로드)을 이 페이지 전용으로 다시 구현해 붙였습니다
// (런타임이 다른 별도 서버 응답이라 같은 JS 파일을 그대로 공유할 수는 없었습니다).

import fs from 'fs';
import path from 'path';
import { escapeHtml, getTodayKST } from './seo.js';

const SITE_URL = 'https://www.jumungosu.com';
const PRIMARY = '#FFB800';
const BG = '#1C1A17';
const CARD = '#2B2620';
const TEXT = '#F5F0E8';
const MUTED = '#A79C8D';
const LINE = '#5A5044';
const AGP_PRICE = '#FFB020';

const APP_HTML_PATH = path.join(process.cwd(), 'app.html');

// ---------------------------------------------------------------
// app.html에서 AUTUMN_GIFT_PRODUCTS 배열만 추출해서 파싱한다 (eval 대신 필드별 정규식 — 임의 코드
// 실행 위험을 피하기 위해 curated_hotdeal 계열 스크립트들과 같은 접근을 쓴다).
// ---------------------------------------------------------------
let cachedProducts = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // warm 인스턴스에서도 5분에 한 번은 app.html을 다시 읽음(배포 반영 지연 최소화)

function parseProducts(){
  const now = Date.now();
  if (cachedProducts && (now - cachedAt) < CACHE_TTL_MS) return cachedProducts;

  const html = fs.readFileSync(APP_HTML_PATH, 'utf8');
  const arrMatch = html.match(/const AUTUMN_GIFT_PRODUCTS = \[\n([\s\S]*?)\n {2}\];/);
  if (!arrMatch){
    throw new Error('app.html에서 AUTUMN_GIFT_PRODUCTS 배열을 찾지 못했습니다.');
  }
  const body = arrMatch[1];

  const itemRe = /\{ name: "((?:[^"\\]|\\.)*)", price: "((?:[^"\\]|\\.)*)", category: "((?:[^"\\]|\\.)*)", url: "((?:[^"\\]|\\.)*)", isSearchUrl: (true|false), rating: (null|[\d.]+), reviews: (null|\d+), partnersUrl: "((?:[^"\\]|\\.)*)", partnersHtml: "((?:[^"\\]|\\.)*)", fixNeeded: "((?:[^"\\]|\\.)*)", targets: \[((?:[^\]]*))\], pick: (\d+), pickLabel: "((?:[^"\\]|\\.)*)", pickReason: "((?:[^"\\]|\\.)*)" \}/g;

  const unesc = (s) => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');

  const products = [];
  let m;
  while ((m = itemRe.exec(body)) !== null){
    const [, name, price, category, url, , rating, reviews, partnersUrl, partnersHtml, , targetsRaw] = m;
    const targets = targetsRaw
      .split(',')
      .map(t => unesc(t.trim().replace(/^"|"$/g, '')))
      .filter(Boolean);
    products.push({
      name: unesc(name),
      price: unesc(price),
      category: unesc(category),
      url: unesc(url),
      rating: rating === 'null' ? null : Number(rating),
      reviews: reviews === 'null' ? null : Number(reviews),
      partnersUrl: unesc(partnersUrl),
      partnersHtml: unesc(partnersHtml),
      targets,
    });
  }

  if (!products.length){
    throw new Error('AUTUMN_GIFT_PRODUCTS 파싱 결과가 0건입니다(정규식이 app.html 실제 형식과 어긋났을 수 있음).');
  }

  cachedProducts = products;
  cachedAt = now;
  return products;
}

// seo.js의 fmtTodayLabel()과 동일한 포맷이지만 그 함수 자체는 export되어 있지 않아(로컬 함수),
// export된 getTodayKST()(YYYY-MM-DD)만 가져와 여기서 같은 방식으로 포맷만 다시 만든다.
function fmtTodayLabelKo(){
  const today = getTodayKST();
  const [y, m, d] = today.split('-');
  return `${y}년 ${parseInt(m, 10)}월 ${parseInt(d, 10)}일`;
}

function parsePriceWon(priceStr){
  if (!priceStr) return -1;
  const digits = String(priceStr).replace(/[^0-9]/g, '');
  return digits ? parseInt(digits, 10) : -1;
}

// /hot-deals의 autumnGiftIsRenderDuplicate()와 동일한 규칙: 상품명+URL이 완전히 같은 행 중
// 먼저 나온 것만 남기고 뒤의 것은 화면에서 제외한다(데이터 자체는 건드리지 않음).
function dedupeByNameUrl(products){
  const seen = new Set();
  const out = [];
  for (const p of products){
    const key = p.name + '||' + p.url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

// 과일 필터의 "배"/"포도" 등 짧은 키워드가 무관한 상품(홍삼 제품의 "배양근", 견과+요거트 간식)에
// 잘못 걸리는 걸 막기 위한 예외 처리 — 실제 DB를 확인해서 찾은 구체적인 오탐 2건만 배제한다.
function isFruitProduct(p){
  const hay = p.name + ' ' + p.category;
  const kws = ['과일', '사과', '배', '샤인머스켓', '포도', '곶감'];
  if (!kws.some(k => hay.includes(k))) return false;
  if (p.name.includes('배양근')) return false; // 홍삼 제품("산삼 배양근")
  if (p.name.includes('견과') && p.name.includes('요거트')) return false; // 견과 간식("청포도요거트")
  return true;
}

// ---------------------------------------------------------------
// 10개 페이지 정의
// ---------------------------------------------------------------
const SHOPPING_PAGE_DEFS = {
  'chuseok-gift': {
    title: '2026 추석 선물세트 모아보기 | 주문의고수',
    description: '한우·굴비·과일·건강식품·참치 등 다양한 2026 추석 선물세트를 가격대와 종류별로 한곳에서 확인해보세요.',
    h1: '2026 추석 선물세트 모아보기',
    intro: '한우·굴비·과일·건강식품·참치 등 추석 선물세트를 한곳에 모았습니다.',
    conditionLabel: '추석 선물 상품 전체',
    filter: () => true,
    isHub: true,
  },
  'chuseok-gift-for-parents': {
    title: '2026 부모님 추석 선물 모아보기 | 주문의고수',
    description: '부모님께 드릴 추석 선물을 찾고 있다면 건강식품·한우·과일·굴비 등 다양한 선물세트를 가격대별로 확인해보세요.',
    h1: '부모님 추석 선물 모아보기',
    intro: '부모님께 드릴 만한 추석 선물세트를 모았습니다.',
    conditionLabel: '추천대상 "부모님"이 포함된 상품',
    filter: p => p.targets.includes('부모님'),
  },
  'chuseok-gift-for-business': {
    title: '2026 직장·거래처 추석 선물 모아보기 | 주문의고수',
    description: '직장과 거래처에 전달할 추석 선물을 찾을 때 식품·생활용품·선물세트 등 다양한 상품을 가격대별로 확인해보세요.',
    h1: '직장·거래처 추석 선물 모아보기',
    intro: '직장이나 거래처에 전달하기 좋은 추석 선물세트를 모았습니다.',
    conditionLabel: '추천대상 "직장·거래처"가 포함된 상품',
    filter: p => p.targets.includes('직장·거래처'),
  },
  'chuseok-gift-under-30000': {
    title: '3만원 이하 추석 선물세트 모아보기 | 주문의고수',
    description: '부담을 줄인 추석 선물을 찾을 때 3만원 이하의 식품·생활용품·선물세트를 한곳에서 확인해보세요.',
    h1: '3만원 이하 추석 선물세트',
    intro: '3만원 이하로 부담 없이 준비할 수 있는 추석 선물세트를 모았습니다.',
    conditionLabel: '현재가격 3만원 이하',
    filter: p => { const w = parsePriceWon(p.price); return w > 0 && w <= 30000; },
  },
  'chuseok-gift-30000-50000': {
    title: '3만원~5만원 추석 선물세트 모아보기 | 주문의고수',
    description: '3만원대부터 5만원까지의 추석 선물세트를 종류별로 모아보고 상품 가격과 평점·리뷰 정보를 함께 확인해보세요.',
    h1: '3만원~5만원 추석 선물세트',
    intro: '3만원 초과 5만원 이하 가격대의 추석 선물세트를 모았습니다.',
    conditionLabel: '현재가격 3만원 초과 5만원 이하',
    filter: p => { const w = parsePriceWon(p.price); return w > 30000 && w <= 50000; },
  },
  'chuseok-gift-50000-100000': {
    title: '5만원~10만원 추석 선물세트 모아보기 | 주문의고수',
    description: '5만원대부터 10만원까지의 추석 선물세트를 한우·과일·수산물·건강식품 등 다양한 종류로 확인해보세요.',
    h1: '5만원~10만원 추석 선물세트',
    intro: '5만원 초과 10만원 이하 가격대의 추석 선물세트를 모았습니다.',
    conditionLabel: '현재가격 5만원 초과 10만원 이하',
    filter: p => { const w = parsePriceWon(p.price); return w > 50000 && w <= 100000; },
  },
  'chuseok-hanwoo-gift': {
    title: '2026 추석 한우 선물세트 모아보기 | 주문의고수',
    description: '추석 선물로 찾는 한우 선물세트를 가격대별로 모아보고 상품 가격과 평점·리뷰 정보를 한곳에서 확인해보세요.',
    h1: '추석 한우 선물세트 모아보기',
    intro: '한우가 포함된 추석 선물세트를 모았습니다.',
    conditionLabel: '상품명 또는 카테고리에 "한우" 포함',
    filter: p => (p.name + p.category).includes('한우'),
  },
  'chuseok-gulbi-gift': {
    title: '2026 추석 굴비 선물세트 모아보기 | 주문의고수',
    description: '추석 명절 선물로 찾는 굴비 선물세트를 가격대별로 모아보고 상품 가격과 평점·리뷰 정보를 확인해보세요.',
    h1: '추석 굴비 선물세트 모아보기',
    intro: '굴비가 포함된 추석 선물세트를 모았습니다.',
    conditionLabel: '상품명 또는 카테고리에 "굴비" 포함',
    filter: p => (p.name + p.category).includes('굴비'),
  },
  'chuseok-fruit-gift': {
    title: '2026 추석 과일 선물세트 모아보기 | 주문의고수',
    description: '사과·배·샤인머스켓 등 추석 과일 선물세트를 종류와 가격대별로 모아보고 상품 정보를 한곳에서 확인해보세요.',
    h1: '추석 과일 선물세트 모아보기',
    intro: '사과·배·곶감 등 과일류 추석 선물세트를 모았습니다.',
    conditionLabel: '상품명 또는 카테고리에 과일 관련 키워드 포함',
    filter: isFruitProduct,
  },
  'chuseok-health-gift': {
    title: '2026 추석 건강식품 선물세트 모아보기 | 주문의고수',
    description: '홍삼·건강식품 등 추석에 선물하기 좋은 건강 관련 선물세트를 가격대별로 모아보고 상품 정보를 확인해보세요.',
    h1: '추석 건강식품 선물세트 모아보기',
    intro: '홍삼 등 건강식품류 추석 선물세트를 모았습니다.',
    conditionLabel: '상품명 또는 카테고리에 "홍삼"/"건강식품" 포함',
    filter: p => (p.name + ' ' + p.category).includes('홍삼') || (p.name + ' ' + p.category).includes('건강식품') || (p.name + ' ' + p.category).includes('건강기능식품'),
  },
};

// 페이지 목록/내부링크용 순서(허브가 항상 맨 앞)
const SHOPPING_PAGE_ORDER = [
  'chuseok-gift',
  'chuseok-gift-for-parents',
  'chuseok-gift-for-business',
  'chuseok-gift-under-30000',
  'chuseok-gift-30000-50000',
  'chuseok-gift-50000-100000',
  'chuseok-hanwoo-gift',
  'chuseok-gulbi-gift',
  'chuseok-fruit-gift',
  'chuseok-health-gift',
];

// 페이지 하나당 실제로 그리는 상품 수 상한(성능/iframe 부담 관리용). 넘으면 "전체 보기 → /hot-deals"
// 안내만 추가하고, 텍스트 상품 수 자체는 실제 매칭 개수를 그대로 안내 문구에 쓴다(숫자를 속이지 않음).
const MAX_PRODUCTS_PER_PAGE = 40;

function autumnGiftPriceLabel(p){
  const raw = (p.price || '').trim();
  return raw ? escapeHtml(raw) : '가격은 쿠팡에서 확인';
}

// /hot-deals와 같은 카드 정보 구성(카테고리/상품명/가격/평점·리뷰) — iframe은 원본 그대로,
// 초기에는 빈 슬롯만 렌더링하고 페이지 하단 스크립트가 지연 로드한다.
function productCardHtml(p, idx){
  const ratingText = (p.rating !== null && p.rating !== undefined) ? `⭐ ${p.rating}` : '';
  const reviewsText = (p.reviews !== null && p.reviews !== undefined) ? ` (${Number(p.reviews).toLocaleString('ko-KR')})` : '';
  const href = escapeHtml(p.partnersUrl || p.url || '');
  if (p.partnersHtml){
    return `
      <div class="pcard">
        <div class="pcard-slot" data-html="${escapeHtml(Buffer.from(p.partnersHtml, 'utf8').toString('base64'))}"></div>
        <a class="pcard-link" href="${href}" target="_blank" rel="noopener sponsored">
          ${p.category ? `<p class="pcard-cat">${escapeHtml(p.category)}</p>` : ''}
          <p class="pcard-name">${escapeHtml(p.name)}</p>
          <p class="pcard-price">${autumnGiftPriceLabel(p)}<span class="pcard-snap"> · 확인 시점</span></p>
          ${ratingText ? `<p class="pcard-rating">${ratingText}${reviewsText}</p>` : ''}
        </a>
      </div>`;
  }
  // partnerHtml이 없는 상품(현재 DB엔 없지만 미래 대비) — /hot-deals의 이미지 없는 줄 리스트와 동일한 정보 구성.
  return `
    <a class="prow" href="${href}" target="_blank" rel="noopener sponsored">
      <div class="prow-main">
        ${p.category ? `<p class="pcard-cat">${escapeHtml(p.category)}</p>` : ''}
        <p class="pcard-name">${escapeHtml(p.name)}</p>
      </div>
      <div class="prow-side">
        <p class="pcard-price">${autumnGiftPriceLabel(p)}</p>
        ${ratingText ? `<p class="pcard-rating">${ratingText}${reviewsText}</p>` : ''}
      </div>
    </a>`;
}

function relatedLinksHtml(currentKey){
  const LABELS = {
    'chuseok-gift': '추석 선물세트 전체',
    'chuseok-gift-for-parents': '부모님 추석 선물',
    'chuseok-gift-for-business': '직장·거래처 추석 선물',
    'chuseok-gift-under-30000': '3만원 이하',
    'chuseok-gift-30000-50000': '3~5만원',
    'chuseok-gift-50000-100000': '5~10만원',
    'chuseok-hanwoo-gift': '한우 선물세트',
    'chuseok-gulbi-gift': '굴비 선물세트',
    'chuseok-fruit-gift': '과일 선물세트',
    'chuseok-health-gift': '건강식품 선물세트',
  };
  const def = SHOPPING_PAGE_DEFS[currentKey];
  const pills = SHOPPING_PAGE_ORDER
    .filter(k => k !== currentKey)
    .map(k => `<a href="/${k}" class="pill">${escapeHtml(LABELS[k])}</a>`)
    .join('');
  return `
    <div class="related">
      <p class="related-title">${def.isHub ? '조건별로 찾아보기' : '다른 추석 선물 보기'}</p>
      <div class="pills">${pills}</div>
    </div>`;
}

function shoppingBreadcrumbJsonLd(pageKey){
  const canonical = `${SITE_URL}/${pageKey}`;
  const def = SHOPPING_PAGE_DEFS[pageKey];
  const items = [{ name: '홈', url: `${SITE_URL}/` }];
  if (!def.isHub){
    items.push({ name: SHOPPING_PAGE_DEFS['chuseok-gift'].h1, url: `${SITE_URL}/chuseok-gift` });
  }
  items.push({ name: def.h1, url: canonical });
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })),
  };
  const safe = JSON.stringify(jsonLd).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${safe}</script>`;
}

function renderShoppingPage(pageKey){
  const def = SHOPPING_PAGE_DEFS[pageKey];
  if (!def) return null;
  const canonical = `${SITE_URL}/${pageKey}`;
  const todayLabel = fmtTodayLabelKo();

  const allProducts = parseProducts();
  const matched = dedupeByNameUrl(allProducts.filter(def.filter));
  const totalMatched = matched.length;
  // 리뷰 많은순(기존 /hot-deals 기본 정렬과 동일한 기준) — "BEST/추천순위"가 아니라 정렬 기준 표기일 뿐.
  const sorted = matched.slice().sort((a, b) => (Number(b.reviews) || 0) - (Number(a.reviews) || 0));
  const shown = sorted.slice(0, MAX_PRODUCTS_PER_PAGE);
  const truncated = totalMatched > shown.length;

  const cardsHtml = shown.map((p, i) => productCardHtml(p, i)).join('');

  const bodyEmpty = totalMatched === 0;

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
<meta property="og:site_name" content="주문의고수">
<meta property="og:title" content="${escapeHtml(def.title)}">
<meta property="og:description" content="${escapeHtml(def.description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:image" content="${SITE_URL}/og-image.png">
<link rel="icon" type="image/png" href="/favicon.png">
${shoppingBreadcrumbJsonLd(pageKey)}
<style>
  body{ margin:0; background:${BG}; color:${TEXT}; font-family:'Noto Sans KR', -apple-system, sans-serif; }
  a{ color:${PRIMARY}; }
  .wrap{ max-width:960px; margin:0 auto; padding:24px 16px 60px; }
  h1{ font-size:22px; margin:4px 0 8px; }
  h1, h2, h3, p, li, a, button{ word-break: keep-all; overflow-wrap: break-word; }
  .condition{ display:inline-block; font-size:12px; color:${PRIMARY}; background:rgba(255,184,0,0.10); border:1px solid ${PRIMARY}; border-radius:999px; padding:4px 12px; margin:6px 0 18px; }
  .grid{ display:grid; grid-template-columns:repeat(2,1fr); gap:12px; margin:8px 0 20px; }
  @media (min-width:640px){ .grid{ grid-template-columns:repeat(3,1fr); } }
  @media (min-width:900px){ .grid{ grid-template-columns:repeat(4,1fr); } }
  .pcard{ background:${CARD}; border:1px solid ${LINE}; border-radius:10px; padding:12px; display:flex; flex-direction:column; align-items:center; text-align:center; }
  .pcard-slot{ width:120px; height:240px; overflow:hidden; margin-bottom:8px; }
  .pcard-link{ text-decoration:none; color:inherit; display:block; width:100%; }
  .pcard-cat{ font-size:11px; color:${MUTED}; margin:0 0 4px; }
  .pcard-name{ font-size:12px; font-weight:600; color:${TEXT}; margin:0 0 4px; }
  .pcard-price{ font-size:15px; font-weight:800; color:${AGP_PRICE}; margin:0 0 4px; }
  .pcard-snap{ font-size:10px; font-weight:400; color:${MUTED}; }
  .pcard-rating{ font-size:11px; color:${MUTED}; margin:0; }
  .prow{ display:flex; align-items:center; justify-content:space-between; gap:12px; padding:12px; border-bottom:1px solid ${LINE}; text-decoration:none; color:inherit; }
  .prow:last-child{ border-bottom:none; }
  .empty{ color:${MUTED}; font-size:14px; padding:24px 0; }
  .related{ margin:24px 0; }
  .related-title{ font-size:12px; font-weight:700; color:${MUTED}; margin:0 0 8px; }
  .pills{ display:flex; flex-wrap:wrap; gap:6px; }
  .pill{ display:inline-block; padding:6px 12px; border-radius:999px; font-size:12px; font-weight:600; text-decoration:none; background:${CARD}; color:${MUTED}; border:1px solid ${LINE}; }
  .cta{ display:block; text-align:center; margin:20px 0 8px; padding:14px; background:${PRIMARY}; color:${BG}; font-weight:700; border-radius:8px; text-decoration:none; }
  .cta-outline{ display:block; text-align:center; margin:10px 0; padding:12px; background:${CARD}; color:${TEXT}; font-weight:600; border:1px solid ${LINE}; border-radius:8px; text-decoration:none; font-size:13px; }
  .note{ font-size:12px; color:${MUTED}; opacity:0.85; margin:4px 0; }
  .disclosure{ font-size:11px; color:${MUTED}; opacity:0.7; line-height:1.5; margin-top:16px; }
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
    주문의고수
  </a>
  <p style="font-size:12px; color:${MUTED}; margin:0 0 4px;">${escapeHtml(todayLabel)} 기준</p>
  <h1>${escapeHtml(def.h1)}</h1>
  <p style="font-size:14px; line-height:1.6; color:${MUTED}; margin-bottom:4px;">${escapeHtml(def.intro)}</p>
  <span class="condition">${escapeHtml(def.conditionLabel)} · ${totalMatched}개</span>

  ${bodyEmpty
    ? `<p class="empty">현재 조건에 맞는 상품이 없어요. <a href="/hot-deals">전체 추석 선물세트 보기 →</a></p>`
    : `<div class="grid">${cardsHtml}</div>
       ${truncated ? `<p class="note">${totalMatched}개 중 ${shown.length}개만 표시했어요(리뷰 많은순). 나머지는 아래에서 확인하세요.</p>` : ''}
       <a href="/hot-deals" class="cta">/hot-deals에서 필터로 전체 보기 →</a>`
  }

  ${relatedLinksHtml(pageKey)}

  <p class="note">상품 정보는 확인 시점 기준이며 쿠팡에서 변경될 수 있습니다.</p>
  <p class="disclosure">이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.</p>
  <p style="font-size:11px; color:${MUTED}; opacity:0.7; margin-top:24px;">주문의고수 · 운영: 문라잇 · <a href="/about" style="color:${MUTED};">서비스 소개</a></p>
</div>
<script>
(function(){
  // /hot-deals와 같은 원리의 지연 로드: 슬롯이 뷰포트 근처에 들어올 때만 쿠팡 iframe(base64로 실어둔
  // partnerHtml 원본)을 그대로 삽입한다. src 재설정/반복 삽입 없음 — 슬롯당 딱 한 번만 채운다.
  function b64ToUtf8(b64){
    try { return decodeURIComponent(escape(window.atob(b64))); } catch (e) { return ''; }
  }
  function loadSlot(slot){
    if (!slot || slot.dataset.loaded === '1') return;
    var html = b64ToUtf8(slot.getAttribute('data-html') || '');
    if (!html) return;
    slot.dataset.loaded = '1';
    slot.innerHTML = html;
  }
  var slots = document.querySelectorAll('.pcard-slot');
  if (typeof window.IntersectionObserver === 'function'){
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(entry){
        if (!entry.isIntersecting) return;
        loadSlot(entry.target);
        io.unobserve(entry.target);
      });
    }, { root: null, rootMargin: '600px 0px', threshold: 0 });
    slots.forEach(function(s){ io.observe(s); });
  } else {
    slots.forEach(loadSlot);
  }
})();
</script>
</body>
</html>`;
}

export { SHOPPING_PAGE_DEFS, SHOPPING_PAGE_ORDER, parseProducts, dedupeByNameUrl, renderShoppingPage };

export default async function handler(req, res){
  try {
    const pageKey = req.query.page;
    const html = renderShoppingPage(pageKey);
    if (!html){
      res.status(404).send('Not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    res.status(200).send(html);
  } catch (err){
    console.error('[주문의고수 쇼핑 SEO 페이지]', err);
    res.status(500).send('페이지를 불러오지 못했습니다.');
  }
}

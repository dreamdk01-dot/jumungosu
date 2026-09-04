// /api/home.js
//
// 홈("/") 요청에 대해서만, 정적 index.html을 그대로 내려주는 대신
// "지금 라이브인 할인 데이터"를 서버에서 읽어와 아래 3개 영역에 실제 텍스트로 채워 넣은 뒤 응답합니다.
//   - 오늘 배달 할인 리스트 (#discount-list)
//   - BEST 3 (#best3-list, #best3-list-mobile)
//   - 오늘 할인 브랜드 내부링크 (#today-brand-links)
//
// 왜 필요한가:
// index.html에서 이 세 영역은 전부 빈 <div>이고, 브라우저가 JS를 실행해서
// /api/discounts를 fetch()한 뒤에야 채워집니다. 검색엔진이 JS 렌더링을 하지 않거나
// (네이버 등) 렌더링에 실패/타임아웃되면, 사이트의 대표 URL(홈)이 사실상 빈 페이지로 보일 수 있습니다.
//
// 이 파일이 하는 일은 딱 "미리 채워두는 것"뿐입니다.
//   - index.html 파일 자체는 디스크에서 읽기만 하고 절대 수정하지 않습니다.
//   - 기존 프론트엔드 JS(loadDiscountsFromAirtable → renderDiscountList/renderBest3/renderTodayBrandLinks)는
//     그대로 동작하며, 페이지 로드 후 이 영역들의 innerHTML을 다시 전체 교체합니다.
//     (index.html 확인 결과 전부 innerHTML 전체 대입 방식이라, 이 함수가 미리 채워둔 내용과
//      실제로 중복 표시될 가능성은 없습니다.)
//   - 할인 데이터 조회(Supabase/Airtable 캐시)가 실패해도 원본 index.html을 그대로 응답해서
//     홈페이지 자체가 500 오류로 죽는 일이 없게 합니다.
//
// 재사용 원칙:
// 브랜드/필드 판정 로직을 새로 만들지 않고, 이미 8개 SEO 랜딩페이지에서 검증된 seo.js의
// mapRecord/isLive/PAGE_DEFS/fmtWon/escapeHtml/APP_LABEL/NAV_LABEL을 그대로 가져다 씁니다.
// "오늘 배달 할인"/"BEST3" 목록은 today-delivery-discount SEO 페이지와 동일하게,
// 브랜드로 묶지 않고 개별 레코드를 할인 금액 내림차순으로 나열하는 방식을 그대로 따릅니다.

import fs from 'fs';
import path from 'path';
import {
  PAGE_DEFS,
  NAV_LABEL,
  mapRecord,
  isLive,
  fmtWon,
  escapeHtml,
  APP_LABEL,
} from './seo.js';

const INDEX_HTML_PATH = path.join(process.cwd(), 'index.html');

// 이번 요청에서 보여줄 "오늘 배달 할인" 개수 (BEST3와 별개로, 리스트 영역에 채울 개수)
const TOP_LIST_COUNT = 12;

// 함수 인스턴스가 재사용되는 동안(warm)에는 디스크를 다시 읽지 않도록 메모리에 캐시합니다.
// 새 배포가 있으면 어차피 새 함수 인스턴스가 뜨므로 index.html 변경 사항은 항상 반영됩니다.
let cachedTemplate = null;
function getTemplate() {
  if (cachedTemplate === null) {
    cachedTemplate = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  }
  return cachedTemplate;
}

// discounts.js와 동일한 방식으로 Supabase 캐시(cached_airtable_records)를 service_role 키로 조회합니다.
// (seo.js의 fetchCachedRecords()는 export되어 있지 않고, 그 함수의 기존 반환 형태를 바꾸는 것은
//  seo.js 기존 동작 변경 위험이 있어 피하고, discounts.js와 같은 조회 로직만 이 파일 안에 별도로 둡니다.)
async function fetchLiveDiscounts() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('환경변수(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY)가 비어있습니다.');
  }

  const url = `${SUPABASE_URL}/rest/v1/cached_airtable_records?id=eq.1&select=records`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 조회 오류 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const rows = await res.json();
  const rawRecords = (rows && rows[0] && rows[0].records) || [];
  return rawRecords.map(mapRecord).filter(Boolean).filter(isLive);
}

// 홈 화면의 "UPDATED" 배지(admin이 저장한 app_config 값)와 동일한 값을 서버에서도 조회합니다.
// 실패해도 SSR 전체를 막지 않고, 배지 자리만 비워둡니다(기존에도 값이 없으면 빈 문자열이었음).
async function fetchDiscountUpdatedAt() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_discount_updated_at`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) return null;
    return (await res.json()) || null;
  } catch {
    return null;
  }
}

// index.html의 formatUpdatedBadge()와 동일한 표시 규칙 (🟢 UPDATED MM/DD HH:mm).
// 화면에 보이는 문구가 SSR 단계와 JS 렌더링 단계에서 서로 달라 보이지 않도록 그대로 맞췄습니다.
function formatUpdatedBadge(dateStr) {
  const raw = (dateStr || '').toString();
  if (!raw) return '';
  const hasTime = raw.includes('T');
  const d = new Date(hasTime ? raw : `${raw}T00:00:00`);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  const dateLabel = `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  const timeLabel = hasTime ? ` ${pad(d.getHours())}:${pad(d.getMinutes())}` : '';
  return `🟢 UPDATED ${dateLabel}${timeLabel}`;
}

function limitedTimeBadgeHtml(d) {
  return d.limitedTime
    ? `<span style="font-size:11px; color:#FF5A36; margin-left:6px;">⏰ ${escapeHtml(d.limitedTime)} 선착순</span>`
    : '';
}

function appTagHtml(app) {
  return `<span style="display:inline-block; font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted);">${escapeHtml(APP_LABEL[app] || app)}</span>`;
}

// "오늘 배달 할인" 리스트 카드 (#discount-list 자리에 들어갈 SSR 텍스트)
function renderSsrDiscountCards(list) {
  return list
    .map(
      (d) => `
    <div class="rounded-md p-3 sm:p-4" style="background:var(--surface); border:1px solid var(--line);">
      <div class="flex items-center justify-between gap-2 mb-1">
        <p class="font-bold text-sm sm:text-base">${escapeHtml(d.name)}</p>
        <p class="font-mono text-sm sm:text-base font-bold" style="color:var(--primary);">${fmtWon(d.amount)} 할인</p>
      </div>
      <div class="flex items-center gap-1 flex-wrap">
        ${d.app.map(appTagHtml).join('')}
        ${limitedTimeBadgeHtml(d)}
      </div>
    </div>`
    )
    .join('');
}

// BEST3 데스크탑(영수증 카드형)
function renderSsrBest3Desktop(list) {
  return list
    .map(
      (d) => `
    <div class="rounded-md p-3 sm:p-4" style="background:var(--surface);">
      <div class="flex items-center gap-2 mb-1.5 sm:mb-3">
        <div class="w-7 h-7 sm:w-9 sm:h-9 rounded font-mono text-[11px] sm:text-xs flex items-center justify-center font-bold" style="background:var(--card-alt); color:var(--primary);">${escapeHtml((d.name || '').slice(0, 2))}</div>
        <p class="font-bold text-sm sm:text-base leading-tight">${escapeHtml(d.name)}</p>
      </div>
      <p class="font-mono text-lg sm:text-2xl font-bold mb-1 sm:mb-2" style="color:var(--primary);">${fmtWon(d.amount)} 할인</p>
      <div class="flex gap-1 flex-wrap items-center">
        ${d.app.map(appTagHtml).join('')}
        ${limitedTimeBadgeHtml(d)}
      </div>
    </div>`
    )
    .join('');
}

// BEST3 모바일(한 줄 리스트형)
function renderSsrBest3Mobile(list) {
  return list
    .map(
      (d, i) => `
    <div class="rounded-md px-3 py-2.5" style="background:var(--surface);">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="font-mono text-xs font-bold shrink-0" style="color:var(--primary); width:14px;">${i + 1}</span>
          <span class="font-bold text-sm truncate">${escapeHtml(d.name)}</span>
          ${d.app.slice(0, 1).map(appTagHtml).join('')}
        </div>
        <span class="font-mono text-sm font-bold shrink-0" style="color:var(--primary);">${fmtWon(d.amount)}</span>
      </div>
    </div>`
    )
    .join('');
}

// "오늘 할인 브랜드" 내부링크 — seo.js의 PAGE_DEFS(singleBrand 10개)를 그대로 판정 기준으로 사용해
// 브랜드 SEO 페이지(예: /bbq-discount)와 판정 기준이 어긋나지 않게 합니다.
function buildBrandLinks(liveDiscounts) {
  const brandKeys = Object.keys(PAGE_DEFS).filter((k) => PAGE_DEFS[k].singleBrand);
  const matched = brandKeys
    .map((key) => {
      const rows = liveDiscounts.filter(PAGE_DEFS[key].filter);
      if (!rows.length) return null;
      const label = (NAV_LABEL[key] || key).replace(/\s*할인.*$/, '');
      const maxAmount = Math.max(...rows.map((d) => d.amount));
      return { slug: key, label, amount: maxAmount };
    })
    .filter(Boolean);
  matched.sort((a, b) => b.amount - a.amount);
  return matched.slice(0, 5);
}

function renderSsrBrandLinks(list) {
  return list
    .map(
      (b) => `
    <a href="/${b.slug}" class="flex items-center justify-between px-4 py-3 rounded-lg" style="background:var(--card); border:1px solid var(--line);">
      <span class="font-semibold text-sm" style="color:var(--text);">${escapeHtml(b.label)}</span>
      <span class="font-bold text-sm" style="color:var(--primary);">${fmtWon(b.amount)} 할인 →</span>
    </a>`
    )
    .join('');
}

// index.html 문자열 안의 "비어있는" 특정 태그(anchor)를 찾아 그 자리에 SSR 조각을 끼워 넣습니다.
// anchor를 못 찾으면(=index.html 구조가 나중에 바뀌면) 아무것도 하지 않고 조용히 건너뛰어서,
// 이 함수 하나 때문에 페이지 전체가 깨지는 일이 없게 합니다.
function injectIntoEmptyTag(html, anchor, innerHtml) {
  if (!html.includes(anchor)) return html;
  const openEnd = anchor.indexOf('>');
  const openPart = anchor.slice(0, openEnd + 1);
  const closePart = anchor.slice(openEnd + 1); // 예: '</div>'
  return html.replace(anchor, `${openPart}${innerHtml}${closePart}`);
}

export default async function handler(req, res) {
  let html;
  try {
    html = getTemplate();
  } catch (err) {
    // index.html 자체를 읽지 못하면(배포 이슈 등) 이 함수는 아무 것도 응답할 수 없습니다.
    // (정적 서빙이었어도 파일이 없으면 동일하게 사이트를 볼 수 없는 상황입니다.)
    console.error('[홈 SSR] index.html 템플릿을 읽지 못했습니다.', err);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(500).end('일시적인 오류가 발생했습니다.');
  }

  try {
    const live = await fetchLiveDiscounts();

    if (live.length > 0) {
      const sortedByAmount = live.slice().sort((a, b) => b.amount - a.amount);
      const top3 = sortedByAmount.slice(0, 3);
      const topList = sortedByAmount.slice(0, TOP_LIST_COUNT);
      const brandLinks = buildBrandLinks(live);
      const updatedBadge = formatUpdatedBadge(await fetchDiscountUpdatedAt());

      html = injectIntoEmptyTag(
        html,
        '<div id="discount-list" class="grid sm:grid-cols-2 gap-4"></div>',
        renderSsrDiscountCards(topList)
      );
      html = injectIntoEmptyTag(
        html,
        '<div id="best3-list-mobile" class="sm:hidden space-y-2"></div>',
        renderSsrBest3Mobile(top3)
      );
      html = injectIntoEmptyTag(
        html,
        '<div id="best3-list" class="contents"></div>',
        renderSsrBest3Desktop(top3)
      );

      // result-count는 이미 "0"이라는 텍스트가 들어있는 상태라 위 injectIntoEmptyTag(빈 태그 전용)로는
      // 처리할 수 없어, 정확히 일치하는 문자열을 통째로 바꾸는 방식으로 별도 처리합니다.
      html = html.replace(
        '<span id="result-count">0</span>',
        `<span id="result-count">${sortedByAmount.length}</span>`
      );

      if (updatedBadge) {
        html = injectIntoEmptyTag(
          html,
          '<span class="font-mono text-xs" id="best3-updated-badge" style="color:var(--muted);"></span>',
          updatedBadge
        );
        html = injectIntoEmptyTag(
          html,
          '<p id="discount-list-updated" class="font-mono text-[12px] mb-2 whitespace-nowrap" style="color:var(--muted);"></p>',
          updatedBadge
        );
      }

      if (brandLinks.length > 0) {
        html = injectIntoEmptyTag(
          html,
          '<div id="today-brand-links" class="flex flex-col gap-2"></div>',
          renderSsrBrandLinks(brandLinks)
        );
        // 이 섹션은 원래 class="mb-8 hidden"으로 시작해서 JS가 데이터 있을 때만 hidden을 제거하는 구조입니다.
        // 검색엔진이 display:none 텍스트를 낮게 평가할 수 있어, 실제로 보여줄 데이터가 있을 때는
        // SSR 단계에서 미리 hidden을 제거해 "보이는 상태"로 내려줍니다.
        // (페이지 로드 후 renderTodayBrandLinks()가 동일한 방식으로 다시 한 번 hidden을 정리하므로 충돌 없음.)
        html = html.replace(
          '<section id="today-brand-links-section" class="mb-8 hidden">',
          '<section id="today-brand-links-section" class="mb-8">'
        );
      }
    }
    // live.length === 0인 경우(오늘 등록된 할인이 하나도 없는 극단적 상황)에는
    // 아무것도 끼워 넣지 않고, 기존과 동일하게 빈 컨테이너 그대로 응답합니다(하드코딩 데이터 없음).

    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(html);
  } catch (err) {
    // 데이터 조회 실패(Airtable/Supabase 장애 등) 시에는 SSR을 포기하고
    // 원본 index.html(기존과 100% 동일한 동작 — 브라우저가 /api/discounts를 다시 시도)을 그대로 응답합니다.
    console.error('[홈 SSR] 할인 데이터 조회 실패 - SSR 없이 원본 index.html로 응답합니다.', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(200).end(getTemplate());
  }
}

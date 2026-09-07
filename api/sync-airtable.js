// [브랜드 SEO 페이지 이력 기능] 이 함수(sync-airtable)가 실행될 때마다 오늘(KST) 기준으로
// "브랜드별·앱별 정액 할인이 있었는지"를 Supabase brand_discount_daily 테이블에 upsert 해둡니다.
// 브랜드 SEO 페이지(/bbq-discount, /dominopizza-discount 등)의 "최근 할인 이력" / "최근 30일
// 앱별 할인 횟수" 섹션이 이 데이터를 읽어갑니다.
//
// 브랜드명→brand_key 정규화와 플랫폼 변환은 새로 만들지 않고 seo.js의 PAGE_DEFS/mapRecord를
// 그대로 재사용합니다 — 브랜드 SEO 페이지가 실제로 쓰는 판정 기준과 완전히 동일하게 맞추기 위함입니다.
//   - brand_key: PAGE_DEFS의 각 singleBrand 페이지 키(예: 'dominopizza-discount')에서
//     '-discount'를 뗀 값 (seo.js가 브랜드 페이지를 렌더링할 때 쓰는 것과 동일한 규칙).
//   - platform: mapRecord()가 이미 배달의민족→baemin, 요기요→yogiyo, 쿠팡이츠→coupang,
//     땡겨요→ddangyo 로 정규화해서 반환하는 값을 그대로 씀 (여기서 별도 변환하지 않음).
import { PAGE_DEFS, mapRecord, isLive, getTodayKST } from './seo.js';

const BRAND_PAGE_KEYS = Object.keys(PAGE_DEFS).filter((k) => PAGE_DEFS[k].singleBrand);

// 오늘 라이브 상태인 할인들을 브랜드×앱별로 정리해서, brand_discount_daily에 upsert할
// { brand_key, date_kst, platform, amount } 행 배열을 만듭니다.
// 같은 brand_key+date_kst+platform 조합은 하나로 집계(레코드가 여럿이면 더 큰 금액을 대표로 씀).
function buildBrandDailyRows(records) {
  const discounts = records.map(mapRecord).filter(Boolean).filter(isLive);
  const today = getTodayKST();
  const rows = [];

  for (const pageKey of BRAND_PAGE_KEYS) {
    const def = PAGE_DEFS[pageKey];
    const brandKey = pageKey.replace('-discount', '');
    const matched = discounts.filter(def.filter);
    const bestByApp = {};
    matched.forEach((d) => {
      // 할인금액이 정상적인 양수가 아니거나 앱 정보가 없는 레코드는 이력에 남기지 않음
      if (!(d.amount > 0)) return;
      const app = d.app[0];
      if (!app) return;
      if (!bestByApp[app] || d.amount > bestByApp[app]) bestByApp[app] = d.amount;
    });
    Object.entries(bestByApp).forEach(([platform, amount]) => {
      rows.push({ brand_key: brandKey, date_kst: today, platform, amount });
    });
  }
  return rows;
}

// brand_discount_daily에 upsert. rows가 0개면 Supabase 요청 없이 0을 반환하고 정상 종료.
// 실패하면 에러를 그대로 throw해서(호출부에서 잡아 console.error로 남김) 원인을 로그에서 바로 확인할 수 있게 함.
async function updateBrandDailyHistory(records) {
  const rows = buildBrandDailyRows(records);
  if (!rows.length) return 0;

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/brand_discount_daily?on_conflict=brand_key,date_kst,platform`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`brand_discount_daily 저장 오류 (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  return rows.length;
}

export default async function handler(req, res) {
  const providedSecret = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.SYNC_SECRET || providedSecret !== process.env.SYNC_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const AIRTABLE_PAT = process.env.AIRTABLE_PAT;
  const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
  const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!AIRTABLE_PAT || !AIRTABLE_BASE_ID || !AIRTABLE_TABLE_NAME || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: '환경변수가 비어있습니다. Vercel 프로젝트 설정을 확인해주세요.' });
  }

  try {
    const records = [];
    let offset = null;
    do {
      const url = new URL(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`);
      url.searchParams.set('pageSize', '100');
      if (offset) url.searchParams.set('offset', offset);

      const airtableRes = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${AIRTABLE_PAT}` },
      });
      if (!airtableRes.ok) {
        const text = await airtableRes.text().catch(() => '');
        throw new Error(`Airtable API 오류 (HTTP ${airtableRes.status}): ${text.slice(0, 300)}`);
      }
      const data = await airtableRes.json();
      records.push(...(data.records || []));
      offset = data.offset || null;
    } while (offset);

    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/cached_airtable_records?on_conflict=id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: 1, records, updated_at: new Date().toISOString() }),
    });

    if (!upsertRes.ok) {
      const text = await upsertRes.text().catch(() => '');
      throw new Error(`Supabase 저장 오류 (HTTP ${upsertRes.status}): ${text.slice(0, 300)}`);
    }

    // 3) 브랜드별 오늘의 할인 이력 기록 (best-effort — 실패해도 위의 캐시 동기화 응답은 그대로 성공 처리)
    let historyRows = 0;
    try {
      historyRows = await updateBrandDailyHistory(records);
    } catch (historyErr) {
      console.error('[sync-airtable] 브랜드 이력 기록 실패 (brand_discount_daily 확인 필요)', historyErr);
    }

    return res.status(200).json({ ok: true, count: records.length, historyRows, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[sync-airtable]', err);
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}

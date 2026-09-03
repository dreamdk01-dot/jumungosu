// /api/sync-airtable.js
//
// Vercel 서버리스 함수: Airtable에서 할인 데이터를 전부 읽어와 Supabase(cached_airtable_records)에
// 저장해두는 역할만 합니다. 방문자 브라우저가 아니라 "서버"가 Airtable을 호출하기 때문에,
// 방문자가 아무리 많아져도 Airtable API 호출 횟수는 이 함수가 실행되는 횟수(하루 288회, 5분 간격)로 고정됩니다.
//
// 아무나 이 주소(/api/sync-airtable)를 알면 호출할 수 있으므로, ?secret=... 값으로 보호합니다.
// UptimeRobot이나 Vercel Cron이 이 비밀값을 포함한 주소로만 호출하도록 설정해야 합니다.
//
// 필요한 환경변수 (Vercel 프로젝트 설정 → Environment Variables 에서 등록):
//   AIRTABLE_PAT                Airtable Personal Access Token (읽기 전용 권한만)
//   AIRTABLE_BASE_ID            Airtable Base ID (app로 시작)
//   AIRTABLE_TABLE_NAME         Airtable 테이블 ID (tbl로 시작)
//   SUPABASE_URL                https://sxuqkuqpopckhttvpwvh.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   Supabase 프로젝트 설정 → API → service_role 키 (절대 클라이언트에 노출 금지!)
//   SYNC_SECRET                 아무 임의의 긴 문자열 (예: openssl rand -hex 16 로 생성)
//
// [브랜드 SEO 페이지 이력 기능 추가] 이 함수가 실행될 때마다(5분마다) 오늘(KST) 기준으로
// "브랜드별·앱별 정액 할인이 있었는지"를 Supabase brand_discount_daily 테이블에 하루 1행씩
// upsert 해둡니다. 브랜드 SEO 페이지(/bbq-discount 등)의 "최근 할인 이력" / "최근 30일 앱별
// 할인 횟수" 섹션이 이 데이터를 읽어갑니다. brand_discount_daily 테이블과
// get_brand_discount_stats() RPC를 먼저 Supabase에 만들어야 동작합니다(SQL은 별도 전달).
// 브랜드 판정 로직(어떤 레코드가 어떤 브랜드인지)은 seo.js의 PAGE_DEFS를 그대로 재사용해서,
// 브랜드 매칭 기준이 두 파일에서 어긋나지 않도록 합니다.
import { PAGE_DEFS, mapRecord, isLive, getTodayKST } from './seo.js';

const BRAND_PAGE_KEYS = Object.keys(PAGE_DEFS).filter((k) => PAGE_DEFS[k].singleBrand);

// 오늘 라이브 상태인 할인들을 브랜드×앱별로 정리해서, brand_discount_daily에 upsert할
// 행 배열을 만듭니다. 같은 브랜드+앱에 여러 레코드가 있으면 더 큰 금액을 대표로 씁니다.
// (재실행마다 최신 감지값으로 덮어쓰는 방식 — 하루 안에서 금액이 바뀌면 마지막 동기화 값이 남습니다.)
function buildBrandDailyRows(rawRecords) {
  const discounts = rawRecords.map(mapRecord).filter(Boolean).filter(isLive);
  const today = getTodayKST();
  const rows = [];

  for (const pageKey of BRAND_PAGE_KEYS) {
    const def = PAGE_DEFS[pageKey];
    const brandKey = pageKey.replace('-discount', '');
    const matched = discounts.filter(def.filter);
    const bestByApp = {};
    matched.forEach((d) => {
      const app = d.app[0];
      if (!bestByApp[app] || d.amount > bestByApp[app]) bestByApp[app] = d.amount;
    });
    Object.entries(bestByApp).forEach(([platform, amount]) => {
      rows.push({ brand_key: brandKey, date_kst: today, platform, amount });
    });
  }
  return rows;
}

// brand_discount_daily 테이블/RPC가 아직 배포 전이거나 이 호출이 실패해도
// 본 캐시 동기화(sync-airtable의 핵심 기능)에는 영향을 주지 않도록 항상 별도로 감싸서 호출합니다.
async function updateBrandDailyHistory(rawRecords, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY }) {
  const rows = buildBrandDailyRows(rawRecords);
  if (!rows.length) return { upserted: 0 };

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
  return { upserted: rows.length };
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
    // 1) Airtable에서 전체 레코드 가져오기 (한 번에 최대 100건 → offset으로 페이지네이션)
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

    // 2) Supabase에 캐싱 (id=1 고정 행을 upsert — service_role 키라 RLS를 우회함)
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

    // 3) 브랜드별 오늘의 할인 이력 기록 (best-effort — 실패해도 위의 캐시 동기화 응답은 정상 처리)
    let brandHistoryResult = null;
    try {
      brandHistoryResult = await updateBrandDailyHistory(records, { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY });
    } catch (historyErr) {
      console.warn('[sync-airtable] 브랜드 이력 기록 실패 (brand_discount_daily 테이블/RPC 확인 필요)', historyErr);
    }

    return res.status(200).json({
      ok: true,
      count: records.length,
      brandHistoryUpserted: brandHistoryResult ? brandHistoryResult.upserted : null,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[sync-airtable]', err);
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}

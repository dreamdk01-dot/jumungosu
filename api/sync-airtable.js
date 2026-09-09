// /api/sync-airtable.js
//
// Vercel 서버리스 함수: Airtable에서 할인 데이터를 전부 읽어와 Supabase(cached_airtable_records)에
// 저장해두는 역할을 합니다. 방문자 브라우저가 아니라 "서버"가 Airtable을 호출하기 때문에,
// 방문자가 아무리 많아져도 Airtable API 호출 횟수는 이 함수가 실행되는 횟수(약 5분 간격)로 고정됩니다.
//
// 아무나 이 주소(/api/sync-airtable)를 알면 호출할 수 있으므로, ?secret=... 값으로 보호합니다.
// 외부 스케줄러(UptimeRobot 등) 또는 Vercel Cron이 이 비밀값을 포함한 주소로만 호출하도록 설정해야 합니다.
// (2026-09-09 조사 결과: 이 저장소의 vercel.json에는 sync-airtable용 cron 항목이 없고,
//  실제로는 5분 간격으로 외부에서 이 엔드포인트를 직접 호출하고 있는 것으로 확인됐습니다.
//  이 파일은 "무엇이 호출하든" 매 실행마다 아래 3가지 작업을 전부 하도록 만든 것이고,
//  스케줄러 자체 설정은 이 파일 밖(Vercel 프로젝트 밖)에 있어 이번 수정 범위가 아닙니다.)
//
// 필요한 환경변수 (Vercel 프로젝트 설정 → Environment Variables 에서 등록):
//   AIRTABLE_PAT                Airtable Personal Access Token (읽기 전용 권한만)
//   AIRTABLE_BASE_ID            Airtable Base ID (app로 시작)
//   AIRTABLE_TABLE_NAME         Airtable 테이블 ID (tbl로 시작)
//   SUPABASE_URL                https://sxuqkuqpopckhttvpwvh.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   Supabase 프로젝트 설정 → API → service_role 키 (절대 클라이언트에 노출 금지!)
//   SYNC_SECRET                 아무 임의의 긴 문자열
//
// 이 함수가 매 실행마다 하는 일 (실행 순서):
//   1) Airtable 전체 레코드 조회
//   2) Supabase cached_airtable_records 갱신 (핵심 기능 — 실패하면 전체 sync 실패로 처리)
//   3) app_config.discount_updated_at 갱신 (홈 화면 "UPDATED" 배지, best-effort)
//   4) Supabase brand_discount_daily에 오늘(KST) 브랜드×앱별 이력 upsert (best-effort)
// 3)/4)는 서로 완전히 독립적인 best-effort 작업이라, 하나가 실패해도 다른 하나와 핵심 기능(2)에는
// 영향을 주지 않습니다. 다만 예전에는 실패해도 응답에 아무 흔적이 안 남아 문제를 알아차리기 어려웠던
// 점을 개선해서, 이제 응답에 각각 성공/실패 상태를 명시적으로 남깁니다(진단 강화).
//
// 브랜드명→brand_key 정규화와 플랫폼 변환은 새로 만들지 않고 seo.js의 PAGE_DEFS/mapRecord를
// 그대로 재사용합니다 — 브랜드 SEO 페이지가 실제로 쓰는 판정 기준과 완전히 동일하게 맞추기 위함입니다.
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
// 실패하면 에러를 그대로 throw해서(호출부에서 잡아 진단 정보로 남김) 원인을 바로 확인할 수 있게 함.
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

    // 2) Supabase에 캐싱 (id=1 고정 행을 upsert — service_role 키라 RLS를 우회함). 핵심 기능이라
    //    실패하면 아래 3)/4)를 시도하지 않고 그대로 catch로 빠져 sync 전체를 실패 처리한다.
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

    // 3) 홈 화면 "UPDATED" 배지 자동 갱신 (best-effort). set_discount_updated_at RPC는 관리자
    //    수동 저장 전용으로 그대로 두고, 여기서는 service_role로 app_config를 직접 UPDATE한다.
    let discountUpdatedAtOk = false;
    let discountUpdatedAtError = null;
    try {
      // 서버 실행 환경의 타임존에 의존하지 않도록, UTC 기준 시각에 9시간을 명시적으로 더해
      // KST 벽시계 시각을 직접 계산한다. 관리자 수동 저장값과 완전히 같은 포맷
      // ('YYYY-MM-DDTHH:mm:00', 타임존 표기 없음)으로 맞춰서, app.html의 표시 로직은
      // 전혀 손대지 않아도 그대로 정상 동작하게 한다.
      const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
      const kstNow = new Date(Date.now() + KST_OFFSET_MS);
      const pad = (n) => String(n).padStart(2, '0');
      const kstDateTime =
        `${kstNow.getUTCFullYear()}-${pad(kstNow.getUTCMonth() + 1)}-${pad(kstNow.getUTCDate())}` +
        `T${pad(kstNow.getUTCHours())}:${pad(kstNow.getUTCMinutes())}:00`;

      const updateRes = await fetch(`${SUPABASE_URL}/rest/v1/app_config?key=eq.discount_updated_at`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
        body: JSON.stringify({ value: kstDateTime }),
      });

      if (!updateRes.ok) {
        const text = await updateRes.text().catch(() => '');
        throw new Error(`app_config(discount_updated_at) 갱신 오류 (HTTP ${updateRes.status}): ${text.slice(0, 300)}`);
      }
      discountUpdatedAtOk = true;
    } catch (updatedAtErr) {
      discountUpdatedAtError = updatedAtErr.message || String(updatedAtErr);
      console.error('[sync-airtable] discount_updated_at 자동 갱신 실패 (app_config 테이블 확인 필요)', updatedAtErr);
    }

    // 4) 브랜드별 오늘의 할인 이력 기록 (best-effort — 실패해도 위 2)/3)과 무관하게 sync 자체는
    //    성공 응답을 유지한다). 다만 성공/실패 여부를 응답에 명시적으로 남겨서, 예전처럼
    //    "실패해도 sync는 200이라 아무도 못 알아차리는" 문제가 재발하지 않게 한다.
    let historyRows = 0;
    let historyOk = false;
    let historyError = null;
    try {
      historyRows = await updateBrandDailyHistory(records);
      historyOk = true;
    } catch (historyErr) {
      historyError = historyErr.message || String(historyErr);
      console.error('[sync-airtable] 브랜드 이력 기록 실패 (brand_discount_daily 확인 필요)', historyErr);
    }

    return res.status(200).json({
      ok: true,
      count: records.length,
      discountUpdatedAtOk,
      discountUpdatedAtError,
      historyRows,
      historyOk,
      historyError,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[sync-airtable]', err);
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}

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

    // 할인 데이터 동기화가 정상 완료됐으므로, 홈 화면 "UPDATED" 배지도 자동으로 지금 시각으로
    // 갱신한다. 실패해도 위의 캐시 동기화(핵심 기능)는 이미 성공했으므로 sync 자체는 실패
    // 처리하지 않고, 콘솔에만 명확히 로그를 남긴다(best-effort).
    // set_discount_updated_at RPC는 관리자 수동 저장 전용으로 그대로 두고 건드리지 않으며,
    // 여기서는 service_role로 app_config 테이블을 직접 UPDATE한다(RLS는 service_role이 우회).
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
    } catch (updatedAtErr) {
      console.error('[sync-airtable] discount_updated_at 자동 갱신 실패 (app_config 테이블 확인 필요)', updatedAtErr);
    }

    return res.status(200).json({ ok: true, count: records.length, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[sync-airtable]', err);
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}

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

    return res.status(200).json({ ok: true, count: records.length, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[sync-airtable]', err);
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}

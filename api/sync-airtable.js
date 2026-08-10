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

    return res.status(200).json({ ok: true, count: records.length, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[sync-airtable]', err);
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}

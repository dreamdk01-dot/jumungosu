// /api/discounts.js
//
// 방문자 브라우저가 Supabase(cached_airtable_records)를 anon key로 직접 조회하던 방식을
// 이 서버 함수를 거치도록 바꿔서, 무단으로 할인 데이터를 통째로 긁어가기 어렵게 만듭니다.
//
// 적용한 방어 조치 (완벽 차단이 아니라 "일반적인 자동 스크래핑을 번거롭게" 만드는 목적):
//   1) service_role 키로만 Supabase를 조회 → cached_airtable_records 테이블 자체는
//      RLS로 완전히 잠가서(anon 직접 조회 불가) 이 함수를 거치지 않고는 접근 불가.
//   2) 원본 Airtable 레코드 구조(record.id, createdTime, 내부 필드명 등)를 그대로 노출하지 않고
//      필요한 필드만 뽑아 응답 → 크롤러가 재사용하기 애매한 형태로 가공.
//   3) Cache-Control 헤더로 Vercel 엣지에 짧게 캐싱 → 같은 응답이 반복 요청돼도
//      실제 Supabase 조회 없이 캐시로 응답 (봇이 초당 여러 번 때려도 부하/비용 증가 없음).
//   4) Referer 체크로 우리 사이트 외부에서의 직접 API 호출을 1차로 걸러냄
//      (완벽한 차단은 아니며, header spoofing에는 뚫릴 수 있는 수준의 진입장벽입니다).
//
// 필요한 환경변수 (Vercel 프로젝트 설정 → Environment Variables, sync-airtable.js와 동일):
//   SUPABASE_URL                https://sxuqkuqpopckhttvpwvh.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   Supabase 프로젝트 설정 → API → service_role 키

const ALLOWED_REFERER_HOSTS = ['jumungosu.com', 'www.jumungosu.com'];

function isAllowedReferer(req) {
  const referer = req.headers.referer || req.headers.referrer;
  // Referer가 아예 없는 경우(직접 주소창 입력, 일부 프라이버시 브라우저 등)는
  // 너무 빡빡하게 막으면 정상 사용자도 막힐 수 있어 일단 통과시킵니다.
  // → Referer 체크는 "매너 있는 확인" 수준이며, 이것만으로 완전 차단은 안 됩니다.
  if (!referer) return true;
  try {
    const host = new URL(referer).hostname;
    return ALLOWED_REFERER_HOSTS.includes(host);
  } catch {
    return true;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!isAllowedReferer(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: '환경변수가 비어있습니다. Vercel 프로젝트 설정을 확인해주세요.' });
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/cached_airtable_records?id=eq.1&select=records,updated_at`;
    const supaRes = await fetch(url, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!supaRes.ok) {
      const text = await supaRes.text().catch(() => '');
      throw new Error(`Supabase 조회 오류 (HTTP ${supaRes.status}): ${text.slice(0, 300)}`);
    }

    const rows = await supaRes.json();
    const row = rows && rows[0];
    const rawRecords = (row && row.records) || [];

    // 원본 Airtable 레코드 형태(record.id, createdTime, fields{...})를 그대로 넘기지 않고
    // index.html의 mapAirtableRecordToDiscount()가 기대하는 최소 형태로만 가공해서 응답.
    // (record.id는 프론트에서 안정적인 그룹핑 키로 쓰이는 부분이 없어 굳이 유지할 필요 없어 제거)
    const records = rawRecords.map(r => ({ fields: r.fields || {} }));

    // 60초 동안은 Vercel 엣지가 캐시된 응답을 재사용하고, 그 이후 120초까지는
    // 새 데이터를 백그라운드로 받아오는 동안 이전 캐시를 계속 서빙합니다(끊김 없는 갱신).
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({
      records,
      updated_at: (row && row.updated_at) || null,
    });
  } catch (err) {
    console.error('[discounts]', err);
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}

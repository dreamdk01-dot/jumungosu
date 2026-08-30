// /api/check-event-deadline.js
//
// 매일 한 번(마감 시각 직후) Vercel Cron이 이 함수를 호출합니다.
// 지금 "공개된 이벤트"의 마감 시각(매달 마지막날 22:00 KST)이 지났는데 아직 결과를
// 보고한 적이 없으면, 득표 순위를 정리해서 jumungosu@gmail.com으로 메일을 보내고
// vote_events.reported_at을 채워 다음날 다시 보내지 않도록 표시합니다.
//
// 트리거는 sync-airtable.js와 같은 방식(쿼리스트링 ?secret=...)으로 보호합니다.
// vercel.json의 crons 설정에서 이 secret을 포함한 경로로만 호출되도록 되어 있습니다.
//
// 필요한 환경변수 (Vercel 프로젝트 설정 → Environment Variables):
//   SUPABASE_URL                https://sxuqkuqpopckhttvpwvh.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY   Supabase 프로젝트 설정 → API → service_role 키
//   RESEND_API_KEY              Resend 대시보드에서 발급받은 API 키
//                                (Supabase Auth SMTP에 이미 등록해두신 Resend 계정의 키를 그대로 사용 가능)
//   CRON_SECRET                 아무 임의의 긴 문자열 (예: openssl rand -hex 16 로 생성) — sync-airtable.js의 SYNC_SECRET과 같은 역할

const REPORT_TO_EMAIL = 'jumungosu@gmail.com';
const REPORT_FROM_EMAIL = '주문의 고수 <no-reply@jumungosu.com>'; // Resend에 등록된 발신 도메인에 맞게 필요시 수정하세요

// eventId("chicken_vote_YYYY-MM")에서 연/월을 파싱 (프론트엔드 parseEventMonthInfo와 동일한 로직)
function parseEventMonthInfo(eventId) {
  const m = String(eventId || '').match(/(\d{4})-(\d{2})$/);
  if (!m) return null;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const lastDay = new Date(Date.UTC(year, month, 0)); // UTC 기준으로 그 달의 마지막 날짜만 뽑아 쓰는 용도
  return { year, month, lastDayDate: lastDay.getUTCDate() };
}

// eventId로 지정된 달의 "마지막 날 22:00(KST)"를 유닉스 타임스탬프(ms)로 반환 (프론트엔드와 동일 공식)
function getEventVoteDeadline(eventId) {
  const info = parseEventMonthInfo(eventId);
  if (!info) return null;
  // 22:00 KST = 13:00 UTC (같은 날짜)
  return Date.UTC(info.year, info.month - 1, info.lastDayDate, 13, 0, 0);
}

function weekLabelFromEventId(eventId) {
  const info = parseEventMonthInfo(eventId);
  return info ? `${info.month}월` : eventId;
}

async function supabaseRest(path, { method = 'GET', body, serviceKey, supabaseUrl, extraHeaders = {} } = {}) {
  const res = await fetch(`${supabaseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase 요청 실패 (HTTP ${res.status}) ${path}: ${text.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function buildReportHtml({ eventId, weekLabel, ranked, total, winnerCount, alreadyDrawnCount }) {
  const rows = ranked.map((o, i) => {
    const pct = total > 0 ? Math.round((o.votes / total) * 100) : 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}위`;
    return `<tr>
      <td style="padding:8px 10px; border-bottom:1px solid #333;">${medal}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #333; font-weight:${i === 0 ? '700' : '400'};">${escapeHtml(o.label)}</td>
      <td style="padding:8px 10px; border-bottom:1px solid #333; text-align:right;">${o.votes}표 (${pct}%)</td>
    </tr>`;
  }).join('');

  const drawReminder = alreadyDrawnCount > 0
    ? `<p style="color:#4ADE80;">✅ 이 회차는 이미 ${alreadyDrawnCount}명 추첨을 완료했어요.</p>`
    : `<p style="color:#FF5A36; font-weight:700;">⚠️ 아직 이 회차의 당첨자를 추첨하지 않았어요! 관리자 페이지에서 추첨해주세요.</p>`;

  return `
  <div style="font-family:sans-serif; max-width:520px; margin:0 auto; background:#1C1A17; color:#F5F0E8; padding:24px; border-radius:8px;">
    <p style="color:#FFB800; font-weight:700; font-size:18px; margin-bottom:4px;">🥄 주문의 고수</p>
    <h2 style="margin:0 0 8px;">${escapeHtml(weekLabel)} 이벤트가 마감됐어요</h2>
    <p style="color:#A79C8D; font-size:13px; margin-bottom:20px;">이벤트 ID: ${escapeHtml(eventId)} · 총 참여자 ${total}명</p>
    <table style="width:100%; border-collapse:collapse; font-size:14px; margin-bottom:20px;">
      <thead>
        <tr style="color:#A79C8D; text-align:left;">
          <th style="padding:8px 10px; border-bottom:1px solid #555;">순위</th>
          <th style="padding:8px 10px; border-bottom:1px solid #555;">항목</th>
          <th style="padding:8px 10px; border-bottom:1px solid #555; text-align:right;">득표</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${drawReminder}
    <p style="color:#A79C8D; font-size:12px; margin-top:24px;">이 결과를 게시판 발표글, 인스타 카드뉴스, 다음 이벤트 기획 등에 활용해보세요.</p>
  </div>`;
}

export default async function handler(req, res) {
  const providedSecret = req.query.secret || (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.CRON_SECRET || providedSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const RESEND_API_KEY = process.env.RESEND_API_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !RESEND_API_KEY) {
    return res.status(500).json({ error: '환경변수(SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/RESEND_API_KEY)가 비어있습니다.' });
  }

  const restOpts = { serviceKey: SUPABASE_SERVICE_ROLE_KEY, supabaseUrl: SUPABASE_URL };

  try {
    // 1) 지금 공개된 이벤트 ID를 app_config에서 조회 (기존 get_home_banner_config RPC 재사용)
    const configRows = await supabaseRest('/rest/v1/rpc/get_home_banner_config', { method: 'POST', body: {}, ...restOpts });
    const activeRow = (configRows || []).find((r) => r.key === 'active_vote_event_id');
    if (!activeRow || !activeRow.value) {
      return res.status(200).json({ ok: true, skipped: '아직 active_vote_event_id가 설정되지 않았습니다.' });
    }
    const eventId = activeRow.value;

    // 2) 마감 시각이 지났는지 확인
    const deadline = getEventVoteDeadline(eventId);
    if (deadline === null || Date.now() < deadline) {
      return res.status(200).json({ ok: true, skipped: '아직 마감 전입니다.', eventId });
    }

    // 3) 이미 보고했는지 확인
    const eventRows = await supabaseRest(
      `/rest/v1/vote_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id,week_label,reported_at`,
      restOpts
    );
    const eventRow = eventRows && eventRows[0];
    if (eventRow && eventRow.reported_at) {
      return res.status(200).json({ ok: true, skipped: '이미 보고된 이벤트입니다.', eventId });
    }

    // 4) 후보 라벨 + 득표수 조회
    const optionRows = await supabaseRest('/rest/v1/rpc/get_vote_event', { method: 'POST', body: { p_event_id: eventId }, ...restOpts });
    const countRows = await supabaseRest('/rest/v1/rpc/get_event_vote_counts', { method: 'POST', body: { p_event_id: eventId }, ...restOpts });

    const countsById = {};
    (countRows || []).forEach((r) => { countsById[r.option_id] = Number(r.vote_count) || 0; });
    const ranked = (optionRows || [])
      .map((o) => ({ label: o.label, votes: countsById[o.id] || 0 }))
      .sort((a, b) => b.votes - a.votes);
    const total = ranked.reduce((s, o) => s + o.votes, 0);

    // 5) 이미 추첨된 당첨자 수 확인 (관리자에게 추첨 여부 리마인드용)
    const winnerRows = await supabaseRest(
      `/rest/v1/winners?event_id=eq.${encodeURIComponent(eventId)}&select=id`,
      restOpts
    );
    const alreadyDrawnCount = (winnerRows || []).length;

    const weekLabel = (eventRow && eventRow.week_label) || weekLabelFromEventId(eventId);
    const html = buildReportHtml({ eventId, weekLabel, ranked, total, winnerCount: 5, alreadyDrawnCount });

    // 6) Resend API로 메일 발송
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: REPORT_FROM_EMAIL,
        to: [REPORT_TO_EMAIL],
        subject: `[주문의 고수] ${weekLabel} 이벤트 결과 보고 (참여자 ${total}명)`,
        html,
      }),
    });
    if (!sendRes.ok) {
      const text = await sendRes.text().catch(() => '');
      throw new Error(`Resend 발송 실패 (HTTP ${sendRes.status}): ${text.slice(0, 300)}`);
    }

    // 7) 중복 발송 방지를 위해 reported_at 기록
    await supabaseRest(`/rest/v1/vote_events?event_id=eq.${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      body: { reported_at: new Date().toISOString() },
      ...restOpts,
      extraHeaders: { Prefer: 'return=minimal' },
    });

    return res.status(200).json({ ok: true, eventId, total, sent: true });
  } catch (err) {
    console.error('[check-event-deadline]', err);
    return res.status(500).json({ error: err.message || '알 수 없는 오류' });
  }
}

// api/_lib/supabase-rest.js
// service_role 키로 Supabase REST를 호출하는 서버 전용 도우미. (discounts.js와 같은 환경변수 사용)
// 키는 로그·에러 메시지에 넣지 않는다.

export function readSupabaseEnv(env = process.env) {
  const url = env.SUPABASE_URL || '';
  const key = env.SUPABASE_SERVICE_ROLE_KEY || '';
  return { url, key, configured: Boolean(url && key) };
}

export function createSupabaseRest({ url, key, fetchImpl = globalThis.fetch, timeoutMs = 8000 }) {
  async function call(path, { method = 'GET', body, headers = {} } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${url}${path}`, {
        method,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`Supabase HTTP ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      const text = await res.text();
      return text ? JSON.parse(text) : null;
    } finally {
      clearTimeout(timer);
    }
  }
  return { call };
}

// 쿠팡 API 호출 기록을 Supabase 테이블(coupang_api_calls)에 남겨, 서버리스 인스턴스가 여러 개여도
// 시간당 호출 수를 함께 센다.  (endpoint='blocked' 행의 called_at = "이 시각까지 호출 중단")
export function createSupabaseUsageStore(rest) {
  return {
    async countSince(endpoint, sinceMs) {
      const since = new Date(sinceMs).toISOString();
      const rows = await rest.call(`/rest/v1/coupang_api_calls?select=id&endpoint=eq.${encodeURIComponent(endpoint)}&called_at=gte.${encodeURIComponent(since)}`);
      return Array.isArray(rows) ? rows.length : 0;
    },
    async record(endpoint, atMs) {
      await rest.call('/rest/v1/coupang_api_calls', { method: 'POST', body: { endpoint, called_at: new Date(atMs).toISOString() }, headers: { Prefer: 'return=minimal' } });
    },
    async blockedUntil() {
      const rows = await rest.call('/rest/v1/coupang_api_calls?select=called_at&endpoint=eq.blocked&order=called_at.desc&limit=1');
      return rows && rows[0] ? Date.parse(rows[0].called_at) : 0;
    },
    async markBlocked(untilMs) {
      await rest.call('/rest/v1/coupang_api_calls', { method: 'POST', body: { endpoint: 'blocked', called_at: new Date(untilMs).toISOString() }, headers: { Prefer: 'return=minimal' } });
    },
  };
}

// /api/coupang-refresh.js  — 관리자 전용
//
// 검토·승인된 상품 중 가격 확인일이 오래된 것부터 몇 개를 골라 쿠팡 파트너스 검색 API로 가격·이미지를 갱신한다.
// 상품·옵션이 정확히 일치할 때만 갱신하고, 검색 결과에 없다고 품절로 처리하지 않는다(api/_lib/refresh.js).
//
// 켜기 전 확인: README의 "쿠팡 파트너스 API 검증 체크리스트". 기본은 꺼짐(COUPANG_REFRESH_ENABLED).
// 필요한 환경변수(값은 Vercel 환경변수에만 등록, 채팅·Git에 붙여넣지 않기):
//   COUPANG_PARTNERS_ACCESS_KEY, COUPANG_PARTNERS_SECRET_KEY
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ADMIN_EMAILS (쉼표 구분, 관리자 이메일)
//   COUPANG_REFRESH_ENABLED=true            (기능 자체를 켠다. 켜도 아래 값이 없으면 "확인만" 하고 아무것도 쓰지 않는다)
//   COUPANG_PRICE_REFRESH_ENABLED=true      (선택) 가격·이미지를 실제로 저장한다. 실제 응답에서 상품·옵션 식별자와 가격이
//                                           같은 옵션의 것임을 확인한 뒤에만 켠다(README 체크리스트).
//   COUPANG_SEARCH_HOURLY_BUDGET(선택, 기본 8), COUPANG_REFRESH_MAX_PER_RUN(선택, 기본 3)

// 서버 전용 모듈은 요청 시점에 불러온다(이유는 api/situation-products.js 의 같은 주석 참고).
async function loadDeps() {
  const [cp, rf, sb] = await Promise.all([import('./_lib/coupang-partners.js'), import('./_lib/refresh.js'), import('./_lib/supabase-rest.js')]);
  return { ...cp, ...rf, ...sb };
}
let cache = null; // 같은 검색어 1시간 재사용(서버리스 인스턴스별). 모듈을 불러온 뒤 처음 쓸 때 만든다.

function intEnv(name, def, min, max) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;
}

async function verifyAdmin(req, supa) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const admins = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!admins.length) return null;
  try {
    const r = await fetch(`${supa.url}/auth/v1/user`, { headers: { apikey: supa.key, Authorization: `Bearer ${m[1]}` } });
    if (!r.ok) return null;
    const u = await r.json();
    const email = String(u && u.email ? u.email : '').toLowerCase();
    return admins.includes(email) ? email : null;
  } catch { return null; }
}

// 상품별 기록. 성공(updated/checked)이면 실패 횟수를 0으로, 실패면 +1 (재시도 간격 계산에 쓰인다).
// 데이터 컬럼(가격·이미지)은 updated 일 때만 건드리고, 실패·확인만(checked)일 때는 상태 컬럼만 쓴다.
export function toDbPatch(r, previousFailures, nowIso) {
  if (r.outcome === 'updated') {
    const out = { last_refresh_at: nowIso, last_refresh_status: 'updated', refresh_failures: 0 };
    if (r.patch.price != null) { out.price = r.patch.price; out.price_checked_at = r.patch.priceCheckedAt; }
    if (r.patch.imageUrl) out.image_url = r.patch.imageUrl;
    return out;
  }
  if (r.outcome === 'checked') return { last_refresh_at: nowIso, last_refresh_status: 'checked', refresh_failures: 0 };
  return { last_refresh_at: nowIso, last_refresh_status: r.outcome + ':' + r.reason, refresh_failures: (Number(previousFailures) || 0) + 1 };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  if (process.env.COUPANG_REFRESH_ENABLED !== 'true') return res.status(503).json({ error: 'refresh_disabled' });

  let deps;
  try { deps = await loadDeps(); } catch (e) {
    console.error('[coupang-refresh] module_load_failed', e && e.code ? e.code : (e && e.name) || 'error');
    return res.status(500).json({ error: 'module_load_failed', code: (e && e.code) || null });
  }
  cache = cache || deps.createTtlCache(60 * 60 * 1000);

  const supa = deps.readSupabaseEnv();
  if (!supa.configured) return res.status(503).json({ error: 'not_configured' });

  const adminEmail = await verifyAdmin(req, supa);
  if (!adminEmail) return res.status(401).json({ error: 'unauthorized' });

  const cred = deps.readCredentialsFromEnv();
  if (!cred.configured) return res.status(503).json({ error: 'keys_missing' }); // 어떤 키가 비었는지·값은 알리지 않는다.

  try {
    const rest = deps.createSupabaseRest(supa);
    const guard = deps.createUsageGuard(deps.createSupabaseUsageStore(rest), {
      hourlyBudget: intEnv('COUPANG_SEARCH_HOURLY_BUDGET', deps.SEARCH_HOURLY_BUDGET_DEFAULT, 1, 10),
    });
    const client = deps.createClient({ accessKey: cred.accessKey, secretKey: cred.secretKey, guard, cache, searchPath: deps.resolveSearchPath() });

    const rows = await rest.call(
      '/rest/v1/situation_products?select=id,name,search_keyword,price_checked_at,review_state,coupang_product_id,coupang_item_id,coupang_vendor_item_id,last_refresh_at,last_refresh_status,refresh_failures&review_state=eq.approved&limit=500'
    );
    // coupang_product_id 가 없는 승인 상품도 가져온다: 호출은 하지 않고 "보완 필요"로 세어 관리자에게 알리기 위해.
    const products = (rows || []).map((r) => ({
      id: r.id, name: r.name, searchKeyword: r.search_keyword, priceCheckedAt: r.price_checked_at,
      reviewState: r.review_state, coupangProductId: r.coupang_product_id,
      coupangItemId: r.coupang_item_id, coupangVendorItemId: r.coupang_vendor_item_id,
      lastRefreshAt: r.last_refresh_at, lastRefreshStatus: r.last_refresh_status, refreshFailures: r.refresh_failures,
    }));
    const failuresById = new Map(products.map((p) => [p.id, p.refreshFailures]));
    const dryRun = process.env.COUPANG_PRICE_REFRESH_ENABLED !== 'true';

    const maxCalls = intEnv('COUPANG_REFRESH_MAX_PER_RUN', 3, 1, 8);
    const nowIso = new Date().toISOString();
    const { results, stopped, attempted, plan } = await deps.refreshProducts({ products, client, maxCalls, dryRun });

    for (const r of results) {
      // 호출 한도·차단·네트워크 같은 시스템 쪽 실패는 상품의 실패가 아니므로 기록하지 않는다(그러면 멀쩡한 상품이 재시도 대기에 걸린다).
      if (r.attribute === false) continue;
      const body = toDbPatch(r, failuresById.get(r.id), nowIso);
      await rest.call(`/rest/v1/situation_products?id=eq.${encodeURIComponent(r.id)}`, { method: 'PATCH', body, headers: { Prefer: 'return=minimal' } });
    }

    return res.status(200).json({
      mode: dryRun ? 'dry_run' : 'apply',      // dry_run: 일치 여부만 확인하고 가격·이미지는 저장하지 않음
      attempted,
      updated: results.filter((r) => r.outcome === 'updated').length,
      checked: results.filter((r) => r.outcome === 'checked').length,
      needsFix: plan.needsFix.length,          // 옵션 식별자가 없어 호출하지 않은 승인 상품 수
      cooling: plan.cooling.length,            // 최근 실패로 재시도 대기 중
      recent: plan.recent.length,              // 최근 확인돼 건너뜀
      // dry_run 에서는 응답의 가격을 보여주되 저장하지 않는다. 운영자가 저장된 값과 비교해 같은 옵션인지 판단하는 용도.
      results: results.map((r) => ({ id: r.id, outcome: r.outcome, reason: r.reason, observedPrice: r.observed ? r.observed.price : undefined })),
      stopped: stopped ? { code: stopped.code } : null,
    });
  } catch (err) {
    console.error('[coupang-refresh]', err && err.code ? err.code : 'error', err && err.message ? String(err.message).slice(0, 120) : '');
    const code = err && err.code ? err.code : 'internal_error';
    const status = code === 'rate_limited' || code === 'blocked' ? 429 : code === 'keys_missing' ? 503 : 500;
    return res.status(status).json({ error: code });
  }
}

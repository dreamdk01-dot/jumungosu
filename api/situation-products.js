// /api/situation-products.js
//
// 상황별 추천에 쓰는 "검토 완료(approved)" 상품만 내려주는 읽기 전용 API.
//  - situation_products 테이블은 RLS로 잠가 두고(anon 직접 조회 불가), service_role 키로 이 함수만 읽는다.
//  - 내부 메모(검토자, 쿠팡 식별자, 갱신 상태 등)는 응답에서 뺀다.
//  - 쿠팡 파트너스 API는 여기서 호출하지 않는다(방문자 요청이 쿠팡 호출 한도를 소모하지 않도록).
//    가격·이미지 갱신은 api/coupang-refresh.js(관리자 전용)가 따로 한다.
//
// 필요한 환경변수: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (discounts.js와 동일)

import { readSupabaseEnv, createSupabaseRest } from './_lib/supabase-rest.mjs';

const ALLOWED_REFERER_HOSTS = ['jumungosu.com', 'www.jumungosu.com'];

function isAllowedReferer(req) {
  const referer = req.headers.referer || req.headers.referrer;
  if (!referer) return true; // discounts.js와 같은 기준: Referer가 없는 정상 방문도 있어 막지 않는다.
  try {
    const host = new URL(referer).hostname;
    // 미리보기(*.vercel.app) 배포에서도 확인할 수 있게 허용
    return ALLOWED_REFERER_HOSTS.includes(host) || host.endsWith('.vercel.app') || host === 'localhost';
  } catch {
    return true;
  }
}

const COLUMNS = [
  'id', 'name', 'category', 'price', 'price_checked_at', 'image_url', 'affiliate_url',
  'situations', 'subtypes', 'recipients', 'exclude_tags', 'reason', 'caution',
  'rating', 'review_count', 'review_checked_at', 'review_verified_at', 'reviewed_at',
].join(',');

export function toPublicProduct(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category || null,
    price: typeof r.price === 'number' && r.price > 0 ? r.price : null,
    priceCheckedAt: r.price_checked_at || null,
    imageUrl: r.image_url || null,
    affiliateUrl: r.affiliate_url,
    situations: r.situations || [],
    subtypes: r.subtypes || [],
    recipients: r.recipients || [],
    excludeTags: r.exclude_tags || [],
    reason: r.reason || '',
    caution: r.caution || '',
    // 평점·리뷰수는 확인일이 함께 있을 때만 내려준다(확인일 없는 값은 보여주지 않는다).
    rating: r.review_checked_at && typeof r.rating === 'number' ? r.rating : null,
    reviewCount: r.review_checked_at && typeof r.review_count === 'number' ? r.review_count : null,
    reviewCheckedAt: r.review_checked_at || null,
    // 운영자가 상품평을 직접 읽고 검토한 날. 읽은 개수·검토 근거 같은 내부 기록은 내려주지 않는다.
    reviewVerifiedAt: r.review_verified_at || null,
    reviewedAt: r.reviewed_at || null,
    reviewState: 'approved',
  };
}

// DB 제약이 이미 막지만(승인 조건), 데이터가 다른 경로로 들어왔을 때를 대비해 서버에서도 한 번 더 거른다.
export function isPublishable(p) {
  if (!p.reviewVerifiedAt) return false;                                              // 상품평 검토 기록 없음
  if (p.situations.indexOf('dol') !== -1 && p.subtypes.length === 0) return false;     // 돌잔치인데 참석/답례 구분 없음
  return true;
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!isAllowedReferer(req)) return res.status(403).json({ error: 'forbidden' });

  const env = readSupabaseEnv();
  if (!env.configured) return res.status(503).json({ error: 'not_configured' });

  try {
    const rest = createSupabaseRest(env);
    const rows = await rest.call(
      `/rest/v1/situation_products?select=${COLUMNS}&review_state=eq.approved&affiliate_url=not.is.null&review_verified_at=not.is.null&order=reviewed_at.desc&limit=500`
    );
    const products = (Array.isArray(rows) ? rows : []).map(toPublicProduct).filter(isPublishable);
    // 오류 응답은 캐시하지 않고, 정상 응답만 짧게 캐시한다.
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ products });
  } catch (err) {
    console.error('[situation-products]', err && err.message ? err.message : 'error');
    // 테이블이 아직 없을 때(마이그레이션 전)는 구분해서 알려준다.
    const missing = err && err.status === 404;
    res.setHeader('Cache-Control', 'no-store');
    return res.status(missing ? 503 : 502).json({ error: missing ? 'table_missing' : 'upstream_error' });
  }
}

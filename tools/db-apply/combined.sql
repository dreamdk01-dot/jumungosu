-- 상황별 쇼핑 마이그레이션 2개를 하나의 트랜잭션으로 적용하는 결합본 (자동 생성: node tools/db-apply/build-combined.mjs — 직접 수정하지 말 것)
-- 원본 1/2: 20261001000000_situation_products.sql  sha256=6d7b6d4e933b70bae142dfdedcf7c5135c95ce061c0eaa4a631a51711848b0b8
-- 원본 2/2: 20261002000000_review_verification.sql  sha256=8ed2fdfe90e260afcf4948d968acc7cd276e2894b485c8f4818651ac1a1b259a
-- 하나라도 실패하면 전체가 롤백된다(begin … commit). 적용 전에 preflight.sql, 적용 후에 verify-after.sql 을 실행한다.
begin;

-- ======== 1/2 20261001000000_situation_products.sql ========
-- 상황별 추천 쇼핑: 검토 상품 테이블, 쿠팡 API 호출 기록, 관리자 RPC
--
-- ⚠ 운영 DB에는 아직 적용하지 않았습니다. 미리보기 확인 후 Supabase SQL Editor 또는
--   `supabase db push`로 적용하세요. 되돌리는 SQL은 파일 맨 아래 주석에 있습니다.
--
-- 보안 방식은 기존과 같습니다.
--   · 모든 테이블 RLS 켜고 정책 없음 → anon/authenticated 직접 접근 불가, service_role(서버)만 가능
--   · 조회는 매니저 3명(get_funnel_stats와 동일 목록), 저장은 마스터 1명만 — SECURITY DEFINER RPC + auth.jwt()->>'email'
--   · RETURNS TABLE을 쓰지 않는다(OUT 파라미터 이름이 컬럼명과 충돌하는 문제를 원천 차단)

-- ------------------------------------------------------------------
-- 관리자 판정 (get_funnel_stats 의 허용 이메일 목록과 동일하게 유지할 것)
-- ------------------------------------------------------------------
create or replace function public.is_site_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) in (
    'jumungosu@gmail.com', 'dream3359@naver.com', 'withcarrot@gmail.com'
  );
$$;

-- 쓰기(상품 저장/승인)는 마스터 계정만. 기존 규칙(set_home_banner_config = 마스터 전용, 조회 = 매니저 전체)과 동일.
create or replace function public.is_site_master()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'jumungosu@gmail.com';
$$;

-- ------------------------------------------------------------------
-- 검토 상품
-- ------------------------------------------------------------------
create table if not exists public.situation_products (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null check (char_length(btrim(name)) between 2 and 200),
  category               text check (category is null or char_length(category) <= 100),

  -- 가격·이미지: 쿠팡 API 또는 운영자가 직접 확인한 값. 확인 시각과 함께만 의미가 있다.
  price                  integer check (price is null or price > 0),
  price_checked_at       timestamptz,
  image_url              text check (image_url is null or image_url like 'https://%'),

  -- 제휴(파트너스) 링크. 승인하려면 필수.
  affiliate_url          text check (affiliate_url is null or affiliate_url like 'https://%'),
  coupang_url            text check (coupang_url is null or coupang_url like 'https://%'),

  -- API 정확 일치 갱신용 식별자 (상품 + 옵션)
  coupang_product_id     text,
  coupang_item_id        text,
  coupang_vendor_item_id text,
  search_keyword         text check (search_keyword is null or char_length(search_keyword) <= 100),

  -- 상황 연결
  situations             text[] not null default '{}',
  subtypes               text[] not null default '{}',   -- 비어 있으면 세부 선택(참석 선물/답례품) 모두에 해당
  recipients             text[] not null default '{}',
  exclude_tags           text[] not null default '{}',   -- 이 태그가 사용자 제외조건과 겹치면 제외

  reason                 text check (reason is null or char_length(reason) <= 300),    -- 이 상황에 추천하는 이유
  caution                text check (caution is null or char_length(caution) <= 300),  -- 구매 전 확인사항

  -- 평점·리뷰: 실제 확인한 값만. 확인일 없이 값만 있을 수 없다. 리뷰 원문은 저장하지 않는다.
  rating                 numeric(2,1) check (rating is null or (rating >= 0 and rating <= 5)),
  review_count           integer check (review_count is null or review_count >= 0),
  review_checked_at      date,

  review_state           text not null default 'draft' check (review_state in ('draft', 'approved', 'hold', 'rejected')),
  reviewed_at            timestamptz,
  reviewed_by            text,
  source                 text not null default 'manual' check (source in ('manual', 'legacy_hotdeal')),

  last_refresh_at        timestamptz,
  last_refresh_status    text,

  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint situation_products_review_date_required
    check ((rating is null and review_count is null) or review_checked_at is not null),
  constraint situation_products_price_date_required
    check (price is null or price_checked_at is not null),
  -- 승인 조건: 상황 1개 이상 + 추천 이유 + 제휴 링크
  constraint situation_products_approved_requirements
    check (review_state <> 'approved'
           or (cardinality(situations) >= 1
               and reason is not null and char_length(btrim(reason)) > 0
               and affiliate_url is not null)),
  constraint situation_products_situations_valid
    check (situations <@ array['dol','season','groceries','housewarming','solo','outing']::text[]),
  constraint situation_products_subtypes_valid
    check (subtypes <@ array['attend','return']::text[]),
  constraint situation_products_recipients_valid
    check (recipients <@ array['parents','friend','baby','work','family','lover']::text[]),
  constraint situation_products_exclude_tags_valid
    check (exclude_tags <@ array['alcohol','nuts','meat','scented','perishable','sugar']::text[])
);

-- 같은 쿠팡 상품·옵션을 두 번 등록하지 못하게 (상황은 배열로 여러 개 연결)
create unique index if not exists situation_products_coupang_unique
  on public.situation_products (coupang_product_id, coalesce(coupang_item_id, ''))
  where coupang_product_id is not null;

create index if not exists situation_products_state_idx on public.situation_products (review_state);

alter table public.situation_products enable row level security;
-- 정책을 만들지 않는다: anon/authenticated 직접 접근 불가.

-- ------------------------------------------------------------------
-- 쿠팡 API 호출 기록(시간당 호출 수 제한용) — 서버(service_role)만 사용
--   endpoint='search' : 검색 호출 1건
--   endpoint='blocked': 쿠팡이 거절해서 called_at 시각까지 호출을 멈추는 표시
-- ------------------------------------------------------------------
create table if not exists public.coupang_api_calls (
  id        bigint generated always as identity primary key,
  endpoint  text not null check (endpoint in ('search', 'blocked')),
  called_at timestamptz not null default now()
);
create index if not exists coupang_api_calls_endpoint_time_idx on public.coupang_api_calls (endpoint, called_at desc);
alter table public.coupang_api_calls enable row level security;

-- ------------------------------------------------------------------
-- updated_at 자동 갱신
-- ------------------------------------------------------------------
create or replace function public.situation_products_touch()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists situation_products_touch_trg on public.situation_products;
create trigger situation_products_touch_trg
  before update on public.situation_products
  for each row execute function public.situation_products_touch();

-- ------------------------------------------------------------------
-- 관리자: 전체 목록
-- ------------------------------------------------------------------
create or replace function public.admin_list_situation_products()
returns setof public.situation_products
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_site_admin() then
    raise exception '관리자만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  return query
    select sp.*
    from public.situation_products sp
    order by sp.review_state, sp.updated_at desc;
end;
$$;

-- ------------------------------------------------------------------
-- 관리자: 저장(없으면 생성, id가 있으면 수정). review_state 도 여기서 함께 바꾼다.
--   배열 필드는 허용 값 검증을 테이블 CHECK 제약이 한 번 더 한다.
-- ------------------------------------------------------------------
create or replace function public.admin_save_situation_product(p jsonb)
returns public.situation_products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email      text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_id         uuid := nullif(p ->> 'id', '')::uuid;
  v_state      text := coalesce(nullif(p ->> 'review_state', ''), 'draft');
  v_situations text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'situations', '[]'::jsonb))), '{}');
  v_subtypes   text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'subtypes', '[]'::jsonb))), '{}');
  v_recipients text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'recipients', '[]'::jsonb))), '{}');
  v_excludes   text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'exclude_tags', '[]'::jsonb))), '{}');
  v_row        public.situation_products;
begin
  if not public.is_site_master() then
    raise exception '마스터 계정만 저장할 수 있습니다.' using errcode = '42501';
  end if;
  if v_state not in ('draft', 'approved', 'hold', 'rejected') then
    raise exception '알 수 없는 검토 상태: %', v_state;
  end if;

  if v_id is null then
    insert into public.situation_products (
      name, category, price, price_checked_at, image_url, affiliate_url, coupang_url,
      coupang_product_id, coupang_item_id, coupang_vendor_item_id, search_keyword,
      situations, subtypes, recipients, exclude_tags, reason, caution,
      rating, review_count, review_checked_at, review_state, reviewed_at, reviewed_by, source
    ) values (
      btrim(p ->> 'name'), nullif(btrim(p ->> 'category'), ''),
      nullif(p ->> 'price', '')::integer, nullif(p ->> 'price_checked_at', '')::timestamptz,
      nullif(btrim(p ->> 'image_url'), ''), nullif(btrim(p ->> 'affiliate_url'), ''), nullif(btrim(p ->> 'coupang_url'), ''),
      nullif(btrim(p ->> 'coupang_product_id'), ''), nullif(btrim(p ->> 'coupang_item_id'), ''), nullif(btrim(p ->> 'coupang_vendor_item_id'), ''),
      nullif(btrim(p ->> 'search_keyword'), ''),
      v_situations, v_subtypes, v_recipients, v_excludes,
      nullif(btrim(p ->> 'reason'), ''), nullif(btrim(p ->> 'caution'), ''),
      nullif(p ->> 'rating', '')::numeric, nullif(p ->> 'review_count', '')::integer, nullif(p ->> 'review_checked_at', '')::date,
      v_state,
      case when v_state = 'approved' then now() else null end,
      case when v_state = 'approved' then v_email else null end,
      coalesce(nullif(p ->> 'source', ''), 'manual')
    )
    returning * into v_row;
  else
    -- 별칭(sp)을 붙여 컬럼과 PL/pgSQL 변수가 섞이지 않게 한다.
    update public.situation_products sp
       set name = btrim(p ->> 'name'),
           category = nullif(btrim(p ->> 'category'), ''),
           price = nullif(p ->> 'price', '')::integer,
           price_checked_at = nullif(p ->> 'price_checked_at', '')::timestamptz,
           image_url = nullif(btrim(p ->> 'image_url'), ''),
           affiliate_url = nullif(btrim(p ->> 'affiliate_url'), ''),
           coupang_url = nullif(btrim(p ->> 'coupang_url'), ''),
           coupang_product_id = nullif(btrim(p ->> 'coupang_product_id'), ''),
           coupang_item_id = nullif(btrim(p ->> 'coupang_item_id'), ''),
           coupang_vendor_item_id = nullif(btrim(p ->> 'coupang_vendor_item_id'), ''),
           search_keyword = nullif(btrim(p ->> 'search_keyword'), ''),
           situations = v_situations,
           subtypes = v_subtypes,
           recipients = v_recipients,
           exclude_tags = v_excludes,
           reason = nullif(btrim(p ->> 'reason'), ''),
           caution = nullif(btrim(p ->> 'caution'), ''),
           rating = nullif(p ->> 'rating', '')::numeric,
           review_count = nullif(p ->> 'review_count', '')::integer,
           review_checked_at = nullif(p ->> 'review_checked_at', '')::date,
           review_state = v_state,
           reviewed_at = case when v_state = 'approved' then now() else sp.reviewed_at end,
           reviewed_by = case when v_state = 'approved' then v_email else sp.reviewed_by end
     where sp.id = v_id
    returning * into v_row;
    if not found then
      raise exception '상품을 찾을 수 없습니다.';
    end if;
  end if;

  return v_row;
end;
$$;

-- ------------------------------------------------------------------
-- 관리자: 상황 선택/결과 없음/상품 클릭 집계 (원문 검색어는 저장하지 않으므로 상황·구간 단위로만 집계)
-- ------------------------------------------------------------------
create or replace function public.admin_get_situation_stats(p_period text default '30d')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today_start timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  v_start       timestamptz;
  v_result      jsonb;
begin
  if not public.is_site_admin() then
    raise exception '관리자만 조회할 수 있습니다.' using errcode = '42501';
  end if;

  if p_period = 'today' then v_start := v_today_start;
  elsif p_period = '7d' then v_start := v_today_start - interval '6 days';
  elsif p_period = '30d' then v_start := v_today_start - interval '29 days';
  else raise exception 'invalid period: %', p_period;
  end if;

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
    into v_result
    from (
      select e.event_name                              as event,
             coalesce(e.metadata ->> 'situation', '')  as situation,
             coalesce(e.metadata ->> 'subtype', '')    as subtype,
             coalesce(e.metadata ->> 'reason', '')     as reason,
             coalesce(e.metadata ->> 'budget_bucket', '') as budget_bucket,
             count(*)::int                             as n
        from public.funnel_events e
       where e.event_name in ('situation_select', 'situation_no_result', 'situation_product_click')
         and e.created_at >= v_start
       group by 1, 2, 3, 4, 5
       order by n desc
    ) t;

  return v_result;
end;
$$;

-- ------------------------------------------------------------------
-- 실행 권한: 관리자 RPC는 로그인 사용자만(내부에서 다시 관리자 확인)
-- ------------------------------------------------------------------
revoke all on function public.admin_list_situation_products() from public, anon;
revoke all on function public.admin_save_situation_product(jsonb) from public, anon;
revoke all on function public.admin_get_situation_stats(text) from public, anon;
grant execute on function public.admin_list_situation_products() to authenticated;
grant execute on function public.admin_save_situation_product(jsonb) to authenticated;
grant execute on function public.admin_get_situation_stats(text) to authenticated;

-- ------------------------------------------------------------------
-- 되돌리기(필요할 때만 실행)
--   drop function if exists public.admin_get_situation_stats(text);
--   drop function if exists public.admin_save_situation_product(jsonb);
--   drop function if exists public.admin_list_situation_products();
--   drop table if exists public.coupang_api_calls;
--   drop table if exists public.situation_products;
--   drop function if exists public.situation_products_touch();
--   -- is_site_admin() 은 다른 곳에서 쓸 수 있어 남겨 둠
-- ------------------------------------------------------------------

-- ======== 2/2 20261002000000_review_verification.sql ========
-- 상품 승인 조건 보강: 상품평 검토 기록, 돌잔치 세부 구분 필수, 카테고리별 평점·리뷰수 기준, 갱신 실패 추적
--
-- ⚠ 운영 DB에는 아직 적용하지 않았습니다. 20261001000000_situation_products.sql 다음에 적용하세요(여러 번 실행해도 안전).
--
-- 이 파일이 하는 일
--   1) 상품평을 "실제로 읽고 검토했다"는 기록(검토일·읽은 개수·검토 근거)을 저장할 컬럼을 추가
--   2) 승인(approved)하려면 상품평 검토 기록이 있어야 하도록 DB 제약을 교체
--   3) 돌잔치(dol) 상품은 참석 선물(attend)/답례품(return)을 하나 이상 명시해야 승인 가능
--   4) 카테고리별 최소 평점·리뷰수 기준 테이블(운영자가 정함, 기본은 비어 있음) + 승인 시 검사 트리거
--   5) 가격 갱신 실패 횟수 컬럼(재시도 간격 계산용)
--
-- 이 DB는 상품평 내용이 "실제로 읽혔는지"를 알 수 없습니다. 기록은 운영자가 직접 적은 것이고,
-- 제약은 "기록이 비어 있으면 승인할 수 없다"까지만 보장합니다.

-- ------------------------------------------------------------------
-- 1) 컬럼
-- ------------------------------------------------------------------
alter table public.situation_products
  add column if not exists review_verified_at date,                    -- 운영자가 상품평을 직접 읽고 검토한 날
  add column if not exists review_verified_by text,                    -- 저장한 계정(서버가 채움)
  add column if not exists review_read_count  integer check (review_read_count is null or review_read_count >= 0),
  add column if not exists review_basis       text    check (review_basis is null or char_length(review_basis) <= 500),
  add column if not exists refresh_failures   integer not null default 0 check (refresh_failures >= 0);

-- 검토 기록은 세 값이 함께 있어야 한다: 날짜 + 읽은 개수(1 이상) + 근거(공백 제외 10자 이상).
-- 근거가 무엇인지는 사람이 적는다. 시스템이 문장을 만들어 넣지 않는다.
alter table public.situation_products drop constraint if exists situation_products_review_verified_complete;
alter table public.situation_products
  add constraint situation_products_review_verified_complete
  check (
    review_verified_at is null
    or (review_read_count is not null and review_read_count >= 1
        and review_basis is not null and char_length(btrim(review_basis)) >= 10)
  );

-- ------------------------------------------------------------------
-- 2) 기존에 승인돼 있던 행 정리 (새 조건을 못 채우는 행은 보류로 내려 방문자 화면에서 빼기)
--    마이그레이션 1만 적용되고 승인 상품이 있었던 경우에만 해당. 데이터는 지우지 않고 상태만 바꾼다.
-- ------------------------------------------------------------------
update public.situation_products as sp
   set review_state = 'hold'
 where sp.review_state = 'approved'
   and (sp.review_verified_at is null
        or ('dol' = any (sp.situations) and cardinality(sp.subtypes) = 0));

-- ------------------------------------------------------------------
-- 3) 승인 조건 교체: 상황 + 추천 이유 + 제휴 링크 + 상품평 검토 기록
--    돌잔치 상품은 세부 구분(attend/return) 1개 이상 필수. 비어 있다고 양쪽에 자동 노출하지 않는다.
-- ------------------------------------------------------------------
alter table public.situation_products drop constraint if exists situation_products_approved_requirements;
alter table public.situation_products
  add constraint situation_products_approved_requirements
  check (review_state <> 'approved'
         or (cardinality(situations) >= 1
             and reason is not null and char_length(btrim(reason)) > 0
             and affiliate_url is not null
             and review_verified_at is not null));

alter table public.situation_products drop constraint if exists situation_products_dol_subtype_required;
alter table public.situation_products
  add constraint situation_products_dol_subtype_required
  check (review_state <> 'approved'
         or not ('dol' = any (situations))
         or cardinality(subtypes) >= 1);

-- ------------------------------------------------------------------
-- 4) 카테고리별 기준 (운영자가 정함. 비어 있으면 숫자 기준 없이 상품평 검토 기록만 요구)
--    "검증된 기준"이 아니라 운영자 내부 승인 기준이다. 방문자 화면에는 기준값을 내세우지 않는다.
-- ------------------------------------------------------------------
create table if not exists public.category_review_thresholds (
  category         text primary key check (char_length(btrim(category)) between 1 and 100),
  min_rating       numeric(2,1) check (min_rating is null or (min_rating >= 0 and min_rating <= 5)),
  min_review_count integer check (min_review_count is null or min_review_count >= 0),
  note             text check (note is null or char_length(note) <= 300),
  updated_at       timestamptz not null default now(),
  updated_by       text
);
alter table public.category_review_thresholds enable row level security;   -- 정책 없음: 직접 접근 불가

-- 승인 시 해당 카테고리 기준이 있으면 평점·리뷰수(확인일 포함)가 기준 이상이어야 한다.
create or replace function public.situation_products_enforce_thresholds()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_t public.category_review_thresholds;
begin
  if new.review_state <> 'approved' or new.category is null then
    return new;
  end if;

  select t.* into v_t
    from public.category_review_thresholds as t
   where t.category = new.category;

  if not found then
    return new;
  end if;

  if v_t.min_rating is not null
     and (new.rating is null or new.review_checked_at is null or new.rating < v_t.min_rating) then
    raise exception '카테고리 "%" 기준: 평점 % 이상(확인일 포함)이어야 승인할 수 있습니다.', new.category, v_t.min_rating
      using errcode = '23514', constraint = 'situation_products_category_threshold';
  end if;

  if v_t.min_review_count is not null
     and (new.review_count is null or new.review_checked_at is null or new.review_count < v_t.min_review_count) then
    raise exception '카테고리 "%" 기준: 리뷰 % 개 이상(확인일 포함)이어야 승인할 수 있습니다.', new.category, v_t.min_review_count
      using errcode = '23514', constraint = 'situation_products_category_threshold';
  end if;

  return new;
end;
$$;

drop trigger if exists situation_products_enforce_thresholds_trg on public.situation_products;
create trigger situation_products_enforce_thresholds_trg
  before insert or update on public.situation_products
  for each row execute function public.situation_products_enforce_thresholds();

-- ------------------------------------------------------------------
-- 관리자 RPC: 저장(상품평 검토 기록 포함). 반환 타입은 기존과 같고 RETURNS TABLE을 쓰지 않는다.
--   UPDATE 에는 별칭(sp)을 붙이고 컬럼은 sp. 로 한정한다(변수·컬럼 이름 충돌 방지).
-- ------------------------------------------------------------------
create or replace function public.admin_save_situation_product(p jsonb)
returns public.situation_products
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email      text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_id         uuid := nullif(p ->> 'id', '')::uuid;
  v_state      text := coalesce(nullif(p ->> 'review_state', ''), 'draft');
  v_situations text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'situations', '[]'::jsonb))), '{}');
  v_subtypes   text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'subtypes', '[]'::jsonb))), '{}');
  v_recipients text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'recipients', '[]'::jsonb))), '{}');
  v_excludes   text[] := coalesce(array(select jsonb_array_elements_text(coalesce(p -> 'exclude_tags', '[]'::jsonb))), '{}');
  v_rv_date    date := nullif(p ->> 'review_verified_at', '')::date;
  v_rv_by      text;
  v_row        public.situation_products;
begin
  if not public.is_site_master() then
    raise exception '마스터 계정만 저장할 수 있습니다.' using errcode = '42501';
  end if;
  if v_state not in ('draft', 'approved', 'hold', 'rejected') then
    raise exception '알 수 없는 검토 상태: %', v_state;
  end if;

  v_rv_by := case when v_rv_date is not null then v_email else null end;

  if v_id is null then
    insert into public.situation_products (
      name, category, price, price_checked_at, image_url, affiliate_url, coupang_url,
      coupang_product_id, coupang_item_id, coupang_vendor_item_id, search_keyword,
      situations, subtypes, recipients, exclude_tags, reason, caution,
      rating, review_count, review_checked_at,
      review_verified_at, review_verified_by, review_read_count, review_basis,
      review_state, reviewed_at, reviewed_by, source
    ) values (
      btrim(p ->> 'name'), nullif(btrim(p ->> 'category'), ''),
      nullif(p ->> 'price', '')::integer, nullif(p ->> 'price_checked_at', '')::timestamptz,
      nullif(btrim(p ->> 'image_url'), ''), nullif(btrim(p ->> 'affiliate_url'), ''), nullif(btrim(p ->> 'coupang_url'), ''),
      nullif(btrim(p ->> 'coupang_product_id'), ''), nullif(btrim(p ->> 'coupang_item_id'), ''), nullif(btrim(p ->> 'coupang_vendor_item_id'), ''),
      nullif(btrim(p ->> 'search_keyword'), ''),
      v_situations, v_subtypes, v_recipients, v_excludes,
      nullif(btrim(p ->> 'reason'), ''), nullif(btrim(p ->> 'caution'), ''),
      nullif(p ->> 'rating', '')::numeric, nullif(p ->> 'review_count', '')::integer, nullif(p ->> 'review_checked_at', '')::date,
      v_rv_date, v_rv_by, nullif(p ->> 'review_read_count', '')::integer, nullif(btrim(p ->> 'review_basis'), ''),
      v_state,
      case when v_state = 'approved' then now() else null end,
      case when v_state = 'approved' then v_email else null end,
      coalesce(nullif(p ->> 'source', ''), 'manual')
    )
    returning * into v_row;
  else
    update public.situation_products as sp
       set name = btrim(p ->> 'name'),
           category = nullif(btrim(p ->> 'category'), ''),
           price = nullif(p ->> 'price', '')::integer,
           price_checked_at = nullif(p ->> 'price_checked_at', '')::timestamptz,
           image_url = nullif(btrim(p ->> 'image_url'), ''),
           affiliate_url = nullif(btrim(p ->> 'affiliate_url'), ''),
           coupang_url = nullif(btrim(p ->> 'coupang_url'), ''),
           coupang_product_id = nullif(btrim(p ->> 'coupang_product_id'), ''),
           coupang_item_id = nullif(btrim(p ->> 'coupang_item_id'), ''),
           coupang_vendor_item_id = nullif(btrim(p ->> 'coupang_vendor_item_id'), ''),
           search_keyword = nullif(btrim(p ->> 'search_keyword'), ''),
           situations = v_situations,
           subtypes = v_subtypes,
           recipients = v_recipients,
           exclude_tags = v_excludes,
           reason = nullif(btrim(p ->> 'reason'), ''),
           caution = nullif(btrim(p ->> 'caution'), ''),
           rating = nullif(p ->> 'rating', '')::numeric,
           review_count = nullif(p ->> 'review_count', '')::integer,
           review_checked_at = nullif(p ->> 'review_checked_at', '')::date,
           review_verified_at = v_rv_date,
           review_verified_by = v_rv_by,
           review_read_count = nullif(p ->> 'review_read_count', '')::integer,
           review_basis = nullif(btrim(p ->> 'review_basis'), ''),
           review_state = v_state,
           reviewed_at = case when v_state = 'approved' then now() else sp.reviewed_at end,
           reviewed_by = case when v_state = 'approved' then v_email else sp.reviewed_by end
     where sp.id = v_id
    returning * into v_row;
    if not found then
      raise exception '상품을 찾을 수 없습니다.';
    end if;
  end if;

  return v_row;
end;
$$;

-- ------------------------------------------------------------------
-- 관리자 RPC: 카테고리 기준 (조회=매니저, 저장·삭제=마스터)
-- ------------------------------------------------------------------
create or replace function public.admin_list_category_thresholds()
returns setof public.category_review_thresholds
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_site_admin() then
    raise exception '관리자만 조회할 수 있습니다.' using errcode = '42501';
  end if;
  return query
    select t.* from public.category_review_thresholds as t order by t.category;
end;
$$;

create or replace function public.admin_save_category_threshold(p jsonb)
returns public.category_review_thresholds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_row   public.category_review_thresholds;
begin
  if not public.is_site_master() then
    raise exception '마스터 계정만 저장할 수 있습니다.' using errcode = '42501';
  end if;

  insert into public.category_review_thresholds as t (category, min_rating, min_review_count, note, updated_at, updated_by)
  values (btrim(p ->> 'category'), nullif(p ->> 'min_rating', '')::numeric, nullif(p ->> 'min_review_count', '')::integer,
          nullif(btrim(p ->> 'note'), ''), now(), v_email)
  on conflict (category) do update
     set min_rating = excluded.min_rating,
         min_review_count = excluded.min_review_count,
         note = excluded.note,
         updated_at = now(),
         updated_by = v_email
  returning t.* into v_row;

  return v_row;
end;
$$;

create or replace function public.admin_delete_category_threshold(p_category text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_site_master() then
    raise exception '마스터 계정만 삭제할 수 있습니다.' using errcode = '42501';
  end if;
  delete from public.category_review_thresholds as t where t.category = p_category;
end;
$$;

revoke all on function public.admin_list_category_thresholds() from public, anon;
revoke all on function public.admin_save_category_threshold(jsonb) from public, anon;
revoke all on function public.admin_delete_category_threshold(text) from public, anon;
grant execute on function public.admin_list_category_thresholds() to authenticated;
grant execute on function public.admin_save_category_threshold(jsonb) to authenticated;
grant execute on function public.admin_delete_category_threshold(text) to authenticated;
-- admin_save_situation_product 는 create or replace 로 기존 권한이 유지된다(authenticated 만).

-- 헬퍼 함수 실행 권한 회수: is_site_admin()/is_site_master() 는 위 RPC 들 안에서만 쓰인다(RPC 가 SECURITY DEFINER 라
-- 소유자 권한으로 호출하므로 사용자 권한은 필요 없다). 1번 마이그레이션에서 만들 때 기본 권한(PUBLIC 실행 가능)이 남아 있어서,
-- anon 이 SECURITY DEFINER 함수를 직접 호출할 수 있다는 Security Advisor 경고를 피하려고 여기서 회수한다.
revoke all on function public.is_site_admin() from public, anon, authenticated;
revoke all on function public.is_site_master() from public, anon, authenticated;

-- ------------------------------------------------------------------
-- 이 프로젝트의 public 스키마 기본 권한: 새로 만든 테이블·함수·시퀀스에 anon/authenticated/service_role 이 전부 기본 부여된다
-- (pg_default_acl 확인). "RLS 켜고 정책 없음"만으로는 접근이 막히긴 해도 권한 자체는 남아 RLS 한 겹에만 의존하게 되므로,
-- 새 객체의 권한을 명시적으로 회수한다. service_role(서버 API)은 그대로 쓴다. 관리자 RPC 는 SECURITY DEFINER 라 소유자 권한으로 테이블에 접근한다.
-- 1번 마이그레이션이 만든 테이블(situation_products, coupang_api_calls)도 여기서 함께 회수한다.
-- ------------------------------------------------------------------
revoke all on table public.situation_products from public, anon, authenticated;
revoke all on table public.coupang_api_calls from public, anon, authenticated;
revoke all on table public.category_review_thresholds from public, anon, authenticated;

do $$
declare
  v_seq text := pg_get_serial_sequence('public.coupang_api_calls', 'id');
begin
  if v_seq is not null then
    execute format('revoke all on sequence %s from public, anon, authenticated', v_seq);
  end if;
end $$;

-- 트리거 함수는 직접 호출할 수 없지만(트리거로만 실행됨) 기본 권한이 남지 않게 정리한다.
revoke all on function public.situation_products_touch() from public, anon, authenticated;
revoke all on function public.situation_products_enforce_thresholds() from public, anon, authenticated;

-- ------------------------------------------------------------------
-- 되돌리기(필요할 때만 실행)
--   drop trigger if exists situation_products_enforce_thresholds_trg on public.situation_products;
--   drop function if exists public.situation_products_enforce_thresholds();
--   drop function if exists public.admin_delete_category_threshold(text);
--   drop function if exists public.admin_save_category_threshold(jsonb);
--   drop function if exists public.admin_list_category_thresholds();
--   drop table if exists public.category_review_thresholds;
--   alter table public.situation_products drop constraint if exists situation_products_dol_subtype_required;
--   alter table public.situation_products drop constraint if exists situation_products_review_verified_complete;
--   -- 승인 조건을 1번 마이그레이션 상태로 되돌리려면 approved_requirements 를 (상황·이유·제휴링크)만 요구하도록 다시 만들고
--   -- admin_save_situation_product 는 20261001000000 파일의 정의로 다시 create or replace 한다.
--   -- (컬럼 review_verified_* / review_read_count / review_basis / refresh_failures 는 데이터 보존을 위해 남겨 둠)
-- ------------------------------------------------------------------

commit;

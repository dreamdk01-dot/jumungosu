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

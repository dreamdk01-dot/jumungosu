-- 적용을 되돌린다(하나의 트랜잭션). ⚠ 상품·호출 기록·카테고리 기준 데이터가 모두 삭제된다. 데이터를 등록한 뒤에는 먼저 내보내기(백업)할 것.
-- 기존 테이블·함수는 건드리지 않는다(새로 만든 것만 지운다).
begin;
drop trigger if exists situation_products_enforce_thresholds_trg on public.situation_products;
drop trigger if exists situation_products_touch_trg on public.situation_products;
drop function if exists public.admin_delete_category_threshold(text);
drop function if exists public.admin_save_category_threshold(jsonb);
drop function if exists public.admin_list_category_thresholds();
drop function if exists public.admin_get_situation_stats(text);
drop function if exists public.admin_save_situation_product(jsonb);
drop function if exists public.admin_list_situation_products();
drop function if exists public.situation_products_enforce_thresholds();
drop function if exists public.situation_products_touch();
drop table if exists public.category_review_thresholds;
drop table if exists public.coupang_api_calls;
drop table if exists public.situation_products;
drop function if exists public.is_site_master();
drop function if exists public.is_site_admin();
commit;

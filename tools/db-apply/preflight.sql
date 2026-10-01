-- 읽기 전용. 적용 "직전"에 실행한다. 모든 행의 ok 가 true 여야 적용한다(하나라도 false 면 중단).
with c(check_name, expected, actual) as (
  select '01 새 테이블이 아직 없음', '0', (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('situation_products','coupang_api_calls','category_review_thresholds'))::text
  union all select '02 새 함수가 아직 없음', '0', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('is_site_admin','is_site_master','situation_products_touch','situation_products_enforce_thresholds','admin_list_situation_products','admin_save_situation_product','admin_get_situation_stats','admin_list_category_thresholds','admin_save_category_threshold','admin_delete_category_threshold'))::text
  union all select '03 필요한 역할(anon, authenticated, service_role)', '3', (select count(*) from pg_roles where rolname in ('anon','authenticated','service_role'))::text
  union all select '04 auth.jwt() 존재', 'true', (to_regprocedure('auth.jwt()') is not null)::text
  union all select '05 gen_random_uuid() 사용 가능', 'true', (to_regprocedure('gen_random_uuid()') is not null)::text
  union all select '06 funnel_events 필수 컬럼(event_name, metadata, created_at)', '3', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'funnel_events' and column_name in ('event_name','metadata','created_at'))::text
)
select check_name, expected, actual, (expected = actual) as ok from c order by check_name;

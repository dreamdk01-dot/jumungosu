-- 읽기 전용. 적용 "직후"에 실행한다. 모든 행의 ok 가 true 여야 한다(하나라도 false 면 롤백(rollback.sql) 후 원인 확인).
with
t(name) as (values ('situation_products'), ('coupang_api_calls'), ('category_review_thresholds')),
rpc(name) as (values ('admin_list_situation_products'), ('admin_save_situation_product'), ('admin_get_situation_stats'), ('admin_list_category_thresholds'), ('admin_save_category_threshold'), ('admin_delete_category_threshold')),
helper(name) as (values ('is_site_admin'), ('is_site_master'), ('situation_products_touch'), ('situation_products_enforce_thresholds')),
newfn as (select p.oid, p.proname, p.prosecdef, p.proconfig, p.proowner, p.proacl from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in (select name from rpc union select name from helper)),
tbl as (select c.oid, c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in (select name from t)),
checks(check_name, expected, actual) as (
  select '01 테이블 3개 존재', '3', (select count(*) from tbl)::text
  union all select '02 함수 10개 존재', '10', (select count(*) from newfn)::text
  union all select '03 트리거 2개 존재', '2', (select count(*) from pg_trigger g join tbl on tbl.oid = g.tgrelid where not g.tgisinternal and g.tgname in ('situation_products_touch_trg','situation_products_enforce_thresholds_trg'))::text
  union all select '04 RLS 켜짐(테이블 3개)', '3', (select count(*) from tbl where relrowsecurity)::text
  union all select '05 정책 없음(의도)', '0', (select count(*) from pg_policy pol join tbl on tbl.oid = pol.polrelid)::text
  union all select '06 anon/authenticated 의 테이블 권한(있으면 안 됨)', '0', (select count(*) from tbl, unnest(array['anon','authenticated']) as r where has_table_privilege(r, tbl.oid, 'select,insert,update,delete,truncate,references,trigger'))::text
  union all select '07 service_role 의 테이블 권한(서버 API용)', '3', (select count(*) from tbl where has_table_privilege('service_role', tbl.oid, 'select') and has_table_privilege('service_role', tbl.oid, 'insert') and has_table_privilege('service_role', tbl.oid, 'update') and has_table_privilege('service_role', tbl.oid, 'delete'))::text
  union all select '08 anon/authenticated 의 시퀀스 권한(있으면 안 됨)', '0', (select count(*) from unnest(array['anon','authenticated']) as r where has_sequence_privilege(r, pg_get_serial_sequence('public.coupang_api_calls', 'id'), 'usage,select,update'))::text
  union all select '09 헬퍼·트리거 함수를 anon/authenticated 가 실행(있으면 안 됨)', '0', (select count(*) from newfn f, unnest(array['anon','authenticated']) as r where f.proname in (select name from helper) and has_function_privilege(r, f.oid, 'execute'))::text
  union all select '10 관리자 RPC 를 anon 이 실행(있으면 안 됨)', '0', (select count(*) from newfn f where f.proname in (select name from rpc) and has_function_privilege('anon', f.oid, 'execute'))::text
  union all select '11 관리자 RPC 를 authenticated 가 실행', '6', (select count(*) from newfn f where f.proname in (select name from rpc) and has_function_privilege('authenticated', f.oid, 'execute'))::text
  union all select '12 새 함수 중 PUBLIC 실행 가능(있으면 안 됨)', '0', (select count(*) from newfn f where exists (select 1 from aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'))::text
  union all select '13 SECURITY DEFINER = 관리자 RPC 6 + 헬퍼 2', '8', (select count(*) from newfn where prosecdef)::text
  union all select '14 새 함수 모두 search_path 고정', '10', (select count(*) from newfn where exists (select 1 from unnest(coalesce(proconfig, '{}')) cfg where cfg like 'search_path=%'))::text
  union all select '15 새 테이블은 비어 있음(시드 없음)', '0', ((select count(*) from public.situation_products) + (select count(*) from public.coupang_api_calls) + (select count(*) from public.category_review_thresholds))::text
  union all select '16 승인 조건 제약 3개', '3', (select count(*) from pg_constraint where conname in ('situation_products_approved_requirements','situation_products_dol_subtype_required','situation_products_review_verified_complete'))::text
  union all select '17 상품평 검토·갱신 실패 컬럼 5개', '5', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'situation_products' and column_name in ('review_verified_at','review_verified_by','review_read_count','review_basis','refresh_failures'))::text
  union all select '18 funnel_events 컬럼 변경 없음(8개)', '8', (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'funnel_events')::text
)
select check_name, expected, actual, (expected = actual) as ok from checks order by check_name;

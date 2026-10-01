-- 단정 기반 DB 테스트. 하나라도 어긋나면 예외 → psql 이 0 이 아닌 코드로 종료.
\set ON_ERROR_STOP on
\pset tuples_only on

create function pg_temp.as_user(r text, e text) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('email', e)::text, false);
  execute format('set role %I', r);
end $$;

create function pg_temp.expect_err(sql text, pat text) returns void language plpgsql as $$
declare ok boolean := false;
begin
  begin
    execute sql;
  exception when others then
    if sqlerrm ~ pat then ok := true; else raise exception '다른 오류가 났다. 기대 패턴 [%] / 실제 [%]', pat, sqlerrm; end if;
  end;
  if not ok then raise exception '오류가 나야 하는데 성공했다: %', left(sql, 200); end if;
end $$;

create function pg_temp.save(j jsonb) returns public.situation_products language sql as $$ select public.admin_save_situation_product(j) $$;

-- 승인 가능한 최소 기본 상품(상품평 검토 기록 포함)
create function pg_temp.base(extra jsonb default '{}') returns jsonb language sql as $$
  select jsonb_build_object(
    'name', '테스트 상품', 'review_state', 'approved', 'situations', jsonb_build_array('housewarming'),
    'reason', '테스트용 추천 이유', 'affiliate_url', 'https://link.coupang.com/a/test',
    'review_verified_at', '2026-10-01', 'review_read_count', 12, 'review_basis', '테스트 근거 문장입니다 열 자 이상'
  ) || extra $$;

-- ============ 1) 상품평 검토 없이 승인 불가 ============
do $$ begin
  perform pg_temp.as_user('authenticated', 'jumungosu@gmail.com');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base() - 'review_verified_at' - 'review_read_count' - 'review_basis')$q$, 'approved_requirements');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base() - 'review_verified_at')$q$, 'review_verified_complete|approved_requirements');
  -- 날짜만 있고 읽은 개수 없음 / 0개 / 근거 없음 / 근거 너무 짧음
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base() - 'review_read_count')$q$, 'review_verified_complete');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"review_read_count":0}'))$q$, 'review_verified_complete');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base() - 'review_basis')$q$, 'review_verified_complete');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"review_basis":"      짧음  "}'))$q$, 'review_verified_complete');
  -- 검토 기록이 비어 있는 draft 는 저장 가능(승인만 막는다)
  perform pg_temp.save(pg_temp.base('{"review_state":"draft","name":"검토 전 초안"}') - 'review_verified_at' - 'review_read_count' - 'review_basis');
  raise notice 'OK 1) 상품평 검토 없이 승인 불가';
end $$;

-- ============ 2) 검토 기록이 있으면 승인 가능, 검토자는 서버가 채움 ============
do $$ declare r public.situation_products; begin
  perform pg_temp.as_user('authenticated', 'JumunGosu@gmail.com');
  r := pg_temp.save(pg_temp.base('{"name":"검토 완료 상품"}'));
  assert r.review_state = 'approved', '승인돼야 함';
  assert r.review_verified_by = 'jumungosu@gmail.com', '검토자는 JWT 이메일(소문자)';
  assert r.review_read_count = 12 and r.review_verified_at = date '2026-10-01', '기록 보존';
  assert r.refresh_failures = 0, '실패 횟수 기본 0';
  -- 클라이언트가 review_verified_by 를 보내도 무시(위조 불가)
  r := pg_temp.save(pg_temp.base('{"name":"검토자 위조 시도","review_verified_by":"someone@else.com"}'));
  assert r.review_verified_by = 'jumungosu@gmail.com', '검토자 위조 불가';
  raise notice 'OK 2) 검토 기록 있으면 승인, 검토자는 서버가 채움';
end $$;

-- ============ 3) 승인된 상품의 검토 기록을 지우면 거부, 보류로 바꾸는 건 가능 ============
do $$ declare r public.situation_products; begin
  perform pg_temp.as_user('authenticated', 'jumungosu@gmail.com');
  r := pg_temp.save(pg_temp.base('{"name":"수정 시나리오"}'));
  perform pg_temp.expect_err(format($q$select pg_temp.save(pg_temp.base('{"id":"%s","name":"수정 시나리오"}') - 'review_verified_at' - 'review_read_count' - 'review_basis')$q$, r.id), 'approved_requirements');
  r := pg_temp.save(pg_temp.base(jsonb_build_object('id', r.id, 'review_state', 'hold')) - 'review_verified_at' - 'review_read_count' - 'review_basis');
  assert r.review_state = 'hold' and r.review_verified_at is null, '보류 + 검토 기록 비움은 가능';
  raise notice 'OK 3) 수정 경로';
end $$;

-- ============ 4) 돌잔치: 세부 구분 필수 ============
do $$ declare r public.situation_products; begin
  perform pg_temp.as_user('authenticated', 'jumungosu@gmail.com');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"name":"돌 구분 없음","situations":["dol"],"subtypes":[]}'))$q$, 'dol_subtype_required');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"name":"돌+다른 상황 구분 없음","situations":["dol","housewarming"]}'))$q$, 'dol_subtype_required');
  r := pg_temp.save(pg_temp.base('{"name":"돌 참석","situations":["dol"],"subtypes":["attend"]}'));
  assert r.subtypes = array['attend'];
  r := pg_temp.save(pg_temp.base('{"name":"돌 답례","situations":["dol"],"subtypes":["return"]}'));
  r := pg_temp.save(pg_temp.base('{"name":"돌 양쪽","situations":["dol"],"subtypes":["attend","return"]}'));
  assert cardinality(r.subtypes) = 2, '양쪽은 운영자가 둘 다 명시';
  -- draft 는 구분 없이도 저장 가능, 돌잔치가 아닌 상품은 구분 없이 승인 가능
  perform pg_temp.save(pg_temp.base('{"name":"돌 초안","review_state":"draft","situations":["dol"]}'));
  perform pg_temp.save(pg_temp.base('{"name":"집들이 상품"}'));
  -- 허용되지 않는 세부 값
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"name":"잘못된 구분","situations":["dol"],"subtypes":["both"]}'))$q$, 'subtypes_valid');
  raise notice 'OK 4) 돌잔치 세부 구분 필수';
end $$;

-- ============ 5) 카테고리별 기준 ============
do $$ declare t public.category_review_thresholds; begin
  -- 기준이 없는 동안은 숫자 기준 없이 승인 가능(임의 기본 기준을 만들지 않는다)
  perform pg_temp.as_user('authenticated', 'jumungosu@gmail.com');
  perform pg_temp.save(pg_temp.base('{"name":"기준 없는 카테고리","category":"식품","rating":3.1,"review_count":5,"review_checked_at":"2026-10-01"}'));
  assert (select count(*) from public.admin_list_category_thresholds()) = 0, '기본 기준은 비어 있어야 함';

  t := public.admin_save_category_threshold('{"category":"식품","min_rating":4.0,"min_review_count":100,"note":"운영자 내부 기준"}');
  assert t.min_rating = 4.0 and t.updated_by = 'jumungosu@gmail.com';

  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"name":"평점 미달","category":"식품","rating":3.5,"review_count":500,"review_checked_at":"2026-10-01"}'))$q$, '평점 4\.0 이상');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"name":"리뷰 부족","category":"식품","rating":4.5,"review_count":99,"review_checked_at":"2026-10-01"}'))$q$, '리뷰 100 개 이상');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"name":"수치 없음","category":"식품"}'))$q$, '평점 4\.0 이상');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base('{"name":"확인일 없음","category":"식품","rating":4.5,"review_count":500}'))$q$, 'review_date_required|평점 4\.0 이상');
  perform pg_temp.save(pg_temp.base('{"name":"기준 충족","category":"식품","rating":4.2,"review_count":150,"review_checked_at":"2026-10-01"}'));
  -- 다른 카테고리·초안은 영향 없음
  perform pg_temp.save(pg_temp.base('{"name":"다른 카테고리","category":"생활","rating":3.0,"review_count":3,"review_checked_at":"2026-10-01"}'));
  perform pg_temp.save(pg_temp.base('{"name":"기준 미달 초안","category":"식품","review_state":"draft"}'));
  -- 기준을 바꿔도 이미 저장된 행은 건드리지 않고, 다음 저장 때 검사된다 / 기준 삭제 후에는 숫자 기준 없음
  perform public.admin_delete_category_threshold('식품');
  perform pg_temp.save(pg_temp.base('{"name":"기준 삭제 후","category":"식품"}'));
  raise notice 'OK 5) 카테고리별 기준';
end $$;

-- ============ 6) 권한 ============
do $$ begin
  -- 매니저: 조회 가능, 저장·삭제 불가
  perform pg_temp.as_user('authenticated', 'dream3359@naver.com');
  perform public.admin_list_category_thresholds();
  perform public.admin_list_situation_products();
  perform pg_temp.expect_err($q$select public.admin_save_category_threshold('{"category":"식품","min_rating":1}')$q$, '마스터 계정만');
  perform pg_temp.expect_err($q$select public.admin_delete_category_threshold('식품')$q$, '마스터 계정만');
  perform pg_temp.expect_err($q$select pg_temp.save(pg_temp.base())$q$, '마스터 계정만');
  -- 일반 로그인 사용자·anon
  perform pg_temp.as_user('authenticated', 'stranger@example.com');
  perform pg_temp.expect_err($q$select public.admin_list_category_thresholds()$q$, '관리자만');
  perform pg_temp.expect_err($q$select public.admin_save_category_threshold('{"category":"x"}')$q$, '마스터 계정만');
  perform pg_temp.as_user('anon', 'x@example.com');
  perform pg_temp.expect_err($q$select public.admin_list_category_thresholds()$q$, 'permission denied');
  -- 헬퍼 함수는 누구도 직접 실행할 수 없다(RPC 안에서만 쓰임). 그래도 RPC 는 정상 동작해야 한다(위 테스트들).
  perform pg_temp.as_user('anon', 'x@example.com');
  perform pg_temp.expect_err($q$select public.is_site_master()$q$, 'permission denied');
  perform pg_temp.expect_err($q$select public.is_site_admin()$q$, 'permission denied');
  perform pg_temp.as_user('authenticated', 'jumungosu@gmail.com');
  perform pg_temp.expect_err($q$select public.is_site_master()$q$, 'permission denied');
  -- 테이블 직접 접근 불가
  perform pg_temp.as_user('authenticated', 'jumungosu@gmail.com');
  perform pg_temp.expect_err($q$select * from public.category_review_thresholds$q$, 'permission denied');
  perform pg_temp.expect_err($q$insert into public.situation_products(name, review_state) values ('직접삽입','approved')$q$, 'permission denied');
  execute 'reset role';
  raise notice 'OK 6) 권한';
end $$;

-- ============ 7) 기준 값 검증 ============
do $$ begin
  perform pg_temp.as_user('authenticated', 'jumungosu@gmail.com');
  perform pg_temp.expect_err($q$select public.admin_save_category_threshold('{"category":"식품","min_rating":6}')$q$, 'min_rating_check');
  perform pg_temp.expect_err($q$select public.admin_save_category_threshold('{"category":"  ","min_rating":4}')$q$, 'category_check');
  execute 'reset role';
  raise notice 'OK 7) 기준 값 검증';
end $$;

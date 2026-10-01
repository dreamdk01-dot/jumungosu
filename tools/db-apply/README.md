# DB 적용 준비물 (상황별 쇼핑 마이그레이션 2개)

**운영 DB 에 아직 적용하지 않았다.** 아래 순서로, 사람이 승인한 뒤에만 적용한다. 대상: Supabase 프로젝트 `jumungosu`(ref `sxuqkuqpopckhttvpwvh`).

| 파일 | 용도 |
|---|---|
| `combined.sql` | 두 마이그레이션을 `begin … commit` 으로 묶은 결합본(한 트랜잭션). 하나라도 실패하면 전부 롤백. **직접 수정 금지** — `node tools/db-apply/build-combined.mjs` 로 다시 만든다 |
| `preflight.sql` | 읽기 전용. 적용 **직전** 점검 6개(이름 충돌 없음·필요한 역할·`auth.jwt()`·`funnel_events` 컬럼 등). 모든 `ok` 가 true 여야 적용 |
| `verify-after.sql` | 읽기 전용. 적용 **직후** 검증 18개(객체·RLS·객체별 권한·SECURITY DEFINER·search_path·빈 테이블·제약). 모든 `ok` 가 true 여야 한다 |
| `advisor-expected.json` + `check-advisors.mjs` | Security Advisor 적용 전 기준선과 적용 후 기대값, 비교 도구 |
| `rollback.sql` | 되돌리기(한 트랜잭션). ⚠ 새 테이블 데이터가 삭제된다 |

## 순서
1. `preflight.sql` 실행 → 전부 `ok = true`.
2. `combined.sql` 을 **한 번의 호출로** 적용(Supabase SQL Editor 에 통째로 붙여넣어 한 번 실행, 또는 도구로 한 덩어리). 조각내어 여러 번 나눠 실행하면 트랜잭션이 깨진다.
3. `verify-after.sql` 실행 → 18개 전부 `ok = true`. 하나라도 false 면 `rollback.sql`.
4. Security Advisor 조회 → `{린트 이름: [항목 이름]}` JSON 으로 정리해 `node tools/db-apply/check-advisors.mjs actual.json` (기대: rls_enabled_no_policy +3 테이블, authenticated_…executable +6 관리자 RPC, anon_…executable 변화 없음).
5. 실제 로그인으로 확인: 마스터(저장·기준 저장 가능), 매니저(조회만, 저장은 "마스터 계정만"), 일반 회원·비로그인(관리자 RPC 거부), 상품평 검토 없이 승인 → 거부, 돌잔치 구분 없이 승인 → 거부.
6. `/api/situation-products` 가 `table_missing`(503) → `{"products":[]}`(200) 으로 바뀌는지, 홈·`/hot-deals`·`partner_click` 기록이 그대로인지.

## 로컬 검증 (임시 Postgres, 운영 DB 와 무관)
```bash
bash tools/db-test/run-combined.sh   # 정상 적용, 실패 롤백(A·B·C), 검증 SQL 민감도, rollback.sql, 재적용
bash tools/db-test/run.sh            # 마이그레이션별 기능·권한 단정 테스트
```
- **실패 시 전체 롤백**은 세 방식으로 확인: (A) 끝에서 실패 (B) 두 마이그레이션 사이에서 실패(1번도 롤백) (C) `begin/commit` 없이 한 번의 호출로 보낸 경우(단일 호출의 암묵 트랜잭션).
- 한계: 로컬은 Postgres 16 이고 운영은 17, `auth.jwt()`·역할·기본 권한은 운영 설정을 흉내 낸 스텁이다. 운영에서 `preflight.sql`/`verify-after.sql` 이 실제 확인이다.
- 마이그레이션 이력: 결합본을 한 번에 적용하면 `supabase_migrations` 에 이력이 한 줄(또는 적용 방식에 따라 없음)만 남고, 저장소에는 파일 2개가 있다. 나중에 `supabase db push` 를 쓰면 두 파일이 다시 적용되지만 둘 다 멱등이라 안전하다.

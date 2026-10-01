# HANDOFF — 상황별 쇼핑 작업 현황 (2026-10-01, 2차 보완 후)

브랜치: `feature/situation-shopping` (기준: `main` 의 baseline 커밋 = 업로드된 파일 그대로, `app.html` md5 `0d3c9fbf…`)

## 한눈에

| 구분 | 상태 |
|---|---|
| 쇼핑 첫 화면·상황 검색·돌잔치 참석/답례 선택·보조 필터·상태 화면 | ✅ 구현, 로컬 브라우저 확인 |
| **상품평 검토를 승인 조건에 반영**(DB 제약 + 서버 필터 + 관리자 화면 + 방문자 노출 조건) | ✅ 구현·DB 테스트 |
| **카테고리별 평점·리뷰수 기준**(운영자 설정, 기본 비어 있음, 방문자에게 홍보 안 함) | ✅ 구현·DB 테스트 |
| **돌잔치 상품 세부 구분 필수**(비어 있어도 양쪽 노출 안 함) | ✅ 구현·DB/서버/화면 테스트 |
| **갱신 대상 선정**(실패 이력·재시도 간격·옵션 없는 상품 사전 제외·보완 필요 표시) | ✅ 구현·모의 테스트 |
| 쿠팡 파트너스 API — **공식 문서 확인** | ❌ 못 함 |
| 쿠팡 파트너스 API — **실제 호출 성공** | ❌ 못 함(키 없음, 이 환경은 쿠팡 서버 접근 불가) |
| 쿠팡 파트너스 API — 모의 테스트 | ✅ 통과(모의 응답 기준이라 실제 동작을 보증하지 않음) |
| 가격 자동 저장 | ⛔ 꺼짐 유지(옵션 식별자·옵션별 가격 검증 불가) |
| 운영 저장소 비교 | ✅ 완료 — `dreamdk01-dot/jumungosu` `main`(`21512e3`)과 비교, 이 브랜치는 그 위에 얹음(아래) |
| Vercel Preview | ⏳ 브랜치를 GitHub 에 push 해야 생성됨(작업 환경에는 push 권한이 없음). 준비는 끝남 |
| 실제 Supabase 에서의 권한 검증 | ❌ 미적용(SQL 검토 승인 후 진행) |
| 운영 배포 / 운영 DB 변경 | ❌ 하지 않음 |

## 이번 보완에서 바뀐 것

1. **승인에는 상품평 검토 기록이 필요하다.** 검토일 + 직접 읽은 수(≥1) + 운영자가 쓴 근거(10자 이상). 기록이 없으면 DB 가 승인을 거부하고,
   공개 API 는 검토 기록이 없는 행을 내려주지 않고, 관리자 화면은 저장 전에 막고, 방문자 화면의 랭킹도 한 번 더 거른다. 시스템은 근거를 대신 써 넣지 않는다.
2. **카테고리별 기준**(최소 평점·리뷰수)을 운영자가 정할 수 있다. 기본은 비어 있어 임의 기준이 없다. 방문자 화면에는 기준을 내세우지 않는다.
3. **돌잔치**: `dol` 상품은 `attend`/`return` 중 하나 이상을 명시해야 승인된다. 구분이 비어 있어도 양쪽에 노출되지 않는다.
4. **갱신 대상 선정 재작성**:
   - 이전: "가격 확인일이 오래된 순" → 계속 실패해 확인일이 비어 있는 상품이 매번 먼저 뽑혀 다른 상품이 밀렸다.
   - 이후: 한 번도 시도하지 않은 상품 → 마지막 시도가 오래된 상품 순. 실패한 상품은 6시간(이후 12h, 24h … 최대 72h) 뒤에 재시도. 방금 확인된 상품은 6시간 건너뜀.
   - 쿠팡 상품·옵션 식별자가 없는 상품은 **호출 전에 제외**하고 관리자 목록에 "보완 필요"로 표시.
   - 검색 결과 없음·옵션 불일치는 "확인 못 함"으로만 기록(품절 아님). 호출 한도·차단 같은 시스템 쪽 실패는 상품 실패로 기록하지 않는다.
5. **갱신 기본이 "확인만"**: `COUPANG_REFRESH_ENABLED=true` 만으로는 호출해서 일치 여부만 보고 가격·이미지를 저장하지 않는다.
   저장은 `COUPANG_PRICE_REFRESH_ENABLED=true` 일 때만.
6. 검색 경로를 환경변수로 선택(`COUPANG_PARTNERS_SEARCH_PATH`, 두 형태만 허용), 상품 URL 의 `pageKey` 형식 지원, 실제 응답 구조 확인 도구(`tools/verify-coupang.mjs`) 추가.
7. SQL 검토 중 발견: 1번 마이그레이션의 `is_site_admin()`/`is_site_master()` 가 PUBLIC 실행 권한을 그대로 갖고 있었다 → 2번 마이그레이션에서 회수하고 테스트로 고정.

### 기존 테스트와의 관계

- 기존 75개 중 **동작이 의도적으로 바뀐 3개**를 새 동작에 맞게 바꿨다(나머지 72개는 그대로 통과):
  ① 돌잔치 `subtypes: []` 는 양쪽에 노출 → 어느 쪽에도 노출 안 함 ② 옵션 ID 없는 상품은 호출 후 거절 → 호출 전 제외 ③ 갱신 테스트는 저장 모드(`dryRun:false`)를 명시.
  또한 테스트 상품 데이터에 새 필드(`reviewVerifiedAt`)를 추가했다.
- 변이 검사: DB 제약 3곳(승인에 상품평 필요 / 돌잔치 구분 / 카테고리 기준 트리거)을 일부러 지우면 DB 테스트가 실패하는 것을 확인했다.

## 쿠팡 파트너스 API — 확인한 것과 못 한 것

- **못 한 것**: 공식 문서 원문 확인. 검색에서 파트너스 공식 문서는 나오지 않았고(판매자용 Wing 문서와 제3자 글뿐), 키가 없어 실제 호출도 못 했다.
- **제3자 자료에서 본 것(공식 아님) — 서로 모순된다**:
  - 검색 경로: `/openapi/products/search`(위키·SDK 예제) vs `/openapi/v1/products/search`(블로그 요청 예시).
  - 호출 한도: 시간당 10회 vs 분당 50회 vs 분당 100회. 한 실측 글은 "문서엔 분당 50회라고 돼 있었는데 실제로는 시간당 10회였고 초과하면 403·24시간 차단, 3회 반복 시 계정 제한 가능"이라고 한다.
  - 그래서 구현은 가장 보수적인 값(시간당 8회, 403/429 시 24시간 호출 중단)을 따른다.
- **응답에 상품·옵션 식별자가 있는지는 모른다.** 한 자료의 딥링크 예시에는 `pageKey/itemId/vendorItemId` 가 있지만 검색 API 응답의 `productUrl` 형태는 확인하지 못했다.
  없으면 코드는 갱신을 거절한다(안전한 쪽). 실제 응답은 `tools/verify-coupang.mjs` 로 확인한다(README 절차).
- 평점·리뷰수·리뷰 원문·품절 여부는 API 가 준다고 가정하지 않았다(운영자가 직접 확인).

## Preview / Supabase / 운영 저장소 — 이번에 한 것과 못 한 것

- **Vercel(정정)**: 지난 보고의 "프로젝트·배포 없음"은 **틀렸다.** 팀 ID 를 지정해 조회한 결과가 비어 있었던 것을 잘못 해석했다(원인 미확인, 조회 방식 문제).
  다시 확인한 사실: 연결된 계정 `dream.dk.01@gmail.com`(`dreamdk01-5718`, Hobby) · 팀 `jumungosu`(`team_csZBAJvQIzNoeZXx7eClYB1f`) · 프로젝트 `jumungosu`(`prj_OhnnfzMyik6TXu593hiozFvonRH6`) ·
  도메인 `www.jumungosu.com`·`jumungosu.com` 등 · Git 연결 `github.com/dreamdk01-dot/jumungosu`, 운영 브랜치 `main`(배포 메타데이터 기준) ·
  최신 운영 배포 = `main` 의 `21512e3`("Add files via upload"). 새 프로젝트는 만들지 않았다.
- **운영 저장소 비교(완료)**: `main`(`21512e3`)과 업로드본(baseline)을 파일별로 비교했다. `app.html`·`vercel.json`·`home.js`·`seo-shopping.js` 등 핵심 파일은 **바이트 단위로 동일**.
  차이는 두 가지뿐이다 — ① `api/seo.js`(운영이 더 최신: 앱 이름 나열 순서를 "배민·쿠팡이츠·요기요·땡겨요"로 바꾼 문구 수정) ② 업로드본에 없던 `api/auth/[...nextauth].js`(소셜 로그인, 키는 환경변수로만 읽음).
  이 브랜치는 `main` 위에서 상황별 쇼핑 커밋 2개만 얹었고 위 두 파일을 포함한 운영 파일은 건드리지 않았다. 운영 저장소에는 `.gitignore` 가 없었는데 이 브랜치가 추가한다(`env`·`.env` 실수 커밋 방지).
- **Preview 생성 방법**: 프로젝트가 GitHub 에 연결돼 있으므로 이 브랜치를 `main` 이 아닌 이름으로 push 하면 Vercel 이 Preview 를 만든다. `main` 에 병합·push 하면 곧바로 **운영 배포**가 되니 하지 말 것.
  Preview URL 은 Vercel 로그인 보호(SSO)가 켜져 있다(`all_except_custom_domains`). **Preview 환경변수**(Settings > Environment Variables 에서 Preview 체크)를 따로 확인해야 한다: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ADMIN_EMAILS`, 쿠팡 키 2개,
  `COUPANG_REFRESH_ENABLED=false`, `COUPANG_PRICE_REFRESH_ENABLED=false`. Production 에만 등록돼 있으면 Preview 에서는 `/api/situation-products` 가 503(`not_configured`)이다.
- **Supabase 운영 DB(읽기 전용 조회만)**: 새 테이블·함수·이벤트 없음, 기존 마이그레이션 7개(`20260920…`~`20260921…`) 확인. **아무것도 적용하지 않았다.**
  임시 Postgres 16 에서는 두 마이그레이션 적용·재실행·권한·제약을 모두 단정 테스트로 확인했다(`tools/db-test`). 단 `auth.jwt()` 와 역할은 스텁이라 **실제 Supabase 에서 한 번 더 확인**해야 한다.

## SQL 검토 요약 (적용 전 확인용, 2026-10-01 최신 SQL 기준)

- **대상**: Supabase 프로젝트 `jumungosu`(ref `sxuqkuqpopckhttvpwvh`, ap-southeast-1, Postgres 17, 정상). 계정에 프로젝트 하나뿐이고 `app.html` 의 Supabase URL 과 일치. 운영 DB 한 곳이며 Preview 도 같은 DB 를 쓴다.
- **적용 전 조회(읽기 전용)로 확인**: 이름 충돌 없음(새 테이블 3개·함수 10개 모두 미존재), `funnel_events` 컬럼이 통계 RPC 가 쓰는 것과 일치(1,000행), `pgcrypto` 있음.
- **적용 준비물**: `tools/db-apply/`(결합본 `combined.sql` = 두 마이그레이션을 한 트랜잭션으로, `preflight.sql`, `verify-after.sql`, `rollback.sql`, Advisor 기대값/비교 도구) — 사용법은 `tools/db-apply/README.md`. 로컬 임시 DB 에서 정상 적용·실패 롤백(3가지 방식)·검증 SQL 민감도·롤백 후 재적용을 확인했다(`bash tools/db-test/run-combined.sh`). **운영 DB 에는 `preflight.sql` 만(읽기 전용) 실행했고 6개 모두 통과, 마이그레이션은 아직 적용하지 않았다.**
- **적용 순서**: ① `20261001000000_situation_products.sql` → ② `20261002000000_review_verification.sql` 를 **같은 세션에서 연달아**(①만 적용된 사이에는 헬퍼 함수가 anon 에 열려 있다). 둘 다 여러 번 실행해도 안전.

| 구분 | 내용 |
|---|---|
| 새 테이블 3개 | `situation_products`, `coupang_api_calls`, `category_review_thresholds` (RLS 켬, 정책 없음) |
| 새 함수 10개 | 관리자 RPC 6(`admin_list_situation_products`, `admin_save_situation_product`, `admin_get_situation_stats`, `admin_list_category_thresholds`, `admin_save_category_threshold`, `admin_delete_category_threshold`), 헬퍼 2(`is_site_admin`, `is_site_master`), 트리거 함수 2 |
| 트리거 2개 | `updated_at` 자동 갱신, 승인 시 카테고리 기준 검사 |
| 기존 객체 | **변경·삭제 없음.** `funnel_events` 는 읽기만(통계 RPC). `drop`/`truncate` 없음 |
| 기존 데이터 영향 | 없음. 2번의 `update ... set review_state='hold'` 는 새 테이블의 승인 행에만 해당 → 지금은 0행 |
| 권한(이 프로젝트는 새 테이블·함수에 anon/authenticated/service_role 이 기본 부여됨) | 테이블 3개와 시퀀스는 anon/authenticated 권한을 **명시적으로 회수**(service_role 유지) · 관리자 RPC 6개는 authenticated 만 실행(anon 불가, 내부에서 이메일 재확인: 조회=매니저 3명, 저장=마스터) · 헬퍼·트리거 함수는 아무도 직접 실행 불가 |
| 데이터 변경 SQL | 시드 데이터 없음(기본 카테고리 기준도 없음) |
| 되돌리기 | 각 파일 맨 아래 주석 |

**Security Advisor 기준선(적용 전)**: `rls_enabled_no_policy` 5건(INFO), `function_search_path_mutable` 1, `anon_security_definer_function_executable` 27, `authenticated_security_definer_function_executable` 29, `auth_leaked_password_protection` 1.
**적용 후 예상**: `rls_enabled_no_policy` 5→8(의도: 새 테이블 3개, 기존 테이블과 같은 방식), `authenticated_…executable` 29→35(의도: 관리자 RPC 6개), `anon_…executable` 27 그대로(새 항목 없어야 함). 이와 다르면 적용을 되돌리고 확인한다.
**기존(이번 작업 밖) 관찰**: 기존 SECURITY DEFINER 함수 중 `set_home_banner_config`, `get_funnel_stats()` 등이 anon 에게 실행 가능하다(내부에서 이메일을 확인하긴 함). 이번에 건드리지 않았다.

**적용 후 확인 항목**
1. 객체 존재: 테이블 3·함수 10·트리거 2 (`pg_class`/`pg_proc`/`pg_trigger`).
2. 권한: anon·authenticated 의 새 테이블 권한 없음, 헬퍼·트리거 함수 실행 불가, 관리자 RPC 는 anon 불가·authenticated 가능(`has_table_privilege`/`has_function_privilege`).
3. Security Advisor 수치가 위 예상과 일치.
4. 실제 로그인으로: 마스터 — 저장·카테고리 기준 저장 가능 / 매니저 — 조회만, 저장은 "마스터 계정만" 오류 / 일반 회원·비로그인 — 관리자 RPC 거부.
5. 승인 조건: 상품평 검토 없이 승인 → 거부, 돌잔치 구분 없이 승인 → 거부(관리자 화면에서 확인).
6. 공개 API: `/api/situation-products` 가 `table_missing`(503)에서 승인 상품 0개일 때 `{"products":[]}`(200)로 바뀜.
7. 기존 기능 회귀: 홈·`/hot-deals` 정상, `partner_click` 이벤트 계속 기록, 관리자 대시보드 통계 정상.

## Preview 500(FUNCTION_INVOCATION_FAILED) 사고 기록

- **증상**: Preview 의 `/api/situation-products` 가 JSON 이 아니라 Vercel 500 화면, `/shopping` 은 "추천 상품을 불러오지 못했어요".
- **마이그레이션 누락이 아니다**: 테이블이 없으면 이 함수는 503 JSON(`table_missing`)을 돌려주도록 만들어져 있고, 어떤 입력에서도 JSON 을 돌려주는 것을 재현으로 확인했다.
- **재현된 원인(가장 유력, Vercel 로그로는 미확인)**: 프로젝트에 `package.json` 이 없어 Vercel 이 `api/*.js` 를 ESM→CJS 로 변환한다(`@vercel/node` 로 같은 빌드를 재현). `.mjs` 는 변환되지 않고 ESM 으로 남아,
  변환된 함수의 `require('./_lib/supabase-rest.mjs')` 가 `require(esm)` 이 안 되는 환경에서 `ERR_REQUIRE_ESM` 으로 **모듈 로딩 단계에서** 죽는다. 운영 저장소에는 `.mjs` 가 0개였고 기존 함수는 `.js`→`.js` 만 쓴다.
  Vercel 런타임이 실제로 `require(esm)` 을 막고 있는지는 확인하지 못했다. 이 증상을 낼 수 있는 경로가 이것 하나뿐이라는 것까지만 재현으로 확인했다.
- **수정**: `api/_lib/*.mjs` → `.js`(기존 함수와 같은 방식), 함수 안에서 요청 시점에 동적 import + 실패 시 `{error:'module_load_failed', code}` JSON, `package.json` 은 추가하지 않음.
- **검증**: `tools/vercel-bundle-check.mjs`(Vercel 빌더로 빌드→로드→호출): 수정 전은 `require(esm)` 끄면 FAIL, 수정 후는 기본/끔 모두 PASS, 기존 함수는 영향 없음. 회귀 테스트 4개 추가(106개 중 105개 통과 + DB 1개 별도).
- **Preview 재검증**: 수정 커밋을 push 한 같은 브랜치의 새 Preview 에서 확인(아래 절차).

## 남은 설정 / 사람이 해야 하는 것

1. 이 브랜치를 GitHub 에 **`main` 이 아닌 이름으로** push → Vercel Preview 생성 → Preview 환경변수 확인 → Preview 에서 모바일·PC 확인.
2. 위 SQL 검토 요약을 확인한 뒤 적용 여부 결정. 적용하면 실제 Supabase 에서 마스터·매니저·일반 계정 권한을 확인.
3. 쿠팡 파트너스 공식 문서 확인 → `tools/verify-coupang.mjs` 로 실제 응답 구조 확인(키는 본인 터미널 환경변수로만) → 결과에 따라 경로·필드 보정.
4. 키는 Vercel 환경변수(Preview/Production 각각)에만 등록. 채팅·Git·스크린샷에 붙여넣지 않는다.
5. 마스터로 상품 등록 → **상품평을 직접 읽고** 검토 기록 작성 → 승인. 상황마다 3개 이상.
6. `SITUATION_SHOPPING_PUBLIC` 은 **`app.html` 안의 JavaScript 상수**다(Vercel 환경변수가 아니라서 대시보드에서 바꿀 수 없다). 바꾸려면 파일 수정 → 커밋 → 배포.
7. 업로드된 `env` 파일의 OAuth/NextAuth 시크릿 재발급(이 저장소에는 넣지 않았고 값은 출력하지 않았다).

## 테스트 결과

- `node --test tests/*.test.mjs`: 102개 중 101개 통과 + 1개(DB 연동)는 `RUN_DB_TESTS=1` 일 때 실행되고 그때도 통과 — 검색·쿠팡 연동·핸들러·회귀.
- `tools/db-test/run.sh`: 두 마이그레이션 적용 + 재실행 + 기존 승인 행 정리 + 권한·제약 단정 7묶음 통과.
- `tools/e2e/run.py`: 모바일 390px·데스크톱 1280px, 174개 항목 통과(외부 CDN·Supabase 는 스텁).
- 모두 **모의/로컬 환경**이다. 실제 CDN·실제 Supabase·실제 쿠팡·실제 기기에서의 확인은 위 "남은 설정" 이후.

## 알려진 문제 / 한계

- **(기존, 이번 작업과 무관)** `api/home.js` 가 `app.html` 에서 찾는 문자열 7개 중 5개가 **운영 `main` 의 `app.html` 에도** 정확히 일치하지 않는다(업로드본과 운영본이 같으므로 업로드본 문제가 아니라 운영 상태). 못 찾으면 조용히 건너뛰므로 오류는 없지만 해당 홈 SSR 삽입은 동작하지 않는다. 수정하지 않았다.
- 검색은 규칙 기반이라 6가지 상황 밖의 말, 한글 숫자("오만원"), 복잡한 문장은 못 읽는다(못 읽으면 그렇게 안내). "5만원"처럼 단위만 있는 금액은 상한으로 해석하고 "입력한 금액 기준"으로 표시한다.
- 이미지: 갱신을 켜지 않으면 운영자가 넣은 https URL 만 있다(없으면 "이미지 준비 중"). 쿠팡 이미지 직접 링크 허용 여부는 미확인.
- 가격은 확인일과 함께 표시하지만 오래돼도 자동으로 숨기지 않는다(후속 과제).
- `/shopping` 은 사이트맵에 있고 색인 가능(`PAGE_SEO.shopping.indexable: true`). 승인 상품이 거의 없는 채로 공개하면 얇은 페이지가 되므로 채워질 때까지 noindex 를 고려.
- 관리자 이메일 목록이 세 곳에 있다: `app.html`(`MANAGER_EMAILS`), DB 함수(`is_site_admin`/`is_site_master`), 환경변수 `ADMIN_EMAILS`(갱신 API). 바꿀 때 함께 바꿀 것.
- 마이그레이션은 아직 운영 DB 의 마이그레이션 이력(`supabase_migrations`)에 등록되지 않았다. 적용 방식(SQL Editor / CLI)에 따라 이력 관리 방법이 달라진다.

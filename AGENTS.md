# AGENTS.md — 이 저장소에서 작업하는 개발 도구(사람/AI)를 위한 규칙

## 반드시 유지할 기능 (이번 작업과 무관하게 깨뜨리지 말 것)

- 배달할인: 홈(`/`), `api/home.js`(SSR), `api/discounts.js`(Airtable 캐시), `api/sync-airtable.js`, SEO 페이지 `api/seo.js`
- 소식·제보 게시판, 회원가입/로그인(Supabase Auth), 관리자 대시보드(방문·회원·퍼널 통계, 홈 배너)
- 쇼핑핫딜(`/hot-deals`): `AUTUMN_GIFT_PRODUCTS`, 필터, 카드, **기존 `partner_click` 추적**
- 추석 SEO 페이지(`/chuseok-*`, `api/seo-shopping.js`) 와 `/shopping/chuseok` 질문 플로우
- 쿠팡 파트너스 고지(`hotdealsAffiliateDisclosureHtml()`)와 제휴 링크(`rel="noopener sponsored"`)

## 건드릴 때 주의

- `app.html` 의 `AUTUMN_GIFT_PRODUCTS` 는 한 줄 형식 그대로 둔다. `api/seo-shopping.js` 가 정규식으로 읽는다.
  (`tests/regression.test.mjs` 가 해시로 지킨다. 데이터를 바꿔야 하면 파서와 테스트를 함께 바꾼다.)
- `api/home.js` 는 `app.html` 홈 마크업의 문자열을 찾아 바꾼다. 홈 마크업을 바꾸면 SSR 이 조용히 건너뛸 수 있다.
- `app.html` 은 단일 파일 SPA 다. 새 코드는 표시된 블록(`상황별 쇼핑 (2026-10)`, `관리자: 상황별 쇼핑 상품 검토`)에 둔다.
- 기존 브랜치·변경을 덮어쓰지 말고 작업 브랜치에서 수정한다. 운영 배포 전에는 변경 결과(Preview)를 사람에게 보여준다.

## 비밀값

- Access Key / Secret Key / service_role 키 / OAuth 시크릿은 **서버 환경변수로만** 다룬다.
  브라우저 코드, Git, 로그, 응답, 스크린샷, 채팅에 값이 나타나면 안 된다. `.env.example` 에는 이름만 적는다.
- 키가 필요한데 없으면 필요한 환경변수 이름과 등록 위치(Vercel > Settings > Environment Variables)만 안내한다. 값을 달라고 하지 않는다.
- `env`, `.env*` 는 `.gitignore` 대상이다. 업로드된 `env` 파일에 실제 값이 들어 있으면 그 값을 출력·복사하지 말고 교체(rotate)를 권한다.

## 추천 데이터 규칙 (서비스의 신뢰와 직결)

- 방문자에게는 **운영자가 승인(`review_state='approved'`)한 상품만** 보여준다. 쿠팡 검색 결과를 그대로 "검증된 추천"으로 공개하지 않는다.
- 예시 상품, 가짜 리뷰, 가짜 가격으로 빈자리를 채우지 않는다. 상품이 없으면 "준비 중/조건에 맞는 상품 없음"으로 안내한다.
- 평점·리뷰수·가격은 **확인한 값 + 확인일**로만 표시한다. 리뷰 원문을 확보하지 못했다면 후기를 분석·요약한 것처럼 쓰지 않는다.
- **상품평 검토 없이는 승인할 수 없다.** 승인(`approved`)에는 상황·추천 이유·제휴 링크에 더해 상품평 검토 기록(검토일 + 직접 읽은 수 ≥ 1 + 운영자가 쓴 근거 10자 이상)이
  필요하다(DB 제약 + 서버 필터 + 관리자 화면 검증). 시스템·AI 는 검토 근거나 상품평 요약을 **대신 써 넣지 않는다.** 읽지 않은 상품평을 읽은 것처럼 기록하지 않는다.
- 카테고리별 최소 평점·리뷰수는 운영자가 정하는 내부 기준이다(기본은 비어 있음). 임의의 숫자를 기본값으로 넣지 않고, 방문자 화면에서 "검증된 기준"으로 홍보하지 않는다.
- 돌잔치(`dol`) 상품은 `attend`/`return` 을 하나 이상 명시해야 승인된다. 비어 있다고 양쪽에 노출하지 않는다(양쪽이면 둘 다 명시).
- API 값 갱신은 **상품 ID와 옵션 ID가 모두 일치할 때만** 한다. 옵션 식별자가 없는 상품은 호출 전에 제외하고 관리자에게 "보완 필요"로 알린다.
  가격 저장은 `COUPANG_PRICE_REFRESH_ENABLED` 가 켜진 경우에만(기본은 확인만). 이름이 비슷한 다른 상품을 연결하지 않는다.
- 검색 결과에 없다는 이유로 품절/판매중지라고 판정하지 않는다. 오류가 나면 기존 값을 0원·품절 등으로 덮어쓰지 않는다.
- 원문 검색어를 서버로 보내거나 저장하지 않는다. 추적은 상황 id·예산 구간·결과 수 같은 범주값만.
- 사이트 문구는 과장하지 않는다. "AI가 이해한다"처럼 보이게 쓰지 않는다(지원하는 상황·조건만 읽는 규칙 기반이다).

## 쿠팡 파트너스 API

- 판매자용(Wing) Open API 와 혼동하지 않는다. 구현은 공식 문서 대조 전이라 `COUPANG_REFRESH_ENABLED` 가 기본 꺼짐이다(README 체크리스트).
- 검색 호출 한도(공개 정리글 기준 시간당 10회)를 지킨다. 방문자 요청에서 쿠팡 API를 직접 호출하지 않는다.
- 403/429 가 오면 호출을 멈춘다(자동 재시도 금지). 호출 한도·차단 같은 시스템 쪽 실패는 상품의 실패로 기록하지 않는다. 상품이 실패하면 `refresh_failures` 가 늘고 6시간부터 최대 72시간까지 재시도를 늦춘다. 한도·차단 상태는 `coupang_api_calls` 테이블에 기록된다.

## DB 규칙

- 스키마 변경은 `supabase/migrations/` 파일로만 하고, 적용 전에 사람이 검토한다. 재실행해도 안전하게(idempotent) 쓴다.
- 모든 테이블은 RLS 를 켜고, 쓰기는 `SECURITY DEFINER` RPC 안에서 `auth.jwt()->>'email'` 로 확인한다(기존 방식). 조회=매니저, 저장=마스터.
- PL/pgSQL 에서 `RETURNS TABLE` 을 쓰면 컬럼명이 OUT 변수로 잡혀 `UPDATE ... SET col = ...`, `ON CONFLICT`, `WHERE col = ...` 가 모호해질 수 있다.
  이 경우 UPDATE/INSERT 대상 테이블에 **별칭**(`update public.t as t set ... where t.id = ...`)을 붙이고 컬럼은 항상 `t.` 로 한정한다.
  새 함수는 가능하면 `RETURNS TABLE` 대신 `RETURNS jsonb` / `RETURNS SETOF 테이블`을 쓴다(이번 마이그레이션이 그렇다).

## 작업 후 확인

```bash
node --test tests/*.test.mjs        # 반드시 통과
tools/db-test/run.sh                # 마이그레이션을 바꿨다면: 임시 Postgres 에서 두 마이그레이션 적용 + 단정 테스트
```
화면을 바꿨다면 `tools/e2e/README.md` 의 하네스 또는 Vercel Preview 에서 모바일·PC 를 직접 확인한다.

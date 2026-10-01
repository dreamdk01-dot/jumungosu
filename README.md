# 주문의고수 (jumungosu.com)

배달앱 할인 비교 + 상황별 쇼핑 추천. Vercel(정적 `app.html` + `api/` 서버리스 함수) + Supabase.

> 이 브랜치(`feature/situation-shopping`)는 쇼핑 페이지를 **"상황별 추천"** 으로 바꾼 작업입니다.
> 지금 어디까지 됐고 무엇이 검증되지 않았는지는 [HANDOFF.md](./HANDOFF.md), 작업 규칙은 [AGENTS.md](./AGENTS.md).

## 구조

```
app.html                    단일 페이지 앱(탭 라우팅). 모든 화면·클라이언트 JS가 여기 있음
situation-search.js         상황·예산·제외조건 해석 + 랭킹 (규칙 기반, 브라우저/테스트 공용 UMD)
api/
  home.js, seo.js, seo-shopping.js   SSR/SEO (app.html 을 읽어서 사용 — "건드리면 안 되는 것" 참고)
  discounts.js, sync-airtable.js     배달할인 데이터
  situation-products.js     승인·상품평 검토된 추천 상품 목록(읽기 전용, 공개)
  coupang-refresh.js        쿠팡 API 확인/가격 갱신(관리자 전용, 기본 꺼짐)
  _lib/                     서버 전용(Vercel 이 함수/정적 파일로 노출하지 않음)
    coupang-partners.js      쿠팡 파트너스 클라이언트(서명·검증·호출한도·응답매핑·정확일치)
    refresh.js               대상 선정(실패 이력·재시도 간격·보완 필요 제외) + 정확 일치 갱신
    supabase-rest.js         service_role REST 도우미 + 호출 기록 저장소
supabase/migrations/
  20261001000000_situation_products.sql    상품·호출기록 테이블, 관리자 RPC            (운영 DB 미적용)
  20261002000000_review_verification.sql   상품평 검토·돌잔치 구분·카테고리 기준·갱신 실패 추적 (운영 DB 미적용, 1번 다음에 적용)
tests/                      node:test 테스트
tools/
  db-test/                  임시 Postgres 로 마이그레이션 적용 + 권한·제약 단정 테스트
  e2e/                      브라우저 확인 하네스(선택)
  verify-coupang.mjs        키를 가진 사람이 실제 응답 구조를 확인하는 도구(검색 API 1회 호출)
vercel.json                 rewrites (수정 없음)
```

app.html 안의 새 코드 두 블록: `상황별 쇼핑 (2026-10)`, `관리자: 상황별 쇼핑 상품 검토`.

## 동작 방식

1. `/shopping` 에서 상황 버튼을 누르거나 문장을 입력한다(예: `친구 아이 돌잔치 선물, 5만원 이하`).
2. `situation-search.js` 가 상황·세부 선택(돌잔치: 참석 선물/답례품)·예산·제외조건을 **규칙으로** 읽는다. 외부 AI는 쓰지 않는다.
3. `/api/situation-products` 가 Supabase 에서 **승인 + 상품평 검토 기록이 있는** 상품만 내려준다.
4. 브라우저가 예산·제외조건을 먼저 적용하고 상황 적합도로 정렬해 최대 6개를 보여준다. 해석 결과는 칩으로 보이고 수정할 수 있다.
5. 승인 상품이 없으면 "준비 중"/"조건에 맞는 상품 없음". 예시 상품·가짜 리뷰로 채우지 않는다.

방문자 요청은 **쿠팡 API를 호출하지 않는다.** 확인/갱신은 관리자가 따로 실행한다.

## 상품 승인 조건 (DB 제약 + 서버 + 관리자 화면 모두에서 검사)

| 조건 | 설명 |
|---|---|
| 상황 1개 이상 · 추천 이유 · 제휴 링크 | 기존 조건 |
| **상품평 검토 기록** | 검토일 + 직접 읽은 상품평 수(1 이상) + 운영자가 직접 쓴 검토 근거(공백 제외 10자 이상). 비어 있으면 승인 불가 |
| **돌잔치 세부 구분** | `dol` 상황 상품은 `attend`(참석 선물)/`return`(답례품) 중 하나 이상 명시. 비어 있다고 양쪽에 노출하지 않음. 양쪽이면 둘 다 명시 |
| **카테고리 기준(선택)** | 운영자가 카테고리별 최소 평점·리뷰수를 정하면, 그 카테고리 상품은 기준 이상(+확인일)이어야 승인. **기본은 비어 있다**(임의 기준 없음) |

- DB 는 상품평을 실제로 읽었는지 알 수 없다. 기록은 운영자가 쓴 것이고, 시스템은 "기록이 비어 있으면 승인 불가"까지만 보장한다.
  검토 근거·상품평 요약을 시스템이 대신 만들어 넣지 않는다(입력란은 항상 비어 있는 채로 시작).
- 평점·리뷰수는 별개의 숫자 기록이다(확인일과 함께만 저장·표시). 카테고리 기준은 운영 내부 기준이며 방문자 화면에서 "검증된 기준"으로 소개하지 않는다.
- 방문자 카드에는 "운영자가 상품평을 직접 읽고 확인 · M/D" 한 줄만 나온다. 읽은 수·근거·상품평 내용은 공개하지 않는다.

## 관리자 화면 (관리자 페이지 > "상황별 쇼핑 상품 검토")

- 조회: 매니저 3명 / 저장·승인·기준 변경·갱신: 마스터(`jumungosu@gmail.com`) 1명 — DB RPC 가 같은 기준으로 한 번 더 막는다.
- 상황별 승인 상품 수(3개 미만이면 "부족"), 최근 30일 상황 선택·결과 없음·상품 클릭.
- 목록 표시: 상품평 미검토 / **보완 필요(쿠팡 상품·옵션 식별자 없음 → 가격 갱신 불가)** / 돌잔치 구분 필요 / 가격 확인 실패 횟수(품절 아님).
- 기존 쇼핑핫딜(`AUTUMN_GIFT_PRODUCTS`)에서 이름·링크만 불러오기(가격·평점·검토 기록은 비워 둠).

## 공개 스위치 `SITUATION_SHOPPING_PUBLIC`

`app.html` 안의 **JavaScript 상수**입니다(`const SITUATION_SHOPPING_PUBLIC = false;`). **Vercel 환경변수가 아니라서** 대시보드에서 바꿀 수 없고,
값을 바꾸려면 `app.html` 을 수정 → 커밋 → 배포해야 합니다(서버 설정 없이 즉시 켜고 끄는 방법 없음).

- `false`(기본): 상단 "쇼핑" 메뉴는 기존대로 쇼핑핫딜(`/hot-deals`)로 간다. 새 화면은 `/shopping` 주소로만 접근.
- `true`: "쇼핑" 메뉴가 `/shopping` 으로 바뀌고 핫딜 페이지에 "상황별로 추천 받기" 링크가 생긴다.
- 승인 상품이 상황마다 충분히 쌓인 뒤에 바꾸는 것을 권장.

## 실행 / 테스트

Node 22 이상. 별도 의존성 없음.

```bash
node --test tests/*.test.mjs     # 단위·회귀 (102개, 그중 DB 연동 1개는 RUN_DB_TESTS=1 일 때만 실행)
tools/db-test/run.sh             # 임시 Postgres(16)에서 두 마이그레이션 적용 + DB 단정 테스트 (postgresql 필요)
RUN_DB_TESTS=1 node --test tests/*.test.mjs   # 위 DB 테스트를 node 테스트에 포함해서 실행
```

| 파일 | 내용 |
|---|---|
| `situation-search.test.mjs` | 동의어, 오인 방지, 참석/답례 구분(명시한 상품만), 상품평 검토 없는 상품 제외, 예산·제외조건, 랭킹 |
| `coupang-partners.test.mjs` | 서명, 검증, 응답 매핑, 정확 일치, 호출 한도, 캐시, 검색 경로 선택, **갱신 대상 선정(실패 상품 반복 선택 방지·재시도 간격·옵션 없는 상품 사전 제외)**, 검증 도구 |
| `handlers.test.mjs` | `/api/situation-products`(검토 기록 없는 행·구분 없는 돌잔치 행 제외), `/api/coupang-refresh`(권한·dry-run·보완 필요·실패 기록·시스템 오류 비기록) |
| `regression.test.mjs` | 기존 기능 보존, 새 화면, 관리자 검증 문구, 문서 정확성(공개 스위치 설명 등) |
| `tools/db-test` | DB: 상품평 없이 승인 불가, 돌잔치 구분 필수, 카테고리 기준, 권한(매니저/마스터/일반/anon), 헬퍼 함수 직접 호출 불가, 기존 승인 행 정리 |

브라우저 확인(`tools/e2e`, 모바일 390px·데스크톱 1280px, 174개 항목): 외부 CDN·Supabase 는 스텁이라 **실제 연결에서의 확인을 대신하지 못한다.**

## 배포 순서

1. 브랜치를 올려 Vercel Preview 를 만든다(현재 연결된 Vercel 계정에는 이 사이트 프로젝트가 없다 — HANDOFF 참고).
2. **SQL 검토 후** Supabase 에 마이그레이션 두 개를 순서대로 적용(여러 번 실행해도 안전). 적용 전에는 `/api/situation-products` 가 503(`table_missing`)을 돌려주고
   화면은 "상황별 추천을 준비하고 있어요"로 안내한다(깨지지 않음). 되돌리는 SQL 은 각 파일 맨 아래 주석.
3. Vercel 환경변수: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`(기존), `ADMIN_EMAILS` 및 쿠팡 관련 변수는 `.env.example` 참고. **Preview/Production 각각** Settings > Environment Variables 에 등록.
4. 마스터 계정으로 상품을 등록하고 상품평을 직접 읽은 뒤 승인한다.
5. 상황마다 충분하면 `app.html` 의 `SITUATION_SHOPPING_PUBLIC` 을 `true` 로 바꿔 배포.

## 쿠팡 파트너스 API — 검증 상태

세 가지를 구분합니다. **현재는 "공식 문서 확인"과 "실제 호출 성공"이 모두 없습니다.**

| 항목 | 공식 문서 확인 | 실제 호출 성공 | 모의 테스트 | 비고 |
|---|---|---|---|---|
| 인증(HMAC CEA 서명) | ❌ | ❌ | ✅ | 제3자 SDK·글 다수가 같은 방식을 설명 |
| 검색 경로 | ❌ | ❌ | ✅(두 형태 모두 서명 확인) | **자료마다 다름**: `/openapi/products/search` vs `/openapi/v1/products/search`. 환경변수 `COUPANG_PARTNERS_SEARCH_PATH` 로 선택 |
| 호출 한도 | ❌ | ❌ | ✅(예산·차단 동작) | **자료마다 다름**: 시간당 10회(여러 실측 글: 초과 시 403·24시간 차단, 반복 시 계정 제한) vs 분당 50회("공식 문서"라고 인용한 글) vs 분당 100회. 가장 보수적인 값(시간당 10회 → 구현은 8회)을 따른다 |
| 응답 필드(`rCode`, `productData[]`, `productId/productName/productPrice/productImage/productUrl`…) | ❌ | ❌ | ✅ | 일부만 SDK 설명에서 확인 |
| **상품·옵션 식별자(itemId/vendorItemId)가 응답에 있는가** | ❌ | ❌ | ✅(없으면 갱신 거절) | 상품 URL 에 들어 있는지 **미확인**. 없으면 정확한 옵션 가격을 검증할 수 없다 → 가격 저장 금지 |
| 검색 결과의 가격이 어느 옵션의 가격인가 | ❌ | ❌ | — | 확인 불가 → 기본은 "확인만"(가격 저장 안 함) |
| 가격 필터 파라미터 | — | — | — | 한 실측 글: 검색 API 는 가격 필터를 지원하지 않음(우리는 쓰지 않음) |
| 평점·리뷰수·**리뷰 원문**·품절 여부 | ❌ | ❌ | — | **API 가 준다고 가정하지 않음.** 운영자가 직접 확인·입력 |
| 가격·이미지 저장·표시 허용 조건(약관) | ❌ | — | — | 미확인 |

### 실제 확인 절차 (키를 가진 분이 하는 일)

1. 파트너스 포털의 공식 문서에서 위 표의 ❌ 항목(경로·한도·응답 필드·이용 조건)을 확인한다.
2. **키는 채팅에 붙여넣지 말고** 본인 터미널의 환경변수로만 둔다.
   ```bash
   export COUPANG_PARTNERS_ACCESS_KEY=...   # 값은 터미널에서만 입력
   export COUPANG_PARTNERS_SECRET_KEY=...
   node tools/verify-coupang.mjs --keyword "수건 세트" --confirm          # 기본 경로, 검색 API 1회 호출
   node tools/verify-coupang.mjs --keyword "수건 세트" --confirm --v1     # 403/404 가 나면 v1 경로로(한도 소모 주의)
   ```
   출력은 **구조뿐**(필드 이름·값 종류·URL 형태·옵션 식별자 유무)이고 키·서명·제휴 태그 값은 나오지 않는다. 호출은 1회뿐이다.
3. 결과로 판단: 인증·경로가 맞는지 / 응답에 상품·옵션 식별자가 있는지 / 한도 응답이 가정과 맞는지.
4. Vercel(Preview 먼저)에 키와 `COUPANG_REFRESH_ENABLED=true` 를 등록하면 **"확인만"** 모드가 켜진다: 관리자 화면에서 상품 1~2개로 실행 → 응답 가격과 저장된 가격을 사람이 비교.
5. 같은 옵션의 가격임이 확인될 때만 `COUPANG_PRICE_REFRESH_ENABLED=true`. 확인되지 않으면 켜지 않는다(가격은 운영자가 직접 확인해 입력).

쿠팡이 403/429 를 주면 서버가 24시간 호출을 멈춘다(`coupang_api_calls` 의 `blocked` 행). 이 경우 상품은 실패로 기록되지 않는다.

## 건드리면 안 되는 것

- `app.html` 의 `AUTUMN_GIFT_PRODUCTS` 배열 형식: `api/seo-shopping.js` 가 정규식으로 읽는다(회귀 테스트가 해시로 지킨다).
- `api/home.js` 가 `app.html` 의 특정 마크업 문자열을 찾아 치환한다(홈 화면 마크업 변경 주의).
- 기존 `partner_click` 이벤트와 `hotdealsAffiliateDisclosureHtml()` 의 쿠팡 파트너스 고지.

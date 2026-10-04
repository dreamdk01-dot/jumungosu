# 실제 캐시 데이터 검증 (다중 카테고리 브랜드)

`tests/fixtures/real-cache-2026-10-03.json` 은 운영 캐시(`cached_airtable_records`)에서 뽑은 **실제 레코드**(오늘 유효 130행, 원래 순서)입니다.
샘플이 아니라 이 데이터로 운영 코드(`api/seo.js`, `app.html`)를 그대로 실행해 확인합니다. 날짜는 2026-10-03(한국시간 정오)로 고정합니다.

```bash
node --test tests/*.test.mjs                       # SEO 페이지: 브랜드 순위·제목·링크·푸터·맘스터치 양쪽·중복 방지·전체 페이지 대조
CHROMIUM_PATH=/path/to/chrome python3 tools/verify-real-cache/home_real.py   # 홈 필터 전수 비교 + /?category= 딥링크 (PC·모바일)
```

- `home_real.py` 는 외부 CDN·Supabase 를 가로채기로 대체한다(실제 연결 확인이 아님). `pip install playwright` 필요.
- 비교 기준(수정 전 `seo.js`)은 저장소에 두지 않는다. 테스트가 `git show main:api/seo.js` 로 꺼내 쓰고(`SEO_BASELINE_REF`/`SEO_BASELINE` 로 지정 가능), 없으면 해당 테스트만 건너뛴다.
- 데이터가 바뀌면(브랜드·금액·기간) 기대값은 테스트 안에서 픽스처로 다시 계산하므로 픽스처만 새로 뽑아 바꾸면 된다.

## 배포 제외
`tests/`, `tools/` 는 검증용이라 서비스 배포물에 포함하지 않는다(루트 파일은 정적으로 서빙되기 때문).
- `.vercelignore` 로 제외(루트 기준 `/tests`, `/tools`)
- `vercel.json` 의 `redirects` 로 `/tests…`, `/tools…` 주소를 홈으로 보낸다(리다이렉트는 정적 파일보다 먼저 평가됨)
Preview 에서 `/tests/fixtures/real-cache-2026-10-03.json` 을 열었을 때 JSON 이 아니라 홈으로 이동하면 정상이다.

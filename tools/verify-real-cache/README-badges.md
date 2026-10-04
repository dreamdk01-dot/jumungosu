# 대표이미지(이니셜) 자동 표시 검증

`tests/fixtures/real-brand-badges-2026-10-03.json` 은 운영 캐시(`cached_airtable_records`)에서 뽑은 **실제 (브랜드명, 대표이미지) 162쌍**이다.
집계(2026-10-03 조회): 브랜드명이 있는 행 전체는 163행(대표이미지 입력 92·누락 71)이고, 그중 금액이 0 초과이며 10/3 기준 만료되지 않은 행이 162행(입력 91·누락 71)이다. 픽스처는 이 162행이며, 빠진 1행은 '두찜 (브랜드데이)'(종료 10/2, 대표이미지 입력됨)이다.

```bash
node --test tests/*.test.mjs        # 규칙 표(브라우저·서버 구현), 두 구현 코드 동일성, 실제 데이터 무변화, 서버 렌더링 끝까지
# 브라우저 검증(PC·모바일): 실제 데이터 + 엣지 케이스, 수정 전 코드와 비교, 칸 크기·넘침 검사
TW_CSS=/path/tw.css CHROMIUM_PATH=/path/chrome python3 tools/verify-real-cache/badges_real.py [--baseline 수정전_app.html] [--shots 폴더]
```

- `TW_CSS` 는 `app.html` 을 대상으로 로컬에서 빌드한 Tailwind(v3) CSS 다(CDN 대신). 없으면 칸 크기·넘침 검사만 건너뛴다.
- `--baseline` 을 주지 않으면 `git show main:app.html` 을 수정 전 기준으로 쓴다.
- 외부 CDN·Supabase 는 가로채기로 대체한다(실제 연결 확인이 아님). 엣지 케이스는 브랜드명에 '테스트' 등을 붙인 시험용 레코드다.

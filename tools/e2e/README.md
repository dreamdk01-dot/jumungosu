# 브라우저 확인 하네스 (선택)

운영 코드가 아니라, 새 화면을 실제 Chromium 으로 열어 확인하는 도구입니다. `node --test` 와 별개이고 필수가 아닙니다.

필요: Node 22, Python 3 + `pip install playwright` + 브라우저(`playwright install chromium`, 이미 있으면 `CHROMIUM_PATH=/path/to/chrome`).

```bash
tools/e2e/build-css.sh                         # Tailwind CSS 를 tools/e2e/tw.css 로 생성
node tools/e2e/server.mjs &                    # http://localhost:5601 (정적 파일 + 모의 API)
python3 tools/e2e/run.py                       # 스크린샷은 tools/e2e/shots/
```

- 외부 CDN(Tailwind, supabase-js, emailjs, GA)은 브라우저 요청 가로채기로 대체한다. supabase 클라이언트는 호출을 기록하는 스텁이다.
  → **실제 Supabase·실제 Tailwind CDN·실제 기기에서의 확인을 대신하지 못한다.** Vercel Preview 에서 한 번 더 확인할 것.
- 픽스처 상품은 모두 `[테스트]` 접두사의 가짜 데이터이며 이 도구 안에만 있다(운영 코드/DB 에는 없음).
- 확인 항목: 첫 화면, 버튼/문장 검색, 예산·카테고리·제외 보조필터, 돌잔치 참석/답례 선택, 빈 결과 2종, 해석 불가, API 실패(502)·미설정(503)·느린 응답,
  승인 상품 0개, 추적 이벤트와 "입력 원문 미전송", URL 복원, 기존 핫딜/홈/`/shopping/chuseok`/핫딜 클릭 추적, 관리자 패널(마스터/매니저/방문자), 공개 플래그 ON.

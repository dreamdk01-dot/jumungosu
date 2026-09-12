// /event, /event/ 요청에 실제 HTTP 410 Gone을 반환하는 전용 엔드포인트.
// 이벤트 이용자가 적어 공개 이벤트 페이지를 당분간 운영하지 않기로 하여,
// 검색엔진이 재크롤링 시 "영구적으로 사라진 페이지"로 정확히 인식하도록 410을 명시한다.
// (200 + JS 리다이렉트로는 검색엔진이 제거를 정확히 인식하지 못할 수 있어 서버 상태 코드로 직접 처리)
//
// 재활성화 방법: vercel.json에서 /event, /event/ 를 이 함수로 보내는 rewrite 2줄만 지우면
// 기존 catch-all(app.html)로 다시 흐르게 되어 즉시 원상 복구된다. 이벤트 관리자 기능/Supabase
// 데이터/이벤트 관련 RPC는 이 파일과 전혀 무관하므로 그대로 유지된다.
export default function handler(req, res) {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<title>페이지를 찾을 수 없습니다 | 주문의고수</title>
</head>
<body>
<p>현재 운영하지 않는 페이지입니다.</p>
<p><a href="https://www.jumungosu.com/">주문의고수 홈으로 이동</a></p>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=86400');
  return res.status(410).end(html);
}

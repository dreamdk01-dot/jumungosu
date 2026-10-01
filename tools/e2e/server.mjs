// 로컬 확인용 서버(운영 코드 아님): Vercel 의 rewrite(정적 파일 우선 → 나머지는 app.html)를 흉내내고,
// /api/situation-products 는 시나리오(ok|empty|error|unavailable|slow)로 모의한다. 픽스처 상품은 전부 "[테스트]" 이름의 가짜 데이터다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.SITE_ROOT || path.resolve(HERE, '..', '..');          // 저장소 루트
const TW_CSS = process.env.TW_CSS || path.join(HERE, 'tw.css');                // build-css.sh 가 만든다
let scenario = 'ok';
const T = '[테스트] ';
const approved = (o) => Object.assign({ category: '생활', price: 30000, priceCheckedAt: '2026-09-30T01:00:00Z', imageUrl: null, affiliateUrl: 'https://link.coupang.com/a/TEST', situations: [], subtypes: [], recipients: [], excludeTags: [], reason: '', caution: '', rating: null, reviewCount: null, reviewCheckedAt: null, reviewedAt: '2026-09-30T02:00:00Z', reviewVerifiedAt: '2026-09-29', reviewState: 'approved' }, o);
const FIXTURE = [
  approved({ id: '00000000-0000-0000-0000-00000000a001', name: T + '수건 세트', price: 19800, category: '생활', situations: ['housewarming'], reason: '받는 사람이 취향을 안 타고 바로 쓸 수 있어요', caution: '색상 옵션을 확인하세요', rating: 4.5, reviewCount: 864, reviewCheckedAt: '2026-09-30', imageUrl: 'https://img.example/a.png' }),
  approved({ id: '00000000-0000-0000-0000-00000000a002', name: T + '핸드블렌더', price: 57500, category: '주방', situations: ['housewarming', 'solo'], reason: '요리를 시작하는 집에 쓸모가 많아요', caution: '전압(220V)을 확인하세요' }),
  approved({ id: '00000000-0000-0000-0000-00000000a003', name: T + '와인 선물 세트', price: 42000, category: '식품', situations: ['housewarming'], excludeTags: ['alcohol'], reason: '집들이 자리에서 바로 나눌 수 있어요' }),
  approved({ id: '00000000-0000-0000-0000-00000000a004', name: T + '디퓨저', price: 33000, category: '생활', situations: ['housewarming'], excludeTags: ['scented'], reason: '분위기를 바꿔줘요', caution: '향 취향이 갈려요' }),
  approved({ id: '00000000-0000-0000-0000-00000000a005', name: T + '가격 미확인 상품', price: null, priceCheckedAt: null, category: '식품', situations: ['housewarming'], reason: '가격을 아직 확인하지 않은 상품' }),
  approved({ id: '00000000-0000-0000-0000-00000000a006', name: T + '고가 주방 세트', price: 129000, category: '주방', situations: ['housewarming'], reason: '예산이 넉넉할 때 좋아요' }),
  approved({ id: '00000000-0000-0000-0000-00000000a007', name: T + '추가 상품 7', price: 25000, category: '생활', situations: ['housewarming'], reason: '여섯 개 제한 확인용' }),
  approved({ id: '00000000-0000-0000-0000-00000000b001', name: T + '돌 참석 선물 A', price: 20000, category: '아기용품', situations: ['dol'], subtypes: ['attend'], recipients: ['baby'], reason: '아이가 바로 쓸 수 있어요', caution: '개월 수 확인' }),
  approved({ id: '00000000-0000-0000-0000-00000000b002', name: T + '돌 참석 선물 B', price: 35000, category: '아기용품', situations: ['dol'], subtypes: ['attend'], reason: '부모님도 좋아해요' }),
  approved({ id: '00000000-0000-0000-0000-00000000b003', name: T + '돌 참석 선물 C', price: 60000, category: '도서', situations: ['dol'], subtypes: ['attend'], reason: '오래 두고 볼 수 있어요' }),
  approved({ id: '00000000-0000-0000-0000-00000000b004', name: T + '돌 답례품 A', price: 12000, category: '식품', situations: ['dol'], subtypes: ['return'], reason: '손님께 나눠 드리기 좋아요' }),
  approved({ id: '00000000-0000-0000-0000-00000000b005', name: T + '돌 공통 상품', price: 15000, category: '식품', situations: ['dol'], subtypes: ['attend', 'return'], reason: '양쪽에 모두 어울려요' }),
  // 아래 둘은 서버가 거르지만(실제로는 내려오지 않음), 화면 쪽 2차 방어가 동작하는지 보려고 일부러 섞어 둔다.
  approved({ id: '00000000-0000-0000-0000-00000000b006', name: T + '돌 구분 없음(노출되면 안 됨)', price: 10000, category: '식품', situations: ['dol'], subtypes: [], reason: '구분을 안 적은 상품' }),
  approved({ id: '00000000-0000-0000-0000-00000000a008', name: T + '상품평 미검토(노출되면 안 됨)', price: 10000, category: '생활', situations: ['housewarming'], reviewVerifiedAt: null, reason: '검토 기록이 없는 상품' }),
  approved({ id: '00000000-0000-0000-0000-00000000c001', name: T + '환절기 상품', price: 18000, category: '건강', situations: ['season'], reason: '일교차 대비' }),
];
const mime = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.xml': 'application/xml', '.txt': 'text/plain' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__scenario') { scenario = u.searchParams.get('name') || 'ok'; res.end('ok ' + scenario); return; }
  if (u.pathname === '/api/situation-products') {
    res.setHeader('Content-Type', 'application/json');
    if (scenario === 'error') { res.statusCode = 502; res.end('{"error":"upstream_error"}'); return; }
    if (scenario === 'unavailable') { res.statusCode = 503; res.end('{"error":"table_missing"}'); return; }
    if (scenario === 'slow') { setTimeout(() => res.end(JSON.stringify({ products: FIXTURE })), 600); return; }
    res.end(JSON.stringify({ products: scenario === 'empty' ? [] : FIXTURE })); return;
  }
  if (u.pathname.startsWith('/api/')) { res.statusCode = 500; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"mock"}'); return; }
  let file = null;
  if (u.pathname === '/tw.css') file = TW_CSS;
  else { const f = path.join(ROOT, u.pathname); if (f.startsWith(ROOT) && fs.existsSync(f) && fs.statSync(f).isFile() && u.pathname !== '/') file = f; }
  if (!file) file = path.join(ROOT, 'app.html');
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(5601, () => console.log('listening 5601'));

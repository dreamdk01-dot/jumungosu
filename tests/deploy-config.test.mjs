// 배포 설정 검증: tests/ 와 tools/ (검증용 테스트·도구·픽스처)가 서비스 배포물로 서빙되지 않게 막는 설정.
// 이 프로젝트는 루트 파일을 정적으로 서빙한다. 막는 방법은 두 겹이다.
//   1) .vercelignore : 배포물에서 제외(Vercel 문서상 CLI 배포 기준이 확실하고, Git 연동에서는 문서가 분명하지 않다)
//   2) vercel.json redirects : 리다이렉트는 정적 파일보다 먼저 평가되므로, 파일이 남아 있어도 /tests, /tools 주소는 홈으로 보낸다
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT } from './helpers/seo-render.mjs';

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

test('vercel.json: /tests, /tools 하위 주소를 홈으로 보내는 리다이렉트가 있다(임시 리다이렉트)', () => {
  assert.equal(vercel.redirects.length, 1);
  const r = vercel.redirects[0];
  assert.equal(r.source, '/(tests|tools)(/.*)?');
  assert.equal(r.destination, '/');
  assert.equal(r.permanent, false);
});

test('리다이렉트 패턴은 /tests, /tools 와 그 하위만 잡고 서비스 경로는 건드리지 않는다', () => {
  const re = new RegExp('^' + vercel.redirects[0].source + '$');   // 이 패턴은 path-to-regexp 와 정규식에서 같은 뜻
  for (const p of ['/tests', '/tests/', '/tests/fixtures/real-cache-2026-10-03.json', '/tools/verify-real-cache/home_real.py', '/tools/e2e/run.py']) assert.ok(re.test(p), p);
  for (const p of ['/', '/testsuite', '/toolsbox/x', '/api/seo', '/api/home', '/api/situation-products', '/today-chicken-discount', '/momstouch-discount', '/hot-deals', '/shopping', '/board', '/sitemap.xml', '/robots.txt', '/favicon.png', '/og-image.png']) assert.ok(!re.test(p), p);
});

test('.vercelignore: 루트 기준 /tests, /tools 만 제외한다(하위 폴더의 같은 이름·다른 파일은 건드리지 않음)', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(lines, ['/tests', '/tools']);
});

test('기존 라우팅(rewrites)·함수 설정(functions)은 수정 전과 같다', { skip: !(() => { try { execFileSync('git', ['show', 'main:vercel.json'], { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; } })() && 'git main 기준 없음' }, () => {
  const base = JSON.parse(execFileSync('git', ['show', `${process.env.SEO_BASELINE_REF || 'main'}:vercel.json`], { cwd: ROOT, encoding: 'utf8' }));
  assert.deepEqual(vercel.rewrites, base.rewrites);
  assert.deepEqual(vercel.functions, base.functions);
});

test('서비스에 쓰이는 파일(app.html, api/, 정적 자산)은 /tests, /tools 안에 있지 않다', () => {
  const must = ['app.html', 'api/seo.js', 'api/home.js', 'api/discounts.js', 'sitemap.xml', 'robots.txt'];
  for (const f of must) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  for (const f of must) assert.ok(!/^(tests|tools)\//.test(f));
  // vercel.json 의 includeFiles 대상도 루트 파일
  for (const fn of Object.values(vercel.functions)) assert.ok(!/^(tests|tools)\//.test(fn.includeFiles || ''));
});

#!/usr/bin/env node
// Vercel 이 실제로 쓰는 빌더(@vercel/node)로 api/*.js 를 빌드해서, (1) 어떤 파일이 번들에 들어가는지 (2) 변환된 결과가 로드되는지
// (3) require(esm) 이 꺼진 런타임에서도 로드되는지 (4) 함수가 크래시 대신 JSON 을 돌려주는지 확인한다. 배포하지 않고 로컬에서만 돈다.
//   사용: npm i --prefix /tmp/vn @vercel/node @vercel/build-utils && VN_DIR=/tmp/vn node tools/vercel-bundle-check.mjs
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.VN_DIR || '/tmp/vn', 'x.js'));
const { build } = require('@vercel/node'); const { glob } = require('@vercel/build-utils');

const CHECKS = {
  'api/situation-products.js': { env: { SUPABASE_URL: '', SUPABASE_SERVICE_ROLE_KEY: '' }, req: { method: 'GET', headers: {} }, expect: [503, 'not_configured'] },
  'api/coupang-refresh.js': { env: { COUPANG_REFRESH_ENABLED: '' }, req: { method: 'POST', headers: {} }, expect: [503, 'refresh_disabled'] },
  'api/seo-shopping.js': { loadOnly: true }, 'api/discounts.js': { loadOnly: true },
};
const files = await glob('**', { cwd: ROOT, ignore: ['**/node_modules/**', '.git/**', 'tests/**', 'tools/**'] });
let failed = 0;
for (const [entry, c] of Object.entries(CHECKS)) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-'));
  const log = console.warn; console.warn = () => {}; const logi = console.log; console.log = () => {};
  let lambda; try { lambda = (await build({ files, entrypoint: entry, workPath: ROOT, repoRootPath: ROOT, config: { nodeVersion: '24.x' }, meta: { isDev: false, skipDownload: true } })).output; } finally { console.warn = log; console.log = logi; }
  const names = Object.keys(lambda.files).filter((n) => !n.includes('node_modules') && !n.endsWith('.map'));
  for (const n of Object.keys(lambda.files)) { if (n.includes('node_modules')) continue; const f = lambda.files[n]; const d = path.join(out, n); fs.mkdirSync(path.dirname(d), { recursive: true }); if (f.fsPath) fs.copyFileSync(f.fsPath, d); else if (f.data != null) fs.writeFileSync(d, f.data); }
  const mjs = names.filter((n) => n.endsWith('.mjs'));
  const runner = `const m=require('./${entry}');if(!m.default){process.exit(3)}
${c.loadOnly ? 'console.log("loaded")' : `Object.assign(process.env, ${JSON.stringify(c.env)});const r={code:200,body:null,setHeader(){},status(x){r.code=x;return r},json(b){r.body=b;return r}};
m.default(${JSON.stringify(c.req)}, r).then(()=>console.log(JSON.stringify([r.code, r.body && r.body.error])))`}`;
  fs.writeFileSync(path.join(out, 'run.cjs'), runner);
  for (const flag of [[], ['--no-experimental-require-module']]) {
    const r = spawnSync(process.execPath, [...flag, 'run.cjs'], { cwd: out, encoding: 'utf8' });
    const last = (r.stdout || '').trim().split('\n').pop();
    const ok = r.status === 0 && (c.loadOnly ? last === 'loaded' : last === JSON.stringify(c.expect));
    if (!ok) failed++;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${entry} [${flag.length ? 'require(esm) 꺼짐' : '기본'}] 번들 ${names.length}개${mjs.length ? ' (.mjs 포함: ' + mjs.join(',') + ')' : ''} → ${ok ? last : (r.stderr || last).split('\n').filter((l) => /Error/.test(l))[0] || last}`);
  }
}
process.exit(failed ? 1 : 0);

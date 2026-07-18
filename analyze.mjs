// Analisis HTTP capture. Pakai: node analyze.mjs <file.ndjson> [file2 ...]
import fs from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) { console.error('Usage: node analyze.mjs <http-*.ndjson> [...]'); process.exit(1); }

const posts = [];
const endpoints = new Map(); // "METHOD path" -> status
const pages = new Set();

for (const f of files) {
  let lines;
  try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { continue; }
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    const u = o.url || '';
    if (!u.includes('slendro-ai.com')) continue;
    if (/cdn-cgi\/rum/.test(u)) continue;
    if (/^data:/.test(u)) continue;
    const pathOnly = u.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const method = o.method || 'GET';
    endpoints.set(`${method} ${pathOnly}`, o.status);

    if (method !== 'GET') {
      posts.push({
        method, path: pathOnly, status: o.status,
        reqType: o.requestContentType || '',
        reqBody: o.requestBody || '',
        respBody: typeof o.body === 'string' ? o.body.slice(0, 350) : '',
      });
    }
    if (/html/.test(o.contentType || '')) pages.add(`[${o.status}] ${pathOnly}`);
  }
}

console.log('===== REQUEST NON-GET (cara buat konten) =====');
if (!posts.length) console.log('(tidak ada)');
for (const p of posts) {
  console.log(`\n${p.method} [${p.status}] ${p.path}`);
  if (p.reqType) console.log('  req-type:', p.reqType);
  if (p.reqBody) console.log('  >> REQUEST:', p.reqBody);
  if (p.respBody) console.log('  << RESPONSE:', p.respBody);
}

console.log('\n===== SEMUA ENDPOINT slendro-ai.com =====');
[...endpoints.entries()].sort().forEach(([k, v]) => console.log(`  [${v}] ${k}`));

console.log('\n===== HALAMAN HTML =====');
[...pages].sort().forEach(c => console.log(' ', c));

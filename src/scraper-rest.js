// Generic REST polling scraper.
//
// Untuk game/web yang pakai REST API biasa (token Bearer) tanpa Colyseus/SIWS,
// misalnya Realm Rumble (playrealmrumble.com). Flow:
//   1. Auth (mis. POST /api/auth/demo) -> ambil token
//   2. Fetch semua snapshotEndpoints sekali -> simpan ke <safe>.json
//   3. Expand: ambil list (mis. /api/empires) lalu fetch detail per-id (dibatasi)
//   4. Poll: GET pollEndpoints berkala, append snapshot ke poll-<ts>.ndjson
//      sampai Ctrl+C atau pollDurationMs tercapai
//
// Semua perilaku dikontrol lewat site.rest di src/sites.js, jadi tambah site
// REST baru cukup dengan menambah entry config (tanpa ubah kode ini).

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function safeName(p) {
  return (
    String(p)
      .replace(/^\/+/, '')
      .replace(/[^a-z0-9]+/gi, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '') || 'root'
  );
}

// Ambil nilai bersarang dari objek pakai path "a.b.c"
function dig(obj, dotted) {
  if (!dotted) return obj;
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export async function scrapeRest(site, dumpDir, { log = console.log } = {}) {
  const cfg = site.rest || {};
  const BASE = site.apiBase;
  fs.mkdirSync(dumpDir, { recursive: true });

  const baseHeaders = {
    'user-agent': UA,
    accept: 'application/json',
    origin: site.webBase,
    referer: `${site.webBase}/`,
  };

  async function req(method, p, { body, token } = {}) {
    const headers = { ...baseHeaders };
    if (body) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(BASE + p, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, ok: res.ok, body: parsed };
  }

  // ---------- 1. Auth ----------
  let token = null;
  if (cfg.auth) {
    const a = cfg.auth;
    try {
      const r = await req(a.method || 'POST', a.path, { body: a.body });
      token = dig(r.body, a.tokenField || 'token') || null;
      fs.writeFileSync(
        path.join(dumpDir, 'auth.json'),
        JSON.stringify(r.body, null, 2)
      );
      if (token) {
        fs.writeFileSync(path.join(dumpDir, 'token.txt'), token);
        log(`[${r.status}] ${a.path} -> token OK`);
      } else {
        log(`[${r.status}] ${a.path} -> tidak ada token (lanjut anonim)`);
      }
    } catch (e) {
      log(`auth gagal: ${e.message} (lanjut anonim)`);
    }
  }

  // ---------- 2. Snapshot endpoints ----------
  const captured = {};
  for (const p of cfg.snapshotEndpoints || []) {
    try {
      const r = await req('GET', p, { token });
      fs.writeFileSync(
        path.join(dumpDir, safeName(p) + '.json'),
        JSON.stringify(r.body, null, 2)
      );
      captured[p] = r.body;
      const size = Array.isArray(r.body)
        ? `[${r.body.length}]`
        : r.body && typeof r.body === 'object'
        ? `{${Object.keys(r.body).length}}`
        : '';
      log(`[${r.status}] GET ${p} ${size}`);
    } catch (e) {
      log(`error GET ${p}: ${e.message}`);
    }
    await sleep(cfg.requestDelayMs ?? 80);
  }

  // ---------- 3. Expand detail per-id ----------
  for (const ex of cfg.expand || []) {
    let src = captured[ex.listPath];
    if (src === undefined) {
      try { src = (await req('GET', ex.listPath, { token })).body; } catch {}
    }
    let arr = ex.arrayField ? dig(src, ex.arrayField) : src;
    if (!Array.isArray(arr)) {
      log(`expand ${ex.detail}: list ${ex.listPath} bukan array, skip`);
      continue;
    }
    const idField = ex.idField || 'id';
    const ids = arr
      .map((it) => (it && typeof it === 'object' ? it[idField] : it))
      .filter((v) => v != null)
      .slice(0, ex.limit || 20);
    const outDir = path.join(dumpDir, ex.outDir || safeName(ex.detail));
    fs.mkdirSync(outDir, { recursive: true });
    log(`expand ${ex.detail}: ${ids.length} item -> ${path.relative(dumpDir, outDir)}/`);
    for (const id of ids) {
      const p = ex.detail.replace('{id}', encodeURIComponent(String(id)));
      try {
        const r = await req('GET', p, { token });
        fs.writeFileSync(
          path.join(outDir, safeName(String(id)) + '.json'),
          JSON.stringify(r.body, null, 2)
        );
      } catch (e) {
        log(`  error ${p}: ${e.message}`);
      }
      await sleep(ex.delayMs ?? 60);
    }
  }

  // ---------- 4. Poll loop ----------
  const pollEndpoints = cfg.pollEndpoints || [];
  if (pollEndpoints.length) {
    const interval = cfg.pollIntervalMs || 10_000;
    const durationMs = cfg.pollDurationMs ?? 0; // 0 = sampai Ctrl+C
    const stamp = new Date().toISOString().replace(/[:.]/g, '_');
    const pollLog = fs.createWriteStream(
      path.join(dumpDir, `poll-${stamp}.ndjson`)
    );

    let stop = false;
    const onSig = () => { stop = true; };
    process.on('SIGINT', onSig);

    const started = Date.now();
    log(
      `Polling ${pollEndpoints.length} endpoint tiap ${interval}ms` +
        (durationMs ? ` selama ${durationMs}ms` : ' (Ctrl+C untuk berhenti)') +
        '...'
    );

    let rounds = 0;
    while (!stop) {
      rounds++;
      for (const p of pollEndpoints) {
        try {
          const r = await req('GET', p, { token });
          pollLog.write(
            JSON.stringify({ t: Date.now(), path: p, status: r.status, body: r.body }) + '\n'
          );
        } catch (e) {
          pollLog.write(
            JSON.stringify({ t: Date.now(), path: p, error: e.message }) + '\n'
          );
        }
        if (stop) break;
      }
      if (rounds % 10 === 0) log(`poll rounds: ${rounds}`);
      if (durationMs && Date.now() - started >= durationMs) break;
      // tunggu interval tapi tetap responsif terhadap stop
      for (let w = 0; w < interval && !stop; w += 200) await sleep(200);
    }

    process.removeListener('SIGINT', onSig);
    pollLog.end();
    log(`poll selesai (${rounds} rounds) -> poll-${stamp}.ndjson`);
  }

  log(`[${site.name}] REST scrape selesai -> ${dumpDir}`);
}

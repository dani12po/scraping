// Colyseus client scraper
//
// Pakai library resmi colyseus.js sebagai client. Library ini paham protokol
// schema Cozyville, jadi kita langsung dapat state JSON terstruktur (bukan
// raw bytes seperti sebelumnya).

import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'colyseus.js';

// Walk schema/object dengan aman -> plain JSON.
// Schema punya properti $-prefixed (metadata) yang harus diabaikan.
function deepJson(value, seen = new WeakSet(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (depth > 50) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  // Schema collections (MapSchema/ArraySchema) bisa di-iterate sebagai biasa
  if (typeof value.toJSON === 'function') {
    try {
      const json = value.toJSON();
      // toJSON kadang masih kembalikan struktur Schema; recurse sekali lagi
      if (json && typeof json === 'object' && json !== value) {
        return deepJson(json, seen, depth + 1);
      }
    } catch {}
  }

  if (Array.isArray(value)) {
    return value.map((v) => deepJson(v, seen, depth + 1));
  }

  // Map-like
  if (typeof value.forEach === 'function' && typeof value.size === 'number') {
    const out = {};
    value.forEach((v, k) => {
      out[String(k)] = deepJson(v, seen, depth + 1);
    });
    return out;
  }

  const out = {};
  for (const k of Object.keys(value)) {
    if (k.startsWith('$') || k.startsWith('_')) continue;
    if (typeof value[k] === 'function') continue;
    out[k] = deepJson(value[k], seen, depth + 1);
  }
  return out;
}

export async function scrapeColyseus({
  apiBase,
  reservation,
  dumpDir,
  log = console.log,
  durationMs = 0, // 0 = forever
}) {
  fs.mkdirSync(dumpDir, { recursive: true });

  // Snapshot reservation untuk debugging struktur
  const reservationFile = path.join(dumpDir, 'spawn-region.json');
  fs.writeFileSync(reservationFile, JSON.stringify(reservation, null, 2));

  const client = new Client(apiBase);

  let room;
  try {
    room = await client.consumeSeatReservation(reservation);
  } catch (err) {
    throw new Error(
      `consumeSeatReservation gagal: ${err.message}. Cek dump/spawn-region.json untuk lihat struktur respons.`
    );
  }

  log(`joined room "${room.name}" id=${room.roomId} session=${room.sessionId}`);

  // file dumps (timestamp + per-jenis)
  const stamp = new Date().toISOString().replace(/[:.]/g, '_');
  const stateLog = fs.createWriteStream(path.join(dumpDir, `state-${stamp}.ndjson`));
  const msgLog = fs.createWriteStream(path.join(dumpDir, `messages-${stamp}.ndjson`));

  const counters = { state: 0, messages: 0, errors: 0 };

  room.onStateChange((state) => {
    counters.state++;
    const json = deepJson(state);
    stateLog.write(JSON.stringify({ t: Date.now(), n: counters.state, state: json }) + '\n');

    if (counters.state === 1) {
      const snap = path.join(dumpDir, 'state-snapshot.json');
      fs.writeFileSync(snap, JSON.stringify(json, null, 2));
      log(`first state snapshot -> ${snap}`);
      // Print top-level keys agar user tahu apa yang tersedia
      const keys = json && typeof json === 'object' ? Object.keys(json) : [];
      log(`  state keys: ${keys.join(', ')}`);
    } else if (counters.state % 100 === 0) {
      log(`state updates: ${counters.state}`);
    }
  });

  // Tangkap semua pesan (wildcard)
  if (typeof room.onMessage === 'function') {
    try {
      room.onMessage('*', (type, message) => {
        counters.messages++;
        msgLog.write(
          JSON.stringify({
            t: Date.now(),
            type: typeof type === 'symbol' ? String(type) : type,
            message: deepJson(message),
          }) + '\n'
        );
        if (counters.messages <= 20 || counters.messages % 50 === 0) {
          const preview =
            typeof message === 'object'
              ? JSON.stringify(message).slice(0, 120)
              : String(message).slice(0, 120);
          log(`msg [${type}] ${preview}`);
        }
      });
    } catch (e) {
      log('onMessage(*) tidak didukung:', e.message);
    }
  }

  room.onError((code, msg) => {
    counters.errors++;
    log('room ERROR', code, msg || '');
  });

  return new Promise((resolve) => {
    let timer = null;
    if (durationMs > 0) {
      timer = setTimeout(() => {
        log(`durasi ${durationMs}ms tercapai, leave room`);
        try { room.leave(true); } catch {}
      }, durationMs);
    }

    room.onLeave((code) => {
      if (timer) clearTimeout(timer);
      stateLog.end();
      msgLog.end();
      log(`room LEAVE code=${code} | state=${counters.state} messages=${counters.messages} errors=${counters.errors}`);
      resolve({ code, ...counters, room });
    });
  });
}

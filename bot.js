// Generic web/game scraper — interactive mode
//
// Bot tetap jalan dan minta URL untuk discrape.
//
// Site dikenal (di src/sites.js): full auto pipeline
//   1. Cek token cache -> kalau valid lanjut
//   2. Coba SIWS headless dengan pk.txt -> kalau gagal lanjut
//   3. Launch browser, user klik Connect -> wallet auto-sign -> bot ambil
//      token dari /auth/siws response -> browser ditutup otomatis
//   4. Connect Colyseus passive observer, decode state ke JSON terus-menerus
//   5. Token expired -> loop balik ke step 2/3
//
// Site tidak dikenal: launch Chrome, user pakai sebagaimana mestinya, bot
// record HTTP + WebSocket selama browser terbuka.
//
// Output: dump/<brand>/...  (folder sendiri per site)
//
// Penggunaan:
//   node bot.js                  -> prompt interaktif
//   node bot.js <url>            -> scrape sekali lalu lanjut interaktif
//   node bot.js --once <url>     -> scrape sekali lalu keluar
//   node bot.js --browser <url>  -> paksa mode browser raw capture
//   node bot.js --crawl <url>    -> setelah login, auto-jelajahi semua halaman
//   node bot.js --wallet <url>   -> aktifkan wallet auto-sign di browser (site web3)
//   node bot.js --no-wallet      -> nonaktifkan wallet auto-sign di browser
//   node bot.js --list           -> daftar site yang dikenal
//
// Perintah dalam prompt:
//   <url>          scrape URL itu
//   list           tampilkan site yang dikenal
//   help           bantuan
//   exit           keluar

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadKeypairFromFile, makeSigner } from './src/wallet.js';
import { siwsLogin, isTokenExpired } from './src/auth.js';
import { scrapeColyseus } from './src/scraper.js';
import { detectSite, safeFolderName, normalizeUrl, hostnameFor } from './src/dispatcher.js';
import { listSites, SITES } from './src/sites.js';
import { captureBrowserSession } from './src/browser-capture.js';
import { farmtownLogin, isWalletSessionExpired, isSupabaseTokenExpired } from './src/auth-farmtown.js';
import { scrapeRest } from './src/scraper-rest.js';

// ---------- konfigurasi ----------
const CONFIG = {
  pkFile: 'pk.txt',
  baseDumpDir: 'dump',
};

// ---------- argumen CLI ----------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));
const ONCE = flags.has('--once');
const FORCE_BROWSER = flags.has('--browser');
const FORCE_HEADLESS = flags.has('--headless');
const NO_WALLET = flags.has('--no-wallet');
const FORCE_WALLET = flags.has('--wallet');
const CRAWL = flags.has('--crawl');
const LIST = flags.has('--list');

// ---------- util ----------
const ts = () => new Date().toISOString();
const log = (...m) => console.log(`[${ts()}]`, ...m);

// ---------- state ----------
let SIGNER = null;

async function ensureSigner() {
  if (SIGNER) return SIGNER;
  if (!fs.existsSync(CONFIG.pkFile)) {
    throw new Error(
      `${CONFIG.pkFile} tidak ditemukan. Buat file ini dengan private key Solana ` +
        `(format base58 / JSON array 64 byte / hex 128 char).`
    );
  }
  const kp = loadKeypairFromFile(CONFIG.pkFile);
  SIGNER = makeSigner(kp);
  log('wallet:', kp.address);
  return SIGNER;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body, headers: res.headers };
}

// ---------- mode 1: site dikenal (full auto pipeline) ----------
// Flow:
//   1. Cek dump/<site>/token.txt - kalau valid skip ke step 4
//   2. Coba SIWS headless dengan pk.txt - kalau gagal lanjut step 3
//   3. Launch browser, user klik Connect, bot ambil token dari /auth/siws
//      response, browser otomatis tutup
//   4. Call /spawn-region dengan token -> seat reservation
//   5. Connect Colyseus client (passive observer), decode state ke JSON
//   6. Kalau room close dengan auth error -> hapus token, loop balik step 1

// ---------- pipeline: FarmTown (Socket.IO + Supabase + wallet challenge) ----------
async function autoScrapeFarmtown(site, dumpDir) {
  fs.mkdirSync(dumpDir, { recursive: true });
  log(`[${site.name}] farmtown pipeline, output -> ${dumpDir}`);

  if (!fs.existsSync(CONFIG.pkFile)) {
    log(`pk.txt tidak ditemukan. Membuka browser untuk login manual...`);
    return scrapeViaBrowser(`${site.webBase}/`, dumpDir, { isWeb3: true });
  }

  let consecutiveFailures = 0;
  const MAX_FAILURES = 3;

  while (true) {
    let session;
    try {
      session = await farmtownLogin({ pkFile: CONFIG.pkFile, dumpDir, log });
    } catch (e) {
      log('farmtown login gagal:', e.message);
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_FAILURES) {
        log(`${MAX_FAILURES}x gagal login, fallback ke browser...`);
        return scrapeViaBrowser(`${site.webBase}/`, dumpDir, { isWeb3: true });
      }
      await sleep(5000);
      continue;
    }

    log(`[farmtown] login OK. Wallet: ${session.walletAddress}`);
    if (session.profile) {
      log(`  profile: ${session.profile.displayName} (lv${session.profile.level}, xp ${session.profile.xp})`);
    }
    if (session.farm) {
      log(`  farm: "${session.farm.name}" (${session.farm.slug})`);
    }

    // Fetch beberapa endpoint API berguna
    const apiHeaders = {
      authorization: `Bearer ${session.accessToken}`,
      'x-wallet-session-token': session.walletSessionToken,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      origin: site.webBase,
      referer: `${site.webBase}/`,
    };

    const apiEndpoints = [
      '/api/auth/profile',
      '/api/auth/session',
      '/api/farms/my',
      '/api/token/stars/balance',
      '/api/token/stars/ledger?limit=20',
    ];

    for (const ep of apiEndpoints) {
      try {
        const r = await fetchJson(`${site.apiBase}${ep}`, { headers: apiHeaders });
        const safe = ep.replace(/[^a-z0-9]/gi, '_').replace(/__+/g, '_').slice(1);
        fs.writeFileSync(path.join(dumpDir, `${safe}.json`), JSON.stringify(r.body, null, 2));
        log(`  [${r.status}] ${ep}`);
      } catch (e) {
        log(`  error ${ep}: ${e.message}`);
      }
    }

    log('[farmtown] Membuka browser untuk sesi game (wallet sudah ter-connect otomatis)...');
    // Tulis session ke file sementara, browser-capture akan inject ke localStorage
    const sessionInjectFile = path.join(dumpDir, '_session_inject.json');
    fs.writeFileSync(sessionInjectFile, JSON.stringify({
      supabaseToken: JSON.stringify(session.supabaseRaw),
      walletAddress: session.walletAddress,
      displayName: session.profile?.displayName || session.walletAddress.slice(0, 8),
    }));

    await captureBrowserSession({
      url: `${site.webBase}/`,
      dumpDir,
      log,
      pkFile: fs.existsSync(CONFIG.pkFile) ? CONFIG.pkFile : null,
      farmtownSessionFile: sessionInjectFile,
      closeAfterInGame: false,
    });

    // Bersihkan file inject
    try { fs.unlinkSync(sessionInjectFile); } catch {}

    log('[farmtown] sesi selesai.');
    return;
  }
}
async function fetchTokenHeadless(site) {
  const signer = await ensureSigner();
  const { token } = await siwsLogin({
    apiBase: site.apiBase,
    webBase: site.webBase,
    domain: site.siws.domain,
    uri: site.siws.uri,
    statement: site.siws.statement,
    noncePath: site.auth.noncePath,
    siwsPath: site.auth.siwsPath,
    signer,
  });
  return token;
}

async function fetchTokenViaBrowser(site, dumpDir) {
  const result = await captureBrowserSession({
    url: `${site.webBase}/play/`,
    dumpDir,
    log,
    pkFile: fs.existsSync(CONFIG.pkFile) ? CONFIG.pkFile : null,
    siwsApiUrl: `${site.apiBase}${site.auth.siwsPath}`,
    spawnPathFragment: site.spawn.path, // backup token capture dari URL spawn
    closeAfterInGame: true,
  });
  if (!result.token) {
    throw new Error('browser ditutup tanpa token (login dibatalkan?)');
  }
  return result.token;
}

async function getValidToken(site, dumpDir, { forceRefresh = false } = {}) {
  const tokenFile = path.join(dumpDir, 'token.txt');

  if (!forceRefresh && fs.existsSync(tokenFile)) {
    const cached = fs.readFileSync(tokenFile, 'utf8').trim();
    if (cached && !isTokenExpired(cached)) {
      log('token cache valid, skip login');
      return cached;
    }
    log('token cache expired/invalid, login ulang');
  }

  // Coba headless SIWS dulu (lebih cepat, tanpa browser)
  if (fs.existsSync(CONFIG.pkFile)) {
    try {
      log('Coba headless SIWS...');
      const token = await fetchTokenHeadless(site);
      log('headless SIWS sukses');
      fs.mkdirSync(dumpDir, { recursive: true });
      fs.writeFileSync(tokenFile, token);
      return token;
    } catch (e) {
      log('headless SIWS gagal:', e.message);
      log('lanjut ke browser login (auto-close setelah token didapat)...');
    }
  }

  // Fall back: browser login (auto-close)
  const token = await fetchTokenViaBrowser(site, dumpDir);
  fs.mkdirSync(dumpDir, { recursive: true });
  fs.writeFileSync(tokenFile, token);
  return token;
}

async function fetchSpawnRegion(site, token) {
  const param = site.spawn.tokenParam || 'token';
  const url = `${site.apiBase}${site.spawn.path}?${param}=${encodeURIComponent(token)}`;
  log(`GET ${site.spawn.path}`);
  const r = await fetchJson(url);
  if (!r.ok) throw new Error(`spawn-region ${r.status}: ${JSON.stringify(r.body).slice(0, 200)}`);
  return r.body;
}

async function autoScrapeKnownSite(site, dumpDir) {
  // Dispatch ke pipeline khusus kalau bukan SIWS default
  if (site.type === 'farmtown') {
    return autoScrapeFarmtown(site, dumpDir);
  }
  if (site.type === 'rest') {
    return scrapeRest(site, dumpDir, { log });
  }

  fs.mkdirSync(dumpDir, { recursive: true });
  log(`[${site.name}] auto-scrape pipeline, output -> ${dumpDir}`);

  // Static assets sekali di awal
  for (const p of site.staticAssets || []) {
    const url = `${site.webBase}${p}`;
    const filename = path.basename(p);
    log('GET', url);
    try {
      const r = await fetchJson(url);
      fs.writeFileSync(path.join(dumpDir, filename), JSON.stringify(r.body, null, 2));
    } catch (e) { log('error', url, e.message); }
  }

  let attempt = 0;
  let consecutiveFailures = 0;
  const MAX_FAILURES = 3;

  while (true) {
    attempt++;
    let token;
    try {
      token = await getValidToken(site, dumpDir, { forceRefresh: consecutiveFailures > 0 });
    } catch (e) {
      log('gagal dapat token:', e.message);
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_FAILURES) {
        log(`${MAX_FAILURES}x gagal login berturut-turut, berhenti.`);
        return;
      }
      await sleep(5000);
      continue;
    }

    let spawn;
    try {
      spawn = await fetchSpawnRegion(site, token);
      fs.writeFileSync(path.join(dumpDir, 'spawn-region.json'), JSON.stringify(spawn, null, 2));
    } catch (e) {
      log('spawn-region gagal:', e.message);
      // token mungkin baru saja expired
      try { fs.unlinkSync(path.join(dumpDir, 'token.txt')); } catch {}
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_FAILURES) {
        log(`${MAX_FAILURES}x gagal spawn-region berturut-turut, berhenti.`);
        return;
      }
      await sleep(Math.min(30_000, 1000 * Math.pow(2, consecutiveFailures)));
      continue;
    }

    log('Colyseus passive observer connecting (Ctrl+C untuk berhenti)...');
    let result;
    try {
      result = await scrapeColyseus({
        apiBase: site.apiBase,
        reservation: spawn,
        dumpDir,
        log,
        durationMs: 0,
      });
    } catch (e) {
      log('Colyseus error:', e.message);
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_FAILURES) {
        log(`${MAX_FAILURES}x gagal Colyseus berturut-turut, berhenti.`);
        return;
      }
      await sleep(Math.min(30_000, 1000 * Math.pow(2, consecutiveFailures)));
      continue;
    }

    // Eksamin code close untuk decide retry
    if (result.code === 4001 || result.code === 4002 || result.code === 4003) {
      log(`auth/session error (close ${result.code}), refresh token...`);
      try { fs.unlinkSync(path.join(dumpDir, 'token.txt')); } catch {}
      consecutiveFailures = 0; // reset karena ini expected reconnect
      continue;
    }
    if (result.code === 1000) {
      log('disconnect normal, selesai.');
      return;
    }
    log(`disconnect dengan code ${result.code}, retry...`);
    consecutiveFailures = 0;
    await sleep(3000);
  }
}

// ---------- mode 2: site tidak dikenal (browser) ----------
async function scrapeViaBrowser(url, dumpDir, { isWeb3 = false } = {}) {
  log(`Membuka Chrome untuk ${url}`);
  // Wallet auto-sign kalau:
  //  - --wallet flag, ATAU
  //  - konteks web3 (fallback dari pipeline SIWS), ATAU
  //  - URL mengandung sinyal web3 (kintara, game, play, dll)
  const looksWeb3 = isWeb3 || /\.(gg|fun|xyz|game|io)\b/.test(url) ||
    /\/(play|app|game|connect)/i.test(url);
  const usePk = !NO_WALLET && (FORCE_WALLET || looksWeb3) && fs.existsSync(CONFIG.pkFile);
  if (usePk) {
    log(`Mode wallet auto-sign: ON (pakai ${CONFIG.pkFile})`);
    log(`Klik "Connect Wallet" di Chrome -> tanda tangan otomatis tanpa popup.`);
  } else {
    log(`Mode capture biasa (tanpa wallet). Login/pakai site secara normal di Chrome.`);
    log(`Cookies & localStorage akan disimpan saat browser ditutup.`);
  }
  await captureBrowserSession({
    url,
    dumpDir,
    log,
    pkFile: usePk ? CONFIG.pkFile : null,
    autoCrawl: CRAWL,
  });
}

// ---------- handler utama ----------
async function handleUrl(input) {
  const url = normalizeUrl(input);
  if (!url) {
    log('URL tidak valid:', input);
    return;
  }

  const host = hostnameFor(url);
  const dumpDir = path.join(CONFIG.baseDumpDir, safeFolderName(host));
  const site = detectSite(url);

  if (FORCE_BROWSER) {
    log(`mode --browser dipaksa untuk ${host}`);
    return scrapeViaBrowser(url, dumpDir);
  }

  if (site && !FORCE_BROWSER) {
    log(`Detected site: ${site.name}`);
    try {
      return await autoScrapeKnownSite(site, dumpDir);
    } catch (e) {
      log('auto-scrape error:', e.message);
      if (FORCE_HEADLESS) throw e;
      log('Fallback ke mode browser raw capture...');
      return scrapeViaBrowser(url, dumpDir, { isWeb3: true });
    }
  }

  log(`Site tidak dikenal (${host}). Pakai mode browser.`);
  return scrapeViaBrowser(url, dumpDir);
}

// ---------- REPL interaktif ----------
async function interactiveLoop() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) =>
    new Promise((res) => rl.question(q, (a) => res(a)));

  console.log('');
  console.log('=== Web/Game Scraper ===');
  console.log('Ketik URL untuk discrape, atau "list" / "help" / "exit".');
  console.log('');

  while (true) {
    let input;
    try {
      input = (await ask('url> ')).trim();
    } catch {
      break; // SIGINT/EOF
    }
    if (!input) continue;
    if (input === 'exit' || input === 'quit') break;
    if (input === 'help' || input === '?') {
      console.log('  <url>       scrape URL');
      console.log('  list        tampilkan site dikenal (mode headless+SIWS)');
      console.log('  exit        keluar');
      console.log('  Ctrl+C      interrupt sesi scrape, kembali ke prompt');
      console.log('');
      console.log('  Mode otomatis:');
      console.log('    Site dikenal (di src/sites.js) + pk.txt -> headless SIWS');
      console.log('    Site tidak dikenal -> Chrome dengan wallet auto-sign (kalau pk.txt ada)');
      console.log('    Tanpa pk.txt -> Chrome, user connect wallet manual');
      continue;
    }
    if (input === 'list') {
      const sites = listSites();
      if (!sites.length) console.log('(belum ada site terdaftar)');
      console.log('Site dikenal (auto-detect, mode headless+SIWS):');
      for (const s of sites) console.log(`  ${s.name.padEnd(16)} ${s.webBase}`);
      console.log('Site lain: otomatis pakai mode browser.');
      continue;
    }

    try {
      await handleUrl(input);
    } catch (e) {
      console.error('error:', e.message || e);
    }
    console.log('');
  }

  rl.close();
}

// ---------- main ----------
(async () => {
  if (LIST) {
    console.log('Site terdaftar:');
    for (const s of listSites()) console.log(`  - ${s.name}  (${s.webBase})`);
    process.exit(0);
  }

  // SIGINT: interrupt scrape tanpa exit bot (ditangani readline juga)
  process.on('SIGINT', () => {
    console.log('\n(Ctrl+C diterima, kembali ke prompt — ketik "exit" untuk keluar)');
  });

  if (positional.length > 0) {
    try {
      await handleUrl(positional[0]);
    } catch (e) {
      console.error('error:', e.message || e);
    }
    if (ONCE) process.exit(0);
  }
  await interactiveLoop();
})().catch((err) => {
  console.error('fatal', err.message || err);
  process.exit(1);
});

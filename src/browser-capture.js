// Browser-based session capture pakai puppeteer-core + Chrome installed user.
//
// Bot launch Chrome dengan profile persistent (Phantom/Solflare extension tetap
// kepasang antar sesi), user login normal di window itu, bot record semua
// HTTP response (JSON/text) dan semua WebSocket frame ke folder dump/<host>/.
//
// Selesai: tutup window Chrome -> bot otomatis simpan dan kembali ke prompt.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import puppeteer from 'puppeteer-core';
import { setupWalletInjection } from './wallet-injector.js';
import { safeFolderName } from './dispatcher.js';

function findChromeExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  let candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || '';
    const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates = [
      path.join(pf, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(pf86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(local, 'Google\\Chrome\\Application\\chrome.exe'),
      // fallback Edge (Chromium-based juga, kompatibel)
      path.join(pf86, 'Microsoft\\Edge\\Application\\msedge.exe'),
      path.join(pf, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ];
  } else if (process.platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  } else {
    candidates = [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
    ];
  }

  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

const PROFILE_ROOT = 'profiles';

function profilePathFor(host) {
  return path.resolve(PROFILE_ROOT, safeFolderName(host));
}

export async function captureBrowserSession({
  url,
  dumpDir,
  log,
  pkFile = null,
  closeAfterLogin = false,
  closeAfterInGame = false,
  inGameFrameThreshold = 25, // 25 frame dalam 5 detik (~5 fps)
  closeDelayMs = 30_000,     // jeda setelah deteksi in-game
  siwsApiUrl = null,
  spawnPathFragment = null,  // contoh: '/spawn-region' - kalau request URL match dan punya ?token=, ekstrak
  autoCrawl = false,         // setelah load, navigasi semua link same-origin otomatis
  crawlMaxPages = 60,        // batas halaman yang dikunjungi
  crawlDelayMs = 1500,       // jeda antar navigasi (politeness)
  crawlWaitAfterLoad = 20_000, // tunggu user login dulu sebelum mulai crawl
  crawlProbeCommon = true,   // probe path SaaS umum (/dashboard, /generate, dll)
  farmtownSessionFile = null, // path ke JSON file berisi { supabaseToken, walletAddress, displayName }
}) {
  fs.mkdirSync(dumpDir, { recursive: true });

  const chromePath = findChromeExecutable();
  if (!chromePath) {
    throw new Error(
      'Chrome/Edge tidak ditemukan. Install Google Chrome dari https://www.google.com/chrome/ ' +
        'atau set environment variable CHROME_PATH ke executable browser Chromium.'
    );
  }
  log('Browser exe :', chromePath);

  const host = new URL(url).hostname;
  const profileDir = profilePathFor(host);
  fs.mkdirSync(profileDir, { recursive: true });
  log('Profile dir :', profileDir);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    defaultViewport: null,
    userDataDir: profileDir,
    args: [
      '--start-maximized',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');

  // Block audio asset di level network CDP (tanpa request interception loop).
  // Game yang file musiknya 404 tidak akan spam retry ke server.
  try {
    await cdp.send('Network.setBlockedURLs', {
      urls: ['*.mp3', '*.ogg', '*.wav', '*.aac', '*.opus', '*.m4a', '*.flac'],
    });
  } catch {
    // older CDP versions might not support this — no-op
  }

  // Wallet auto-sign injection (sebelum navigate, supaya ke-pasang sebelum
  // script site dijalankan).
  if (pkFile) {
    try {
      await setupWalletInjection({ page, pkFile, log });
    } catch (e) {
      log('wallet injection skipped:', e.message);
    }
  } else {
    log('Wallet auto-sign nonaktif (pk.txt tidak diberikan). User harus connect wallet manual.');
  }

  // FarmTown: inject session ke localStorage sebelum navigate agar game tidak perlu
  // klik "Connect Wallet" lagi — langsung masuk sebagai user yang sudah login.
  if (farmtownSessionFile) {
    try {
      const sessionData = JSON.parse(fs.readFileSync(farmtownSessionFile, 'utf8'));
      await page.evaluateOnNewDocument((sbKey, sbToken, walletAddr, displayName) => {
        // Dijalankan SEBELUM setiap document load, jadi tersedia saat game init
        try { localStorage.setItem(sbKey, sbToken); } catch {}
        try { localStorage.setItem('farmtown_wallet_address', walletAddr); } catch {}
        try { localStorage.setItem('farmtown_display_name', displayName); } catch {}
        try { localStorage.setItem('farmtown_music_muted', '1'); } catch {} // mute musik agar tidak spam 404
      },
        'sb-irarxwyrpmmxacrbvpnz-auth-token',
        sessionData.supabaseToken,
        sessionData.walletAddress,
        sessionData.displayName || sessionData.walletAddress.slice(0, 8)
      );
      log(`[farmtown] session inject: ${sessionData.walletAddress} (${sessionData.displayName})`);
    } catch (e) {
      log('farmtown session inject skipped:', e.message);
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '_');
  const httpLog = fs.createWriteStream(path.join(dumpDir, `http-${stamp}.ndjson`));
  const wsLog = fs.createWriteStream(path.join(dumpDir, `ws-${stamp}.ndjson`));
  // Log request non-GET (payload) TERPISAH — dijamin tertangkap walau response
  // streaming / gagal di-getResponseBody.
  const reqLog = fs.createWriteStream(path.join(dumpDir, `requests-${stamp}.ndjson`));

  const mainHost = new URL(url).hostname;
  const savedFiles = new Set(); // hindari overwrite duplikat
  const categoryStats = {};
  const requests = new Map();
  const wsByRequest = new Map();
  let httpCount = 0;
  let wsCount = 0;

  function categorize(urlStr, contentType, type) {
    const ct = (contentType || '').toLowerCase();
    let u;
    try { u = new URL(urlStr); } catch { return null; }
    const p = u.pathname.toLowerCase();
    const isXhr = type === 'XHR' || type === 'Fetch';
    const isCrossOrigin = u.hostname !== mainHost;

    // Skip resource yang umumnya tidak menarik untuk scraping data
    if (ct.includes('image/') && !ct.includes('svg')) return null;
    if (ct.includes('font/')) return null;
    if (ct.includes('audio/') || ct.includes('video/')) return null;

    // API: XHR/Fetch ATAU cross-origin ATAU path /api/, /v1/, /auth/, /graphql, /rpc, /trpc
    if (isXhr || isCrossOrigin || /\/(api|v\d+|auth|graphql|rpc|trpc)(\/|$)/i.test(p)) {
      return 'api';
    }
    // JSON statis dari host sendiri
    if (ct.includes('json') || p.endsWith('.json')) return 'data';
    // HTML page
    if (ct.includes('html')) return 'pages';
    // JS bundle (sengaja off default karena besar; aktifkan dengan SAVE_JS env)
    if (p.endsWith('.js') || p.endsWith('.mjs') || ct.includes('javascript')) {
      return process.env.SAVE_JS === '1' ? 'js' : null;
    }
    // CSS sengaja skip
    if (ct.includes('css') || p.endsWith('.css')) return null;
    // SVG / text
    if (ct.includes('svg') || ct.startsWith('text/')) return 'assets';
    return null;
  }

  function buildFilePath(category, urlStr, contentType, body) {
    let u;
    try { u = new URL(urlStr); } catch { return null; }

    // Path: <category>/<host>/<path>
    let p = u.pathname;
    if (p === '' || p === '/') p = '/index';
    if (p.endsWith('/')) p += 'index';

    // Kalau ada query string, hash kecil agar URL berbeda tidak overwrite
    let suffix = '';
    if (u.search) {
      const h = crypto.createHash('md5').update(u.search).digest('hex').slice(0, 6);
      suffix = `__${h}`;
    }

    const ct = (contentType || '').toLowerCase();
    let ext = path.extname(p);
    if (!ext) {
      if (ct.includes('json')) ext = '.json';
      else if (ct.includes('html')) ext = '.html';
      else if (ct.includes('javascript')) ext = '.js';
      else if (ct.includes('svg')) ext = '.svg';
      else if (ct.startsWith('text/')) ext = '.txt';
      else ext = '.bin';
      p = p + ext;
    }

    // Sanitize tiap segmen, batasi panjang
    const segments = p.replace(/^\//, '').split('/').map((s) =>
      s.replace(/[^a-z0-9._\-]/gi, '_').slice(0, 80) || '_'
    );
    const safeFile = segments.pop();
    const dir = path.join(dumpDir, category, u.hostname, ...segments);

    // Tambah suffix sebelum extension
    const stem = safeFile.replace(/(\.[^.]+)$/, '');
    const finalExt = path.extname(safeFile) || ext;
    const filename = `${stem}${suffix}${finalExt}`;
    return path.join(dir, filename);
  }

  let capturedToken = null;
  let resolveTokenCaptured = null;
  const tokenCapturedPromise = new Promise((r) => { resolveTokenCaptured = r; });

  // In-game detection state
  let inGameDetected = false;
  let closeTimer = null;
  let maxTimeoutTimer = null;
  let postAuthWsId = null;
  const inGameMaxWaitMs = 3 * 60_000; // 3 menit hard timeout

  function triggerClose(reason) {
    if (inGameDetected) return;
    inGameDetected = true;
    log(`${reason}. Browser akan tutup otomatis dalam ${Math.round(closeDelayMs / 1000)} detik.`);
    log('(tutup browser manual kapan saja kalau sudah siap)');
    if (maxTimeoutTimer) clearTimeout(maxTimeoutTimer);
    closeTimer = setTimeout(() => {
      log('menutup browser otomatis...');
      browser.close().catch(() => {});
    }, closeDelayMs);
  }

  function startMaxWaitTimer() {
    if (maxTimeoutTimer || !closeAfterInGame) return;
    maxTimeoutTimer = setTimeout(() => {
      if (!inGameDetected) {
        log(`${Math.round(inGameMaxWaitMs / 60000)} menit setelah login, belum terdeteksi in-game.`);
        log('Menutup browser paksa untuk lanjut headless...');
        browser.close().catch(() => {});
      }
    }, inGameMaxWaitMs);
  }

  cdp.on('Network.requestWillBeSent', ({ requestId, request, type }) => {
    requests.set(requestId, {
      url: request.url,
      method: request.method,
      type,
      postData: request.postData, // body request (kalau kecil & ada)
      hasPostData: request.hasPostData,
      reqHeaders: request.headers,
    });

    // Rekam SEMUA request non-GET (atau XHR/Fetch) ke reqLog, independen response.
    const isNonGet = request.method && request.method !== 'GET';
    const isApiLike = type === 'XHR' || type === 'Fetch';
    if ((isNonGet || isApiLike) && !/cdn-cgi\/rum/.test(request.url)) {
      const writeReq = (postData) => {
        reqLog.write(JSON.stringify({
          t: Date.now(),
          method: request.method,
          url: request.url,
          type,
          contentType: request.headers['content-type'] || request.headers['Content-Type'] || '',
          postData: postData ? String(postData).slice(0, 8000) : undefined,
        }) + '\n');
      };
      if (request.postData) {
        writeReq(request.postData);
      } else if (request.hasPostData) {
        cdp.send('Network.getRequestPostData', { requestId })
          .then((pd) => writeReq(pd.postData))
          .catch(() => writeReq(null));
      } else {
        writeReq(null);
      }
    }

    // Backup token capture: kalau request berisi ?token=... ke endpoint spawn,
    // berarti user sudah punya sesi (mungkin dari cookie). Ekstrak token dari URL.
    if (
      !capturedToken &&
      spawnPathFragment &&
      request.url.includes(spawnPathFragment) &&
      request.url.includes('token=')
    ) {
      try {
        const u = new URL(request.url);
        const t = u.searchParams.get('token');
        if (t && t.length > 20) {
          capturedToken = t;
          log(`token captured (dari URL ${spawnPathFragment}, ${t.length} chars)`);
          resolveTokenCaptured(t);
          if (closeAfterLogin && !closeAfterInGame) {
            setTimeout(() => {
              log('login terdeteksi, menutup browser otomatis...');
              browser.close().catch(() => {});
            }, 1500);
          } else if (closeAfterInGame) {
            log('login terdeteksi (sesi lama). Bot deteksi otomatis saat Anda di game.');
            startMaxWaitTimer();
          }
        }
      } catch {}
    }
  });

  cdp.on('Network.responseReceived', async ({ requestId, response, type }) => {
    const ct = String(
      response.headers['content-type'] || response.headers['Content-Type'] || ''
    ).toLowerCase();

    if (response.status === 304 || response.status === 0) return;
    if (response.status >= 300 && response.status < 400) return; // redirects

    // Suppress 404 untuk audio/video asset — game sering retry file yang tidak ada
    // di server, jangan polusi log dengan spam ini.
    const urlPath = (() => { try { return new URL(response.url).pathname.toLowerCase(); } catch { return ''; } })();
    const isAudioAsset = /\.(mp3|ogg|wav|aac|opus|webm|m4a|flac)(\?|$)/.test(urlPath) ||
      ct.includes('audio/') || ct.includes('video/');
    if (response.status === 404 && isAudioAsset) return; // skip sepenuhnya, tanpa log

    const category = categorize(response.url, ct, type);
    if (!category) return; // skip yang tidak menarik

    // berikan jeda kecil agar body fully diterima
    setTimeout(async () => {
      try {
        const body = await cdp.send('Network.getResponseBody', { requestId });
        const req = requests.get(requestId) || {};

        // 1. Aggregate NDJSON (history lengkap)
        const entry = {
          t: Date.now(),
          url: response.url,
          method: req.method,
          status: response.status,
          type,
          category,
          contentType: ct,
        };
        // Sertakan request body (payload) untuk non-GET -> tahu cara buat konten
        if (req.method && req.method !== 'GET') {
          let reqBody = req.postData;
          if (!reqBody && req.hasPostData) {
            try {
              const pd = await cdp.send('Network.getRequestPostData', { requestId });
              reqBody = pd.postData;
            } catch {}
          }
          if (reqBody) entry.requestBody = String(reqBody).slice(0, 5000);
          // content-type request (form/json) dari header
          const rh = req.reqHeaders || {};
          entry.requestContentType = rh['content-type'] || rh['Content-Type'] || '';
        }
        if (body.base64Encoded) entry.bodyB64 = body.body;
        else entry.body = body.body;
        httpLog.write(JSON.stringify(entry) + '\n');
        httpCount++;

        // -- Token capture: kalau cocok dengan siwsApiUrl, ekstrak token --
        if (
          siwsApiUrl &&
          !capturedToken &&
          response.url === siwsApiUrl &&
          response.status === 200 &&
          !body.base64Encoded
        ) {
          try {
            const data = JSON.parse(body.body);
            if (data && typeof data.token === 'string') {
              capturedToken = data.token;
              log(`token captured (${data.token.length} chars)`);
              resolveTokenCaptured(data.token);
              if (closeAfterLogin && !closeAfterInGame) {
                setTimeout(() => {
                  log('login selesai, menutup browser otomatis...');
                  browser.close().catch(() => {});
                }, 1500);
              } else if (closeAfterInGame) {
                log('login OK. Lanjut buat karakter / setup -> bot deteksi otomatis saat Anda masuk game.');
                startMaxWaitTimer();
              }
            }
          } catch {}
        }

        // 2. File individual per kategori (sekali per URL)
        const filePath = buildFilePath(category, response.url, ct, body);
        if (filePath && !savedFiles.has(filePath)) {
          savedFiles.add(filePath);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          if (body.base64Encoded) {
            fs.writeFileSync(filePath, Buffer.from(body.body, 'base64'));
          } else {
            // pretty-print JSON kalau valid
            let content = body.body;
            if (ct.includes('json')) {
              try { content = JSON.stringify(JSON.parse(body.body), null, 2); } catch {}
            }
            fs.writeFileSync(filePath, content);
          }
          categoryStats[category] = (categoryStats[category] || 0) + 1;
        }

        if (httpCount <= 30 || httpCount % 50 === 0) {
          log(`http [${response.status}] [${category}] ${response.url.slice(0, 110)}`);
        }
      } catch {
        // beberapa response (cached / redirect / preflight) tidak punya body
      }
    }, 80);
  });

  cdp.on('Network.webSocketCreated', ({ requestId, url: wsUrl }) => {
    wsByRequest.set(requestId, wsUrl);
    log('ws OPEN', wsUrl);
    // WS yang baru terbuka SETELAH token captured = sesi autentikasi (in-game)
    if (closeAfterInGame && capturedToken && !inGameDetected && !postAuthWsId) {
      postAuthWsId = requestId;
      log('  (auth-WS, tunggu frame pertama untuk konfirmasi join room)');
    }
  });

  cdp.on('Network.webSocketFrameReceived', ({ requestId, response }) => {
    wsCount++;
    // Frame pertama di auth-WS = user sudah join room game
    if (
      closeAfterInGame &&
      !inGameDetected &&
      postAuthWsId &&
      requestId === postAuthWsId
    ) {
      triggerClose('✓ join room game dikonfirmasi');
    }
    wsLog.write(
      JSON.stringify({
        t: Date.now(),
        dir: 'in',
        wsUrl: wsByRequest.get(requestId),
        opcode: response.opcode,
        payload: response.payloadData,
      }) + '\n'
    );
  });

  cdp.on('Network.webSocketFrameSent', ({ requestId, response }) => {
    wsCount++;
    wsLog.write(
      JSON.stringify({
        t: Date.now(),
        dir: 'out',
        wsUrl: wsByRequest.get(requestId),
        opcode: response.opcode,
        payload: response.payloadData,
      }) + '\n'
    );
  });

  cdp.on('Network.webSocketClosed', ({ requestId }) => {
    log('ws CLOSE', wsByRequest.get(requestId) || requestId);
  });

  log('navigate ->', url);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch (e) {
    log('navigate warning:', e.message);
  }

  // Snapshot sesi (cookies + localStorage) berkala -> session.json.
  // Berguna untuk scraping API headless setelah browser ditutup.
  let lastSessionOk = false;
  async function snapshotSession() {
    try {
      const { cookies } = await cdp.send('Network.getAllCookies');
      let localStorage = {};
      try {
        localStorage = await page.evaluate(() => {
          const o = {};
          for (let i = 0; i < window.localStorage.length; i++) {
            const k = window.localStorage.key(i);
            o[k] = window.localStorage.getItem(k);
          }
          return o;
        });
      } catch {}
      const data = {
        t: Date.now(),
        url,
        cookies: (cookies || []).map((c) => ({
          name: c.name, value: c.value, domain: c.domain, path: c.path,
          expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
        })),
        localStorage,
      };
      fs.writeFileSync(path.join(dumpDir, 'session.json'), JSON.stringify(data, null, 2));
      lastSessionOk = true;
    } catch {
      // page mungkin sedang navigate / sudah ditutup
    }
  }
  const sessionTimer = setInterval(snapshotSession, 10_000);
  setTimeout(snapshotSession, 3000); // snapshot awal cepat

  log('---');
  if (autoCrawl) {
    log('Chrome terbuka. Login dulu kalau diminta.');
    log(`Bot mulai auto-crawl ${Math.round(crawlWaitAfterLoad / 1000)} detik lagi (max ${crawlMaxPages} halaman).`);
    log('Tutup browser kapan saja untuk stop.');
  } else if (closeAfterInGame) {
    log('Chrome terbuka. Login -> buat karakter / setup -> masuk game.');
    log('Bot akan otomatis tutup browser setelah Anda aktif di game.');
  } else if (closeAfterLogin) {
    log('Chrome terbuka. Klik Connect Wallet / login -> bot tutup browser otomatis.');
    log('Kalau login gagal, tutup window manual untuk batal.');
  } else {
    log('Chrome terbuka. Silakan main / connect wallet di window itu.');
    log('Bot record semua trafik. Tutup window Chrome saat selesai.');
  }
  log('---');

  // ---------- Auto-crawl (same-origin, GET-only, rate-limited) ----------
  let crawlDone = false;
  if (autoCrawl) {
    const origin = new URL(url).origin;
    const visited = new Set();
    let browserAlive = true;
    browser.on('disconnected', () => { browserAlive = false; });

    // Pola URL yang DILEWATI (berbahaya / tidak berguna untuk scraping)
    const SKIP = /(logout|signout|sign-out|log-out|delete|remove|destroy|revoke|unsubscribe|cancel|\/api\/|\.(png|jpg|jpeg|gif|svg|webp|ico|css|js|woff2?|ttf|map)(\?|$))/i;

    async function collectLinks() {
      try {
        return await page.evaluate((orig) => {
          const out = new Set();
          const add = (href) => {
            try {
              const u = new URL(href, location.href);
              if (u.origin === orig) { u.hash = ''; out.add(u.toString()); }
            } catch {}
          };
          // anchor tags
          for (const a of document.querySelectorAll('a[href]')) add(a.href);
          // elemen dengan atribut href-like (SPA router, tombol nav)
          for (const el of document.querySelectorAll('[data-href],[data-to],[data-url],[routerlink],[onclick]')) {
            const v = el.getAttribute('data-href') || el.getAttribute('data-to') ||
                      el.getAttribute('data-url') || el.getAttribute('routerlink');
            if (v) add(v);
            // onclick="location.href='...'" / location.assign('...') / window.open('...')
            const oc = el.getAttribute('onclick') || '';
            for (const m of oc.matchAll(/(?:location\.href|location\.assign|window\.open|location)\s*=?\s*\(?\s*['"]([^'"]+)['"]/g)) add(m[1]);
          }
          // scan seluruh HTML untuk pola path PHP / route, dan inline JS redirect
          const html = document.documentElement.outerHTML;
          for (const m of html.matchAll(/["'`](\/[a-zA-Z0-9_\-]+(?:\.php)?(?:\?[^"'`\s]*)?)["'`]/g)) add(m[1]);
          for (const m of html.matchAll(/(?:location\.href|location\.assign|window\.location)\s*=?\s*['"]([^'"]+)['"]/g)) add(m[1]);
          return [...out];
        }, origin);
      } catch { return []; }
    }

    // Path umum SaaS untuk diprobe (bare + .php), kalau ada di server akan 200.
    function candidatePaths() {
      const words = [
        'dashboard', 'home', 'app', 'generate', 'create', 'chat', 'account',
        'settings', 'profile', 'billing', 'credits', 'projects', 'project',
        'history', 'library', 'gallery', 'explore', 'pricing', 'upgrade',
        'api-keys', 'apikey', 'usage', 'team', 'workspace', 'images', 'videos',
        'tools', 'studio', 'editor', 'jobs', 'tasks', 'orders', 'transactions',
      ];
      const out = [];
      for (const w of words) {
        out.push(`${origin}/${w}`);
        out.push(`${origin}/${w}.php`);
      }
      return out;
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // Tunggu login: tekan ENTER untuk mulai lebih cepat, atau timeout otomatis.
    log(`Login dulu kalau perlu, lalu tekan ENTER untuk mulai crawl (auto-start ${Math.round(crawlWaitAfterLoad / 1000)}s).`);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; cleanup(); resolve(); } };
      const onData = () => finish();
      const cleanup = () => {
        clearTimeout(t);
        try { process.stdin.removeListener('data', onData); } catch {}
        try { process.stdin.pause(); } catch {}
      };
      const t = setTimeout(finish, crawlWaitAfterLoad);
      try { process.stdin.resume(); process.stdin.once('data', onData); } catch {}
    });

    if (!browserAlive) { crawlDone = true; }
    else {
      // Seed dari HALAMAN SAAT INI (tempat user berada setelah login) + url awal.
      let currentUrl = url;
      try { currentUrl = page.url(); } catch {}
      const queue = [];
      const enqueue = (u) => {
        if (u && !visited.has(u) && !SKIP.test(u) && !queue.includes(u)) queue.push(u);
      };
      enqueue(currentUrl);
      // tambahkan link dari halaman saat ini sebagai seed awal
      for (const l of await collectLinks()) enqueue(l);
      enqueue(url);
      // probe path umum SaaS (banyak yang 404, tapi yang 200 = halaman app tersembunyi)
      if (crawlProbeCommon) {
        for (const c of candidatePaths()) enqueue(c);
      }

      log('=== AUTO-CRAWL START ===');
      log(`seed dari: ${currentUrl}`);
      while (browserAlive && queue.length && visited.size < crawlMaxPages) {
        const next = queue.shift();
        if (visited.has(next) || SKIP.test(next)) continue;
        visited.add(next);

        try {
          log(`crawl [${visited.size}/${crawlMaxPages}] ${next}`);
          await page.goto(next, { waitUntil: 'networkidle2', timeout: 30_000 });
          await sleep(crawlDelayMs);
          // scroll untuk trigger lazy-load / infinite scroll
          try {
            await page.evaluate(async () => {
              for (let y = 0; y < 3; y++) {
                window.scrollTo(0, document.body.scrollHeight);
                await new Promise((r) => setTimeout(r, 400));
              }
              window.scrollTo(0, 0);
            });
          } catch {}
          for (const l of await collectLinks()) enqueue(l);
        } catch (e) {
          log(`  crawl warning: ${e.message}`);
        }
      }
      crawlDone = true;
      log(`=== AUTO-CRAWL SELESAI === (${visited.size} halaman dikunjungi)`);
      if (browserAlive) {
        log('crawl selesai, menutup browser...');
        await snapshotSession();
        browser.close().catch(() => {});
      }
    }
  }

  await new Promise((resolve) => browser.on('disconnected', resolve));
  if (closeTimer) clearTimeout(closeTimer);
  if (maxTimeoutTimer) clearTimeout(maxTimeoutTimer);
  if (sessionTimer) clearInterval(sessionTimer);

  httpLog.end();
  wsLog.end();
  if (typeof reqLog?.end === 'function') reqLog.end();
  const catStr = Object.entries(categoryStats)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ') || 'none';
  log(`Sesi browser selesai. HTTP: ${httpCount} (${catStr}), WS: ${wsCount}`);
  if (lastSessionOk) log(`session.json tersimpan (cookies + localStorage) -> ${dumpDir}`);
  return {
    httpCount,
    wsCount,
    dumpDir,
    categoryStats,
    token: capturedToken,
    sessionSaved: lastSessionOk,
  };
}

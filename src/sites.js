// Site registry. Tambahkan entry baru di sini untuk scrape game/web sejenis
// (Colyseus + SIWS Solana auth).
//
// Struktur tiap site:
//   name           : id pendek (huruf kecil, dipakai sebagai nama folder)
//   webBase        : root halaman web (https://...)
//   apiBase        : root API/Colyseus (https://...)
//   type           : 'siws' (default) | 'farmtown' | 'rest'  -- tipe pipeline
//   siws           : { domain, uri, statement }  -- payload pesan SIWS (type=siws)
//   auth           : { noncePath, siwsPath }     -- endpoint Colyseus auth (type=siws)
//   spawn          : { path, tokenParam }        -- endpoint matchmaking (type=siws)
//   realtimeBase   : URL Socket.IO realtime (type=farmtown)
//   rest           : { auth, snapshotEndpoints, expand, pollEndpoints, ... } (type=rest)
//   staticAssets   : daftar path JSON statis yang perlu di-fetch dari webBase

export const SITES = {
  farmtown: {
    name: 'farmtown',
    type: 'farmtown',
    webBase: 'https://play.farmtown.online',
    apiBase: 'https://play.farmtown.online',
    realtimeBase: 'wss://realtime.farmtown.online',
    staticAssets: [],
  },

  cozyville: {
    name: 'cozyville',
    webBase: 'https://cozyville.fun',
    apiBase: 'https://cozyville.fly.dev',
    siws: {
      domain: 'cozyville.fun',
      uri: 'https://cozyville.fun/play/',
      statement: 'Sign in to Cozyville.',
    },
    auth: { noncePath: '/auth/nonce', siwsPath: '/auth/siws' },
    spawn: { path: '/spawn-region', tokenParam: 'token' },
    staticAssets: [
      '/atlases/manifest.json',
      '/atlases/world.atlas.json',
    ],
  },

  // Realm Rumble — game strategi Solana berbasis REST API (token Bearer).
  // Bukan Colyseus/SIWS: punya API sendiri di same-origin (/api/...).
  // Auth demo cukup kirim label -> dapat token, jadi bisa headless penuh.
  realmrumble: {
    name: 'realmrumble',
    type: 'rest',
    webBase: 'https://playrealmrumble.com',
    apiBase: 'https://playrealmrumble.com',
    rest: {
      // Login anonim/demo: { ok, token, user:{ id, username, empireId, demo } }
      auth: {
        method: 'POST',
        path: '/api/auth/demo',
        body: { label: 'scraper-bot' },
        tokenField: 'token',
      },
      // Endpoint yang di-fetch sekali di awal (snapshot penuh)
      snapshotEndpoints: [
        '/api/me',
        '/api/empires',
        '/api/stats',
        '/api/leaderboard',
        '/api/features',
        '/api/shop/config',
        '/api/alliances',
        '/api/arena/rankings',
        '/api/exchange/config',
        '/api/exchange/listings',
        '/api/market/listings',
        '/api/market/activity',
        '/api/characters/config',
        '/api/burns',
      ],
      // Ambil detail per-item dari list besar (dibatasi limit)
      expand: [
        {
          listPath: '/api/empires',
          arrayField: 'rows',
          idField: 'id',
          detail: '/api/empires/{id}',
          outDir: 'empires',
          limit: 50,
          delayMs: 60,
        },
        {
          listPath: '/api/empires',
          arrayField: 'rows',
          idField: 'id',
          detail: '/api/player/{id}',
          outDir: 'players',
          limit: 50,
          delayMs: 60,
        },
      ],
      // Endpoint dinamis yang dipantau berkala (state yang berubah-ubah)
      pollEndpoints: [
        '/api/stats',
        '/api/leaderboard',
        '/api/market/activity',
        '/api/market/listings',
        '/api/arena/rankings',
      ],
      pollIntervalMs: 10_000,
      pollDurationMs: 0, // 0 = jalan terus sampai Ctrl+C
      requestDelayMs: 80,
    },
  },

  // Contoh template untuk site baru:
  //
  // newgame: {
  //   name: 'newgame',
  //   webBase: 'https://newgame.example',
  //   apiBase: 'https://newgame-api.fly.dev',
  //   siws: {
  //     domain: 'newgame.example',
  //     uri: 'https://newgame.example/play/',
  //     statement: 'Sign in to NewGame.',
  //   },
  //   auth: { noncePath: '/auth/nonce', siwsPath: '/auth/siws' },
  //   spawn: { path: '/spawn-region', tokenParam: 'token' },
  //   staticAssets: ['/assets/world.json'],
  // },
};

export function getSite(name) {
  const s = SITES[name];
  if (!s) {
    const list = Object.keys(SITES).join(', ');
    throw new Error(
      `Site "${name}" tidak dikenal. Tersedia: ${list}. ` +
        `Tambahkan ke src/sites.js untuk site baru.`
    );
  }
  return s;
}

export function listSites() {
  return Object.values(SITES).map((s) => ({
    name: s.name,
    webBase: s.webBase,
    apiBase: s.apiBase,
  }));
}

# Skill: Web/Game Data Scraper (Universal + Colyseus/Solana SIWS)

Skill ini scraper data untuk web apa saja. Dua mode:

- **Web3 game (Colyseus + SIWS Solana)** — auth otomatis pakai wallet, decode
  state game real-time. Contoh: Cozyville.
- **Web biasa (non-web3)** — login manual (email/password/OAuth) di browser,
  bot record semua HTTP/WebSocket + simpan cookies & localStorage ke
  `session.json`. Contoh: SaaS, dashboard, AI tools, dll.

Tujuannya mengumpulkan data secara pasif (observer). Untuk game multiplayer,
tanpa aksi gameplay.

> **Batasan etis & legal (WAJIB dipatuhi):**
> Skill ini HANYA untuk pengumpulan data pasif (observer). JANGAN dipakai untuk
> mengotomasi aksi gameplay (mining, farming, trading, quest) di game
> multiplayer — itu umumnya melanggar Terms of Service dan merugikan pemain
> lain. Bot ini sengaja TIDAK punya kemampuan mengirim aksi gameplay, dan
> kemampuan itu tidak boleh ditambahkan. `signTransaction` di wallet injector
> sengaja dimatikan agar tidak bisa transaksi onchain.

---

## 1. Apa yang dilakukan skill ini

1. **Auth otomatis** — login ke game pakai wallet Solana (private key di
   `pk.txt`), via SIWS headless atau browser (auto-sign).
2. **Token management** — cache token, deteksi expired, refresh otomatis.
3. **Passive scraping** — connect ke room Colyseus sebagai observer, decode
   state real-time ke JSON terstruktur.
4. **Browser capture** — untuk site yang belum dikenal, buka Chrome dan record
   semua HTTP response + WebSocket frame, dipisah per kategori.
5. **Multi-site** — tiap site output ke folder sendiri (`dump/<brand>/`).

---

## 2. Arsitektur & file

```
bot.js                    # Entry point, REPL interaktif + CLI, orkestrasi
src/
├── sites.js              # Registry site dikenal (DETECT + config per-site)
├── dispatcher.js         # Routing URL -> site / folder name
├── auth.js               # SIWS flow (nonce -> sign -> token) + cek expired
├── wallet.js             # Load PK dari pk.txt (base58/JSON/hex/base64)
├── wallet-injector.js    # Inject Wallet Standard provider ke browser (auto-sign)
├── browser-capture.js    # puppeteer-core: capture trafik, deteksi in-game
└── scraper.js            # Colyseus client observer, decode state -> NDJSON
```

### Dependency
| Package | Fungsi |
|---------|--------|
| `colyseus.js` | Client Colyseus, decode protokol schema |
| `puppeteer-core` | Drive Chrome/Edge yang sudah ter-install |
| `tweetnacl` | Ed25519 signing |
| `bs58` | Encode/decode base58 (alamat & signature Solana) |
| `ws` | WebSocket (raw dump mode) |

> `puppeteer-core` TIDAK download Chromium. Skill cari Chrome/Edge yang sudah
> ada di sistem (atau env `CHROME_PATH`).

---

## 3. Alur kerja (flow)

### Site dikenal (ada di `src/sites.js`) — full auto pipeline
```
URL -> detectSite() cocok
  1. getValidToken():
     a. cek dump/<site>/token.txt -> kalau valid, pakai
     b. coba SIWS headless (auth.js, pakai pk.txt) -> cepat, tanpa browser
     c. kalau gagal -> fetchTokenViaBrowser() (Chrome, auto-sign, auto-close)
  2. fetchSpawnRegion(token) -> seat reservation Colyseus
  3. scrapeColyseus() -> join room sebagai observer, decode state
  4. room close 4001/4002/4003 (auth) -> hapus token, loop balik ke 1
  5. MAX_FAILURES=3 kegagalan beruntun -> stop
```

### Site tidak dikenal — browser raw capture
```
URL -> detectSite() null
  -> captureBrowserSession(): buka Chrome, inject wallet (kalau pk.txt ada),
     record semua HTTP+WS sampai user tutup browser
```

### Deteksi "sudah masuk game" (auto-close browser)
Browser ditutup otomatis setelah:
- Token captured (dari `/auth/siws` response ATAU dari URL `?token=` di spawn endpoint)
- WebSocket BARU terbuka setelah token (= auth WS)
- Frame pertama di WS itu masuk (= konfirmasi join room)
- Tunggu `closeDelayMs` (default 30 detik) -> tutup
- Safety: 3 menit tidak terdeteksi in-game -> tutup paksa

---

## 4. Penggunaan

```bash
node bot.js                  # REPL interaktif
node bot.js <url>            # scrape sekali lalu lanjut REPL
node bot.js --once <url>     # scrape sekali lalu keluar
node bot.js --browser <url>  # paksa browser raw capture (skip pipeline auto)
node bot.js --headless <url> # paksa headless, throw kalau gagal (no fallback)
node bot.js --wallet <url>   # aktifkan wallet auto-sign di browser (site web3)
node bot.js --no-wallet      # nonaktifkan wallet auto-sign di browser mode
node bot.js --list           # daftar site dikenal
```

REPL commands: `<url>`, `list`, `help`, `exit`. `Ctrl+C` interrupt sesi scrape
tanpa keluar bot.

### Web biasa (non-web3)
Untuk site biasa (login email/password/OAuth), cukup:
```bash
node bot.js https://slendro-ai.com/login
```
- Site tidak ada di registry -> otomatis browser mode.
- Wallet TIDAK di-inject (default off untuk site tak dikenal). Untuk site web3
  tak dikenal yang butuh wallet, tambah `--wallet`.
- Login manual di Chrome (email/password, Google, dll).
- Bot record semua HTTP (dipisah `api/data/pages/assets`) + WebSocket selama
  browser terbuka.
- Saat browser ditutup, `session.json` (cookies + localStorage) tersimpan ->
  bisa dipakai untuk scraping API headless nanti.
- Profile Chrome persistent (`profiles/<brand>/`) -> sesi login tetap antar run.

### Setup wallet
Buat `pk.txt` di root, isi 1 baris private key Solana. Format didukung:
- Base58 (Phantom export, ~88 char)
- JSON array 64 byte (`solana-keygen` / id.json)
- Hex 128 char
- Base64

---

## 5. Output

```
dump/<brand>/
├── token.txt                 # token SIWS aktif (cache)
├── spawn-region.json         # seat reservation terakhir
├── <static-assets>.json      # mis. manifest.json, world.atlas.json
├── state-snapshot.json       # snapshot state PERTAMA (lengkap, paling penting)
├── state-<ts>.ndjson         # tiap update state (1 baris = 1 update, decoded)
├── messages-<ts>.ndjson      # tiap server message (chat, event, dll)
├── http-<ts>.ndjson          # (browser mode) aggregate semua HTTP response
├── ws-<ts>.ndjson            # (browser mode) semua frame WebSocket
├── session.json              # (browser mode) cookies + localStorage saat ditutup
├── api/  data/  pages/  assets/  js/   # (browser mode) file per kategori
profiles/<brand>/             # Chrome profile persistent (ekstensi tetap)
```

Kategori browser capture (lihat `categorize()` di browser-capture.js):
- `api` — XHR/Fetch, cross-origin, atau path `/api|/v\d|/auth|/graphql|/rpc|/trpc`
- `data` — JSON statis dari origin sendiri
- `pages` — HTML
- `assets` — SVG, text
- `js` — bundle JS (off default; set env `SAVE_JS=1`)
- image/font/css di-skip

---

## 6. Menambah site baru (cara cepat)

1. Scrape dulu dengan browser mode untuk discovery:
   ```bash
   node bot.js --browser https://newgame.example
   ```
   Login & main sebentar, tutup browser.

2. Periksa `dump/<brand>/api/` dan `http-*.ndjson` untuk menemukan:
   - Endpoint nonce (POST, return `{nonce}`)
   - Endpoint SIWS verify (POST, return `{token}`)
   - Endpoint matchmaking/spawn (return seat reservation Colyseus)
   - `statement` di pesan SIWS (lihat log `[auto-sign]` atau request body)
   - Static asset JSON penting

3. Tambah entry ke `src/sites.js`:
   ```js
   newgame: {
     name: 'newgame',
     webBase: 'https://newgame.example',
     apiBase: 'https://newgame-api.example',
     siws: {
       domain: 'newgame.example',
       uri: 'https://newgame.example/play/',
       statement: 'Sign in to NewGame.',   // HARUS sama persis dengan frontend
     },
     auth: { noncePath: '/auth/nonce', siwsPath: '/auth/siws' },
     spawn: { path: '/spawn-region', tokenParam: 'token' },
     staticAssets: ['/assets/world.json'],
   },
   ```

4. Jalankan `node bot.js https://newgame.example` — sekarang pakai pipeline auto.

---

## 7. Cara reverse-engineer site (teknik discovery)

Teknik yang dipakai untuk memetakan Cozyville (bisa diulang untuk site lain):

1. **Render halaman `/play/`** dengan browser, ekstrak referensi bundle JS
   (`<script src=...>`).
2. **Download bundle**, cari string endpoint dengan regex:
   - `/auth`, `/nonce`, `/siws`, `/spawn`, `/matchmake`
   - `wss?://`, `https?://<apihost>`
   - keyword: `signMessage`, `siws`, `colyseus`, `sessionId`, `nonce`
3. **Ekstrak fungsi SIWS** untuk tahu format pesan persis (urutan baris,
   statement). Format SIWS umum:
   ```
   ${domain} wants you to sign in with your Solana account:
   ${address}

   ${statement}

   URI: ${uri}
   Nonce: ${nonce}
   ```
4. **Cek protokol WS** — kalau pakai `@colyseus/schema`, gunakan `colyseus.js`
   sebagai client (auto-decode). Kalau bukan, dump raw frame dan analisis
   header byte (opcode).

> Untuk discovery besar, gunakan browser mode lalu baca `api/` dan `js/`
> (set `SAVE_JS=1`). Jangan hardcode asumsi sebelum lihat data nyata.

---

## 8. Detail teknis penting

### SIWS (auth.js)
- `buildSiwsMessage()` membangun pesan, urutan baris harus PERSIS sama dengan
  frontend atau server tolak (401).
- Body POST `/auth/siws`: `{ address, signedMessage: number[], signature: base58 }`.
- `isTokenExpired()` parse token format `<pubkey>\t<sessionId>\t<issued>\t<expires>.<hmac>`,
  cek field expires (unix detik) dengan margin 30 detik.

### Wallet injection (wallet-injector.js)
- Inject 2 cara: Wallet Standard (`wallet-standard:register-wallet`) dan
  Phantom-compat (`window.solana` / `window.phantom`).
- Bridge `window.__cozySign(b64msg)` -> Node sign Ed25519 -> return b64 signature.
- `signMessage` AUTO-SIGN tanpa konfirmasi. `signTransaction` SENGAJA throw
  (login-only, mencegah transaksi onchain tak disengaja).

### Colyseus scraper (scraper.js)
- `consumeSeatReservation(reservation)` join room dari seat reservation.
- `deepJson()` walk Schema/MapSchema/ArraySchema -> plain JSON (skip properti
  `$`/`_`-prefixed yang metadata internal).
- Listen `onStateChange` (state penuh) + `onMessage('*')` (semua pesan).
- Return `{ code, state, messages, errors }`; `code` = WebSocket close code.

### Close codes (Colyseus auth)
| Code | Arti |
|------|------|
| 1000 | Normal close |
| 4001/4002/4003 | Auth/session error (seat reservation expired) -> refresh token |

---

## 9. Konfigurasi yang bisa di-tune

| Lokasi | Variabel | Default | Fungsi |
|--------|----------|---------|--------|
| `bot.js` | `CONFIG.pkFile` | `pk.txt` | Path private key |
| `bot.js` | `CONFIG.baseDumpDir` | `dump` | Root output |
| `bot.js` | `MAX_FAILURES` | `3` | Stop setelah N gagal beruntun |
| `browser-capture.js` | `closeDelayMs` | `30000` | Jeda sebelum auto-close browser |
| `browser-capture.js` | `inGameMaxWaitMs` | `180000` | Hard timeout deteksi in-game |
| env | `CHROME_PATH` | auto-detect | Path executable browser |
| env | `SAVE_JS` | `0` | `1` untuk simpan bundle JS |

---

## 10. Ide ekspansi (yang BOLEH ditambahkan)

Semua read-only / analisis, tidak menyentuh aksi gameplay:

- **Decoder/parser** NDJSON state -> tabel terstruktur (player, item, market, node).
- **Database sink** — tulis state ke SQLite/Postgres, bukan cuma NDJSON.
- **Market tracker** — log harga item ke CSV/time-series untuk analisis tren.
- **Map renderer** — render `world.atlas.json` + posisi node jadi gambar peta.
- **Replay tool** — putar ulang sesi dari NDJSON.
- **Notifier** — alert (desktop/Telegram) saat event/item tertentu muncul.
- **Multi-account observer** — beberapa pk untuk paralel observe region berbeda.
- **Schema dumper** — ekspor definisi schema Colyseus untuk dokumentasi protokol.

### Yang TIDAK boleh ditambahkan
- Mengirim aksi gameplay (move, mine, chop, fish, craft, trade, quest).
- `room.send(...)` dengan payload aksi.
- `signTransaction` / transaksi onchain otomatis.
- Apa pun yang mensimulasikan pemain aktif untuk keuntungan in-game.

---

## 11. Keamanan

- `pk.txt` = kontrol penuh wallet. Sudah di-`.gitignore`. Jangan commit/share.
- Wallet auto-sign menandatangani SEMUA pesan tanpa konfirmasi — hanya buka
  site terpercaya. Untuk site baru, jalankan `--no-wallet` dulu untuk inspeksi.
- Gunakan wallet "burner" dengan saldo minimum, bukan wallet utama.
- `dump/token.txt` berisi token sesi aktif — juga sensitif (di-gitignore via `dump/`).
- Jangan echo isi `pk.txt` / token ke log atau output.
```

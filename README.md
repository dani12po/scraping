# Web/Game Scraper

Bot scraper universal untuk web dan game berbasis Colyseus + Solana SIWS auth. Mendukung dua mode: **headless otomatis** untuk game web3 yang dikenal, dan **browser capture** untuk site apa pun.

## Fitur

- Auth otomatis via SIWS headless (tanpa browser) pakai `pk.txt`
- Fallback ke browser dengan wallet auto-sign jika headless gagal
- Passive observer Colyseus — decode state real-time ke JSON terstruktur
- Browser capture: record semua HTTP response + WebSocket frame
- Multi-site output ke folder terpisah (`dump/<brand>/`)
- Token cache + auto-refresh saat expired
- Auto-crawl halaman same-origin (opsional)

## Prasyarat

- Node.js >= 18
- Google Chrome atau Microsoft Edge ter-install
- (Opsional) `pk.txt` berisi private key Solana untuk mode headless/wallet

## Instalasi

```bash
npm install
```

## Setup Wallet

Buat file `pk.txt` di root project, isi dengan private key Solana kamu (satu baris). Format yang didukung:

- Base58 (~88 karakter) — export dari Phantom
- JSON array 64 byte — format `solana-keygen` / `id.json`
- Hex 128 karakter
- Base64

> **Penting:** `pk.txt` sudah di-gitignore. Jangan pernah commit file ini.

## Penggunaan

```bash
# REPL interaktif
node bot.js

# Scrape satu URL lalu lanjut REPL
node bot.js <url>

# Scrape sekali lalu keluar
node bot.js --once <url>

# Paksa mode browser raw capture
node bot.js --browser <url>

# Setelah login, auto-crawl semua halaman same-origin
node bot.js --crawl <url>

# Aktifkan wallet auto-sign di mode browser
node bot.js --wallet <url>

# Nonaktifkan wallet auto-sign
node bot.js --no-wallet

# Daftar site yang dikenal
node bot.js --list
```

### Perintah dalam REPL

| Perintah | Fungsi |
|----------|--------|
| `<url>` | Scrape URL tersebut |
| `list` | Tampilkan site yang dikenal |
| `help` | Bantuan singkat |
| `exit` | Keluar |
| `Ctrl+C` | Interrupt sesi scrape, kembali ke prompt |

## Site yang Dikenal

Site berikut sudah dikonfigurasi untuk pipeline auto (headless SIWS + Colyseus):

| Nama | URL | Tipe |
|------|-----|------|
| `cozyville` | https://cozyville.fun | SIWS + Colyseus |
| `farmtown` | https://play.farmtown.online | Socket.IO + Supabase |
| `realmrumble` | https://playrealmrumble.com | REST API |

Site di luar daftar ini otomatis menggunakan mode browser capture.

## Alur Kerja

### Site Dikenal (Full Auto Pipeline)

```
URL cocok di sites.js
  → cek token cache (dump/<site>/token.txt)
  → headless SIWS login (pk.txt)      ← cepat, tanpa buka browser
  → fallback: browser login (auto-sign, auto-close setelah token didapat)
  → fetchSpawnRegion → seat reservation Colyseus
  → scrapeColyseus (observer) → decode state → NDJSON
  → token expired/auth error → loop ulang dari awal
```

### Site Tidak Dikenal (Browser Capture)

```
URL tidak dikenal
  → buka Chrome dengan profile persistent
  → inject wallet auto-sign (kalau pk.txt ada)
  → record semua HTTP + WebSocket selama browser terbuka
  → simpan session.json (cookies + localStorage) saat browser ditutup
```

## Struktur Output

```
dump/<brand>/
├── token.txt               # Token aktif (cache)
├── spawn-region.json       # Seat reservation terakhir
├── state-snapshot.json     # Snapshot state pertama (paling penting)
├── state-<ts>.ndjson       # Semua update state (1 baris = 1 update)
├── messages-<ts>.ndjson    # Server messages
├── http-<ts>.ndjson        # (browser mode) aggregate HTTP response
├── ws-<ts>.ndjson          # (browser mode) frame WebSocket
├── requests-<ts>.ndjson    # (browser mode) request non-GET beserta payload
├── session.json            # (browser mode) cookies + localStorage
├── api/                    # File per kategori: XHR/Fetch/API calls
├── data/                   # JSON statis dari origin sendiri
├── pages/                  # HTML
└── assets/                 # SVG, teks lainnya
```

## Struktur Project

```
bot.js                    # Entry point, REPL, orkestrasi pipeline
analyze.mjs               # Analisis file HTTP capture NDJSON
src/
├── sites.js              # Registry site dikenal + config per-site
├── dispatcher.js         # Routing URL → site config / nama folder
├── auth.js               # SIWS flow: nonce → sign → token + cek expired
├── auth-farmtown.js      # Auth khusus FarmTown (Supabase + wallet challenge)
├── wallet.js             # Load private key dari pk.txt (multi-format)
├── wallet-injector.js    # Inject Wallet Standard provider ke browser
├── browser-capture.js    # puppeteer-core: capture trafik + deteksi in-game
├── scraper.js            # Colyseus client observer, decode state → NDJSON
└── scraper-rest.js       # REST polling scraper (snapshot + poll loop)
```

## Menambah Site Baru

1. Scrape dulu dengan browser untuk discovery:
   ```bash
   node bot.js --browser https://newgame.example
   ```

2. Periksa `dump/<brand>/api/` dan `http-*.ndjson` untuk temukan endpoint SIWS dan spawn.

3. Tambah entry ke `src/sites.js`:
   ```js
   newgame: {
     name: 'newgame',
     webBase: 'https://newgame.example',
     apiBase: 'https://newgame-api.example',
     siws: {
       domain: 'newgame.example',
       uri: 'https://newgame.example/play/',
       statement: 'Sign in to NewGame.',
     },
     auth: { noncePath: '/auth/nonce', siwsPath: '/auth/siws' },
     spawn: { path: '/spawn-region', tokenParam: 'token' },
     staticAssets: ['/assets/world.json'],
   },
   ```

4. Jalankan: `node bot.js https://newgame.example`

## Menganalisis Hasil Capture

```bash
# Analisis file HTTP capture NDJSON
node analyze.mjs dump/<brand>/http-*.ndjson
```

Output: daftar semua endpoint, request non-GET beserta payload & response, dan halaman HTML yang ditemukan.

## Variabel Lingkungan

| Variabel | Default | Fungsi |
|----------|---------|--------|
| `CHROME_PATH` | auto-detect | Path executable Chrome/Edge |
| `SAVE_JS` | `0` | Set `1` untuk simpan bundle JS (besar) |

## Catatan Keamanan

- `pk.txt` = kontrol penuh wallet. Sudah di-gitignore, jangan commit.
- Wallet auto-sign menandatangani semua `signMessage` tanpa konfirmasi — hanya buka site terpercaya.
- Gunakan wallet "burner" dengan saldo minimum, bukan wallet utama.
- `signTransaction` sengaja dimatikan di wallet injector untuk mencegah transaksi onchain.
- `dump/token.txt` berisi token sesi aktif — juga sensitif (di-gitignore via `dump/`).

## Dependencies

| Package | Fungsi |
|---------|--------|
| `colyseus.js` | Client Colyseus, decode protokol schema |
| `puppeteer-core` | Drive Chrome/Edge yang sudah ter-install (tidak download Chromium) |
| `tweetnacl` | Ed25519 signing |
| `bs58` | Encode/decode base58 (alamat & signature Solana) |
| `ws` | WebSocket |

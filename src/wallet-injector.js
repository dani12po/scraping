// Inject Wallet Standard provider ke browser supaya site bisa "connect wallet"
// dan otomatis ditandatangani memakai PK dari pk.txt. Tidak perlu Phantom dll.
//
// Yang di-inject:
//   1. Wallet Standard wallet (nama "CozyBot") -> muncul di wallet picker
//   2. window.solana / window.phantom (Phantom-compat) -> auto-detect sebagai Phantom
//
// Yang didukung:
//   - standard:connect / disconnect / events
//   - solana:signMessage   <- DIPAKAI untuk SIWS login (auto-sign)
//   - solana:signTransaction -> throw (mode login-only, untuk safety)
//
// PERHATIAN: Setiap permintaan signMessage akan otomatis ditandatangani tanpa
// konfirmasi user. Hanya buka site yang Anda percaya dengan mode ini aktif.

import fs from 'node:fs';
import nacl from 'tweetnacl';
import { loadKeypairFromFile } from './wallet.js';

// ----------------- IN-BROWSER SCRIPT -----------------
// Function ini akan diserialisasi sebagai string dan dieksekusi di browser context.
// Tidak boleh pakai variabel/import dari Node.
function injectWalletScript({ address, publicKeyArr, walletName, walletIcon }) {
  const publicKey = new Uint8Array(publicKeyArr);

  const u8ToB64 = (u8) => {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  };
  const b64ToU8 = (b64) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };

  async function signBytes(bytes) {
    const sigB64 = await window.__cozySign(u8ToB64(bytes));
    return b64ToU8(sigB64);
  }

  // ---- Wallet Standard wallet ----
  const account = {
    address,
    publicKey,
    chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet'],
    features: ['solana:signMessage', 'solana:signTransaction'],
    label: walletName,
  };

  const wallet = {
    version: '1.0.0',
    name: walletName,
    icon: walletIcon,
    chains: ['solana:mainnet', 'solana:devnet', 'solana:testnet'],
    accounts: [account],
    features: {
      'standard:connect': {
        version: '1.0.0',
        connect: async () => ({ accounts: [account] }),
      },
      'standard:disconnect': {
        version: '1.0.0',
        disconnect: async () => {},
      },
      'standard:events': {
        version: '1.0.0',
        on: () => () => {},
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...args) => {
          const inputs = args.flat();
          const results = [];
          for (const inp of inputs) {
            const sig = await signBytes(inp.message);
            results.push({ signedMessage: inp.message, signature: sig });
          }
          return results;
        },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        signTransaction: async () => {
          throw new Error(
            walletName +
              ': signTransaction tidak didukung (mode login-only). ' +
              'Untuk transaksi onchain pakai ekstensi Phantom/Solflare asli.'
          );
        },
      },
    },
  };

  function registerMe(api) {
    try { api.register(wallet); }
    catch (e) { console.warn('[' + walletName + '] register failed', e); }
  }
  window.addEventListener('wallet-standard:app-ready', (e) => registerMe(e.detail));
  window.dispatchEvent(
    new CustomEvent('wallet-standard:register-wallet', { detail: registerMe })
  );

  // ---- Phantom-compat (window.solana / window.phantom.solana) ----
  const phantomLike = {
    isPhantom: true,
    publicKey: {
      toString: () => address,
      toBase58: () => address,
      toBytes: () => publicKey,
      toBuffer: () => publicKey,
      equals: (other) => other && other.toString && other.toString() === address,
    },
    isConnected: false,
    connect: async () => {
      phantomLike.isConnected = true;
      return { publicKey: phantomLike.publicKey };
    },
    disconnect: async () => {
      phantomLike.isConnected = false;
    },
    signMessage: async (message) => {
      const bytes =
        message instanceof Uint8Array
          ? message
          : new TextEncoder().encode(String(message));
      const sig = await signBytes(bytes);
      return { publicKey: phantomLike.publicKey, signature: sig };
    },
    signTransaction: async () => {
      throw new Error(walletName + ': signTransaction tidak didukung');
    },
    signAllTransactions: async () => {
      throw new Error(walletName + ': signAllTransactions tidak didukung');
    },
    on: () => {},
    off: () => {},
    request: async () => {
      throw new Error(walletName + ': request() tidak didukung');
    },
  };

  try {
    Object.defineProperty(window, 'solana', {
      value: phantomLike,
      writable: false,
      configurable: false,
    });
  } catch (e) {
    try { window.solana = phantomLike; } catch {}
  }
  try { window.phantom = { solana: phantomLike }; } catch {}

  console.log('[' + walletName + '] wallet injected:', address);
}

// ----------------- NODE SIDE -----------------
const ICON_DATA_URL =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">' +
      '<rect width="16" height="16" fill="#2b7fff"/>' +
      '<text x="8" y="12" text-anchor="middle" fill="#fff" font-size="10" font-family="monospace">$</text>' +
      '</svg>'
  ).toString('base64');

export async function setupWalletInjection({ page, pkFile, log = console.log, walletName = 'CozyBot' }) {
  if (!pkFile || !fs.existsSync(pkFile)) return null;

  const kp = loadKeypairFromFile(pkFile);
  log(`Wallet auto-sign AKTIF: ${kp.address} (semua signMessage akan otomatis ditandatangani)`);

  // Bridge: browser -> Node untuk signing
  await page.exposeFunction('__cozySign', async (b64msg) => {
    try {
      const msg = Uint8Array.from(Buffer.from(b64msg, 'base64'));
      const sig = nacl.sign.detached(msg, kp.secretKey);
      // Coba decode preview kalau printable, biar log informatif
      let preview = '';
      try {
        const utf = new TextDecoder('utf-8', { fatal: false }).decode(msg);
        if (/[\x20-\x7e]{6,}/.test(utf)) preview = ` "${utf.replace(/\s+/g, ' ').slice(0, 60)}..."`;
      } catch {}
      log(`  [auto-sign] ${msg.length}B${preview}`);
      return Buffer.from(sig).toString('base64');
    } catch (e) {
      log('  [auto-sign error]', e.message);
      throw e;
    }
  });

  await page.evaluateOnNewDocument(injectWalletScript, {
    address: kp.address,
    publicKeyArr: Array.from(kp.publicKey),
    walletName,
    walletIcon: ICON_DATA_URL,
  });

  return { address: kp.address };
}

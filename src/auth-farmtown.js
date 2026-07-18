// Auth headless untuk FarmTown (play.farmtown.online)
//
// Flow:
//   1. POST Supabase /auth/v1/signup?anonymous (atau refresh) -> access_token
//   2. POST /api/auth/wallet/challenge { walletAddress } -> challengeId, nonce, message
//   3. Sign message dengan private key (Ed25519, signature = base64)
//   4. POST /api/auth/wallet/verify { challengeId, nonce, walletAddress, message, signature }
//      -> walletSessionToken
//   5. Simpan ke localStorage: sb-...-auth-token, farmtown_wallet_address, dll
//
// Hasil: { accessToken, walletSessionToken, refreshToken, userId, profile }
//
// walletSessionToken expire dalam ~30 menit. accessToken expire dalam ~1 jam.
// Keduanya perlu di-refresh sebelum expired.

import fs from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { loadKeypairFromFile } from './wallet.js';

const FARMTOWN_API = 'https://play.farmtown.online';
const FARMTOWN_SUPABASE_URL = 'https://irarxwyrpmmxacrbvpnz.supabase.co';
// anon key diambil dari bundle JS game — public key, aman disimpan di sini
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlyYXJ4d3lycG1teGFjcmJ2cG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk5OTY4NDYsImV4cCI6MjA2NTU3Mjg0Nn0.n5oT7AMV_8yDmJCy1UcKqDf59J0rUFBLl_AoVrxfz3o';

const DEFAULT_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-language': 'en-US,en;q=0.9,id;q=0.8',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  origin: 'https://play.farmtown.online',
  referer: 'https://play.farmtown.online/',
};

async function fetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { ...DEFAULT_HEADERS, ...(init.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    throw new Error(`${init.method || 'GET'} ${url} -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

// ─── Step 1: Supabase anonymous sign-up ───────────────────────────────────────
// Kalau sudah ada token valid, refresh saja.
async function getSupabaseToken(savedToken = null) {
  // Coba refresh dulu kalau ada
  if (savedToken?.refresh_token) {
    try {
      const data = await fetchJson(
        `${FARMTOWN_SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY },
          body: JSON.stringify({ refresh_token: savedToken.refresh_token }),
        }
      );
      if (data.access_token) return data;
    } catch {}
  }

  // Sign up anonymous baru
  const data = await fetchJson(
    `${FARMTOWN_SUPABASE_URL}/auth/v1/signup`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: SUPABASE_ANON_KEY },
      body: JSON.stringify({}),
    }
  );
  if (!data.access_token) {
    throw new Error('Supabase anonymous signup gagal: tidak ada access_token');
  }
  return data;
}

// ─── Step 2–4: Wallet challenge / verify ──────────────────────────────────────
async function walletLogin(walletAddress, accessToken, signer) {
  // 2. Challenge
  const challenge = await fetchJson(
    `${FARMTOWN_API}/api/auth/wallet/challenge`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ walletAddress }),
    }
  );
  if (!challenge.nonce || !challenge.challengeId || !challenge.message) {
    throw new Error('Respon challenge tidak lengkap: ' + JSON.stringify(challenge));
  }

  // 3. Sign message
  const msgBytes = new TextEncoder().encode(challenge.message);
  const sigBytes = nacl.sign.detached(msgBytes, signer.secretKey);
  // FarmTown pakai base64 (bukan base58) untuk signature
  const signatureB64 = Buffer.from(sigBytes).toString('base64');

  // 4. Verify
  const verify = await fetchJson(
    `${FARMTOWN_API}/api/auth/wallet/verify`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        walletAddress,
        message: challenge.message,
        signature: signatureB64,
        displayName: signer.displayName || walletAddress.slice(0, 8),
      }),
    }
  );

  if (!verify.walletSessionToken) {
    throw new Error('walletSessionToken tidak ditemukan di respon verify');
  }
  return verify;
}

// ─── Cek apakah walletSessionToken masih valid ────────────────────────────────
export function isWalletSessionExpired(token, marginSec = 60) {
  if (!token) return true;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[0], 'base64').toString('utf8'));
    // token farmtown: { v, authUserId, playerId, walletAddress, iat, exp, nonce }
    if (payload.exp) {
      // exp dalam milliseconds (bukan Unix second!)
      const expMs = payload.exp;
      return Date.now() > expMs - marginSec * 1000;
    }
  } catch {}
  return false;
}

export function isSupabaseTokenExpired(accessToken, marginSec = 60) {
  if (!accessToken) return true;
  try {
    const parts = accessToken.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (payload.exp) {
      return Date.now() / 1000 > payload.exp - marginSec;
    }
  } catch {}
  return false;
}

// ─── Cache helper ─────────────────────────────────────────────────────────────
function loadCache(cacheFile) {
  try {
    if (fs.existsSync(cacheFile)) {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    }
  } catch {}
  return null;
}

function saveCache(cacheFile, data) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(data, null, 2));
  } catch {}
}

// ─── Entry point utama ────────────────────────────────────────────────────────
// Mengembalikan { accessToken, walletSessionToken, profile, farm }
export async function farmtownLogin({ pkFile, dumpDir, log = console.log }) {
  const cacheFile = path.join(dumpDir, 'farmtown-session.json');

  const keypair = loadKeypairFromFile(pkFile);
  log(`[farmtown] wallet: ${keypair.address}`);

  // Load cache
  let cache = loadCache(cacheFile);

  // Cek apakah cache masih valid
  if (
    cache &&
    cache.accessToken &&
    cache.walletSessionToken &&
    !isSupabaseTokenExpired(cache.accessToken) &&
    !isWalletSessionExpired(cache.walletSessionToken)
  ) {
    log('[farmtown] session cache valid, skip login');
    return cache;
  }

  // Step 1: Supabase token
  log('[farmtown] mendapatkan Supabase anonymous token...');
  let supabaseData;
  try {
    supabaseData = await getSupabaseToken(cache?.supabaseRaw);
  } catch (e) {
    throw new Error(`Supabase auth gagal: ${e.message}`);
  }
  const accessToken = supabaseData.access_token;
  log(`[farmtown] Supabase access_token ok (${accessToken.length} chars)`);

  // Step 2–4: Wallet login
  log('[farmtown] wallet challenge/verify...');
  let verifyResult;
  try {
    verifyResult = await walletLogin(keypair.address, accessToken, keypair);
  } catch (e) {
    throw new Error(`Wallet verify gagal: ${e.message}`);
  }
  log(`[farmtown] walletSessionToken ok, gameplayAllowed=${verifyResult.gameplayAllowed}`);

  const result = {
    accessToken,
    walletSessionToken: verifyResult.walletSessionToken,
    profile: verifyResult.profile,
    farm: verifyResult.farm,
    walletAddress: keypair.address,
    supabaseRaw: supabaseData, // simpan untuk refresh nanti
    cachedAt: Date.now(),
  };

  // Simpan cache
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(result, null, 2));
  } catch {}

  return result;
}

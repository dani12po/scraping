// Load Solana keypair dari file pk.txt
//
// Format yang didukung:
//  1. Base58 secret key (panjang ~88 char) - format Phantom export
//  2. JSON array byte (64 angka) - format solana-keygen / file id.json
//  3. Hex 128 char - format raw
//  4. Base64 - opsional
//
// File HARUS chmod-private dan WAJIB di-gitignore.

import fs from 'node:fs';
import path from 'node:path';
import nacl from 'tweetnacl';
import bs58 from 'bs58';

function tryDecode(raw) {
  const trimmed = raw.trim();

  // 1. JSON array
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr) && arr.length === 64) {
        return Uint8Array.from(arr);
      }
      if (Array.isArray(arr) && arr.length === 32) {
        // hanya seed, expand jadi keypair
        const kp = nacl.sign.keyPair.fromSeed(Uint8Array.from(arr));
        return kp.secretKey;
      }
    } catch {}
  }

  // 2. Hex (128 char untuk full secretKey, 64 untuk seed)
  if (/^[0-9a-f]+$/i.test(trimmed)) {
    if (trimmed.length === 128) {
      return Uint8Array.from(Buffer.from(trimmed, 'hex'));
    }
    if (trimmed.length === 64) {
      const seed = Uint8Array.from(Buffer.from(trimmed, 'hex'));
      return nacl.sign.keyPair.fromSeed(seed).secretKey;
    }
  }

  // 3. Base58 secret key (Phantom export biasanya 87-88 char)
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length === 64) return new Uint8Array(decoded);
    if (decoded.length === 32) {
      return nacl.sign.keyPair.fromSeed(new Uint8Array(decoded)).secretKey;
    }
  } catch {}

  // 4. Base64
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === 64) return new Uint8Array(buf);
    if (buf.length === 32) {
      return nacl.sign.keyPair.fromSeed(new Uint8Array(buf)).secretKey;
    }
  } catch {}

  throw new Error(
    'Format private key tidak dikenali. Gunakan base58, JSON array 64 byte, atau hex 128 char.'
  );
}

export function loadKeypairFromFile(filepath) {
  const abs = path.resolve(filepath);
  if (!fs.existsSync(abs)) {
    throw new Error(`File private key tidak ditemukan: ${abs}`);
  }
  const raw = fs.readFileSync(abs, 'utf8');
  const secretKey = tryDecode(raw);
  if (secretKey.length !== 64) {
    throw new Error(`secretKey panjangnya harus 64 byte, dapat ${secretKey.length}`);
  }
  // tweetnacl.sign.keyPair.fromSecretKey akan menurunkan publicKey 32-byte terakhir
  const kp = nacl.sign.keyPair.fromSecretKey(secretKey);
  const address = bs58.encode(kp.publicKey);
  return { address, publicKey: kp.publicKey, secretKey: kp.secretKey };
}

// Buat signer kompatibel dengan flow SIWS Cozyville:
// signMessage(messageBytes) -> { signedMessage: Uint8Array, signature: base58 }
export function makeSigner(keypair) {
  return {
    address: keypair.address,
    async signMessage(message) {
      const messageBytes =
        message instanceof Uint8Array ? message : new TextEncoder().encode(String(message));
      const sig = nacl.sign.detached(messageBytes, keypair.secretKey);
      return {
        signedMessage: messageBytes,
        signature: bs58.encode(sig),
      };
    },
  };
}

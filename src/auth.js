// SIWS (Sign-In With Solana) auth flow.
//
// Pola umum di backend Colyseus + Solana:
//   1. POST  ${api}${noncePath}  ->  { nonce }
//   2. Build pesan SIWS standar
//   3. Sign Ed25519
//   4. POST  ${api}${siwsPath}   ->  { token, wallet }
//
// Format pesan SIWS:
//   ${domain} wants you to sign in with your Solana account:
//   ${address}
//
//   ${statement}
//
//   URI: ${uri}
//   Nonce: ${nonce}

export function buildSiwsMessage({ domain, uri, address, nonce, statement = 'Sign in.' }) {
  const lines = [
    `${domain} wants you to sign in with your Solana account:`,
    address,
    '',
    statement,
    '',
    `URI: ${uri}`,
    `Nonce: ${nonce}`,
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

const DEFAULT_HEADERS = {
  'accept': '*/*',
  'accept-language': 'en-US,en;q=0.9,id;q=0.8',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
};

export async function siwsLogin({
  apiBase,
  webBase,
  domain,
  uri,
  statement,
  signer,
  noncePath = '/auth/nonce',
  siwsPath = '/auth/siws',
}) {
  const refHeaders = {
    ...DEFAULT_HEADERS,
    'origin': webBase,
    'referer': `${webBase}/play/`,
  };

  // 1. nonce
  const nonceRes = await fetch(`${apiBase}${noncePath}`, {
    method: 'POST',
    headers: refHeaders,
  });
  if (!nonceRes.ok) {
    throw new Error(`${noncePath} gagal: ${nonceRes.status} ${await nonceRes.text()}`);
  }
  const { nonce } = await nonceRes.json();
  if (!nonce) throw new Error('respon nonce kosong');

  // 2. build & sign
  const messageBytes = buildSiwsMessage({
    domain,
    uri,
    address: signer.address,
    nonce,
    statement,
  });
  const { signedMessage, signature } = await signer.signMessage(messageBytes);

  // 3. siws verify
  const siwsRes = await fetch(`${apiBase}${siwsPath}`, {
    method: 'POST',
    headers: { ...refHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      address: signer.address,
      signedMessage: Array.from(signedMessage),
      signature,
    }),
  });
  if (!siwsRes.ok) {
    throw new Error(`${siwsPath} gagal: ${siwsRes.status} ${await siwsRes.text()}`);
  }
  const data = await siwsRes.json();
  if (!data.token) throw new Error(`respon ${siwsPath} tidak punya token`);
  return { token: data.token, wallet: data.wallet, nonce, message: messageBytes };
}

// Token format: <pubkey>\t<sessionId>\t<issued>\t<expires>.<hmac>
export function isTokenExpired(token, marginSec = 30) {
  if (!token) return true;
  const m = token.match(/\t(\d{10})\.[0-9a-f]+$/);
  if (!m) return false; // tidak tahu format, anggap valid
  const exp = Number(m[1]);
  return Date.now() / 1000 > exp - marginSec;
}

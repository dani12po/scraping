// Routing URL -> site config (kalau dikenal) atau capture browser (kalau tidak).
import { URL } from 'node:url';
import { SITES } from './sites.js';

export function detectSite(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return null; }
  const host = u.hostname.toLowerCase();
  for (const site of Object.values(SITES)) {
    try {
      const siteHost = new URL(site.webBase).hostname.toLowerCase();
      if (host === siteHost || host.endsWith('.' + siteHost)) return site;
    } catch {}
  }
  return null;
}

export function hostnameFor(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return urlStr;
  }
}

export function safeFolderName(host) {
  if (!host) return 'unknown';
  let h = String(host).toLowerCase().trim();
  // buang prefix "www."
  h = h.replace(/^www\./, '');
  // ambil segmen pertama (brand name), buang TLD
  // contoh: realmsol.xyz -> realmsol, cozyville.fun -> cozyville,
  //         api.cozyville.fly.dev -> api
  const i = h.indexOf('.');
  if (i > 0) h = h.slice(0, i);
  // sanitize karakter
  h = h.replace(/[^a-z0-9._-]/g, '_').slice(0, 80);
  return h || 'unknown';
}

export function normalizeUrl(input) {
  let s = String(input).trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    return new URL(s).toString();
  } catch {
    return null;
  }
}

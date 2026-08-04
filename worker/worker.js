/**
 * Cloudflare Worker — serves the OneDrive workbook to the browser with CORS.
 *
 * WHY THIS EXISTS
 *
 * The workbook is shared as "Anyone with the link", but a personal OneDrive
 * share link cannot be fetched directly by a browser. Two things block it, and
 * they need different fixes:
 *
 *   1. Redemption. A bare request for the file is refused. The link must first
 *      be "redeemed" — fetched so that the `redeem=` parameter in its redirect
 *      chain mints a `FedAuth` cookie — and only then does `?download=1` return
 *      the file. A browser cannot do this cross-origin: it can neither read
 *      Set-Cookie nor reliably attach third-party cookies.
 *   2. CORS. Even once redeemed, the response carries no
 *      Access-Control-Allow-Origin, so a page could not read the bytes.
 *
 * This Worker performs the redemption server-side and re-serves the bytes with
 * the CORS header the browser needs.
 *
 * Two request details are mandatory, both discovered empirically:
 *   - A browser User-Agent. Without one the endpoint returns 403.
 *   - The FedAuth cookie on every hop. With a UA but no cookie the endpoint
 *     returns 200 with the HTML *viewer page* rather than the file — which is
 *     why the app validates the `PK` zip signature instead of trusting a 200.
 *
 * Redirects are followed manually because fetch() drops the Cookie header when
 * a redirect crosses origin (1drv.ms → onedrive.live.com), which is precisely
 * where the cookie is required.
 *
 * DEPLOY: see ../docs/onedrive.md § Deploying the Worker.
 */

/** Origins allowed to call this Worker. Without this it is an open relay. */
const ALLOWED_ORIGINS = new Set([
  'https://ganeshbatchu.github.io',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
]);

/**
 * Share links this Worker will serve. Pinning the exact URL — rather than
 * accepting one from the query string — means the Worker cannot be pointed at
 * arbitrary content by a third party.
 */
const ALLOWED_SHARE_URLS = new Set([
  'https://1drv.ms/x/c/c55dffc6b8cf503a/IQCcJqztGhfcSI54_fUf1J7xAdQQXuKZhgTsDajsiRHUh8c?e=QawT7R',
]);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Cache at the edge so every page load doesn't re-run the redemption. */
const CACHE_SECONDS = 300;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function addCookies(jar, res) {
  const list = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const raw of list) {
    const [pair] = raw.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}

const cookieHeader = (jar) => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** Follows redirects manually, re-attaching cookies + UA on every hop. */
async function walk(startUrl, jar, maxHops = 10) {
  let url = startUrl;
  let res;
  for (let i = 0; i < maxHops; i++) {
    res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...(jar.size ? { Cookie: cookieHeader(jar) } : {}) },
    });
    addCookies(jar, res);
    const loc = res.headers.get('location');
    if (!loc) return res;
    url = new URL(loc, url).toString();
  }
  throw new Error('too many redirects');
}

async function fetchWorkbook(shareUrl) {
  const jar = new Map();

  // 1. Redeem the sharing link. The response body is discarded; the cookie is
  //    the whole point.
  await walk(shareUrl, jar);
  if (!jar.has('FedAuth')) {
    throw new Error('redemption did not yield a FedAuth cookie — the link may no longer '
      + 'be shared as "Anyone with the link"');
  }

  // 2. Download, now authorised by that cookie.
  const dl = shareUrl + (shareUrl.includes('?') ? '&' : '?') + 'download=1';
  const res = await walk(dl, jar);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const buf = await res.arrayBuffer();
  // An .xlsx is a zip and must start with "PK". A 200 alone proves nothing here:
  // the un-redeemed path also returns 200, with an HTML page.
  const sig = new Uint8Array(buf.slice(0, 2));
  if (sig[0] !== 0x50 || sig[1] !== 0x4b) {
    throw new Error('upstream returned HTML, not a workbook — redemption likely failed');
  }
  return buf;
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: cors });
    }
    if (!ALLOWED_ORIGINS.has(origin)) {
      // A browser would be blocked by the CORS header anyway; failing loudly
      // makes a misconfigured origin obvious instead of mysterious.
      return new Response(`Origin not allowed: ${origin || '(none)'}`, { status: 403, headers: cors });
    }

    const requested = new URL(request.url).searchParams.get('url')
      || [...ALLOWED_SHARE_URLS][0];
    if (!ALLOWED_SHARE_URLS.has(requested)) {
      return new Response('Share URL not allowed', { status: 403, headers: cors });
    }

    try {
      const buf = await fetchWorkbook(requested);
      return new Response(buf, {
        headers: {
          ...cors,
          'Content-Type': XLSX_TYPE,
          'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
        },
      });
    } catch (err) {
      return new Response(`Worker could not fetch the workbook: ${err.message}`, {
        status: 502,
        headers: { ...cors, 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  },
};

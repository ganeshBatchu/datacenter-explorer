#!/usr/bin/env node
/**
 * Downloads the workbook from its public OneDrive share link.
 *
 * Run at BUILD time (by .github/workflows/deploy.yml), not in the browser. The
 * result is published as part of the site, so the app fetches it same-origin —
 * no CORS, no proxy, no sign-in — while the dataset itself never enters git.
 *
 * A personal OneDrive share link cannot be downloaded with a single request.
 * Two things are required, both established by testing:
 *
 *   1. Redemption. The link must first be fetched so that the `redeem=`
 *      parameter in its redirect chain mints a `FedAuth` cookie. Only then does
 *      `?download=1` return the file.
 *   2. A browser User-Agent. Without one the endpoint answers 403. With a UA but
 *      no cookie it answers 200 carrying the HTML *viewer page* — which is why
 *      a 200 is never trusted on its own and the zip signature is checked.
 *
 * Redirects are followed by hand because fetch() drops the Cookie header when a
 * redirect crosses origin (1drv.ms → onedrive.live.com), which is exactly where
 * the cookie is needed.
 *
 *   node scripts/fetch-workbook.mjs [--out data/master_dataset_1_values_3.xlsx]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SHARE_URL = process.env.WORKBOOK_SHARE_URL
  || 'https://1drv.ms/x/c/c55dffc6b8cf503a/IQCcJqztGhfcSI54_fUf1J7xAdQQXuKZhgTsDajsiRHUh8c?e=QawT7R';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const outArg = process.argv.indexOf('--out');
const OUT = resolve(outArg > -1 ? process.argv[outArg + 1] : 'data/master_dataset_1_values_3.xlsx');

/** Smallest plausible size for this workbook; guards against a truncated body. */
const MIN_BYTES = 50_000;

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
async function walk(startUrl, jar, label) {
  let url = startUrl;
  let res;
  for (let hop = 1; hop <= 10; hop++) {
    res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, ...(jar.size ? { Cookie: cookieHeader(jar) } : {}) },
    });
    addCookies(jar, res);
    const loc = res.headers.get('location');
    console.log(`  ${label} hop ${hop}: HTTP ${res.status}${loc ? ' → redirect' : ''}`);
    if (!loc) return res;
    url = new URL(loc, url).toString();
  }
  throw new Error('too many redirects');
}

async function main() {
  console.log(`share link: ${SHARE_URL.slice(0, 60)}…`);

  const jar = new Map();
  console.log('1. redeeming the sharing link');
  await walk(SHARE_URL, jar, '  ');
  if (!jar.has('FedAuth')) {
    throw new Error('redemption produced no FedAuth cookie. The link is probably no longer '
      + 'shared as "Anyone with the link", or it has been rotated/revoked.');
  }
  console.log(`   cookies: ${[...jar.keys()].join(', ')}`);

  console.log('2. downloading');
  const dl = SHARE_URL + (SHARE_URL.includes('?') ? '&' : '?') + 'download=1';
  const res = await walk(dl, jar, '  ');
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer());

  // A 200 proves nothing here: the un-redeemed path also returns 200, with HTML.
  if (buf.length < 2 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`downloaded ${buf.length} bytes that are not a zip/.xlsx `
      + `(starts with ${buf.subarray(0, 8).toString('hex')}). Redemption probably failed and `
      + 'this is the HTML viewer page.');
  }
  if (buf.length < MIN_BYTES) {
    throw new Error(`downloaded only ${buf.length} bytes, expected at least ${MIN_BYTES} — `
      + 'the response looks truncated.');
  }

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, buf);
  console.log(`\nwrote ${OUT} (${buf.length.toLocaleString()} bytes)`);
}

main().catch((err) => {
  console.error(`\nERROR: ${err.message}`);
  process.exit(1);
});

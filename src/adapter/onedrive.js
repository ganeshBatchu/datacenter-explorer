/**
 * adapter/onedrive.js — fetches the workbook from a public OneDrive share link,
 * with no sign-in.
 *
 * This is the consumer-OneDrive path. It replaced an Entra/MSAL sign-in flow
 * because Northeastern's tenant blocks both anonymous sharing and the app
 * registration needed to read the file on a viewer's behalf. A personal
 * Microsoft account has neither restriction.
 *
 * Consequence worth being explicit about: an "Anyone with the link" URL grants
 * read access to whoever holds it, and this app ships that URL in its
 * JavaScript. The dataset is therefore effectively public. That is a deliberate
 * choice, not an oversight — see the README.
 */

import { CONFIG } from '../config.js';

/** True once a share link has been configured. */
export const isConfigured = () => Boolean(CONFIG.oneDriveShareUrl);

/**
 * Candidate direct-download URLs for a share link, tried in order.
 *
 * Which form works depends on the account type, and only some of them send the
 * `Access-Control-Allow-Origin` header a browser requires:
 *
 *   1. api.onedrive.com `/shares/u!{id}/root/content` — the consumer OneDrive
 *      endpoint, and the one documented to send CORS headers. This is the form
 *      expected to work. It returns `userContentMigrated` for OneDrive for
 *      Business accounts, which is exactly how we learned the old link was
 *      unusable.
 *   2. The share link with `?download=1` — often works for direct download but
 *      is commonly CORS-blocked.
 *   3. SharePoint's `download.aspx` form — business tenants only, normally
 *      requires a session.
 */
export function directDownloadUrls(shareUrl) {
  const urls = [];
  const url = String(shareUrl || '').trim();
  if (!url) return urls;

  try {
    // btoa needs Latin-1; encode first so non-ASCII links don't throw.
    const b64 = btoa(unescape(encodeURIComponent(url)))
      .replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
    urls.push(`https://api.onedrive.com/v1.0/shares/u!${b64}/root/content`);
  } catch { /* skip this candidate */ }

  urls.push(url + (url.includes('?') ? '&' : '?') + 'download=1');

  if (/sharepoint\.com/i.test(url)) {
    urls.push(url.replace(/\/:x:\/[gr]\//, '/_layouts/15/download.aspx?share='));
  }

  return urls;
}

/**
 * Fetches one candidate and validates it really is a workbook.
 *
 * A CORS-blocked or sign-in-redirected response frequently arrives as an HTML
 * page with a 200 status, so the status code alone is not enough. An .xlsx is a
 * zip archive and must begin with the bytes `PK`.
 */
async function fetchXlsx(url, proxy) {
  const target = proxy ? proxy.replace('{url}', encodeURIComponent(url)) : url;
  const res = await fetch(target, { redirect: 'follow', mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = await res.arrayBuffer();
  const sig = new Uint8Array(buf.slice(0, 2));
  if (sig[0] !== 0x50 || sig[1] !== 0x4b) {
    throw new Error('not an .xlsx — got a sign-in page or CORS error page instead');
  }
  return buf;
}

/**
 * Tries each candidate URL until one yields a workbook.
 * Returns { buffer, url, attempts } so the UI can report which form worked.
 */
export async function fetchWorkbook({ onProgress = () => {} } = {}) {
  const candidates = directDownloadUrls(CONFIG.oneDriveShareUrl);
  if (!candidates.length) throw new Error('no share link configured');

  const attempts = [];
  for (const [i, url] of candidates.entries()) {
    try {
      onProgress(candidates.length > 1
        ? `Fetching workbook (${i + 1} of ${candidates.length})…`
        : 'Fetching workbook…');
      const buffer = await fetchXlsx(url, CONFIG.corsProxy);
      return { buffer, url, attempts };
    } catch (err) {
      attempts.push({ url, error: err.message });
    }
  }

  const detail = attempts.map((a) => `• ${a.error}`).join('\n');
  throw new Error(`could not download the workbook from the share link.\n${detail}`);
}

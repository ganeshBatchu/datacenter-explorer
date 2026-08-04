/**
 * views/gate.js — the pre-data screens: setup instructions and load errors.
 *
 * These exist because the app has no data of its own. Until a share link is
 * configured and reachable, there is nothing to render, and the honest thing to
 * show is why — not an empty dashboard or a bare "failed to load".
 */

import { CONFIG } from '../config.js';
import { el } from './util.js';

const shell = (children) => el('div', { class: 'gate' }, [el('div', { class: 'gate-card' }, children)]);

/** Shown when nothing is configured to read. */
export function setupScreen() {
  return shell([
    el('h1', { text: 'No data source configured' }),
    el('p', {
      text: 'This explorer has no dataset of its own. Normally the deploy workflow downloads '
        + 'the workbook from OneDrive and publishes it beside the site, and the app reads it '
        + 'from there.',
    }),
    el('ol', { class: 'steps' }, [
      el('li', { html: 'Set <code>workbookUrl</code> in <code>src/config.js</code> '
        + '(default: <code>data/master_dataset_1_values_2.xlsx</code>).' }),
      el('li', { html: 'Make sure <code>.github/workflows/deploy.yml</code> has run — it is what '
        + 'puts the workbook there.' }),
      el('li', { text: 'Reload this page.' }),
    ]),
    el('p', { class: 'fine', html: 'To explore against a local copy instead, append '
      + '<code>?local=1</code> to the URL.' }),
  ]);
}

/** Terminal error screen, with hints tuned to the failures that actually happen. */
export function errorScreen({ error, onRetry }) {
  const msg = String(error && error.message ? error.message : error);
  const hints = [];

  /**
   * Diagnose from the CONFIGURED URL first, not just the error text.
   *
   * A work/university link fails in a way the browser cannot describe: the
   * consumer endpoint answers 308 (its "userContentMigrated" redirect) and the
   * other candidates surface only an opaque "Failed to fetch", because CORS
   * hides the response body. Left to the generic rules below, that pattern reads
   * as a CORS problem and sends you to configure a proxy — which cannot possibly
   * help, since the server is refusing to serve the file at all. The hostname is
   * the honest signal.
   */
  const isWorkAccountLink = /sharepoint\.com/i.test(CONFIG.oneDriveShareUrl || '');
  if (isWorkAccountLink) {
    hints.push('This share link belongs to a work or university OneDrive (a *.sharepoint.com '
      + 'address). Those endpoints require a tenant sign-in and refuse anonymous requests, so no '
      + 'proxy or client-side change can read them. Move the workbook to a personal Microsoft '
      + 'account and share it as "Anyone with the link".');
  }

  if (/not an \.xlsx|sign-in page|CORS error page/i.test(msg)) {
    hints.push('The link returned a sign-in page rather than a file. That means it is not shared '
      + 'as "Anyone with the link", or it belongs to a work/university account that requires a '
      + 'tenant session. Re-share it from a personal Microsoft account.');
  }
  if (/userContentMigrated|User migrated/i.test(msg)) {
    hints.push('This link belongs to a OneDrive for Business account. The anonymous endpoint only '
      + 'serves consumer OneDrive — move the workbook to a personal Microsoft account.');
  }
  // Only offer the proxy remedy when authorization isn't the more likely cause —
  // otherwise it sends you off to build a Worker that cannot fix anything.
  if (!isWorkAccountLink && /Failed to fetch|NetworkError|blocked/i.test(msg)) {
    hints.push('The browser blocked the request, which usually means the response carried no '
      + 'Access-Control-Allow-Origin header. Set CONFIG.corsProxy — docs/onedrive.md has a '
      + 'locked-down Cloudflare Worker for this.');
  }
  if (/HTTP 40[34]/.test(msg)) {
    hints.push('The link may have been rotated, revoked or the file moved. Re-copy the share link.');
  }
  if (/no local copy on disk/i.test(msg)) {
    hints.push('?local=1 needs data/master_dataset_1_values_2.xlsx present locally. '
      + 'Run "node scripts/fetch-workbook.mjs", or drop ?local=1.');
  }
  if (/deploy workflow may not/i.test(msg)) {
    hints.push('The site is published but the workbook is missing from it. Check the latest '
      + '"Deploy site" run in the repository\'s Actions tab — the download or the schema '
      + 'validation step may have failed.');
  }
  if (/missing required header cells/i.test(msg)) {
    hints.push('A header cell in the source workbook was cleared or renamed. Restore it in '
      + 'Excel (File → Version history undoes an accidental edit), then re-run the deploy.');
  }
  if (/sheet ".*" not found/i.test(msg)) {
    hints.push('The workbook downloaded but a sheet is missing or renamed. The app needs '
      + 'Facilities, Consolidated (all layers), Operators and Jurisdictions — see COLS in '
      + 'src/normalize.js.');
  }

  const retry = el('button', { class: 'btn primary', type: 'button', text: 'Try again' });
  retry.addEventListener('click', onRetry);

  return shell([
    el('h1', { text: 'Could not load the dataset' }),
    el('pre', { class: 'gate-err', text: msg }),
    ...hints.map((h) => el('p', { text: h })),
    el('div', { class: 'gate-actions' }, [retry]),
  ]);
}

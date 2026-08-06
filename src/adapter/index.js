/**
 * adapter/index.js — gets the four raw sheets from wherever they live.
 *
 * Sources, in priority order:
 *   1. LOCAL     — `?local=1`, a dev-only path reading a gitignored local .xlsx.
 *   2. ONEDRIVE  — straight from the share link, only when a CORS proxy is also
 *                  configured (see adapter/onedrive.js for why one is required).
 *   3. PUBLISHED — the default: the workbook the deploy workflow downloaded and
 *                  published beside the site. Same-origin, so no CORS.
 *
 * All three produce identical arrays-of-objects for normalize.js, so there is
 * exactly one parsing and one normalization path regardless of origin.
 */

import { CONFIG } from '../config.js';
import * as onedrive from './onedrive.js';

const SHEETS = {
  facilities: 'Facilities',
  consolidated: 'Consolidated (all layers)',
  operators: 'Operators',
  jurisdictions: 'Jurisdictions',
};

/** Header row is 1-based per sheet; Consolidated has merged layer bands on row 1. */
const HEADER_ROW = { facilities: 1, consolidated: 2, operators: 1, jurisdictions: 1 };

/**
 * Dev escape hatch: `?local=1` reads a local .xlsx instead of the share link, so
 * you can work on the views offline. The workbook is gitignored, so this does
 * nothing on a fresh clone and never affects the deployed site.
 */
const DEV_LOCAL_PATH = 'data/master_dataset_1_values_3.xlsx';
const wantsLocal = () => new URLSearchParams(window.location.search).has('local');

/** Reads one worksheet into objects keyed by its real header strings. */
function sheetToObjects(workbook, sheetName, headerRow) {
  const ws = workbook.Sheets[sheetName];
  if (!ws) throw new Error(`sheet "${sheetName}" not found in workbook`);
  // Not raw:false — we want native numbers for Lat/Long, not strings.
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: null });
  const headers = (grid[headerRow - 1] || []).map((h) => (h === null ? '' : String(h).trim()));
  const out = [];
  for (let i = headerRow; i < grid.length; i++) {
    const row = grid[i];
    if (!row || row.every((c) => c === null || String(c).trim() === '')) continue;
    const obj = {};
    headers.forEach((h, j) => { if (h) obj[h] = row[j] === undefined ? null : row[j]; });
    out.push(obj);
  }
  return out;
}

function parseWorkbook(buf) {
  const wb = XLSX.read(buf, { type: 'array' });
  const sheets = {};
  for (const [key, name] of Object.entries(SHEETS)) {
    sheets[key] = sheetToObjects(wb, name, HEADER_ROW[key]);
  }
  return sheets;
}

/**
 * Reading straight from OneDrive is only attempted when a proxy is configured
 * too, because the share link cannot be fetched by a browser unaided.
 */
const wantsDirect = () => Boolean(CONFIG.oneDriveShareUrl && CONFIG.corsProxy);

/**
 * What the app should do on startup.
 *   'setup' — nothing configured to read; show the setup instructions.
 *   'ready' — data can be loaded now.
 */
export function resolveMode() {
  if (wantsLocal()) return { mode: 'ready', via: 'local' };
  if (wantsDirect()) return { mode: 'ready', via: 'onedrive' };
  if (CONFIG.workbookUrl) return { mode: 'ready', via: 'published' };
  return { mode: 'setup', via: null };
}

export async function loadSheets({ onProgress = () => {} } = {}) {
  if (wantsLocal()) {
    onProgress('Loading local workbook…');
    const res = await fetch(DEV_LOCAL_PATH);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${DEV_LOCAL_PATH} — no local copy on disk`);
    const buf = await res.arrayBuffer();
    return {
      sheets: parseWorkbook(buf),
      source: { mode: 'local', label: 'Local file (preview)', detail: DEV_LOCAL_PATH },
    };
  }

  if (wantsDirect()) {
    const { buffer, url, attempts } = await onedrive.fetchWorkbook({ onProgress });
    return {
      sheets: parseWorkbook(buffer),
      source: {
        mode: 'onedrive',
        label: 'Live · OneDrive',
        detail: attempts.length
          ? `${url}\n(${attempts.length} earlier candidate${attempts.length > 1 ? 's' : ''} failed)`
          : url,
      },
    };
  }

  onProgress('Loading workbook…');
  const res = await fetch(CONFIG.workbookUrl);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${CONFIG.workbookUrl} — the deploy workflow may not `
      + 'have published the workbook yet.');
  }
  const buf = await res.arrayBuffer();
  const sig = new Uint8Array(buf.slice(0, 2));
  if (sig[0] !== 0x50 || sig[1] !== 0x4b) throw new Error(`${CONFIG.workbookUrl} is not a valid .xlsx`);
  return {
    sheets: parseWorkbook(buf),
    source: { mode: 'published', label: 'Published dataset', detail: CONFIG.workbookUrl },
  };
}

export { onedrive };

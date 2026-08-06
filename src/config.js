/**
 * config.js — where the app gets its data.
 *
 * The dataset is not committed to this repository. GitHub Actions downloads it
 * from its public OneDrive share link at build time and publishes it with the
 * site (see .github/workflows/deploy.yml), so the browser reads it
 * same-origin — no CORS, no proxy, no sign-in.
 *
 * NOTE ON ACCESS: the published site serves the workbook to anyone who opens it,
 * so the dataset is effectively public. That is the intended trade-off — it buys
 * near-live data with no sign-in, no consent and no tenant administrator. If the
 * data ever needs restricting, see docs/onedrive.md § Fallback: gate the site.
 */

export const CONFIG = {
  /**
   * The workbook as published by the deploy workflow, relative to index.html.
   * Same-origin, so no CORS is involved.
   */
  workbookUrl: 'data/master_dataset_1_values_3.xlsx',

  /**
   * OPTIONAL: fetch straight from OneDrive on every page load instead, for
   * genuinely live data rather than data refreshed each build.
   *
   * Requires BOTH values. A personal OneDrive link cannot be read by a browser
   * directly — it must first be "redeemed" server-side to mint a FedAuth cookie,
   * and its response carries no Access-Control-Allow-Origin — so this needs the
   * Cloudflare Worker in worker/worker.js. Leave both empty to use workbookUrl,
   * which needs no extra service.
   */
  oneDriveShareUrl: '',
  corsProxy: '',

  /** Trimmed Natural Earth polygons for the choropleth (Singapore is approximated). */
  countriesGeoJson: 'data/countries.geo.json',
};

/**
 * colors.js — colour assignment for every view.
 *
 * Two categorical sets, because the two chart families have different safety
 * gates (validated with the dataviz validator, not by eye):
 *
 *   ADJACENT (stacked/ranked bars, composition): all 8 documented slots. Only
 *     neighbouring pairs ever touch, so the adjacent pairlist applies.
 *     worst adjacent CVD ΔE 9.1 light / 8.4 dark.
 *
 *   ALL_PAIRS (map markers, scatter dots): every pair can appear side by side,
 *     so the all-pairs pairlist applies — and there no 5-hue subset of the
 *     eight clears both modes. A brute-force search over all 8-choose-k subsets
 *     found exactly two passing 4-hue sets; we use blue/yellow/magenta/green
 *     (light all-pairs worst CVD ΔE 9.2, normal-vision 24.0). Categories past
 *     the fourth fold into a desaturated "Other".
 *
 * Yellow, magenta and green sit below 3:1 on the light surface, so the relief
 * rule applies: the app ships a table view and every mark is labelled on hover
 * and focus. Colour never carries meaning alone.
 */

/** Documented 8-slot categorical order — for adjacent-pair contexts only. */
export const CAT_ADJACENT = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark:  ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};

/** All-pairs-safe 4-hue subset — for map markers and scatter. */
export const CAT_ALL_PAIRS = {
  light: ['#2a78d6', '#eda100', '#e87ba4', '#008300'],
  dark:  ['#3987e5', '#c98500', '#d55181', '#008300'],
};

/** Recessive slot for the folded tail. Desaturated so it never reads as a hue. */
export const OTHER_COLOR = { light: '#8f8e88', dark: '#77766f' };
export const OTHER_LABEL = 'Other';
export const NO_DATA_COLOR = { light: '#d9d8d3', dark: '#3a3a37' };

/** Single-hue blue ramp, light→dark, for the choropleth. */
export const SEQ_BLUE = ['#cde2fb', '#b7d3f6', '#9ec5f4', '#86b6ef', '#6da7ec', '#5598e7',
  '#3987e5', '#2a78d6', '#256abf', '#1c5cab', '#184f95', '#104281', '#0d366b'];

/** Fixed status tokens — never used for a series. Always shipped with icon + label. */
export const STATUS = { good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b' };

export function isDark() {
  const stamp = document.documentElement.dataset.theme;
  if (stamp === 'dark') return true;
  if (stamp === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

const mode = () => (isDark() ? 'dark' : 'light');

/**
 * Builds a stable value→colour map for one dimension.
 *
 * Ranking is computed from `allRecords` (the whole dataset), never from the
 * filtered slice, so filtering a category out never repaints the survivors —
 * colour follows the entity, not its current rank.
 *
 * @param {string} scope 'allPairs' (map, scatter) or 'adjacent' (bars, stacks)
 */
export function buildScale(allRecords, valueOf, scope = 'adjacent') {
  const palette = scope === 'allPairs' ? CAT_ALL_PAIRS[mode()] : CAT_ADJACENT[mode()];
  const cap = palette.length;

  const counts = new Map();
  for (const r of allRecords) {
    const v = valueOf(r);
    if (v === null || v === undefined || v === '') continue;
    counts.set(v, (counts.get(v) || 0) + 1);
  }

  // Rank by frequency, then alphabetically so ties are deterministic across reloads.
  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([v]) => v);

  const map = new Map();
  ranked.slice(0, cap).forEach((v, i) => map.set(v, palette[i]));
  const folded = ranked.slice(cap);

  const other = OTHER_COLOR[mode()];
  const noData = NO_DATA_COLOR[mode()];

  return {
    /** Colour for a record's value. */
    of(v) {
      if (v === null || v === undefined || v === '') return noData;
      return map.get(v) || other;
    },
    /** Label to show in legend/tooltip — folded values report as "Other". */
    labelOf(v) {
      if (v === null || v === undefined || v === '') return 'No data';
      return map.has(v) ? String(v) : OTHER_LABEL;
    },
    /** Legend entries, in palette order, with the tail and no-data appended. */
    entries() {
      const out = ranked.slice(0, cap).map((v) => ({ value: v, label: String(v), color: map.get(v) }));
      if (folded.length) {
        out.push({ value: OTHER_LABEL, label: `${OTHER_LABEL} (${folded.length})`, color: other, folded });
      }
      return out;
    },
    foldedValues: folded,
    isFolded: (v) => folded.includes(v),
    cap,
  };
}

/** Sequential colour for a 0–1 normalised magnitude. */
export function seqColor(t) {
  if (t === null || t === undefined || Number.isNaN(t)) return NO_DATA_COLOR[mode()];
  const i = Math.min(SEQ_BLUE.length - 1, Math.max(0, Math.round(t * (SEQ_BLUE.length - 1))));
  return SEQ_BLUE[i];
}

/** Ink tokens so chart text never wears a series colour. */
export function ink() {
  const cs = getComputedStyle(document.documentElement);
  return {
    primary: cs.getPropertyValue('--text-primary').trim(),
    secondary: cs.getPropertyValue('--text-secondary').trim(),
    muted: cs.getPropertyValue('--text-muted').trim(),
    surface: cs.getPropertyValue('--surface-1').trim(),
    grid: cs.getPropertyValue('--grid').trim(),
  };
}

/** Slot 1 — the single-series colour for ranked bars and histograms. */
export const seriesOne = () => CAT_ADJACENT[mode()][0];

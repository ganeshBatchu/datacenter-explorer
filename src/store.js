/**
 * store.js — one filter state for every view.
 *
 * Views never talk to each other. They read `store.view()` and call
 * `store.toggle(...)` / `store.hover(...)`; the store recomputes and notifies
 * everyone. That is what makes the map, bars, histograms and scatter
 * cross-filter as one instrument.
 */

import { applyImputation, buildRecords, dimValue, DIMENSIONS, MEASURES, STRICT_BASES } from './normalize.js';

const listeners = new Set();

const state = {
  /** Map<dimKey, Set<value>> — a dimension with an empty/absent set is unfiltered. */
  filters: new Map(),
  /** Numeric range filters: Map<measureKey, [min, max]>. */
  ranges: new Map(),
  search: '',

  /** 'coded' = only workbook-coded MW. 'imputed' = fill gaps from operator medians. */
  capacityMode: 'coded',
  /** Restrict coded capacity to this-building bases, excluding campus/planned figures. */
  strictBasis: false,
  /** Category grouping toggle: false = grouped labels, true = raw workbook strings. */
  useRaw: false,
  /** Drop the README's placeholder example row (DC-0001). */
  excludePlaceholder: true,

  colorDim: 'operatorCountry',
  hoveredId: null,
  selectedId: null,
};

let all = [];      // every record, imputation applied per capacityMode
let meta = null;
let cache = null;  // memoised filtered result

// ---------------------------------------------------------------------------

export function init(sheets) {
  const built = buildRecords(sheets);
  all = built.records;
  meta = built.meta;
  recomputeCapacity();
  return meta;
}

/**
 * Capacity mode changes what `mw` means on every record, so it is applied once
 * here rather than branched at each call site.
 */
function recomputeCapacity() {
  for (const r of all) {
    r.mw = r.mwCoded ? parseFloat(r.capacityRaw.match(/(\d[\d,]*\.?\d*)/)?.[1].replace(/,/g, '')) : null;
    // Re-derive from the parsed value so repeated mode switches never compound.
    if (r.mwCoded) { r.mwEstimated = false; r.mwSource = 'coded'; }
    else { r.mw = null; r.mwEstimated = null; r.mwSource = null; }
  }
  if (state.capacityMode === 'imputed') applyImputation(all);
}

/** MW to use for aggregation, honouring capacity mode and the strict-basis switch. */
export function effectiveMw(r) {
  if (r.mw === null || r.mw === undefined) return null;
  if (state.capacityMode === 'coded' && !r.mwCoded) return null;
  if (state.strictBasis && r.mwCoded && !STRICT_BASES.includes(r.mwBasis)) return null;
  return r.mw;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function passes(r, { skipDim = null, skipDims = null } = {}) {
  if (state.excludePlaceholder && r.isPlaceholder) return false;

  for (const [dim, values] of state.filters) {
    if (!values || values.size === 0) continue;
    if (dim === skipDim) continue;
    if (skipDims && skipDims.has(dim)) continue;
    if (!values.has(dimValue(r, dim, state.useRaw))) return false;
  }
  for (const [measure, [lo, hi]] of state.ranges) {
    const v = measure === 'mw' ? effectiveMw(r) : r[measure];
    if (v === null || v === undefined) return false;
    if (v < lo || v > hi) return false;
  }
  if (state.search) {
    const q = state.search.toLowerCase();
    const hay = `${r.name} ${r.operator} ${r.city} ${r.country} ${r.ownerParent} ${r.id}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

/**
 * The filtered set, plus the "own-dimension-excluded" sets that keep a
 * dimension's own chart from collapsing to the single bar you just clicked.
 */
export function view() {
  if (cache) return cache;
  const records = all.filter((r) => passes(r));
  const base = all.filter((r) => state.excludePlaceholder ? !r.isPlaceholder : true);

  const codedInView = records.filter((r) => effectiveMw(r) !== null);
  cache = {
    records,
    base,
    all,
    meta,
    state: { ...state, filters: new Map(state.filters), ranges: new Map(state.ranges) },
    /** Records filtered by everything *except* `dim` — for that dim's own chart. */
    exceptDim: (dim) => all.filter((r) => passes(r, { skipDim: dim })),
    /** Same, but excluding several dimensions at once — for a two-axis heatmap. */
    exceptDims: (dims) => all.filter((r) => passes(r, { skipDims: new Set(dims) })),
    stats: {
      n: records.length,
      nTotal: base.length,
      nWithMw: codedInView.length,
      totalMw: codedInView.reduce((a, r) => a + effectiveMw(r), 0),
      nEstimated: codedInView.filter((r) => r.mwEstimated).length,
    },
  };
  return cache;
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

function commit() { cache = null; listeners.forEach((fn) => fn()); }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** Toggle one value of one categorical dimension — the cross-filter primitive. */
export function toggle(dim, value) {
  if (!state.filters.has(dim)) state.filters.set(dim, new Set());
  const set = state.filters.get(dim);
  if (set.has(value)) set.delete(value); else set.add(value);
  if (set.size === 0) state.filters.delete(dim);
  commit();
}

export function setFilter(dim, values) {
  if (!values || values.length === 0) state.filters.delete(dim);
  else state.filters.set(dim, new Set(values));
  commit();
}

export function isActive(dim, value) {
  const set = state.filters.get(dim);
  return Boolean(set && set.has(value));
}

export function hasFilter(dim) {
  const set = state.filters.get(dim);
  return Boolean(set && set.size);
}

export function setRange(measure, lo, hi) {
  if (lo === null || hi === null) state.ranges.delete(measure);
  else state.ranges.set(measure, [lo, hi]);
  commit();
}

export function clearAll() {
  state.filters.clear();
  state.ranges.clear();
  state.search = '';
  commit();
}

export function set(key, value) {
  if (state[key] === value) return;
  state[key] = value;
  // These two change the meaning of `mw` / of category labels, so any filter or
  // range expressed in the old vocabulary is no longer valid.
  if (key === 'capacityMode' || key === 'strictBasis') { recomputeCapacity(); state.ranges.delete('mw'); }
  if (key === 'useRaw') state.filters.clear();
  commit();
}

export function get(key) { return state[key]; }

/** Hover is high-frequency, so it notifies without invalidating the filter cache. */
export function hover(id) {
  if (state.hoveredId === id) return;
  state.hoveredId = id;
  listeners.forEach((fn) => fn({ hoverOnly: true }));
}

export function select(id) {
  state.selectedId = state.selectedId === id ? null : id;
  listeners.forEach((fn) => fn({ hoverOnly: true }));
}

/** Active filters as chips for the filter bar. */
export function activeChips() {
  const chips = [];
  for (const [dim, values] of state.filters) {
    const label = DIMENSIONS.find((d) => d.key === dim)?.label || dim;
    for (const v of values) chips.push({ dim, value: v, label, text: `${label}: ${v ?? '—'}` });
  }
  for (const [measure, [lo, hi]] of state.ranges) {
    const label = MEASURES.find((m) => m.key === measure)?.label || measure;
    chips.push({ measure, text: `${label}: ${Math.round(lo)}–${Math.round(hi)}` });
  }
  if (state.search) chips.push({ search: true, text: `search: "${state.search}"` });
  return chips;
}

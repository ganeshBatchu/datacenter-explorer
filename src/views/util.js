/**
 * views/util.js — shared chart primitives: DOM helpers, formatting, the tooltip
 * singleton, and the aggregation used by every ranked/stacked view.
 */

import * as store from '../store.js';

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  applyAttrs(node, attrs);
  append(node, children);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function svg(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    node.setAttribute(k, v);
  }
  append(node, children);
  return node;
}

function applyAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
}

function append(node, children) {
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/** A titled card with a body, matching the shell's layout classes. */
export function card(title, { note, span = 'c6', bodyClass = '' } = {}) {
  const body = el('div', { class: `body ${bodyClass}` });
  const noteEl = el('span', { class: 'note', text: note || '' });
  const root = el('section', { class: `card ${span}` }, [
    el('header', {}, [el('h2', { text: title }), noteEl]),
    body,
  ]);
  return { root, body, setNote: (t) => { noteEl.textContent = t || ''; } };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const fmtInt = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));

export function fmtMw(n) {
  if (n === null || n === undefined) return '—';
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 100) return Math.round(n).toLocaleString('en-US');
  if (n >= 10) return n.toFixed(0);
  return n.toFixed(1);
}

export const fmtPct = (x) => `${Math.round(x * 100)}%`;

/** Human label for why a capacity cell has no number. */
export const REASON_LABEL = {
  unresolved: 'not yet sourced (→)',
  'area-not-power': 'floor area given, not MW',
  'not-published': 'not published by operator',
  'no-number': 'no figure ("region")',
};

/** Human label for what a coded capacity figure actually measures. */
export const BASIS_LABEL = {
  reported: 'reported',
  approx: 'approximate',
  campus: 'whole campus',
  floor: 'stated as a minimum',
  planned: 'planned / partial build-out',
};

// ---------------------------------------------------------------------------
// Tooltip singleton
// ---------------------------------------------------------------------------

let tipNode = null;

function tipEl() {
  if (!tipNode) {
    tipNode = el('div', { class: 'tip', role: 'tooltip' });
    document.body.appendChild(tipNode);
  }
  return tipNode;
}

/**
 * Shows the tooltip near the pointer, flipping before it leaves the viewport.
 * Tooltips only ever enhance — every value they show is also in the table view.
 */
export function showTip(evt, content) {
  const node = tipEl();
  clear(node);
  if (typeof content === 'string') node.innerHTML = content;
  else append(node, [].concat(content));
  node.classList.add('is-on');

  const pad = 12;
  const r = node.getBoundingClientRect();
  let x = evt.clientX + pad;
  let y = evt.clientY + pad;
  if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - pad;
  node.style.left = `${Math.max(8, x)}px`;
  node.style.top = `${Math.max(8, y)}px`;
}

export function hideTip() { if (tipNode) tipNode.classList.remove('is-on'); }

/** Builds tooltip content: a title plus key/value rows. */
export function tipContent(title, rows, footer) {
  return [
    el('div', { class: 't-title', text: title }),
    ...rows.filter(Boolean).map(([k, v, cls]) =>
      el('div', { class: 't-row' }, [el('span', { text: k }), el('b', { class: cls || '', text: String(v) })])),
    footer ? el('div', { class: 't-row', style: { marginTop: '3px' } }, [el('span', { text: footer })]) : null,
  ];
}

/**
 * Wires hover + keyboard focus to the same tooltip, so focus reveals exactly
 * what hover does. `getContent` is called lazily on each event.
 */
export function attachTip(node, getContent) {
  const show = (e) => showTip(e.touches ? e.touches[0] : e, getContent());
  node.addEventListener('mouseenter', show);
  node.addEventListener('mousemove', show);
  node.addEventListener('mouseleave', hideTip);
  node.addEventListener('focus', () => {
    const r = node.getBoundingClientRect();
    showTip({ clientX: r.left + r.width / 2, clientY: r.bottom }, getContent());
  });
  node.addEventListener('blur', hideTip);
  return node;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/**
 * Groups records by a key function and totals both facility count and MW.
 *
 * `mw` sums only records with a usable figure under the current capacity mode;
 * `nWithMw` reports how many that was, so a view can always say "12 of 19
 * coded" instead of implying the total is complete.
 */
export function aggregate(records, keyOf, { measure = 'count' } = {}) {
  const groups = new Map();
  for (const r of records) {
    const k = keyOf(r);
    const key = k === null || k === undefined || k === '' ? null : k;
    if (!groups.has(key)) groups.set(key, { key, label: key === null ? 'No data' : String(key), n: 0, mw: 0, nWithMw: 0, nEstimated: 0, records: [] });
    const g = groups.get(key);
    g.n++;
    g.records.push(r);
    const mw = store.effectiveMw(r);
    if (mw !== null) { g.mw += mw; g.nWithMw++; if (r.mwEstimated) g.nEstimated++; }
  }
  const out = [...groups.values()];
  out.sort((a, b) => (measure === 'mw' ? b.mw - a.mw || b.n - a.n : b.n - a.n || b.mw - a.mw));
  return out;
}

/** Value used for bar length under the current measure. */
export const measureValue = (g, measure) => (measure === 'mw' ? g.mw : g.n);

/**
 * Orders groups by a documented ordinal sequence (water tiers, WGI bands)
 * rather than by magnitude, appending anything unrecognised.
 */
export function orderBy(groups, order) {
  if (!order) return groups;
  const rank = (g) => {
    const i = order.indexOf(g.key);
    return i === -1 ? order.length + 1 : i;
  };
  return [...groups].sort((a, b) => rank(a) - rank(b) || String(a.label).localeCompare(String(b.label)));
}

/** Bins numeric values into fixed-width buckets for a histogram. */
export function bin(values, binWidth) {
  const bins = new Map();
  for (const v of values) {
    const b = Math.floor(v / binWidth) * binWidth;
    bins.set(b, (bins.get(b) || 0) + 1);
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  if (!keys.length) return [];
  const out = [];
  for (let x = keys[0]; x <= keys[keys.length - 1]; x += binWidth) {
    out.push({ x0: x, x1: x + binWidth, n: bins.get(x) || 0 });
  }
  return out;
}

/** Nice round tick values covering [0, max]. */
export function ticks(max, count = 4) {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let t = 0; t <= max + step * 0.001; t += step) out.push(t);
  return out;
}

/**
 * Marks a chart body stale during a re-render so there is no skeleton flash.
 *
 * The class MUST be cleared on a macrotask, not requestAnimationFrame: rAF is
 * suspended while a tab is hidden, so a background-tab load left every chart
 * permanently at reduced opacity. `fn()` is synchronous, so the class is really
 * only insurance for a future async render — but insurance that never clears is
 * a bug, not insurance.
 */
export function withStale(node, fn) {
  node.classList.add('is-stale');
  try {
    fn();
  } finally {
    setTimeout(() => node.classList.remove('is-stale'), 0);
  }
}

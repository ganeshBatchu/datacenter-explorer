/**
 * views/plots.js — the SVG-rendered charts: the capacity histogram and the
 * linked scatter.
 *
 * Both are hand-rendered rather than delegated to a plotting library so each
 * mark can participate in cross-filtering and share hover state with the map.
 * Axes and gridlines are solid hairlines one shade off the surface — never
 * dashed.
 */

import * as store from '../store.js';
import { DIMENSIONS, MEASURES, dimValue, WATER_TIERS, ENV_TIERS, WGI_ORDER, FOTN_ORDER } from '../normalize.js';
import { buildScale, ink, seriesOne } from '../colors.js';
import {
  bin, card, clear, el, fmtInt, fmtMw, hideTip, showTip, svg, ticks, tipContent, withStale,
} from './util.js';

/**
 * Capacity histogram over facilities with a usable MW figure.
 *
 * Clicking a bar sets a range filter on capacity; clicking the active bar clears
 * it. Bars are the single-series hue — a value-ramp here would double-encode
 * height as colour.
 */
export function createCapacityHistogram({ span = 'c6' }) {
  const ui = card('Capacity distribution', { span });
  const host = el('div', { class: 'plot-wrap' });
  ui.body.appendChild(host);

  function render() {
    withStale(ui.body, () => {
      clear(host);
      const v = store.view();
      // Own-dimension exclusion: the histogram shows the distribution the
      // capacity range filter is being applied *to*, not its own output.
      const scoped = v.records;
      const vals = [];
      let uncoded = 0;
      for (const r of scoped) {
        const mw = store.effectiveMw(r);
        if (mw === null) uncoded++; else vals.push(mw);
      }

      if (!vals.length) {
        host.appendChild(el('div', {
          class: 'empty-state',
          text: store.get('capacityMode') === 'coded'
            ? `No coded capacity in this selection (${uncoded} facilities uncoded).`
            : 'No facilities match the filters.',
        }));
        ui.setNote('');
        return;
      }

      const max = Math.max(...vals);
      // ~14 bins, snapped to a round width so tick labels read cleanly.
      const rawWidth = max / 14;
      const mag = Math.pow(10, Math.floor(Math.log10(rawWidth || 1)));
      const binWidth = ([1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawWidth) || 10 * mag);
      const bins = bin(vals, binWidth);

      host.appendChild(histogramSvg(bins, binWidth, host.clientWidth || 380));
      ui.setNote(uncoded
        ? `${fmtInt(vals.length)} shown · ${fmtInt(uncoded)} without capacity`
        : `${fmtInt(vals.length)} facilities`);
    });
  }

  function histogramSvg(bins, binWidth, width) {
    const c = ink();
    const H = 190; const padL = 34; const padR = 8; const padT = 8; const padB = 30;
    const W = Math.max(260, width);
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;
    const maxN = Math.max(...bins.map((b) => b.n), 1);
    const bw = innerW / bins.length;

    const root = svg('svg', {
      viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
      role: 'img', 'aria-label': 'Histogram of facility capacity in megawatts',
    });

    // y gridlines + ticks
    for (const t of ticks(maxN, 4)) {
      const y = padT + innerH - (t / maxN) * innerH;
      root.appendChild(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: c.grid, 'stroke-width': 1 }));
      root.appendChild(svg('text', {
        x: padL - 6, y: y + 3.5, 'text-anchor': 'end', fill: c.muted, 'font-size': 10,
      }, [String(Math.round(t))]));
    }

    const range = store.view().state.ranges.get('mw');
    const color = seriesOne();

    bins.forEach((b, i) => {
      const h = (b.n / maxN) * innerH;
      const x = padL + i * bw;
      const y = padT + innerH - h;
      const active = range && range[0] === b.x0 && range[1] === b.x1;

      // Hit area spans the full column height so a 1-facility bar is still
      // easy to hit — no pinpoint targets.
      const hit = svg('rect', {
        x, y: padT, width: Math.max(1, bw), height: innerH,
        fill: 'transparent', style: 'cursor:pointer',
        tabindex: 0, role: 'button',
        'aria-label': `${fmtMw(b.x0)} to ${fmtMw(b.x1)} MW: ${b.n} facilities`,
      });
      const content = () => tipContent(`${fmtMw(b.x0)} – ${fmtMw(b.x1)} MW`, [
        ['Facilities', fmtInt(b.n)],
      ], b.n ? 'Click to filter to this range' : null);

      hit.addEventListener('mouseenter', (e) => showTip(e, content()));
      hit.addEventListener('mousemove', (e) => showTip(e, content()));
      hit.addEventListener('mouseleave', hideTip);
      hit.addEventListener('focus', () => {
        const r = hit.getBoundingClientRect();
        showTip({ clientX: r.left + r.width / 2, clientY: r.bottom }, content());
      });
      hit.addEventListener('blur', hideTip);
      const apply = () => (active ? store.setRange('mw', null, null) : store.setRange('mw', b.x0, b.x1));
      hit.addEventListener('click', apply);
      hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apply(); } });

      if (b.n > 0) {
        root.appendChild(svg('rect', {
          // 2px gap between adjacent bars, 4px rounded data-end at the top only.
          x: x + 1, y, width: Math.max(1, bw - 2), height: h,
          fill: color, rx: Math.min(4, Math.max(0, h / 2)),
          opacity: range && !active ? 0.35 : 1,
          style: 'pointer-events:none',
        }));
      }
      root.appendChild(hit);
    });

    // x axis
    root.appendChild(svg('line', {
      x1: padL, x2: W - padR, y1: padT + innerH, y2: padT + innerH, stroke: c.grid, 'stroke-width': 1,
    }));
    const labelEvery = Math.ceil(bins.length / 6);
    bins.forEach((b, i) => {
      if (i % labelEvery) return;
      root.appendChild(svg('text', {
        x: padL + i * bw, y: H - padB + 14, 'text-anchor': 'middle', fill: c.muted, 'font-size': 10,
      }, [fmtMw(b.x0)]));
    });
    root.appendChild(svg('text', {
      x: padL + innerW / 2, y: H - 2, 'text-anchor': 'middle', fill: c.secondary, 'font-size': 10.5,
    }, ['IT capacity (MW)']));

    return root;
  }

  return { root: ui.root, render };
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

/** Ordinal dimensions usable as a scatter axis, with their rank order. */
const ORDINAL_AXES = [
  { key: 'waterStress', label: 'Water stress (WRI tier)', order: WATER_TIERS },
  { key: 'envRisk', label: 'Environmental risk tier', order: ENV_TIERS },
  { key: 'regQuality', label: 'WGI regulatory quality', order: WGI_ORDER },
  { key: 'polStability', label: 'WGI political stability', order: WGI_ORDER },
  { key: 'fotnBand', label: 'Freedom House band', order: FOTN_ORDER },
];

const AXES = [
  ...MEASURES.map((m) => ({ ...m, kind: 'numeric' })),
  ...ORDINAL_AXES.map((o) => ({ ...o, kind: 'ordinal' })),
];

/**
 * Scatter of any two axes, numeric or ordinal, with hover and selection shared
 * with the map. Ordinal axes are jittered within their band because dozens of
 * facilities land on identical tier/tier coordinates.
 *
 * Capacity is log-scaled by default: the coded values span 6–1,289 MW, and on a
 * linear axis the lower two thirds collapse onto the baseline.
 */
export function createScatter({ span = 'c6' }) {
  const ui = card('Scatter', { span });
  const host = el('div', { class: 'plot-wrap' });

  let xKey = 'mw';
  let yKey = 'waterStress';
  let logX = true;

  const xPick = el('select', { 'aria-label': 'X axis' });
  const yPick = el('select', { 'aria-label': 'Y axis' });
  for (const a of AXES) {
    xPick.appendChild(el('option', { value: a.key, text: a.label }));
    yPick.appendChild(el('option', { value: a.key, text: a.label }));
  }
  xPick.addEventListener('change', () => { xKey = xPick.value; render(); });
  yPick.addEventListener('change', () => { yKey = yPick.value; render(); });

  const logBtn = el('button', { class: 'btn', type: 'button', text: 'log x' });
  logBtn.addEventListener('click', () => { logX = !logX; render(); });

  const controls = el('div', { class: 'legend', style: { padding: '0 0 8px' } }, [
    el('span', { style: { fontSize: '11px', color: 'var(--text-muted)' }, text: 'x' }), xPick,
    el('span', { style: { fontSize: '11px', color: 'var(--text-muted)' }, text: 'y' }), yPick,
    logBtn,
  ]);
  ui.body.append(controls, host);

  const axis = (k) => AXES.find((a) => a.key === k);

  /** Numeric position for a record on an axis, or null when unavailable. */
  function valueOf(r, key) {
    const a = axis(key);
    if (!a) return null;
    if (a.kind === 'numeric') return key === 'mw' ? store.effectiveMw(r) : (r[key] ?? null);
    const v = dimValue(r, key, false);
    const i = a.order.indexOf(v);
    return i === -1 ? null : i;
  }

  function render() {
    const ax = axis(xKey); const ay = axis(yKey);
    logBtn.style.display = ax.kind === 'numeric' && xKey === 'mw' ? '' : 'none';
    logBtn.setAttribute('aria-pressed', String(logX));
    logBtn.style.color = logX ? 'var(--accent)' : '';
    xPick.value = xKey; yPick.value = yKey;

    withStale(ui.body, () => {
      clear(host);
      const v = store.view();
      const pts = [];
      let dropped = 0;
      for (const r of v.records) {
        const x = valueOf(r, xKey); const y = valueOf(r, yKey);
        if (x === null || y === null) { dropped++; continue; }
        pts.push({ r, x, y });
      }

      if (!pts.length) {
        host.appendChild(el('div', { class: 'empty-state', text: `No facilities have both ${ax.label} and ${ay.label}.` }));
        ui.setNote('');
        return;
      }

      host.appendChild(scatterSvg(pts, ax, ay, host.clientWidth || 380, v));
      ui.setNote(dropped ? `${fmtInt(pts.length)} plotted · ${fmtInt(dropped)} missing a value` : `${fmtInt(pts.length)} facilities`);
    });
  }

  function scatterSvg(pts, ax, ay, width, v) {
    const c = ink();
    // Ordinal tier names ('Medium–High') are far wider than a numeric tick, so
    // the left gutter grows for them — otherwise the labels render off-canvas.
    const H = 230; const padL = ay.kind === 'ordinal' ? 74 : 46;
    const padR = 10; const padT = 10; const padB = 34;
    const W = Math.max(280, width);
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const useLog = ax.key === 'mw' && logX;
    const tx = (x) => (useLog ? Math.log10(Math.max(0.5, x)) : x);

    const xs = pts.map((p) => tx(p.x));
    const ys = pts.map((p) => p.y);
    const xMin = ax.kind === 'ordinal' ? -0.5 : Math.min(...xs);
    const xMax = ax.kind === 'ordinal' ? ax.order.length - 0.5 : Math.max(...xs);
    const yMin = ay.kind === 'ordinal' ? -0.5 : Math.min(...ys);
    const yMax = ay.kind === 'ordinal' ? ay.order.length - 0.5 : Math.max(...ys);

    const sx = (x) => padL + ((tx(x) - xMin) / (xMax - xMin || 1)) * innerW;
    const sy = (y) => padT + innerH - ((y - yMin) / (yMax - yMin || 1)) * innerH;

    const root = svg('svg', {
      viewBox: `0 0 ${W} ${H}`, width: '100%', height: H,
      role: 'img', 'aria-label': `Scatter of ${ay.label} against ${ax.label}`,
    });

    // Gridlines: ordinal axes get one line per band, numeric axes rounded ticks.
    const yLines = ay.kind === 'ordinal' ? ay.order.map((_, i) => i) : ticks(yMax, 4).filter((t) => t >= yMin);
    for (const t of yLines) {
      const y = sy(t);
      root.appendChild(svg('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: c.grid, 'stroke-width': 1 }));
      const label = ay.kind === 'ordinal' ? shortLabel(ay.order[t]) : String(Math.round(t * 100) / 100);
      root.appendChild(svg('text', {
        x: padL - 6, y: y + 3.5, 'text-anchor': 'end', fill: c.muted, 'font-size': 9.5,
      }, [label]));
    }

    const xLines = ax.kind === 'ordinal'
      ? ax.order.map((_, i) => i)
      : (useLog ? logTicks(xMin, xMax) : ticks(xMax, 4).filter((t) => t >= xMin));
    for (const t of xLines) {
      const x = ax.kind === 'ordinal' ? sx(t) : (useLog ? padL + ((t - xMin) / (xMax - xMin || 1)) * innerW : sx(t));
      root.appendChild(svg('line', { x1: x, x2: x, y1: padT, y2: padT + innerH, stroke: c.grid, 'stroke-width': 1 }));
      const label = ax.kind === 'ordinal' ? shortLabel(ax.order[t]) : (useLog ? fmtMw(Math.pow(10, t)) : fmtMw(t));
      root.appendChild(svg('text', {
        x, y: H - padB + 13, 'text-anchor': 'middle', fill: c.muted, 'font-size': 9.5,
      }, [label]));
    }

    root.appendChild(svg('text', {
      x: padL + innerW / 2, y: H - 2, 'text-anchor': 'middle', fill: c.secondary, 'font-size': 10.5,
    }, [ax.label + (useLog ? ' — log scale' : '')]));

    const dim = store.get('colorDim');
    const scale = buildScale(v.base, (r) => dimValue(r, dim, store.get('useRaw')), 'allPairs');
    const hoveredId = store.get('hoveredId');
    const selectedId = store.get('selectedId');

    // Deterministic jitter keyed off the facility ID, so a point does not hop
    // between renders.
    const jitter = (id, span) => {
      let h = 0;
      for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000;
      return ((h / 1000) - 0.5) * span;
    };

    for (const p of pts) {
      const jx = ax.kind === 'ordinal' ? jitter(p.r.id + 'x', innerW / (ax.order.length * 1.7)) : 0;
      const jy = ay.kind === 'ordinal' ? jitter(p.r.id + 'y', innerH / (ay.order.length * 1.7)) : 0;
      const cx = sx(p.x) + jx;
      const cy = sy(p.y) + jy;
      const isHover = p.r.id === hoveredId;
      const isSel = p.r.id === selectedId;

      // ≥8px markers, with a 2px surface ring instead of a border between marks.
      const dot = svg('circle', {
        cx, cy, r: isHover || isSel ? 7 : 4.5,
        fill: scale.of(dimValue(p.r, dim, store.get('useRaw'))),
        stroke: c.surface, 'stroke-width': 2,
        opacity: hoveredId && !isHover ? 0.3 : 0.92,
        'stroke-dasharray': p.r.mwEstimated ? '2 1.5' : null,
        style: 'cursor:pointer; transition: r 90ms',
        tabindex: 0, role: 'button',
        'aria-label': `${p.r.name}: ${ax.label} ${fmtMw(p.x)}, ${ay.label} ${ay.kind === 'ordinal' ? ay.order[p.y] : p.y}`,
      });

      const content = () => tipContent(p.r.name, [
        ['Operator', p.r.operator],
        ['Location', `${p.r.city}, ${p.r.country}`],
        [ax.label, ax.kind === 'ordinal' ? ax.order[p.x] : fmtMw(p.x)],
        [ay.label, ay.kind === 'ordinal' ? ay.order[p.y] : fmtMw(p.y)],
        p.r.mwEstimated ? ['Capacity', 'estimated', 't-est'] : null,
      ], 'Click to pin');

      dot.addEventListener('mouseenter', (e) => { store.hover(p.r.id); showTip(e, content()); });
      dot.addEventListener('mousemove', (e) => showTip(e, content()));
      dot.addEventListener('mouseleave', () => { store.hover(null); hideTip(); });
      dot.addEventListener('focus', () => {
        store.hover(p.r.id);
        const b = dot.getBoundingClientRect();
        showTip({ clientX: b.left + b.width / 2, clientY: b.bottom }, content());
      });
      dot.addEventListener('blur', () => { store.hover(null); hideTip(); });
      dot.addEventListener('click', () => store.select(p.r.id));
      dot.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); store.select(p.r.id); }
      });

      root.appendChild(dot);
    }

    return root;
  }

  return { root: ui.root, render };
}

/** Tier and band labels are long; axes get a compact form. */
function shortLabel(v) {
  if (!v) return '';
  return String(v)
    .replace('Extremely High', 'Extreme')
    .replace('Not rated (absent from FOTN)', 'Not rated')
    .replace(/\s*\(\d+–\d+\)/, '')
    .replace('Upper-moderate', 'Upper-mod')
    .replace('Low-moderate', 'Low-mod')
    .replace('Low–Medium', 'Low–Med')
    .replace('Medium–High', 'Med–High');
}

function logTicks(lo, hi) {
  const out = [];
  for (let e = Math.floor(lo); e <= Math.ceil(hi); e++) if (e >= lo && e <= hi) out.push(e);
  return out.length > 1 ? out : [lo, hi];
}

/**
 * views/bars.js — the DOM-rendered chart family: ranked bars, ordinal tier bars,
 * stacked composition, and the capacity treemap.
 *
 * These are real buttons rather than SVG rects, which buys keyboard focus, a
 * ~26px hit target and native `aria-pressed` for free — the cross-filter state
 * is legible to a screen reader, not just to the eye.
 *
 * Mark conventions (per the project's viz rules): one hue (slot 1) for a
 * single-series ranked bar — never a value-ramp over nominal categories; a 4px
 * rounded data-end anchored square to the baseline; a 2px surface gap between
 * adjacent stack segments instead of a border.
 */

import * as store from '../store.js';
import { dimValue, DIMENSIONS } from '../normalize.js';
import { buildScale, seriesOne } from '../colors.js';
import {
  aggregate, card, clear, el, fmtInt, fmtMw, hideTip, orderBy, showTip, tipContent, withStale,
} from './util.js';

const dimLabel = (key) => DIMENSIONS.find((d) => d.key === key)?.label || key;

/**
 * Ranked horizontal bars for one categorical dimension.
 *
 * The bars are computed from `exceptDim(dimKey)` — every filter *except* this
 * dimension's own. Without that, clicking "United States" would collapse this
 * chart to a single bar and you could never see what you had selected relative
 * to the rest, or click a second country.
 */
export function createRankedBars({ dimKey, title, span = 'c4', topN = 12, allowMeasureSwitch = true }) {
  const ui = card(title || `By ${dimLabel(dimKey).toLowerCase()}`, { span });

  let measure = 'mw';
  const measureSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Measure' });
  if (allowMeasureSwitch) ui.root.querySelector('header').appendChild(measureSeg);

  function renderSeg() {
    clear(measureSeg);
    for (const [value, label] of [['mw', 'MW'], ['count', 'Sites']]) {
      measureSeg.appendChild(el('button', {
        type: 'button', text: label, 'aria-pressed': String(measure === value),
        onclick: () => { measure = value; render(); },
      }));
    }
  }

  function render() {
    renderSeg();
    withStale(ui.body, () => {
      clear(ui.body);
      const v = store.view();
      const scoped = v.exceptDim(dimKey);
      const groups = aggregate(scoped, (r) => dimValue(r, dimKey, store.get('useRaw')), { measure });

      if (!groups.length) {
        ui.body.appendChild(el('div', { class: 'empty-state', text: 'No facilities match the filters.' }));
        ui.setNote('');
        return;
      }

      const shown = groups.slice(0, topN);
      const rest = groups.slice(topN);
      const max = Math.max(...shown.map((g) => (measure === 'mw' ? g.mw : g.n)), 0);
      const color = seriesOne();

      for (const g of shown) ui.body.appendChild(barRow(g, max, measure, color, dimKey));

      if (rest.length) {
        const restN = rest.reduce((a, g) => a + g.n, 0);
        const restMw = rest.reduce((a, g) => a + g.mw, 0);
        ui.body.appendChild(el('div', {
          class: 'ramp',
          text: `+ ${rest.length} more (${fmtInt(restN)} sites, ${fmtMw(restMw)} MW)`,
        }));
      }

      const coded = shown.reduce((a, g) => a + g.nWithMw, 0);
      const total = shown.reduce((a, g) => a + g.n, 0);
      ui.setNote(measure === 'mw' ? `${coded} of ${total} coded` : `${groups.length} groups`);
    });
  }

  return { root: ui.root, render };
}

/** One interactive bar row. `dimKey` is what a click toggles. */
function barRow(g, max, measure, color, dimKey) {
  const value = measure === 'mw' ? g.mw : g.n;
  const on = store.isActive(dimKey, g.key);
  const pct = max > 0 ? (value / max) * 100 : 0;

  const row = el('button', {
    type: 'button',
    class: `bar-row${on ? ' is-on' : ''}`,
    'aria-pressed': String(on),
    onclick: () => store.toggle(dimKey, g.key),
    onmouseenter: (e) => showTip(e, tip(g, measure)),
    onmousemove: (e) => showTip(e, tip(g, measure)),
    onmouseleave: hideTip,
    onfocus: (e) => showTip({ clientX: e.target.getBoundingClientRect().left + 40, clientY: e.target.getBoundingClientRect().bottom }, tip(g, measure)),
    onblur: hideTip,
  }, [
    el('span', { class: 'lbl', text: g.label, title: g.label }),
    el('span', { class: 'track' }, [
      el('span', { class: 'fill', style: { width: `${pct}%`, background: color } }),
    ]),
    el('span', { class: 'val', text: measure === 'mw' ? fmtMw(value) : fmtInt(value) }),
  ]);
  return row;
}

function tip(g, measure) {
  return tipContent(g.label, [
    ['Facilities', fmtInt(g.n)],
    ['Coded capacity', g.nWithMw ? `${fmtMw(g.mw)} MW` : 'none coded'],
    ['Capacity coded for', `${g.nWithMw} of ${g.n}`],
    g.nEstimated ? ['Of which estimated', fmtInt(g.nEstimated), 't-est'] : null,
    measure === 'mw' && g.nWithMw < g.n ? ['Caution', 'partial coverage'] : null,
  ], 'Click to filter');
}

/**
 * Bars for an ordinal dimension held in its documented sequence (water-stress
 * tiers, WGI bands) rather than sorted by size — the order carries meaning.
 */
export function createTierBars({ dimKey, title, span = 'c4' }) {
  const dim = DIMENSIONS.find((d) => d.key === dimKey);
  const ui = card(title || dimLabel(dimKey), { span });

  function render() {
    withStale(ui.body, () => {
      clear(ui.body);
      const v = store.view();
      const scoped = v.exceptDim(dimKey);
      const raw = aggregate(scoped, (r) => dimValue(r, dimKey, store.get('useRaw')));
      // Raw mode has appended basin/qualifier text, so the documented order no
      // longer matches the labels; fall back to magnitude order there.
      const groups = store.get('useRaw') ? raw : orderBy(raw, dim?.order);

      if (!groups.length) {
        ui.body.appendChild(el('div', { class: 'empty-state', text: 'No facilities match.' }));
        return;
      }
      const max = Math.max(...groups.map((g) => g.n));
      const color = seriesOne();
      for (const g of groups) ui.body.appendChild(barRow(g, max, 'count', color, dimKey));
      ui.setNote(`${fmtInt(groups.reduce((a, g) => a + g.n, 0))} sites`);
    });
  }

  return { root: ui.root, render };
}

/**
 * Stacked composition — share of facilities (or MW) by category, for a
 * dimension chosen from a picker. Segments are clickable and separated by a 2px
 * surface gap rather than a stroke.
 */
export function createComposition({ span = 'c6', dims, title = 'Composition' }) {
  const ui = card(title, { span });
  let dimKey = dims[0];
  let measure = 'count';

  const pick = el('select', { 'aria-label': 'Composition dimension' });
  for (const k of dims) pick.appendChild(el('option', { value: k, text: dimLabel(k) }));
  pick.addEventListener('change', () => { dimKey = pick.value; render(); });

  const measureSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Measure' });
  ui.root.querySelector('header').append(pick, measureSeg);

  function render() {
    clear(measureSeg);
    for (const [value, label] of [['count', 'Sites'], ['mw', 'MW']]) {
      measureSeg.appendChild(el('button', {
        type: 'button', text: label, 'aria-pressed': String(measure === value),
        onclick: () => { measure = value; render(); },
      }));
    }
    pick.value = dimKey;

    withStale(ui.body, () => {
      clear(ui.body);
      const v = store.view();
      const scoped = v.exceptDim(dimKey);
      const dim = DIMENSIONS.find((d) => d.key === dimKey);
      const agg = aggregate(scoped, (r) => dimValue(r, dimKey, store.get('useRaw')), { measure });
      const groups = (!store.get('useRaw') && dim?.order) ? orderBy(agg, dim.order) : agg;

      if (!groups.length) {
        ui.body.appendChild(el('div', { class: 'empty-state', text: 'No facilities match.' }));
        return;
      }

      // Scale built from the unfiltered base, so a category keeps its hue
      // regardless of what is filtered in or out.
      const scale = buildScale(v.base, (r) => dimValue(r, dimKey, store.get('useRaw')), 'adjacent');
      const total = groups.reduce((a, g) => a + (measure === 'mw' ? g.mw : g.n), 0);

      const stack = el('div', { class: 'stack', role: 'group', 'aria-label': `${dimLabel(dimKey)} composition` });
      for (const g of groups) {
        const value = measure === 'mw' ? g.mw : g.n;
        if (!value) continue;
        const on = store.isActive(dimKey, g.key);
        const anyOn = store.hasFilter(dimKey);
        const seg = el('button', {
          type: 'button',
          class: `seg${anyOn && !on ? ' is-dimmed' : ''}`,
          style: { flex: `${value} 0 0`, background: scale.of(g.key) },
          'aria-pressed': String(on),
          'aria-label': `${g.label}: ${measure === 'mw' ? `${fmtMw(value)} MW` : `${value} sites`}`,
          onclick: () => store.toggle(dimKey, g.key),
          onmouseenter: (e) => showTip(e, segTip(g, value, total, measure)),
          onmousemove: (e) => showTip(e, segTip(g, value, total, measure)),
          onmouseleave: hideTip,
          onfocus: (e) => {
            const r = e.target.getBoundingClientRect();
            showTip({ clientX: r.left + r.width / 2, clientY: r.bottom }, segTip(g, value, total, measure));
          },
          onblur: hideTip,
        });
        stack.appendChild(seg);
      }
      ui.body.appendChild(stack);

      // A legend is always present for ≥2 series, so identity is never colour-alone.
      const legend = el('div', { class: 'legend', style: { padding: '8px 0 0' } });
      for (const g of groups) {
        const on = store.isActive(dimKey, g.key);
        const value = measure === 'mw' ? g.mw : g.n;
        legend.appendChild(el('button', {
          type: 'button', class: `legend-item${on ? ' is-on' : ''}`, 'aria-pressed': String(on),
          onclick: () => store.toggle(dimKey, g.key),
        }, [
          el('span', { class: 'sw', style: { background: scale.of(g.key) } }),
          el('span', { text: `${g.label} · ${measure === 'mw' ? `${fmtMw(value)} MW` : fmtInt(value)}` }),
        ]));
      }
      ui.body.appendChild(legend);
      ui.setNote(measure === 'mw'
        ? `${groups.reduce((a, g) => a + g.nWithMw, 0)} of ${groups.reduce((a, g) => a + g.n, 0)} coded`
        : `${groups.length} categories`);
    });
  }

  return { root: ui.root, render };
}

function segTip(g, value, total, measure) {
  return tipContent(g.label, [
    [measure === 'mw' ? 'Capacity' : 'Facilities', measure === 'mw' ? `${fmtMw(value)} MW` : fmtInt(value)],
    ['Share', total ? `${((value / total) * 100).toFixed(1)}%` : '—'],
    measure === 'mw' ? ['Coded for', `${g.nWithMw} of ${g.n}`] : null,
    g.nEstimated ? ['Estimated', fmtInt(g.nEstimated), 't-est'] : null,
  ], 'Click to filter');
}

/**
 * Treemap of capacity by country → operator, via a squarified slice-and-dice.
 *
 * Only facilities with a usable MW figure can appear — area *is* capacity, so
 * an uncoded facility has no size to draw. The note reports how many were left
 * out rather than letting them silently vanish.
 */
export function createTreemap({ span = 'c6' }) {
  const ui = card('Capacity by country → operator', { span });
  const host = el('div', { class: 'treemap' });
  ui.body.appendChild(host);

  function render() {
    withStale(ui.body, () => {
      clear(host);
      const v = store.view();
      const usable = v.records.filter((r) => store.effectiveMw(r) !== null);
      const omitted = v.records.length - usable.length;

      if (!usable.length) {
        host.style.height = 'auto';
        clear(host).appendChild(el('div', {
          class: 'empty-state',
          text: store.get('capacityMode') === 'coded'
            ? 'No coded capacity in this selection. Switch capacity mode to Estimated to see structure.'
            : 'No facilities match the filters.',
        }));
        ui.setNote('');
        return;
      }

      const byCountry = new Map();
      for (const r of usable) {
        if (!byCountry.has(r.country)) byCountry.set(r.country, new Map());
        const ops = byCountry.get(r.country);
        ops.set(r.operator, (ops.get(r.operator) || 0) + store.effectiveMw(r));
      }

      const countries = [...byCountry.entries()]
        .map(([country, ops]) => ({
          country,
          value: [...ops.values()].reduce((a, b) => a + b, 0),
          children: [...ops.entries()].map(([operator, value]) => ({ operator, value }))
            .sort((a, b) => b.value - a.value),
        }))
        .sort((a, b) => b.value - a.value);

      const W = host.clientWidth || 420;
      const H = Math.max(220, Math.min(340, W * 0.62));
      host.style.height = `${H}px`;

      const scale = buildScale(v.base, (r) => r.country, 'adjacent');
      const total = countries.reduce((a, c) => a + c.value, 0);

      for (const cell of squarify(countries, 0, 0, W, H)) {
        const c = cell.node;
        // Nest operators inside each country block when there is room to read them.
        const inner = (cell.w > 46 && cell.h > 34)
          ? squarify(c.children, cell.x, cell.y, cell.w, cell.h)
          : [{ node: { operator: null, value: c.value }, ...cell }];

        for (const sub of inner) {
          const label = sub.node.operator;
          const fits = sub.w > 34 && sub.h > 16;
          const btn = el('button', {
            type: 'button',
            class: 'tm-cell',
            style: {
              left: `${sub.x}px`, top: `${sub.y}px`, width: `${Math.max(0, sub.w - 2)}px`,
              height: `${Math.max(0, sub.h - 2)}px`, background: scale.of(c.country),
            },
            'aria-label': `${c.country}${label ? ` — ${label}` : ''}: ${fmtMw(sub.node.value)} MW`,
            onclick: () => (label ? store.toggle('operator', label) : store.toggle('country', c.country)),
            onmouseenter: (e) => showTip(e, tmTip(c, label, sub.node.value, total)),
            onmousemove: (e) => showTip(e, tmTip(c, label, sub.node.value, total)),
            onmouseleave: hideTip,
            onblur: hideTip,
          }, [
            // Only label a cell when the text fits with padding — never clipped.
            fits ? el('span', { class: 'tm-lbl', text: label || c.country }) : null,
          ]);
          host.appendChild(btn);
        }
      }

      ui.setNote(omitted
        ? `${fmtInt(usable.length)} sized · ${omitted} without capacity omitted`
        : `${fmtInt(usable.length)} facilities`);
    });
  }

  return { root: ui.root, render };
}

/**
 * Squarified treemap layout (Bruls, Huizing & van Wijk) — lays children out in
 * rows/columns chosen to keep aspect ratios near 1.
 */
function squarify(nodes, x, y, w, h) {
  const items = nodes.filter((n) => n.value > 0);
  if (!items.length || w <= 0 || h <= 0) return [];

  const total = items.reduce((a, n) => a + n.value, 0);
  const scaled = items.map((n) => ({ node: n, area: (n.value / total) * w * h }));
  const out = [];

  let rx = x; let ry = y; let rw = w; let rh = h;
  let i = 0;

  while (i < scaled.length) {
    const horizontal = rw >= rh;
    const side = horizontal ? rh : rw;

    // Grow the current row while doing so improves the worst aspect ratio.
    let row = [scaled[i]];
    let rowArea = scaled[i].area;
    let best = worstRatio(row, rowArea, side);
    let j = i + 1;
    while (j < scaled.length) {
      const candArea = rowArea + scaled[j].area;
      const cand = worstRatio([...row, scaled[j]], candArea, side);
      if (cand > best) break;
      row = [...row, scaled[j]];
      rowArea = candArea;
      best = cand;
      j++;
    }

    const thickness = rowArea / side;
    let offset = horizontal ? ry : rx;
    for (const item of row) {
      const extent = item.area / thickness;
      out.push(horizontal
        ? { node: item.node, x: rx, y: offset, w: thickness, h: extent }
        : { node: item.node, x: offset, y: ry, w: extent, h: thickness });
      offset += extent;
    }

    if (horizontal) { rx += thickness; rw -= thickness; } else { ry += thickness; rh -= thickness; }
    i = j;
  }
  return out;
}

function worstRatio(row, rowArea, side) {
  const thickness = rowArea / side;
  let worst = 0;
  for (const item of row) {
    const extent = item.area / thickness;
    const ratio = Math.max(thickness / extent, extent / thickness);
    worst = Math.max(worst, ratio);
  }
  return worst === 0 ? Infinity : worst;
}

function tmTip(c, operator, value, total) {
  return tipContent(operator || c.country, [
    operator ? ['Country', c.country] : null,
    ['Capacity', `${fmtMw(value)} MW`],
    ['Share of shown', total ? `${((value / total) * 100).toFixed(1)}%` : '—'],
  ], 'Click to filter');
}

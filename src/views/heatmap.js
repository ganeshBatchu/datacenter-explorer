/**
 * views/heatmap.js — a two-dimension cross-tab, colour-ramped by magnitude.
 *
 * Where the ranked-bar and composition views each look at one categorical
 * dimension at a time, the heatmap answers "how do two dimensions intersect" —
 * e.g. host country × ownership structure, which cells this project's thesis
 * (capacity and jurisdictional control) is actually about. Cell colour is a
 * single-hue sequential ramp (the same SEQ_BLUE used by the map's choropleth),
 * never a categorical hue, because a cell encodes a magnitude, not an identity.
 *
 * A native <table> rather than a DOM grid of divs, so row/column headers stay
 * legible to a screen reader (`scope="row"`/`scope="col"`) instead of colour
 * being the only carrier of "which row is this".
 */

import * as store from '../store.js';
import { dimValue, DIMENSIONS } from '../normalize.js';
import { seqColor, SEQ_BLUE, NO_DATA_COLOR, isDark } from '../colors.js';
import {
  aggregate, card, clear, el, fmtInt, fmtMw, hideTip, orderBy, showTip, tipContent, withStale,
} from './util.js';

const dimLabel = (key) => DIMENSIONS.find((d) => d.key === key)?.label || key;

const ROW_N = 12;
const COL_N = 8;

export function createHeatmap({ span = 'c6', dims, title = 'Heatmap' } = {}) {
  const ui = card(title, { span, bodyClass: 'flush' });
  const list = dims || DIMENSIONS.map((d) => d.key);

  let rowDim = list.includes('country') ? 'country' : list[0];
  let colDim = list.find((k) => k !== rowDim) || list[0];
  let measure = 'count';

  const rowPick = el('select', { 'aria-label': 'Heatmap rows' });
  const xEl = el('span', {
    text: '×', 'aria-hidden': 'true',
    style: { color: 'var(--text-muted)', fontSize: '11px' },
  });
  const colPick = el('select', { 'aria-label': 'Heatmap columns' });
  const measureSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Measure' });
  for (const k of list) {
    rowPick.appendChild(el('option', { value: k, text: dimLabel(k) }));
    colPick.appendChild(el('option', { value: k, text: dimLabel(k) }));
  }
  rowPick.addEventListener('change', () => {
    rowDim = rowPick.value;
    if (colDim === rowDim) colDim = list.find((k) => k !== rowDim) || colDim;
    render();
  });
  colPick.addEventListener('change', () => {
    colDim = colPick.value;
    if (rowDim === colDim) rowDim = list.find((k) => k !== colDim) || rowDim;
    render();
  });
  ui.root.querySelector('header').append(rowPick, xEl, colPick, measureSeg);

  const host = el('div', { class: 'heatmap-wrap' });
  ui.body.appendChild(host);

  function renderSeg() {
    clear(measureSeg);
    for (const [value, label] of [['count', 'Sites'], ['mw', 'MW']]) {
      measureSeg.appendChild(el('button', {
        type: 'button', text: label, 'aria-pressed': String(measure === value),
        onclick: () => { measure = value; render(); },
      }));
    }
  }

  function render() {
    renderSeg();
    rowPick.value = rowDim;
    colPick.value = colDim;

    withStale(ui.body, () => {
      clear(host);
      const v = store.view();
      const useRaw = store.get('useRaw');
      const scoped = v.exceptDims([rowDim, colDim]);

      const rowDef = DIMENSIONS.find((d) => d.key === rowDim);
      const colDef = DIMENSIONS.find((d) => d.key === colDim);

      let rowGroups = aggregate(scoped, (r) => dimValue(r, rowDim, useRaw), { measure });
      let colGroups = aggregate(scoped, (r) => dimValue(r, colDim, useRaw), { measure });
      if (!useRaw && rowDef?.order) rowGroups = orderBy(rowGroups, rowDef.order);
      if (!useRaw && colDef?.order) colGroups = orderBy(colGroups, colDef.order);

      const rows = rowGroups.slice(0, ROW_N);
      const cols = colGroups.slice(0, COL_N);
      const rowsOmitted = rowGroups.length - rows.length;
      const colsOmitted = colGroups.length - cols.length;

      if (!rows.length || !cols.length) {
        host.appendChild(el('div', { class: 'empty-state', text: 'No facilities match the filters.' }));
        ui.setNote('');
        return;
      }

      const rowKeys = new Set(rows.map((g) => g.key));
      const colKeys = new Set(cols.map((g) => g.key));
      const cells = new Map(); // `${rowKey}||${colKey}` -> { n, mw, nWithMw, nEstimated }

      for (const r of scoped) {
        const rv = dimValue(r, rowDim, useRaw);
        const cv = dimValue(r, colDim, useRaw);
        const rk = rv === null || rv === undefined || rv === '' ? null : rv;
        const ck = cv === null || cv === undefined || cv === '' ? null : cv;
        if (!rowKeys.has(rk) || !colKeys.has(ck)) continue;
        const key = `${rk}||${ck}`;
        if (!cells.has(key)) cells.set(key, { n: 0, mw: 0, nWithMw: 0, nEstimated: 0 });
        const c = cells.get(key);
        c.n++;
        const mw = store.effectiveMw(r);
        if (mw !== null) { c.mw += mw; c.nWithMw++; if (r.mwEstimated) c.nEstimated++; }
      }

      const valueOf = (c) => (measure === 'mw' ? c.mw : c.n);
      const max = Math.max(0, ...[...cells.values()].map(valueOf));

      host.appendChild(buildTable({ rows, cols, cells, max, valueOf }));

      const noteBits = [];
      if (rowsOmitted) noteBits.push(`+${rowsOmitted} rows`);
      if (colsOmitted) noteBits.push(`+${colsOmitted} cols not shown`);
      ui.setNote(noteBits.length ? noteBits.join(', ') : `${rows.length} × ${cols.length}`);
    });
  }

  function buildTable({ rows, cols, cells, max, valueOf }) {
    const dark = isDark();
    const table = el('table', { class: 'hm-table' });
    const thead = el('thead', {}, [
      el('tr', {}, [
        el('th', { class: 'hm-corner', scope: 'col' }),
        ...cols.map((g) => el('th', { class: 'hm-col', scope: 'col' }, [
          el('span', { text: g.label, title: g.label }),
        ])),
      ]),
    ]);

    const tbody = el('tbody');
    for (const rg of rows) {
      const tr = el('tr', {}, [
        el('th', { class: 'hm-row', scope: 'row', text: rg.label, title: rg.label }),
        ...cols.map((cg) => {
          const c = cells.get(`${rg.key}||${cg.key}`);
          if (!c || !c.n) {
            return el('td', { class: 'hm-td' }, [
              el('span', { class: 'hm-cell hm-empty', style: { background: NO_DATA_COLOR[dark ? 'dark' : 'light'] } }),
            ]);
          }
          const value = valueOf(c);
          const t = max > 0 ? value / max : 0;
          const bg = seqColor(t);
          const on = store.isActive(rowDim, rg.key) && store.isActive(colDim, cg.key);
          const btn = el('button', {
            type: 'button',
            class: `hm-cell${on ? ' is-on' : ''}${t > 0.55 ? ' is-dark-bg' : ''}`,
            style: { background: bg },
            'aria-pressed': String(on),
            'aria-label': `${rg.label} × ${cg.label}: ${measure === 'mw' ? `${fmtMw(value)} MW` : `${fmtInt(value)} sites`}`,
            onclick: () => { store.toggle(rowDim, rg.key); store.toggle(colDim, cg.key); },
            onmouseenter: (e) => showTip(e, cellTip(rg, cg, c, measure)),
            onmousemove: (e) => showTip(e, cellTip(rg, cg, c, measure)),
            onmouseleave: hideTip,
            onfocus: (e) => {
              const r = e.target.getBoundingClientRect();
              showTip({ clientX: r.left + r.width / 2, clientY: r.bottom }, cellTip(rg, cg, c, measure));
            },
            onblur: hideTip,
          }, [
            el('span', { class: 'hm-val', text: measure === 'mw' ? fmtMw(value) : fmtInt(value) }),
          ]);
          return el('td', { class: 'hm-td' }, [btn]);
        }),
      ]);
      tbody.appendChild(tr);
    }

    const wrap = el('div', {}, [
      table,
    ]);
    table.append(thead, tbody);

    const legend = el('div', { class: 'ramp' }, [
      el('span', { text: '0' }),
      el('div', { class: 'bar', style: { background: `linear-gradient(to right, ${SEQ_BLUE.join(',')})` } }),
      el('span', { text: measure === 'mw' ? `${fmtMw(max)} MW` : `${fmtInt(max)} sites` }),
    ]);
    return el('div', {}, [wrap, legend]);
  }

  function cellTip(rg, cg, c, measure) {
    return tipContent(`${rg.label} × ${cg.label}`, [
      ['Facilities', fmtInt(c.n)],
      ['Coded capacity', c.nWithMw ? `${fmtMw(c.mw)} MW` : 'none coded'],
      ['Capacity coded for', `${c.nWithMw} of ${c.n}`],
      c.nEstimated ? ['Of which estimated', fmtInt(c.nEstimated), 't-est'] : null,
      measure === 'mw' && c.nWithMw < c.n ? ['Caution', 'partial coverage'] : null,
    ], 'Click to filter both axes');
  }

  return { root: ui.root, render };
}

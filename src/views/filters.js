/**
 * views/filters.js — the single filter row and the stat tiles.
 *
 * One filter row above everything it scopes: no per-chart filters, so every view
 * always answers the same question about the same slice.
 */

import * as store from '../store.js';
import { DIMENSIONS, dimValue } from '../normalize.js';
import { clear, el, fmtInt, fmtMw, fmtPct } from './util.js';

/** Dimensions offered as dropdown filters, in the order they appear in the bar. */
const FILTER_DIMS = ['country', 'region', 'operator', 'operatorCountry', 'ownership', 'serviceModel', 'include'];

export function createFilterBar() {
  const root = el('div', { class: 'filterbar' });

  const searchInput = el('input', {
    type: 'search', placeholder: 'facility, operator, city…', 'aria-label': 'Search facilities',
  });
  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    // Debounced: typing re-filters 244 records and re-renders every view.
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => store.set('search', searchInput.value.trim()), 140);
  });

  const selects = new Map();
  for (const key of FILTER_DIMS) {
    const sel = el('select', { 'aria-label': DIMENSIONS.find((d) => d.key === key)?.label || key });
    sel.addEventListener('change', () => {
      store.setFilter(key, sel.value ? [sel.value] : []);
    });
    selects.set(key, sel);
  }

  const colorSel = el('select', { 'aria-label': 'Colour markers by' });
  for (const d of DIMENSIONS) colorSel.appendChild(el('option', { value: d.key, text: d.label }));
  colorSel.value = store.get('colorDim');
  colorSel.addEventListener('change', () => store.set('colorDim', colorSel.value));

  const capSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Capacity mode' });
  const rawSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Category labels' });
  const strictBtn = el('button', { class: 'btn', type: 'button', text: 'Strict basis' });
  strictBtn.addEventListener('click', () => store.set('strictBasis', !store.get('strictBasis')));

  const clearBtn = el('button', { class: 'btn', type: 'button', text: 'Clear all' });
  clearBtn.addEventListener('click', () => store.clearAll());

  const chipHost = el('div', { class: 'chips' });

  const field = (label, node) => el('div', { class: 'field' }, [el('label', { text: label }), node]);

  root.append(
    field('Search', searchInput),
    ...FILTER_DIMS.map((k) => field(DIMENSIONS.find((d) => d.key === k)?.label || k, selects.get(k))),
    field('Colour by', colorSel),
    field('Capacity', capSeg),
    field('Labels', rawSeg),
    field(' ', strictBtn),
    field(' ', clearBtn),
    el('div', { class: 'field', style: { flexBasis: '100%' } }, [chipHost]),
  );

  function render() {
    const v = store.view();

    // Dropdown options come from the slice filtered by every *other* dimension,
    // so the choices offered are always ones that would return rows.
    for (const [key, sel] of selects) {
      const scoped = v.exceptDim(key);
      const values = [...new Set(scoped.map((r) => dimValue(r, key, store.get('useRaw'))))]
        .filter((x) => x !== null && x !== undefined && x !== '')
        .sort((a, b) => String(a).localeCompare(String(b)));

      const active = v.state.filters.get(key);
      const current = active && active.size === 1 ? [...active][0] : '';
      clear(sel);
      sel.appendChild(el('option', { value: '', text: `All (${values.length})` }));
      for (const val of values) sel.appendChild(el('option', { value: val, text: String(val) }));
      // A multi-value filter (set from a legend or chart click) has no single
      // dropdown representation; show it as such rather than lying.
      if (active && active.size > 1) {
        sel.appendChild(el('option', { value: '', text: `— ${active.size} selected —`, selected: true }));
      } else {
        sel.value = current;
      }
    }

    colorSel.value = store.get('colorDim');

    clear(capSeg);
    for (const [value, label] of [['coded', 'Coded only'], ['imputed', 'Estimated']]) {
      capSeg.appendChild(el('button', {
        type: 'button', text: label, 'aria-pressed': String(store.get('capacityMode') === value),
        onclick: () => store.set('capacityMode', value),
      }));
    }

    clear(rawSeg);
    for (const [value, label] of [[false, 'Grouped'], [true, 'Raw']]) {
      rawSeg.appendChild(el('button', {
        type: 'button', text: label, 'aria-pressed': String(store.get('useRaw') === value),
        onclick: () => store.set('useRaw', value),
      }));
    }

    strictBtn.setAttribute('aria-pressed', String(store.get('strictBasis')));
    strictBtn.style.color = store.get('strictBasis') ? 'var(--accent)' : '';
    strictBtn.title = 'Count only reported/approximate figures — drop campus, planned and minimum values';

    if (searchInput.value !== store.get('search') && document.activeElement !== searchInput) {
      searchInput.value = store.get('search');
    }

    clear(chipHost);
    const chips = store.activeChips();
    for (const c of chips) {
      chipHost.appendChild(el('span', { class: 'chip' }, [
        el('span', { text: c.text }),
        el('button', {
          type: 'button', text: '×', 'aria-label': `Remove filter ${c.text}`,
          onclick: () => {
            if (c.dim) store.toggle(c.dim, c.value);
            else if (c.measure) store.setRange(c.measure, null, null);
            else if (c.search) store.set('search', '');
          },
        }),
      ]));
    }
    clearBtn.style.display = chips.length ? '' : 'none';
  }

  return { root, render };
}

// ---------------------------------------------------------------------------
// Stat tiles + coverage banner
// ---------------------------------------------------------------------------

/**
 * The headline numbers. These are stat tiles rather than a chart because each is
 * a single figure — a one-bar bar chart would be the wrong form.
 */
export function createStats() {
  const root = el('section', { class: 'card c12', bodyClass: 'flush' });
  const grid = el('div', { class: 'stats' });
  root.appendChild(grid);

  function tile(k, v, unit, sub) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v' }, [String(v), unit ? el('span', { class: 'u', text: unit }) : null]),
      el('div', { class: 'sub', text: sub || '' }),
    ]);
  }

  function render() {
    const v = store.view();
    const s = v.stats;
    clear(grid);
    grid.append(
      tile('Facilities', fmtInt(s.n), null, s.n === s.nTotal ? 'no filters' : `of ${fmtInt(s.nTotal)}`),
      tile('Countries', fmtInt(new Set(v.records.map((r) => r.country)).size)),
      tile('Operators', fmtInt(new Set(v.records.map((r) => r.operator)).size)),
      tile('Capacity', fmtMw(s.totalMw), 'MW',
        s.nEstimated ? `${s.nWithMw} sites · ${s.nEstimated} estimated` : `${s.nWithMw} of ${s.n} coded`),
      tile('Restricted-party', fmtInt(v.records.filter((r) => r.restrictedParty).length), null, 'BIS or OFAC listed'),
      tile('Offshore domicile', fmtInt(v.records.filter((r) => r.offshoreDomicile).length), null, 'Cayman / VIE structures'),
    );
  }

  return { root, render };
}

/**
 * Coverage banner. Capacity is coded for well under half the dataset and the
 * gaps are unevenly distributed by country, so any capacity ranking partly
 * measures sourcing effort. That caveat is pinned to the top of the app rather
 * than left to a footnote.
 */
export function createBanner() {
  const root = el('div', { class: 'banner' });

  function render() {
    const v = store.view();
    const meta = v.meta;
    const mode = store.get('capacityMode');
    clear(root);
    root.classList.toggle('is-estimated', mode === 'imputed');

    if (mode === 'imputed') {
      root.append(
        el('span', { class: 'ico', text: '⚠' }),
        el('span', {}, [
          el('strong', { text: 'Estimated capacity is on. ' }),
          `${fmtInt(v.stats.nEstimated)} of ${fmtInt(v.stats.nWithMw)} figures in view are imputed from operator medians — they are not in the workbook, which leaves them blank deliberately because operator IT load is undisclosed. Treat totals as indicative only; CSV export keeps them in a separate column.`,
        ]),
      );
      return;
    }

    const worst = [...meta.coverageByCountry]
      .filter((c) => c.n >= 4)
      .sort((a, b) => (a.coded / a.n) - (b.coded / b.n))
      .slice(0, 3)
      .map((c) => `${c.country} ${c.coded}/${c.n}`)
      .join(', ');

    root.append(
      el('span', { class: 'ico', text: 'ℹ' }),
      el('span', {}, [
        el('strong', { text: `Capacity is coded for ${meta.capacity.nCoded} of ${meta.nFacilities} facilities (${fmtPct(meta.capacity.pctCoded)}). ` }),
        `Coverage is uneven — thinnest: ${worst}. Capacity rankings therefore partly reflect how much has been sourced, not only real capacity. Switch to Estimated to fill gaps from operator medians.`,
      ]),
    );
  }

  return { root, render };
}

/**
 * app.js — bootstrap: load the workbook, build the views, wire the render loop.
 */

import { loadSheets, resolveMode } from './adapter/index.js';
import * as store from './store.js';
import { errorScreen, setupScreen } from './views/gate.js';
import { createBanner, createFilterBar, createStats } from './views/filters.js';
import { createMap } from './views/map.js';
import { createRankedBars, createTierBars, createComposition, createTreemap } from './views/bars.js';
import { createCapacityHistogram, createScatter } from './views/plots.js';
import { createHeatmap } from './views/heatmap.js';
import { createDetail, createTable } from './views/detail.js';
import { clear, el, fmtInt } from './views/util.js';

const app = document.getElementById('app');

boot();

async function boot() {
  const status = el('div', { text: 'Starting…' });
  clear(app).appendChild(el('div', { class: 'loading' }, [el('div', { class: 'spinner' }), status]));

  // Decide what screen to show before attempting to read any data: without a
  // configured share link there is no dataset to load at all.
  const resolved = resolveMode();
  if (resolved.mode === 'setup') { showGate(setupScreen()); return; }

  let loaded;
  try {
    loaded = await loadSheets({ onProgress: (msg) => { status.textContent = msg; } });
  } catch (err) {
    showGate(errorScreen({ error: err, onRetry: () => boot() }));
    return;
  }

  let meta;
  try {
    meta = store.init(loaded.sheets);
  } catch (err) {
    showGate(errorScreen({
      error: new Error(`${err.message} — the workbook downloaded but could not be parsed. `
        + 'A sheet or column header may have been renamed; see COLS in src/normalize.js.'),
      onRetry: () => boot(),
    }));
    return;
  }

  render(loaded.source, meta);
}

function showGate(node) { clear(app).appendChild(node); }

function render(source, meta) {
  clear(app);

  const filters = createFilterBar();
  const banner = createBanner();
  const stats = createStats();

  const map = createMap();
  const detail = createDetail({ span: 'c4' });

  const byCountry = createRankedBars({ dimKey: 'country', title: 'By host country', span: 'c4' });
  const byOperator = createRankedBars({ dimKey: 'operator', title: 'By operator', span: 'c4' });
  const byNationality = createRankedBars({ dimKey: 'operatorCountry', title: 'By operator nationality', span: 'c4' });

  const histogram = createCapacityHistogram({ span: 'c6' });
  const scatter = createScatter({ span: 'c6' });

  const water = createTierBars({ dimKey: 'waterStress', title: 'Water stress (WRI)', span: 'c4' });
  const envRisk = createTierBars({ dimKey: 'envRisk', title: 'Environmental risk tier', span: 'c4' });
  const composition = createComposition({
    span: 'c4',
    dims: ['ownership', 'serviceModel', 'fotnBand', 'regQuality', 'polStability', 'operatorType', 'dataLocalization', 'fdiScreening'],
    title: 'Composition',
  });

  const treemap = createTreemap({ span: 'c6' });
  const heatmap = createHeatmap({
    span: 'c6',
    title: 'Heatmap',
    dims: ['country', 'operatorCountry', 'ownerCountry', 'ownership', 'operatorType',
      'serviceModel', 'region', 'operator', 'status', 'waterStress', 'envRisk',
      'regQuality', 'polStability', 'fotnBand', 'dataLocalization', 'fdiScreening'],
  });
  const table = createTable({ span: 'c12' });

  const views = [stats, map, detail, byCountry, byOperator, byNationality,
    histogram, scatter, water, envRisk, composition, treemap, heatmap, table];

  const grid = el('div', { class: 'grid' }, [
    stats.root,
    map.root, detail.root,
    byCountry.root, byOperator.root, byNationality.root,
    histogram.root, scatter.root,
    water.root, envRisk.root, composition.root,
    treemap.root, heatmap.root,
    table.root,
  ]);

  app.append(
    topbar(source, meta),
    filters.root,
    banner.root,
    el('main', { class: 'main' }, [grid]),
  );

  /**
   * Hover changes only which mark is highlighted, so it repaints the three views
   * that show highlight state and skips the eight that would re-aggregate
   * identical numbers. Without this split, moving the mouse across the map
   * re-renders every chart on every pointer event.
   */
  store.subscribe((opts) => {
    if (opts && opts.hoverOnly) {
      map.renderHover();
      detail.renderHover();
      table.renderHover();
      return;
    }
    filters.render();
    banner.render();
    for (const v of views) v.render();
  });

  filters.render();
  banner.render();
  for (const v of views) v.render();

  // Leaflet caches its container's pixel size at construction, which happens
  // above while the grid is still detached — so it starts out believing it is
  // 0x0, lays out no markers, and loads no tiles. It has to re-measure once
  // mounted. The ResizeObserver in views/map.js does NOT cover this: it fires on
  // observe() while the element is detached (size 0, ignored) and not again on
  // attach, so the first measurement must be triggered explicitly here.
  //
  // setTimeout, NOT requestAnimationFrame: rAF is suspended while a tab is
  // hidden, so opening the app in a background tab (or a restored session)
  // would leave the map permanently blank. A macrotask always runs, and by then
  // layout is committed.
  setTimeout(() => map.invalidate(), 0);

  // Selecting from a chart or the table pans the map to that facility.
  let lastSelected = null;
  store.subscribe(() => {
    const id = store.get('selectedId');
    if (id && id !== lastSelected) map.focusFacility(id);
    lastSelected = id;
  });

  // Re-render on resize: bar widths, treemap layout and SVG viewBoxes are all
  // computed from measured pixel widths.
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      map.invalidate();
      for (const v of views) v.render();
    }, 160);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (store.get('selectedId')) store.select(store.get('selectedId'));
      else store.clearAll();
    }
  });
}

function topbar(source, meta) {
  const pill = el('span', {
    // Green for the real data sources; amber for the local dev copy, so you can
    // never mistake a preview for the published dataset.
    class: `source-pill${source.mode === 'local' ? ' is-bundled' : ''}`,
    title: source.detail || source.label,
  }, [el('span', { class: 'dot' }), el('span', { text: source.label })]);


  const themeBtn = el('button', {
    class: 'btn icon', type: 'button', text: '◐', 'aria-label': 'Toggle colour theme',
    title: 'Toggle light / dark',
    onclick: () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'dark' ? 'light' : cur === 'light' ? 'dark'
        : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark');
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('dc-theme', next); } catch { /* private mode */ }
      window.dispatchEvent(new Event('resize'));
    },
  });

  const warn = meta.joinWarnings.length
    ? el('span', {
      class: 'flag warning',
      text: `⚠ ${meta.joinWarnings.length} join warnings`,
      title: meta.joinWarnings.slice(0, 12).join('\n'),
    })
    : null;

  return el('div', { class: 'topbar' }, [
    el('h1', { text: 'Global Data-Centre Infrastructure' }),
    el('span', {
      class: 'sub',
      text: `${fmtInt(meta.nFacilities)} facilities · ${meta.nCountries} countries · ${meta.nOperators} operators`,
    }),
    el('span', { class: 'topbar-spacer' }),
    warn,
    pill,
    themeBtn,
  ]);
}

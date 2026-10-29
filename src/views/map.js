/**
 * views/map.js — the geographic view.
 *
 * Two layers the user switches between:
 *   Facilities — one marker per site, radius ∝ √MW, fill = the selected dimension.
 *   Countries  — choropleth of aggregate capacity (or facility count) per country,
 *                on a single-hue sequential ramp with a scale legend.
 *
 * Coordinates in this dataset are city/area centroids at 2dp, so many facilities
 * share a point (6 at Ashburn, 6 at Dublin, 5 at Frankfurt). Clustering plus
 * spiderfy-on-max-zoom is what makes those reachable; without it the stacked
 * markers are simply unclickable.
 */

import * as store from '../store.js';
import { dimValue } from '../normalize.js';
import { buildScale, seqColor, SEQ_BLUE, NO_DATA_COLOR, isDark } from '../colors.js';
import { card, clear, el, fmtInt, fmtMw, hideTip, showTip, tipContent, BASIS_LABEL, REASON_LABEL } from './util.js';
import { CONFIG } from '../config.js';

const BASEMAP = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
const ATTRIB = 'Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Source: Esri, TomTom, Garmin, FAO, NOAA, USGS, &copy; OpenStreetMap contributors, and the GIS User Community';

export function createMap() {
  const ui = card('Geography', { span: 'c8', bodyClass: 'flush' });

  // Layer + measure switches live in the card header: they change what the map
  // *is*, not which records it shows, so they are not data filters.
  const layerSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Map layer' });
  const measureSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Choropleth measure' });
  ui.root.querySelector('header').append(layerSeg, measureSeg);

  let mapLayer = 'facilities';
  let choroMeasure = 'mw';

  const seg = (host, options, get, set) => {
    clear(host);
    for (const [value, label] of options) {
      host.appendChild(el('button', {
        type: 'button', text: label, 'aria-pressed': String(get() === value),
        onclick: () => { set(value); render(); },
      }));
    }
  };

  const mapDiv = el('div', { id: 'map' });
  const legendHost = el('div');
  ui.body.append(mapDiv, legendHost);

  const map = L.map(mapDiv, {
    worldCopyJump: true,
    minZoom: 1,
    zoomControl: true,
    // Scroll-wheel zoom hijacks page scrolling on a narrow layout, so it is
    // enabled only once the map has focus.
    scrollWheelZoom: false,
    attributionControl: true,
  }).setView([25, 10], 2);

  map.on('click focus', () => map.scrollWheelZoom.enable());
  map.on('mouseout blur', () => map.scrollWheelZoom.disable());

  let tileBase = null;
  function setTiles() {
    if (tileBase) map.removeLayer(tileBase);
    tileBase = L.tileLayer(BASEMAP, {
      attribution: ATTRIB,
      maxZoom: 19,
    }).addTo(map);
  }
  setTiles();

  const markerLayer = L.markerClusterGroup({
    maxClusterRadius: 38,
    spiderfyOnMaxZoom: true,
    showCoverageOnHover: false,
    disableClusteringAtZoom: 11,
    iconCreateFunction: (cluster) => {
      const n = cluster.getChildCount();
      const size = n < 10 ? 30 : n < 50 ? 38 : 46;
      return L.divIcon({
        html: `<div class="dc-cluster" style="width:${size}px;height:${size}px">${n}</div>`,
        className: '', iconSize: [size, size],
      });
    },
  });

  let choroLayer = null;
  let geo = null;
  const markersById = new Map();

  fetch(CONFIG.countriesGeoJson)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((json) => { geo = json; if (mapLayer === 'countries') render(); })
    .catch(() => { geo = null; });   // choropleth degrades to unavailable; markers still work

  // -------------------------------------------------------------------------

  /** Radius in px from MW. √ scaling so area — not radius — encodes magnitude. */
  function radiusFor(mw, maxMw) {
    if (mw === null || maxMw <= 0) return 4.5;
    return 4.5 + 13 * Math.sqrt(mw / maxMw);
  }

  function renderFacilities(v, scale) {
    markerLayer.clearLayers();
    markersById.clear();

    const withCoords = v.records.filter((r) => r.hasCoords);
    const maxMw = withCoords.reduce((m, r) => Math.max(m, store.effectiveMw(r) ?? 0), 0);

    for (const r of withCoords) {
      const mw = store.effectiveMw(r);
      const dim = store.get('colorDim');
      const value = dimOf(r, dim);
      const size = radiusFor(mw, maxMw) * 2;

      const icon = L.divIcon({
        className: '',
        iconSize: [size, size],
        html: `<div class="dc-marker${r.mwEstimated ? ' is-estimated' : ''}" data-id="${r.id}"
                    style="width:${size}px;height:${size}px;background:${scale.of(value)}"></div>`,
      });
      const marker = L.marker([r.lat, r.lon], {
        icon, keyboard: true,
        title: `${r.name} — ${r.city}, ${r.country}`,
        alt: `${r.name}, ${r.city}, ${r.country}`,
      });

      marker.on('mouseover', (e) => {
        store.hover(r.id);
        showFacilityTip(e.originalEvent, r, scale);
      });
      marker.on('mouseout', () => { store.hover(null); hideTip(); });
      marker.on('click', () => store.select(r.id));

      markersById.set(r.id, marker);
      markerLayer.addLayer(marker);
    }

    if (!map.hasLayer(markerLayer)) map.addLayer(markerLayer);
    if (choroLayer && map.hasLayer(choroLayer)) map.removeLayer(choroLayer);

    renderCategoryLegend(scale, withCoords.length, v.records.length);
  }

  function showFacilityTip(evt, r, scale) {
    const mw = store.effectiveMw(r);
    const dim = store.get('colorDim');
    showTip(evt, tipContent(r.name, [
      ['Operator', r.operator],
      ['Location', `${r.city}, ${r.country}`],
      mw !== null
        ? ['Capacity', `${fmtMw(mw)} MW${r.mwEstimated ? ' (est.)' : ''}`, r.mwEstimated ? 't-est' : '']
        : ['Capacity', REASON_LABEL[r.mwReason] || 'not coded'],
      r.mwCoded && r.mwBasis !== 'reported' ? ['Basis', BASIS_LABEL[r.mwBasis]] : null,
      ['Colour', `${scale.labelOf(dimOf(r, dim))}`],
      r.restrictedParty ? ['Restricted party', `${r.bisListed ? 'BIS' : ''}${r.bisListed && r.ofacListed ? ' + ' : ''}${r.ofacListed ? 'OFAC' : ''}`] : null,
    ], 'Click to pin details'));
  }

  function renderChoropleth(v) {
    markerLayer.clearLayers();
    if (map.hasLayer(markerLayer)) map.removeLayer(markerLayer);
    if (choroLayer) { map.removeLayer(choroLayer); choroLayer = null; }

    if (!geo) {
      clear(legendHost).appendChild(el('div', { class: 'empty-state', text: 'Country polygons unavailable.' }));
      return;
    }

    // Aggregate the *filtered* set so the choropleth answers the same question
    // as every other view.
    const agg = new Map();
    for (const r of v.records) {
      if (!agg.has(r.country)) agg.set(r.country, { n: 0, mw: 0, nWithMw: 0, nEst: 0 });
      const a = agg.get(r.country);
      a.n++;
      const mw = store.effectiveMw(r);
      if (mw !== null) { a.mw += mw; a.nWithMw++; if (r.mwEstimated) a.nEst++; }
    }

    const valueOf = (c) => {
      const a = agg.get(c);
      if (!a) return null;
      return choroMeasure === 'mw' ? (a.nWithMw ? a.mw : null) : a.n;
    };
    const max = Math.max(0, ...[...agg.keys()].map((c) => valueOf(c) ?? 0));

    choroLayer = L.geoJSON(geo, {
      className: 'choro-path',
      style: (f) => {
        const val = valueOf(f.properties.country);
        return {
          fillColor: val === null ? NO_DATA_COLOR[isDark() ? 'dark' : 'light'] : seqColor(max ? val / max : 0),
          fillOpacity: 0.82,
          color: isDark() ? '#1a1a19' : '#fcfcfb',
          weight: 0.9,
        };
      },
      onEachFeature: (f, layer) => {
        const c = f.properties.country;
        const a = agg.get(c);
        layer.on('mouseover', (e) => {
          showTip(e.originalEvent, tipContent(c, [
            ['Facilities', a ? fmtInt(a.n) : '0 (filtered out)'],
            a ? ['Capacity', a.nWithMw ? `${fmtMw(a.mw)} MW` : 'none coded'] : null,
            a && a.nWithMw ? ['Coded', `${a.nWithMw} of ${a.n} facilities`] : null,
            a && a.nEst ? ['Estimated', `${a.nEst} imputed`, 't-est'] : null,
            f.properties.approx ? ['Note', 'polygon approximated'] : null,
          ], 'Click to filter to this country'));
        });
        layer.on('mouseout', () => hideTip());
        layer.on('click', () => store.toggle('country', c));
      },
    }).addTo(map);

    renderRampLegend(max, agg);
  }

  function renderCategoryLegend(scale, shown, total) {
    const host = clear(legendHost);
    const legend = el('div', { class: 'legend', role: 'group', 'aria-label': 'Marker colour legend' });
    const dim = store.get('colorDim');

    for (const e of scale.entries()) {
      const on = store.isActive(dim, e.value);
      const btn = el('button', {
        type: 'button', class: `legend-item${on ? ' is-on' : ''}`,
        'aria-pressed': String(on),
        onclick: () => {
          // The folded tail is a display bucket, not a real value, so clicking it
          // filters to every value inside it rather than to the label "Other".
          if (e.folded) store.setFilter(dim, store.hasFilter(dim) ? [] : e.folded);
          else store.toggle(dim, e.value);
        },
      }, [el('span', { class: 'sw', style: { background: e.color } }), el('span', { text: e.label })]);
      legend.appendChild(btn);
    }
    host.appendChild(legend);

    if (shown < total) {
      host.appendChild(el('div', { class: 'ramp', text: `${total - shown} facilities hidden — no coordinates` }));
    }
    host.appendChild(el('div', {
      class: 'ramp',
      text: 'Marker area ∝ capacity (MW). Dashed outline = estimated capacity.',
    }));
  }

  function renderRampLegend(max, agg) {
    const host = clear(legendHost);
    const grad = `linear-gradient(to right, ${SEQ_BLUE.join(',')})`;
    host.appendChild(el('div', { class: 'ramp' }, [
      el('span', { text: '0' }),
      el('div', { class: 'bar', style: { background: grad } }),
      el('span', { text: choroMeasure === 'mw' ? `${fmtMw(max)} MW` : `${fmtInt(max)} sites` }),
    ]));
    const noCoded = [...agg.entries()].filter(([, a]) => choroMeasure === 'mw' && !a.nWithMw).map(([c]) => c);
    if (noCoded.length) {
      host.appendChild(el('div', { class: 'ramp', text: `Grey = no coded capacity: ${noCoded.join(', ')}` }));
    }
  }

  const dimOf = (r, dim) => dimValue(r, dim, store.get('useRaw'));

  // -------------------------------------------------------------------------

  function render() {
    const v = store.view();

    seg(layerSeg, [['facilities', 'Facilities'], ['countries', 'Countries']],
      () => mapLayer, (x) => { mapLayer = x; });
    seg(measureSeg, [['mw', 'Capacity'], ['count', 'Count']],
      () => choroMeasure, (x) => { choroMeasure = x; });
    measureSeg.style.display = mapLayer === 'countries' ? '' : 'none';

    const dim = store.get('colorDim');
    // Scale is built from the unfiltered base so hues never shift on filter.
    const scale = buildScale(v.base, (r) => dimOf(r, dim), 'allPairs');

    if (mapLayer === 'facilities') renderFacilities(v, scale);
    else renderChoropleth(v);

    ui.setNote(mapLayer === 'facilities'
      ? `${fmtInt(v.records.filter((r) => r.hasCoords).length)} sites`
      : `${fmtInt(new Set(v.records.map((r) => r.country)).size)} countries`);
  }

  /** Hover-only repaint: touch classes, never rebuild the cluster tree. */
  function renderHover() {
    const hoveredId = store.get('hoveredId');
    const selectedId = store.get('selectedId');
    for (const [id, marker] of markersById) {
      const node = marker.getElement()?.querySelector('.dc-marker');
      if (!node) continue;
      node.classList.toggle('is-hovered', id === hoveredId);
      node.classList.toggle('is-selected', id === selectedId);
      node.classList.toggle('is-dimmed', Boolean(hoveredId && id !== hoveredId));
    }
  }

  /** Pans to a facility when it is selected from another view. */
  function focusFacility(id) {
    const r = store.view().records.find((x) => x.id === id);
    if (!r || !r.hasCoords) return;
    map.flyTo([r.lat, r.lon], Math.max(map.getZoom(), 8), { duration: 0.55 });
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { setTiles(); render(); });

  /**
   * Keeps the map correct across *subsequent* size changes — the card reflowing
   * between the wide grid and the narrow single column, a window resize, an
   * orientation change.
   *
   * This does not handle the initial mount: observe() fires once while the
   * element is still detached (size 0, ignored below) and does not fire again
   * when it is attached, so app.js triggers the first measurement explicitly.
   */
  // Dev hook: `?local=1` exposes the Leaflet instance for console debugging.
  if (new URLSearchParams(window.location.search).has('local')) window.__dcMap = map;

  let lastW = 0; let lastH = 0;
  new ResizeObserver((entries) => {
    const { width, height } = entries[0].contentRect;
    if (!width || !height) return;
    if (Math.abs(width - lastW) < 2 && Math.abs(height - lastH) < 2) return;
    const wasUnsized = lastW === 0;
    lastW = width; lastH = height;
    map.invalidateSize();
    // Markers positioned against a zero-size viewport need a genuine re-render,
    // not just an invalidate.
    if (wasUnsized) render();
  }).observe(mapDiv);

  return { root: ui.root, render, renderHover, focusFacility, invalidate: () => map.invalidateSize(), onThemeChange: () => { setTiles(); render(); } };
}

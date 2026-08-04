/**
 * views/detail.js — the facility detail panel and the table view.
 *
 * The table is not an extra: colour-coded marks on a continuous scale need a
 * WCAG-clean twin, and three of the light-mode palette slots sit below 3:1
 * against the surface. Every value shown in a tooltip is reachable here.
 */

import * as store from '../store.js';
import { card, clear, el, fmtInt, fmtMw, BASIS_LABEL, REASON_LABEL } from './util.js';

/** Layer-grouped field list for the detail panel, mirroring the workbook's bands. */
const LAYERS = [
  ['Layer 0 — Identification', [
    ['Facility ID', (r) => r.id],
    ['Operator', (r) => r.operator],
    ['Owner / parent', (r) => r.ownerParent],
    ['City', (r) => r.city],
    ['Country', (r) => r.country],
    ['Region', (r) => r.region],
    ['Address', (r) => r.address],
    ['Coordinates', (r) => (r.hasCoords ? `${r.lat}, ${r.lon}` : null)],
    ['Year RFS', (r) => r.yearRfsRaw],
    ['Status', (r) => r.statusRaw],
  ]],
  ['Layer 1 — Physical / infrastructure', [
    ['Capacity', capacityText],
    ['Capacity (raw cell)', (r) => r.capacityRaw],
    ['Energy source', (r) => r.energySource],
    ['Grid carbon', (r) => (r.gridCarbon !== null ? `${r.gridCarbon} gCO₂/kWh` : null)],
    ['Water stress (WRI)', (r) => r.waterStressRaw],
    ['Environmental risk', (r) => r.envRiskRaw],
    ['Siting determinants', (r) => r.siting],
  ]],
  ['Layer 2 — Network / interconnection', [
    ['Network connectivity', (r) => r.network],
    ['On-net IXPs / cables', (r) => r.ixps],
    ['Interconnection density', (r) => r.interconnectDensity],
    ['Cable-landing proximity', (r) => r.cableProximity],
  ]],
  ['Layer 3 — Ownership / control', [
    ['Operator type', (r) => r.operatorTypeRaw],
    ['Operator nationality', (r) => r.operatorCountry],
    ['# Chinese operators', (r) => (r.nChineseOperators === null ? null : String(r.nChineseOperators))],
    ['Owner(s)', (r) => r.owners],
    ['Ownership structure', (r) => r.ownershipRaw],
    ['Parent origin', (r) => r.ownerCountry],
    ['# Chinese owners', (r) => (r.nChineseOwners === null ? null : String(r.nChineseOwners))],
    ['Ultimate parent', (r) => r.ultimateParent],
    ['Legal domicile', (r) => r.domicile],
    ['State operating share', (r) => r.stateShare],
    ['Siting logic', (r) => r.sitingLogic],
    ['LEI', (r) => r.lei],
  ]],
  ['Layer 4 — Supply chain', [
    ['Construction firm(s)', (r) => r.constructionFirms],
    ['Energy supplier(s)', (r) => r.energySuppliers],
    ['Chip supplier(s)', (r) => r.chipSuppliers],
    ['Hardware supplier(s)', (r) => r.hardwareSuppliers],
    ['Export-control exposure', (r) => r.exportControlRaw],
  ]],
  ['Layer 5 — Regulatory / sovereignty', [
    ['Jurisdiction', (r) => r.jurisdiction],
    ['Data law', (r) => r.dataLaw],
    ['Data localization', (r) => r.dataLocalizationRaw],
    ['FDI screening', (r) => r.fdiScreeningRaw],
    ['Financing model', (r) => r.financing],
    ['Government user(s)', (r) => r.govUsers],
    ['Development incentive', (r) => r.incentive],
    ['Zoning controversy', (r) => r.zoning],
    ['Regulatory quality', (r) => r.regQuality],
    ['Political stability', (r) => r.polStability],
    ['Internet freedom', (r) => (r.internetFreedom !== null ? `${r.internetFreedom}/100 — ${r.fotnBand}` : r.fotnBand)],
    ['WGI rule of law', (r) => (r.ruleOfLaw !== null ? String(r.ruleOfLaw) : null)],
  ]],
  ['Analysis flags', [
    ['Service model', (r) => r.serviceModelRaw],
    ['Include / exclude', (r) => r.includeRaw],
    ['Verification', (r) => r.verification],
    ['Notes', (r) => r.notes],
  ]],
];

function capacityText(r) {
  const mw = store.effectiveMw(r);
  if (mw === null) return `not coded — ${REASON_LABEL[r.mwReason] || 'unknown'}`;
  if (r.mwEstimated) return `${fmtMw(mw)} MW — estimated (${r.mwSource.replace('imputed-', 'from ')} median)`;
  return `${fmtMw(mw)} MW — ${BASIS_LABEL[r.mwBasis] || r.mwBasis}`;
}

export function createDetail({ span = 'c4' }) {
  const ui = card('Facility detail', { span });

  function render() {
    clear(ui.body);
    const v = store.view();
    const id = store.get('selectedId') || store.get('hoveredId');
    const r = id ? v.all.find((x) => x.id === id) : null;

    if (!r) {
      ui.body.appendChild(el('div', {
        class: 'empty-state',
        text: 'Hover a marker, bar or dot to preview. Click to pin.',
      }));
      ui.setNote('');
      return;
    }

    const root = el('div', { class: 'detail' });
    root.appendChild(el('div', { class: 'd-name', text: r.name }));
    root.appendChild(el('div', { class: 'd-sub', text: `${r.operator} · ${r.city}, ${r.country}` }));

    // Restricted-party status is a status colour, so it ships with a label —
    // never colour alone.
    const flags = el('div', { class: 'legend', style: { padding: '0 0 8px' } });
    if (r.bisListed) flags.appendChild(el('span', { class: 'flag critical', text: `⚑ BIS Entity List` }));
    if (r.ofacListed) flags.appendChild(el('span', { class: 'flag critical', text: `⚑ OFAC listed` }));
    if (r.offshoreDomicile) flags.appendChild(el('span', { class: 'flag warning', text: '⚠ Offshore domicile' }));
    if (r.include === 'Exclude') flags.appendChild(el('span', { class: 'flag neutral', text: '○ Excluded by service-model rule' }));
    if (r.isPlaceholder) flags.appendChild(el('span', { class: 'flag warning', text: '⚠ Placeholder example row' }));
    if (r.mwEstimated) flags.appendChild(el('span', { class: 'flag warning', text: '⚠ Capacity estimated' }));
    if (flags.children.length) root.appendChild(flags);

    const dl = el('dl');
    for (const [layer, fields] of LAYERS) {
      dl.appendChild(el('div', { class: 'layer-h', text: layer }));
      for (const [label, get] of fields) {
        const value = get(r);
        dl.appendChild(el('dt', { text: label }));
        dl.appendChild(value
          ? el('dd', { text: value })
          : el('dd', { class: 'empty', text: '—' }));
      }
    }
    root.appendChild(dl);
    ui.body.appendChild(root);
    ui.setNote(store.get('selectedId') === r.id ? 'pinned' : 'preview');
  }

  return { root: ui.root, render, renderHover: render };
}

// ---------------------------------------------------------------------------
// Table view
// ---------------------------------------------------------------------------

const COLUMNS = [
  { key: 'id', label: 'ID' },
  { key: 'name', label: 'Facility' },
  { key: 'operator', label: 'Operator' },
  { key: 'country', label: 'Country' },
  { key: 'city', label: 'City' },
  { key: 'mw', label: 'MW', num: true },
  { key: 'operatorCountry', label: 'Operator nat.' },
  { key: 'ownership', label: 'Ownership' },
  { key: 'serviceModel', label: 'Service model' },
  { key: 'waterStress', label: 'Water stress' },
  { key: 'regQuality', label: 'Reg. quality' },
  { key: 'internetFreedom', label: 'FOTN', num: true },
  { key: 'include', label: 'Include' },
];

export function createTable({ span = 'c12' }) {
  const ui = card('Table view', { span, bodyClass: 'flush' });
  const wrap = el('div', { class: 'table-wrap' });
  ui.body.appendChild(wrap);

  let sortKey = 'mw';
  let sortDir = -1;

  const csvBtn = el('button', {
    class: 'btn', type: 'button', text: 'Export CSV',
    onclick: exportCsv,
  });
  ui.root.querySelector('header').appendChild(csvBtn);

  function valueOf(r, key) {
    if (key === 'mw') return store.effectiveMw(r);
    return r[key];
  }

  function render() {
    clear(wrap);
    const v = store.view();
    const rows = [...v.records].sort((a, b) => {
      const x = valueOf(a, sortKey); const y = valueOf(b, sortKey);
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * sortDir;
      return String(x).localeCompare(String(y)) * sortDir;
    });

    const table = el('table', { class: 'data' });
    const thead = el('thead');
    const tr = el('tr');
    for (const c of COLUMNS) {
      tr.appendChild(el('th', {
        text: c.label + (sortKey === c.key ? (sortDir === -1 ? ' ↓' : ' ↑') : ''),
        scope: 'col',
        'aria-sort': sortKey === c.key ? (sortDir === -1 ? 'descending' : 'ascending') : 'none',
        onclick: () => {
          if (sortKey === c.key) sortDir *= -1; else { sortKey = c.key; sortDir = c.num ? -1 : 1; }
          render();
        },
      }));
    }
    thead.appendChild(tr);
    table.appendChild(thead);

    const tbody = el('tbody');
    const hoveredId = store.get('hoveredId');
    const selectedId = store.get('selectedId');
    for (const r of rows) {
      const row = el('tr', {
        class: `${r.id === hoveredId ? 'is-hovered' : ''} ${r.id === selectedId ? 'is-selected' : ''}`.trim(),
        onmouseenter: () => store.hover(r.id),
        onmouseleave: () => store.hover(null),
        onclick: () => store.select(r.id),
      });
      for (const c of COLUMNS) {
        const raw = valueOf(r, c.key);
        let text = raw === null || raw === undefined || raw === '' ? '—' : String(raw);
        if (c.key === 'mw' && raw !== null) text = fmtMw(raw);
        row.appendChild(el('td', {
          class: `${c.num ? 'num' : ''} ${c.key === 'mw' && r.mwEstimated ? 'est' : ''}`.trim(),
          text: c.key === 'mw' && r.mwEstimated ? `${text} est.` : text,
          title: text.length > 24 ? text : null,
        }));
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    ui.setNote(`${fmtInt(rows.length)} of ${fmtInt(v.stats.nTotal)} facilities`);
  }

  /**
   * Exports the current filtered slice. Imputed capacity is deliberately
   * written as an empty cell with a separate `capacity_estimated_mw` column, so
   * a number the workbook does not contain can never be mistaken for source data.
   */
  function exportCsv() {
    const v = store.view();
    const cols = [
      ['facility_id', (r) => r.id],
      ['facility_name', (r) => r.name],
      ['operator', (r) => r.operator],
      ['owner_parent', (r) => r.ownerParent],
      ['country', (r) => r.country],
      ['city', (r) => r.city],
      ['lat', (r) => r.lat],
      ['lon', (r) => r.lon],
      ['capacity_mw_coded', (r) => (r.mwCoded ? r.mw : '')],
      ['capacity_basis', (r) => (r.mwCoded ? r.mwBasis : '')],
      ['capacity_uncoded_reason', (r) => (r.mwCoded ? '' : r.mwReason)],
      ['capacity_estimated_mw', (r) => (r.mwEstimated ? r.mw : '')],
      ['capacity_raw', (r) => r.capacityRaw],
      ['operator_nationality', (r) => r.operatorCountry],
      ['n_chinese_operators', (r) => r.nChineseOperators],
      ['owner_origin', (r) => r.ownerCountry],
      ['legal_domicile', (r) => r.domicile],
      ['ownership_structure', (r) => r.ownership],
      ['ownership_structure_raw', (r) => r.ownershipRaw],
      ['operator_type', (r) => r.operatorType],
      ['service_model', (r) => r.serviceModel],
      ['include_flag', (r) => r.include],
      ['water_stress', (r) => r.waterStress],
      ['env_risk_tier', (r) => r.envRisk],
      ['grid_carbon_gco2_kwh', (r) => r.gridCarbon],
      ['bis_listed', (r) => r.bisListed],
      ['ofac_listed', (r) => r.ofacListed],
      ['fdi_screening', (r) => r.fdiScreening],
      ['data_localization', (r) => r.dataLocalization],
      ['reg_quality', (r) => r.regQuality],
      ['political_stability', (r) => r.polStability],
      ['internet_freedom_fotn', (r) => r.internetFreedom],
      ['fotn_band', (r) => r.fotnBand],
      ['wgi_rule_of_law', (r) => r.ruleOfLaw],
      ['year_rfs', (r) => r.yearRfs],
      ['status', (r) => r.status],
      ['verification', (r) => r.verification],
    ];
    const esc = (x) => {
      if (x === null || x === undefined) return '';
      const s = String(x);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.map((c) => c[0]).join(',')];
    for (const r of v.records) lines.push(cols.map(([, get]) => esc(get(r))).join(','));

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'datacenter-explorer-filtered.csv' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  return { root: ui.root, render, renderHover: render };
}

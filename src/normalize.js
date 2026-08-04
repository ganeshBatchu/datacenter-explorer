/**
 * normalize.js — single source of truth for turning the raw workbook into analysis records.
 *
 * Runs identically whether the sheets came from a live OneDrive fetch or the bundled
 * copy, so there is exactly one definition of "capacity" / "operator nationality" /
 * "service model" in the whole app.
 *
 * Column names below are the literal header strings read from the workbook on
 * 2026-08-04 (master_dataset_1_values_2.xlsx). If a header is renamed upstream,
 * COLS is the only place that needs editing.
 */

export const COLS = {
  facilities: {
    id: 'Facility ID', name: 'Facility name', operator: 'Operator',
    ownerParent: 'Owner / parent', country: 'Country', region: 'Region', city: 'City',
    lat: 'Lat', lon: 'Long', capacity: 'Capacity (MW)', energy: 'Energy source',
    gridCarbon: 'Grid carbon (lookup)', water: 'Water-stress (WRI)',
    ixps: 'On-net IXPs / cables', notes: 'Notes', yearRfs: 'Year RFS', status: 'Status',
    serviceModel: 'Service model', include: 'Include? (svc-model rule)',
    verification: 'Verification (this audit)',
  },
  consolidated: {
    id: 'Facility ID', address: 'Facility address',
    envRisk: 'Environmental risk tier', siting: 'Siting determinants',
    network: 'Network connectivity', interconnect: 'Interconnection density',
    cable: 'Cable-landing proximity',
    operatorType: 'Operator type',
    operatorCountry: 'Operator(s) country / # Chinese operators',
    stateShare: 'State operating share', owners: 'Owner(s)',
    ownership: 'Ownership structure / state backing / share',
    ownerCountry: 'Parent-company origin / Owner(s) country / # Chinese owners',
    sitingLogic: 'Operator siting logic',
    construction: 'Construction firm(s) (+country,#CN,state)',
    energySuppliers: 'Energy supplier(s) (+country,#CN,state)',
    chips: 'Chip supplier(s) (+country,#CN)',
    hardware: 'Hardware supplier(s) (+country,#CN)',
    dataLaw: 'Data law (host country)', dataLocalization: 'Data-localization regime',
    fdi: 'FDI screening status', exportControl: 'Export-control exposure',
    financing: 'Financing model', govUsers: 'Government user(s)',
    incentive: 'Development incentive (host country)',
    zoning: 'Zoning / planning controversy',
    regQuality: 'Regulatory quality (host country)',
    polStability: 'Political stability (host country)',
    internetFreedom: 'Internet freedom (host country)',
  },
  operators: {
    operator: 'Operator', type: 'Type', parent: 'Ultimate parent',
    parentHq: 'Parent HQ country', ownership: 'Ownership / state-backing',
    bis: 'On BIS Entity List?', ofac: 'On OFAC list (incl. NS-CMIC)?',
    lei: 'LEI', domicile: 'Legal domicile / SEC filer (EDGAR)',
  },
  jurisdictions: {
    country: 'Country', region: 'Region', fdi: 'FDI screening?',
    localization: 'Data-localization?', gridCarbon: 'Grid carbon (gCO2/kWh, 2024)',
    internetFreedom: 'Internet freedom (FOTN 2025 /100)',
    ruleOfLaw: 'WGI Rule of Law (2024, −2.5 to 2.5)',
    regQuality: 'WGI Regulatory Quality (band)',
    polStability: 'WGI Political Stability (band)',
  },
};

/** Rows whose values are placeholders rather than data. */
export const PLACEHOLDER_IDS = ['DC-0001']; // README: "(example) ... replace with Data Center Map"

const s = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** The workbook marks "not yet sourced" with an arrow, sometimes with trailing prose. */
const isUnresolved = (v) => v === '' || v.includes('→');

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/**
 * Capacity (MW) is free text in the workbook. Only ~30% of rows carry a number,
 * and those that do mix in qualifiers that change what the number *means*:
 *   '25'                    -> reported, exact
 *   '~103 (est.)'           -> approximate
 *   '~1,289 (campus)'       -> whole campus, not this building
 *   '300+ (planned campus)' -> a floor on a future build
 *   '~150 (early phase)'    -> partial build-out
 *   '~6,500 sqm'            -> floor AREA, not power. Must never be read as MW.
 *   'region' / 'site (MW n/p)' / '→ to verify' -> no value
 *
 * Returns { mw, basis, coded, raw, reason }. `coded: false` means "no usable MW",
 * and callers must exclude the row from capacity sums rather than treat it as 0.
 */
export function parseCapacity(raw) {
  const v = s(raw);
  const out = { raw: v, mw: null, basis: null, coded: false, reason: null };

  if (isUnresolved(v)) { out.reason = 'unresolved'; return out; }
  // Area units first: '~6,500 sqm' contains a number that is emphatically not MW.
  if (/\b(sqm|sq\s?m|m2|m²|sq\s?ft|sqft|acre|hectare|ha)\b/i.test(v)) {
    out.reason = 'area-not-power'; return out;
  }
  if (/\b(n\/p|n\/a|not published|undisclosed)\b/i.test(v)) { out.reason = 'not-published'; return out; }

  const m = v.match(/(\d[\d,]*\.?\d*)/);
  if (!m) { out.reason = 'no-number'; return out; } // 'region'

  const mw = parseFloat(m[1].replace(/,/g, ''));
  if (!isFinite(mw) || mw <= 0) { out.reason = 'no-number'; return out; }

  // Order matters: the weakest claim wins, so a '300+ (planned campus)' is
  // reported as planned rather than as a clean campus figure.
  let basis = 'reported';
  if (/campus/i.test(v)) basis = 'campus';
  if (/~|\best\b|approx/i.test(v)) basis = 'approx';
  if (/\+|scalable/.test(v)) basis = 'floor';
  if (/planned|early phase|phase\s*\d|initial/i.test(v)) basis = 'planned';

  return { raw: v, mw, basis, coded: true, reason: null };
}

/** Basis values that describe this building's actual current load. */
export const STRICT_BASES = ['reported', 'approx'];

// ---------------------------------------------------------------------------
// Composite string fields
// ---------------------------------------------------------------------------

/**
 * 'United States (# Chinese op: 0)' -> { country: 'United States', nChinese: 0 }
 * 'China (# Chinese owner: 1); domicile: Cayman Is. incorp.; ops Shanghai, PRC — 20-F/6-K [...]'
 *   -> { country: 'China', nChinese: 1, domicile: 'Cayman Is. incorp.; ops Shanghai, PRC — ...' }
 * Multi-country cells ('United States / Canada') are kept verbatim as `country`
 * and also split into `countries` for counting.
 */
export function splitOrigin(raw) {
  const v = s(raw);
  if (isUnresolved(v)) return { country: null, countries: [], nChinese: null, domicile: null, raw: v };

  const nMatch = v.match(/#\s*Chinese\s*(?:op|owner)s?\s*:\s*(\d+)/i);
  const domMatch = v.match(/domicile:\s*(.+)$/i);

  let country = v.split(/\(#/)[0].trim().replace(/[;,]$/, '');
  const countries = country.split('/').map((x) => x.trim()).filter(Boolean);

  return {
    country: country || null,
    countries,
    nChinese: nMatch ? parseInt(nMatch[1], 10) : null,
    domicile: domMatch ? domMatch[1].trim() : null,
    raw: v,
  };
}

/** True when the parent is incorporated offshore relative to where it operates. */
export function offshoreDomicile(domicile) {
  return /cayman|virgin islands|bermuda|VIE|jersey|luxembourg/i.test(s(domicile));
}

/** 'BIS: No ; OFAC: Yes (NS-CMIC, EO 13959)' -> { bis: false, ofac: true, ... } */
export function splitExportControl(raw) {
  const v = s(raw);
  const grab = (label) => {
    const m = v.match(new RegExp(label + '\\s*:\\s*(Yes|No)([^;]*)', 'i'));
    return m ? { flag: /yes/i.test(m[1]), detail: m[2].trim().replace(/^\(|\)$/g, '') || null } : { flag: null, detail: null };
  };
  const bis = grab('BIS'); const ofac = grab('OFAC');
  return { bis: bis.flag, bisDetail: bis.detail, ofac: ofac.flag, ofacDetail: ofac.detail, raw: v };
}

/** 'Yes (Entity List, 2019)' / 'No' -> boolean (Operators sheet uses prose, not flags). */
export function yesNo(raw) {
  const v = s(raw);
  if (/^yes/i.test(v)) return true;
  if (/^no/i.test(v)) return false;
  return null;
}

/** '73' | 'n/a (not in FOTN)' | '58 (FOTN, Partly Free)' -> 73 | null | 58 */
export function parseScore(raw) {
  const v = s(raw);
  if (!v || /^n\/a/i.test(v) || isUnresolved(v)) return null;
  const m = v.match(/-?\d+\.?\d*/);
  return m ? parseFloat(m[0]) : null;
}

/** '~2014 (SH1)' | '2006+' | '1985 bldg / 2018 EQIX' | '→ verify' -> 2014 | 2006 | 1985 | null */
export function parseYear(raw) {
  const v = s(raw);
  if (isUnresolved(v)) return null;
  const m = v.match(/(19|20)\d{2}/);
  return m ? parseInt(m[0], 10) : null;
}

// ---------------------------------------------------------------------------
// Category grouping (the raw <-> grouped toggle)
// ---------------------------------------------------------------------------

/** Water stress: 10 raw labels are 6 WRI tiers plus appended basin notes. */
const WATER_ORDER = ['Low', 'Low–Medium', 'Medium', 'Medium–High', 'High', 'Extremely High'];
export function groupWater(raw) {
  const v = s(raw);
  // Longest-first so 'Low–Medium' is not swallowed by 'Low'.
  for (const tier of ['Extremely High', 'Medium–High', 'Low–Medium', 'High', 'Medium', 'Low']) {
    if (v.startsWith(tier)) return tier;
  }
  return v || null;
}
export const WATER_TIERS = WATER_ORDER;
export const waterRank = (t) => WATER_ORDER.indexOf(t);

/** Environmental risk: 3 raw labels, all suffixed '(water+emissions; heat n/a)'. */
const ENV_ORDER = ['Low', 'Moderate', 'High'];
export function groupEnvRisk(raw) {
  const v = s(raw);
  for (const t of ENV_ORDER) if (v.startsWith(t)) return t;
  return v || null;
}
export const ENV_TIERS = ENV_ORDER;
export const envRank = (t) => ENV_ORDER.indexOf(t);

/** Service model: 18 raw labels collapse to 4 real classes. */
export function groupServiceModel(raw) {
  const v = s(raw);
  if (/^colocation/i.test(v)) return 'Colocation';
  if (/captive|self-build/i.test(v)) return 'Captive (self-build)';
  if (/cloud region/i.test(v)) return 'Commercial cloud region';
  if (/AI-HPC|neocloud/i.test(v)) return 'AI-HPC / neocloud';
  return v || null;
}

/** Operator type: 22 raw labels -> 6. */
export function groupOperatorType(raw) {
  const v = s(raw);
  if (/hyperscaler/i.test(v)) return 'Hyperscaler';
  if (/telco/i.test(v)) return 'Telco / DC';
  if (/AI-HPC|neocloud/i.test(v)) return 'AI-HPC / neocloud';
  if (/self-build/i.test(v)) return 'Self-build';
  if (/^colocation/i.test(v)) return 'Colocation';
  return v || null;
}

/** Status: 6 raw labels -> 2. A row saying 'Operational (scaling)' is operational. */
export function groupStatus(raw) {
  const v = s(raw);
  if (/^operational/i.test(v)) return 'Operational';
  if (/construction/i.test(v)) return 'Under construction';
  return v || null;
}

/** Ownership structure: 47 raw labels -> 6 control classes (the thesis-relevant cut). */
export function groupOwnership(raw) {
  const v = s(raw);
  if (/state-owned/i.test(v)) return 'State-owned';
  if (/state-linked|state-backed|sovereign/i.test(v)) return 'State-linked';
  if (/\bJV\b|joint venture/i.test(v)) return 'Joint venture';
  if (/\bPE\b|private equity|DigitalBridge|EQT|Brookfield/i.test(v)) return 'PE-owned / PE-backed';
  if (/^public/i.test(v)) return 'Public';
  if (/^private/i.test(v)) return 'Private';
  return v || null;
}

/** FDI screening: 5 raw labels -> Yes / No. */
export function groupFdi(raw) {
  const v = s(raw);
  if (/^yes/i.test(v)) return 'Yes';
  if (/^no/i.test(v)) return 'No';
  return v || null;
}

/** Data localization: 14 raw labels -> 3 regimes. */
export function groupLocalization(raw) {
  const v = s(raw);
  if (/^yes/i.test(v)) return 'Yes';
  if (/^partial/i.test(v)) return 'Partial';
  if (/^no/i.test(v)) return 'No';
  return v || null;
}

/** WGI bands share one ordering across regulatory quality and political stability. */
export const WGI_ORDER = ['Low', 'Low-moderate', 'Moderate', 'Upper-moderate', 'High', 'Very high'];
export const wgiRank = (b) => WGI_ORDER.indexOf(s(b));

/**
 * Freedom House FOTN score -> the standard published band.
 * 34 of 194 facilities sit in countries absent from FOTN, which is a real
 * category ('Not rated'), not a zero.
 */
export function fotnBand(score) {
  if (score === null || score === undefined) return 'Not rated (absent from FOTN)';
  if (score >= 70) return 'Free (70–100)';
  if (score >= 40) return 'Partly Free (40–69)';
  return 'Not Free (0–39)';
}
export const FOTN_ORDER = ['Not Free (0–39)', 'Partly Free (40–69)', 'Free (70–100)', 'Not rated (absent from FOTN)'];

// ---------------------------------------------------------------------------
// Join + build records
// ---------------------------------------------------------------------------

const indexBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) { const k = s(r[key]); if (k) m.set(k, r); }
  return m;
};

/**
 * Columns without which the join cannot be performed at all.
 *
 * These are checked explicitly because losing one fails *quietly* otherwise:
 * if `Facility ID` is missing, every row looks like it has no id, every row is
 * skipped, and the app renders a working-looking dashboard reporting zero
 * facilities. That happened for real — a stray keypress in Excel for the web
 * cleared the `Facilities!A1` and `Operators!A1` header cells, and nothing
 * downstream complained. A missing header is a broken source, not an empty
 * dataset, and should say so.
 */
const REQUIRED = [
  ['facilities', COLS.facilities.id, 'Facilities'],
  ['facilities', COLS.facilities.country, 'Facilities'],
  ['facilities', COLS.facilities.operator, 'Facilities'],
  ['consolidated', COLS.consolidated.id, 'Consolidated (all layers)'],
  ['operators', COLS.operators.operator, 'Operators'],
  ['jurisdictions', COLS.jurisdictions.country, 'Jurisdictions'],
];

/**
 * Throws when a required header is absent from a sheet, naming the sheet, the
 * column and the likely cause.
 */
export function assertSchema(sheets) {
  const problems = [];
  for (const [key, column, sheetLabel] of REQUIRED) {
    const rows = sheets[key];
    if (!rows || !rows.length) { problems.push(`sheet "${sheetLabel}" is empty or missing`); continue; }
    // Header strings become object keys, so a cleared header cell means the key
    // is simply absent from every row.
    if (!Object.prototype.hasOwnProperty.call(rows[0], column)) {
      problems.push(`"${sheetLabel}" has no "${column}" column`);
    }
  }
  if (problems.length) {
    throw new Error(
      `the workbook is missing required header cells — ${problems.join('; ')}. `
      + 'This usually means a header cell was cleared or renamed in the source '
      + 'workbook. Restore it (OneDrive → File → Version history) or update COLS '
      + 'in src/normalize.js if the column was deliberately renamed.',
    );
  }
}

/**
 * Joins the four sheets into one record per facility.
 *
 * All four joins were verified clean against master_dataset_1_values_2.xlsx:
 * 194/194 facility IDs present in both facility-grain sheets, no duplicate IDs,
 * 194/194 operator cells matching the Operators sheet exactly, and every
 * facility country present in Jurisdictions. Unmatched keys are still surfaced
 * on `meta.joinWarnings` so upstream edits that break a join are visible
 * instead of silently producing nulls.
 */
export function buildRecords({ facilities, consolidated, operators, jurisdictions }) {
  assertSchema({ facilities, consolidated, operators, jurisdictions });
  const F = COLS.facilities, C = COLS.consolidated, O = COLS.operators, J = COLS.jurisdictions;
  const cIdx = indexBy(consolidated, C.id);
  const oIdx = indexBy(operators, O.operator);
  // 'EU (bloc)' is a bloc-level row with 'n/a (bloc)' values and no facilities;
  // it must not participate in the country join.
  const jIdx = indexBy(jurisdictions.filter((r) => !/\(bloc\)/i.test(s(r[J.country]))), J.country);

  const joinWarnings = [];
  const records = [];

  for (const f of facilities) {
    const id = s(f[F.id]);
    if (!id) continue;

    const c = cIdx.get(id) || {};
    if (!cIdx.has(id)) joinWarnings.push(`${id}: no row on Consolidated`);
    const opName = s(f[F.operator]);
    const o = oIdx.get(opName) || {};
    if (opName && !oIdx.has(opName)) joinWarnings.push(`${id}: operator "${opName}" absent from Operators`);
    const country = s(f[F.country]);
    const j = jIdx.get(country) || {};
    if (country && !jIdx.has(country)) joinWarnings.push(`${id}: country "${country}" absent from Jurisdictions`);

    const cap = parseCapacity(f[F.capacity]);
    const opOrigin = splitOrigin(c[C.operatorCountry]);
    const ownOrigin = splitOrigin(c[C.ownerCountry]);
    const xc = splitExportControl(c[C.exportControl]);
    const lat = Number(f[F.lat]); const lon = Number(f[F.lon]);
    const ifScore = parseScore(c[C.internetFreedom]);

    // Restricted-party status: prefer the operator-level source of truth, fall
    // back to the facility row's parsed flags.
    const bis = yesNo(o[O.bis]); const ofac = yesNo(o[O.ofac]);

    records.push({
      id,
      name: s(f[F.name]) || id,
      isPlaceholder: PLACEHOLDER_IDS.includes(id),

      // Layer 0 — identification
      operator: opName,
      ownerParent: s(f[F.ownerParent]),
      country,
      region: s(f[F.region]),
      city: s(f[F.city]),
      address: s(c[C.address]),
      lat: isFinite(lat) ? lat : null,
      lon: isFinite(lon) ? lon : null,
      hasCoords: isFinite(lat) && isFinite(lon),
      yearRfs: parseYear(f[F.yearRfs]),
      yearRfsRaw: s(f[F.yearRfs]),
      status: groupStatus(f[F.status]),
      statusRaw: s(f[F.status]),

      // Layer 1 — physical
      mw: cap.mw,
      mwCoded: cap.coded,
      mwBasis: cap.basis,
      mwReason: cap.reason,
      capacityRaw: cap.raw,
      mwEstimated: null,   // filled by applyImputation()
      mwSource: cap.coded ? 'coded' : null,
      energySource: s(f[F.energy]),
      gridCarbon: parseScore(f[F.gridCarbon]),
      waterStress: groupWater(f[F.water]),
      waterStressRaw: s(f[F.water]),
      envRisk: groupEnvRisk(c[C.envRisk]),
      envRiskRaw: s(c[C.envRisk]),
      siting: s(c[C.siting]),

      // Layer 2 — network
      network: s(c[C.network]),
      ixps: s(f[F.ixps]),
      interconnectDensity: s(c[C.interconnect]),
      cableProximity: s(c[C.cable]),

      // Layer 3 — ownership / control
      operatorType: groupOperatorType(c[C.operatorType] || o[O.type]),
      operatorTypeRaw: s(c[C.operatorType] || o[O.type]),
      operatorCountry: opOrigin.country,
      operatorCountries: opOrigin.countries,
      nChineseOperators: opOrigin.nChinese,
      owners: s(c[C.owners]),
      ownership: groupOwnership(c[C.ownership] || o[O.ownership]),
      ownershipRaw: s(c[C.ownership] || o[O.ownership]),
      ownerCountry: ownOrigin.country,
      nChineseOwners: ownOrigin.nChinese,
      domicile: ownOrigin.domicile || s(o[O.domicile]) || null,
      offshoreDomicile: offshoreDomicile(ownOrigin.domicile || o[O.domicile]),
      stateShare: s(c[C.stateShare]),
      sitingLogic: s(c[C.sitingLogic]),
      ultimateParent: s(o[O.parent]),
      parentHq: s(o[O.parentHq]),
      lei: s(o[O.lei]),

      // Layer 4 — supply chain
      constructionFirms: s(c[C.construction]),
      energySuppliers: s(c[C.energySuppliers]),
      chipSuppliers: s(c[C.chips]),
      hardwareSuppliers: s(c[C.hardware]),
      bisListed: bis === null ? xc.bis : bis,
      ofacListed: ofac === null ? xc.ofac : ofac,
      bisDetail: xc.bisDetail || (bis ? s(o[O.bis]) : null),
      ofacDetail: xc.ofacDetail || (ofac ? s(o[O.ofac]) : null),
      exportControlRaw: xc.raw,
      restrictedParty: Boolean((bis === null ? xc.bis : bis) || (ofac === null ? xc.ofac : ofac)),

      // Layer 5 — regulatory / sovereignty
      jurisdiction: country,
      dataLaw: s(c[C.dataLaw]),
      dataLocalization: groupLocalization(c[C.dataLocalization]),
      dataLocalizationRaw: s(c[C.dataLocalization]),
      fdiScreening: groupFdi(c[C.fdi]),
      fdiScreeningRaw: s(c[C.fdi]),
      financing: s(c[C.financing]),
      govUsers: s(c[C.govUsers]),
      incentive: s(c[C.incentive]),
      zoning: s(c[C.zoning]),
      regQuality: s(c[C.regQuality]),
      polStability: s(c[C.polStability]),
      internetFreedom: ifScore,
      fotnBand: fotnBand(ifScore),
      ruleOfLaw: parseScore(j[J.ruleOfLaw]),

      // Analysis flags
      serviceModel: groupServiceModel(f[F.serviceModel]),
      serviceModelRaw: s(f[F.serviceModel]),
      include: /^include/i.test(s(f[F.include])) ? 'Include' : 'Exclude',
      includeRaw: s(f[F.include]),
      verification: s(f[F.verification]),
      notes: s(f[F.notes]),
    });
  }

  return { records, meta: buildMeta(records, joinWarnings) };
}

/**
 * Fills `mw` for uncoded rows from the median of coded facilities sharing the
 * same operator, falling back to operator class then to the global median.
 *
 * This generates numbers that are NOT in the source workbook, whose README
 * states the gaps were left blank deliberately because hyperscaler IT load is
 * undisclosed. Every imputed row is marked `mwEstimated: true` and
 * `mwSource: 'imputed-*'` so views can label them and exports can drop them.
 */
export function applyImputation(records) {
  const median = (xs) => {
    if (!xs.length) return null;
    const a = [...xs].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  };

  const coded = records.filter((r) => r.mwCoded && r.mw !== null);
  const byOperator = new Map();
  const byType = new Map();
  for (const r of coded) {
    if (!byOperator.has(r.operator)) byOperator.set(r.operator, []);
    byOperator.get(r.operator).push(r.mw);
    if (!byType.has(r.operatorType)) byType.set(r.operatorType, []);
    byType.get(r.operatorType).push(r.mw);
  }
  const globalMed = median(coded.map((r) => r.mw));

  for (const r of records) {
    if (r.mwCoded) { r.mwEstimated = false; r.mwSource = 'coded'; continue; }
    // An area-only value ('~6,500 sqm') tells us nothing about power, so it is
    // imputed like any other gap rather than converted.
    const opMed = median(byOperator.get(r.operator) || []);
    const tyMed = median(byType.get(r.operatorType) || []);
    const val = opMed ?? tyMed ?? globalMed;
    r.mw = val;
    r.mwEstimated = true;
    r.mwSource = opMed != null ? 'imputed-operator' : tyMed != null ? 'imputed-type' : 'imputed-global';
  }
  return records;
}

/** Coverage + data-quality summary surfaced in the UI so caveats stay visible. */
function buildMeta(records, joinWarnings) {
  const coded = records.filter((r) => r.mwCoded);
  const byCountry = new Map();
  for (const r of records) {
    if (!byCountry.has(r.country)) byCountry.set(r.country, { country: r.country, n: 0, coded: 0, mw: 0 });
    const b = byCountry.get(r.country);
    b.n++;
    if (r.mwCoded) { b.coded++; b.mw += r.mw; }
  }
  const reasons = {};
  for (const r of records) if (!r.mwCoded) reasons[r.mwReason] = (reasons[r.mwReason] || 0) + 1;

  return {
    generatedAt: new Date().toISOString(),
    nFacilities: records.length,
    nCountries: new Set(records.map((r) => r.country)).size,
    nOperators: new Set(records.map((r) => r.operator)).size,
    capacity: {
      nCoded: coded.length,
      pctCoded: records.length ? coded.length / records.length : 0,
      totalCodedMw: coded.reduce((a, r) => a + r.mw, 0),
      uncodedReasons: reasons,
    },
    coverageByCountry: [...byCountry.values()].sort((a, b) => b.n - a.n),
    joinWarnings,
    placeholders: records.filter((r) => r.isPlaceholder).map((r) => r.id),
  };
}

// ---------------------------------------------------------------------------
// Field catalogue — drives the colour-by / filter / axis pickers
// ---------------------------------------------------------------------------

/** Categorical dimensions offered for colouring, filtering and composition charts. */
export const DIMENSIONS = [
  { key: 'operatorCountry', label: 'Operator nationality', rawKey: null, layer: 3 },
  { key: 'ownerCountry', label: 'Parent / owner origin', rawKey: null, layer: 3 },
  { key: 'ownership', label: 'Ownership structure', rawKey: 'ownershipRaw', layer: 3 },
  { key: 'operatorType', label: 'Operator type', rawKey: 'operatorTypeRaw', layer: 3 },
  { key: 'country', label: 'Host country', rawKey: null, layer: 0 },
  { key: 'region', label: 'Region', rawKey: null, layer: 0 },
  { key: 'operator', label: 'Operator', rawKey: null, layer: 3 },
  { key: 'serviceModel', label: 'Service model', rawKey: 'serviceModelRaw', layer: 5 },
  { key: 'include', label: 'Include / exclude', rawKey: 'includeRaw', layer: 5 },
  { key: 'status', label: 'Facility status', rawKey: 'statusRaw', layer: 0 },
  { key: 'waterStress', label: 'Water stress (WRI)', rawKey: 'waterStressRaw', layer: 1, order: WATER_ORDER },
  { key: 'envRisk', label: 'Environmental risk tier', rawKey: 'envRiskRaw', layer: 1, order: ENV_ORDER },
  { key: 'regQuality', label: 'WGI regulatory quality', rawKey: null, layer: 5, order: WGI_ORDER },
  { key: 'polStability', label: 'WGI political stability', rawKey: null, layer: 5, order: WGI_ORDER },
  { key: 'fotnBand', label: 'Freedom House band', rawKey: null, layer: 5, order: FOTN_ORDER },
  { key: 'dataLocalization', label: 'Data-localization regime', rawKey: 'dataLocalizationRaw', layer: 5 },
  { key: 'fdiScreening', label: 'FDI screening', rawKey: 'fdiScreeningRaw', layer: 5 },
];

/** Numeric measures offered for scatter axes. */
export const MEASURES = [
  { key: 'mw', label: 'IT capacity (MW)' },
  { key: 'internetFreedom', label: 'Internet freedom (FOTN /100)' },
  { key: 'ruleOfLaw', label: 'WGI rule of law (−2.5–2.5)' },
  { key: 'gridCarbon', label: 'Grid carbon (gCO₂/kWh)' },
  { key: 'yearRfs', label: 'Year RFS' },
];

/**
 * Reads a dimension off a record, honouring the raw <-> grouped toggle.
 * Dimensions with no raw counterpart ignore the toggle.
 */
export function dimValue(record, dimKey, useRaw) {
  const dim = DIMENSIONS.find((d) => d.key === dimKey);
  if (!dim) return record[dimKey] ?? null;
  if (useRaw && dim.rawKey) return record[dim.rawKey] || null;
  return record[dim.key] ?? null;
}

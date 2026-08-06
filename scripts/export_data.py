#!/usr/bin/env python3
"""
Export the consolidated sheet to JSON + CSV.

The web app itself does NOT need this: it parses the .xlsx directly in the
browser so the live OneDrive workbook and the bundled copy share one code path.
This script exists for the other consumers of the data — R/Stata/pandas, a
co-author who wants a flat file, or a diff between workbook revisions.

Normalization here deliberately mirrors src/normalize.js. If you change a
parsing rule, change it in both. The `--check` mode compares the two by
reporting the same coverage figures the app displays, so drift is visible.

Usage:
    python3 scripts/export_data.py
    python3 scripts/export_data.py --xlsx ~/Downloads/master_dataset_1_values_3.xlsx
    python3 scripts/export_data.py --check
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is required:  python3 -m pip install openpyxl")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_XLSX = os.path.join(ROOT, "data", "master_dataset_1_values_3.xlsx")

SHEET_FACILITIES = "Facilities"
SHEET_CONSOLIDATED = "Consolidated (all layers)"
SHEET_OPERATORS = "Operators"
SHEET_JURISDICTIONS = "Jurisdictions"

# Consolidated carries merged layer-band labels on row 1; real headers are row 2.
HEADER_ROW = {
    SHEET_FACILITIES: 1,
    SHEET_CONSOLIDATED: 2,
    SHEET_OPERATORS: 1,
    SHEET_JURISDICTIONS: 1,
}

PLACEHOLDER_IDS = {"DC-0001"}  # README: worked example, "replace with Data Center Map"

NUM_RE = re.compile(r"(\d[\d,]*\.?\d*)")


def s(v) -> str:
    return "" if v is None else str(v).strip()


def is_unresolved(v: str) -> bool:
    return v == "" or "→" in v


def read_sheet(wb, name):
    """Rows as dicts keyed by the sheet's real header strings."""
    ws = wb[name]
    hr = HEADER_ROW[name]
    rows = list(ws.iter_rows(values_only=True))
    headers = [s(h) for h in rows[hr - 1]]
    out = []
    for row in rows[hr:]:
        if row is None or all(c is None or s(c) == "" for c in row):
            continue
        out.append({h: row[i] if i < len(row) else None
                    for i, h in enumerate(headers) if h})
    return out


# ---------------------------------------------------------------------------
# Parsers — keep in step with src/normalize.js
# ---------------------------------------------------------------------------

AREA_RE = re.compile(r"\b(sqm|sq\s?m|m2|m²|sq\s?ft|sqft|acre|hectare|ha)\b", re.I)
NOTPUB_RE = re.compile(r"\b(n/p|n/a|not published|undisclosed)\b", re.I)


def parse_capacity(raw):
    """-> (mw|None, basis|None, coded, reason|None). See normalize.js parseCapacity."""
    v = s(raw)
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw), "reported", True, None
    if is_unresolved(v):
        return None, None, False, "unresolved"
    if AREA_RE.search(v):
        return None, None, False, "area-not-power"   # '~6,500 sqm' is not power
    if NOTPUB_RE.search(v):
        return None, None, False, "not-published"
    m = NUM_RE.search(v)
    if not m:
        return None, None, False, "no-number"        # 'region'
    mw = float(m.group(1).replace(",", ""))
    if mw <= 0:
        return None, None, False, "no-number"
    basis = "reported"
    if re.search(r"campus", v, re.I):
        basis = "campus"
    if re.search(r"~|\best\b|approx", v, re.I):
        basis = "approx"
    if re.search(r"\+|scalable", v):
        basis = "floor"
    if re.search(r"planned|early phase|phase\s*\d|initial", v, re.I):
        basis = "planned"
    return mw, basis, True, None


def split_origin(raw):
    """'China (# Chinese owner: 1); domicile: Cayman Is. …' -> country / n / domicile."""
    v = s(raw)
    if is_unresolved(v):
        return None, None, None
    n = re.search(r"#\s*Chinese\s*(?:op|owner)s?\s*:\s*(\d+)", v, re.I)
    dom = re.search(r"domicile:\s*(.+)$", v, re.I)
    country = re.split(r"\(#", v)[0].strip().rstrip(";,") or None
    return country, (int(n.group(1)) if n else None), (dom.group(1).strip() if dom else None)


def split_export_control(raw):
    v = s(raw)

    def grab(label):
        m = re.search(label + r"\s*:\s*(Yes|No)", v, re.I)
        return None if not m else m.group(1).lower() == "yes"

    return grab("BIS"), grab("OFAC")


def yes_no(raw):
    v = s(raw)
    if re.match(r"^yes", v, re.I):
        return True
    if re.match(r"^no", v, re.I):
        return False
    return None


def parse_score(raw):
    v = s(raw)
    if not v or re.match(r"^n/a", v, re.I) or is_unresolved(v):
        return None
    m = re.search(r"-?\d+\.?\d*", v)
    return float(m.group(0)) if m else None


def parse_year(raw):
    v = s(raw)
    if is_unresolved(v):
        return None
    m = re.search(r"(?:19|20)\d{2}", v)
    return int(m.group(0)) if m else None


def group_water(raw):
    v = s(raw)
    for tier in ("Extremely High", "Medium–High", "Low–Medium", "High", "Medium", "Low"):
        if v.startswith(tier):
            return tier
    return v or None


def group_env(raw):
    v = s(raw)
    for tier in ("Low", "Moderate", "High"):
        if v.startswith(tier):
            return tier
    return v or None


def group_service_model(raw):
    v = s(raw)
    if re.match(r"^colocation", v, re.I):
        return "Colocation"
    if re.search(r"captive|self-build", v, re.I):
        return "Captive (self-build)"
    if re.search(r"cloud region", v, re.I):
        return "Commercial cloud region"
    if re.search(r"AI-HPC|neocloud", v, re.I):
        return "AI-HPC / neocloud"
    return v or None


def group_operator_type(raw):
    v = s(raw)
    if re.search(r"hyperscaler", v, re.I):
        return "Hyperscaler"
    if re.search(r"telco", v, re.I):
        return "Telco / DC"
    if re.search(r"AI-HPC|neocloud", v, re.I):
        return "AI-HPC / neocloud"
    if re.search(r"self-build", v, re.I):
        return "Self-build"
    if re.match(r"^colocation", v, re.I):
        return "Colocation"
    return v or None


def group_status(raw):
    v = s(raw)
    if re.match(r"^operational", v, re.I):
        return "Operational"
    if re.search(r"construction", v, re.I):
        return "Under construction"
    return v or None


def group_ownership(raw):
    v = s(raw)
    if re.search(r"state-owned", v, re.I):
        return "State-owned"
    if re.search(r"state-linked|state-backed|sovereign", v, re.I):
        return "State-linked"
    if re.search(r"\bJV\b|joint venture", v, re.I):
        return "Joint venture"
    if re.search(r"\bPE\b|private equity|DigitalBridge|EQT|Brookfield", v, re.I):
        return "PE-owned / PE-backed"
    if re.match(r"^public", v, re.I):
        return "Public"
    if re.match(r"^private", v, re.I):
        return "Private"
    return v or None


def group_yes_no_partial(raw):
    v = s(raw)
    for p in ("Yes", "Partial", "No"):
        if re.match("^" + p, v, re.I):
            return p
    return v or None


def group_fdi(raw):
    v = s(raw)
    if re.match(r"^yes", v, re.I):
        return "Yes"
    if re.match(r"^no", v, re.I):
        return "No"
    return v or None


def fotn_band(score):
    if score is None:
        return "Not rated (absent from FOTN)"
    if score >= 70:
        return "Free (70–100)"
    if score >= 40:
        return "Partly Free (40–69)"
    return "Not Free (0–39)"


def offshore(domicile):
    return bool(re.search(r"cayman|virgin islands|bermuda|VIE|jersey|luxembourg", s(domicile), re.I))


# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

def build(xlsx_path):
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    missing = [n for n in HEADER_ROW if n not in wb.sheetnames]
    if missing:
        sys.exit(f"workbook is missing sheet(s): {missing}\nfound: {wb.sheetnames}")

    # Required headers, checked explicitly: without them the join fails silently
    # and the script cheerfully reports "facilities 0" instead of an error. This
    # is not hypothetical — a stray keypress in Excel for the web cleared the
    # Facilities!A1 and Operators!A1 header cells and nothing complained.
    required = [
        (SHEET_FACILITIES, "Facility ID"),
        (SHEET_FACILITIES, "Country"),
        (SHEET_FACILITIES, "Operator"),
        (SHEET_CONSOLIDATED, "Facility ID"),
        (SHEET_OPERATORS, "Operator"),
        (SHEET_JURISDICTIONS, "Country"),
    ]
    problems = []
    for sheet_name, column in required:
        ws = wb[sheet_name]
        hr = HEADER_ROW[sheet_name]
        headers = [s(c) for c in next(ws.iter_rows(min_row=hr, max_row=hr, values_only=True))]
        if column not in headers:
            problems.append(f'"{sheet_name}" has no "{column}" column')
    if problems:
        sys.exit(
            "ERROR: the workbook is missing required header cells:\n  - "
            + "\n  - ".join(problems)
            + "\n\nA header cell was probably cleared or renamed in the source workbook."
            "\nRestore it (OneDrive → File → Version history), or update the column"
            "\nnames at the top of this script and in src/normalize.js if the rename"
            "\nwas deliberate."
        )

    facilities = read_sheet(wb, SHEET_FACILITIES)
    consolidated = {s(r.get("Facility ID")): r for r in read_sheet(wb, SHEET_CONSOLIDATED)
                    if s(r.get("Facility ID"))}
    operators = {s(r.get("Operator")): r for r in read_sheet(wb, SHEET_OPERATORS)
                 if s(r.get("Operator"))}
    # 'EU (bloc)' is a bloc row with 'n/a (bloc)' values and no facilities.
    jurisdictions = {s(r.get("Country")): r for r in read_sheet(wb, SHEET_JURISDICTIONS)
                     if s(r.get("Country")) and "(bloc)" not in s(r.get("Country"))}

    warnings = []
    records = []

    for f in facilities:
        fid = s(f.get("Facility ID"))
        if not fid:
            continue
        c = consolidated.get(fid)
        if c is None:
            warnings.append(f"{fid}: no row on {SHEET_CONSOLIDATED}")
            c = {}
        op_name = s(f.get("Operator"))
        o = operators.get(op_name)
        if op_name and o is None:
            warnings.append(f'{fid}: operator "{op_name}" absent from {SHEET_OPERATORS}')
            o = {}
        country = s(f.get("Country"))
        j = jurisdictions.get(country)
        if country and j is None:
            warnings.append(f'{fid}: country "{country}" absent from {SHEET_JURISDICTIONS}')
            j = {}

        mw, basis, coded, reason = parse_capacity(f.get("Capacity (MW)"))
        op_country, n_cn_op, _ = split_origin(c.get("Operator(s) country / # Chinese operators"))
        own_country, n_cn_own, domicile = split_origin(
            c.get("Parent-company origin / Owner(s) country / # Chinese owners"))
        bis_xc, ofac_xc = split_export_control(c.get("Export-control exposure"))
        bis = yes_no(o.get("On BIS Entity List?"))
        ofac = yes_no(o.get("On OFAC list (incl. NS-CMIC)?"))
        bis = bis_xc if bis is None else bis
        ofac = ofac_xc if ofac is None else ofac
        if_score = parse_score(c.get("Internet freedom (host country)"))

        lat = f.get("Lat")
        lon = f.get("Long")
        lat = float(lat) if isinstance(lat, (int, float)) else None
        lon = float(lon) if isinstance(lon, (int, float)) else None

        dom = domicile or s(o.get("Legal domicile / SEC filer (EDGAR)")) or None

        records.append({
            "id": fid,
            "name": s(f.get("Facility name")) or fid,
            "is_placeholder": fid in PLACEHOLDER_IDS,

            "operator": op_name,
            "owner_parent": s(f.get("Owner / parent")),
            "country": country,
            "region": s(f.get("Region")),
            "city": s(f.get("City")),
            "address": s(c.get("Facility address")),
            "lat": lat,
            "lon": lon,
            "year_rfs": parse_year(f.get("Year RFS")),
            "year_rfs_raw": s(f.get("Year RFS")),
            "status": group_status(f.get("Status")),
            "status_raw": s(f.get("Status")),

            "capacity_mw": mw,
            "capacity_coded": coded,
            "capacity_basis": basis,
            "capacity_uncoded_reason": reason,
            "capacity_raw": s(f.get("Capacity (MW)")),
            "energy_source": s(f.get("Energy source")),
            "grid_carbon_gco2_kwh": parse_score(f.get("Grid carbon (lookup)")),
            "water_stress": group_water(f.get("Water-stress (WRI)")),
            "water_stress_raw": s(f.get("Water-stress (WRI)")),
            "env_risk_tier": group_env(c.get("Environmental risk tier")),
            "env_risk_tier_raw": s(c.get("Environmental risk tier")),
            "siting_determinants": s(c.get("Siting determinants")),

            "network_connectivity": s(c.get("Network connectivity")),
            "ixps_cables": s(f.get("On-net IXPs / cables")),
            "interconnection_density": s(c.get("Interconnection density")),
            "cable_landing_proximity": s(c.get("Cable-landing proximity")),

            "operator_type": group_operator_type(c.get("Operator type") or o.get("Type")),
            "operator_type_raw": s(c.get("Operator type") or o.get("Type")),
            "operator_nationality": op_country,
            "n_chinese_operators": n_cn_op,
            "owners": s(c.get("Owner(s)")),
            "ownership_structure": group_ownership(
                c.get("Ownership structure / state backing / share") or o.get("Ownership / state-backing")),
            "ownership_structure_raw": s(
                c.get("Ownership structure / state backing / share") or o.get("Ownership / state-backing")),
            "owner_origin": own_country,
            "n_chinese_owners": n_cn_own,
            "legal_domicile": dom,
            "offshore_domicile": offshore(dom),
            "state_operating_share": s(c.get("State operating share")),
            "operator_siting_logic": s(c.get("Operator siting logic")),
            "ultimate_parent": s(o.get("Ultimate parent")),
            "parent_hq_country": s(o.get("Parent HQ country")),
            "lei": s(o.get("LEI")),

            "construction_firms": s(c.get("Construction firm(s) (+country,#CN,state)")),
            "energy_suppliers": s(c.get("Energy supplier(s) (+country,#CN,state)")),
            "chip_suppliers": s(c.get("Chip supplier(s) (+country,#CN)")),
            "hardware_suppliers": s(c.get("Hardware supplier(s) (+country,#CN)")),
            "bis_listed": bis,
            "ofac_listed": ofac,
            "restricted_party": bool(bis or ofac),
            "export_control_raw": s(c.get("Export-control exposure")),

            "jurisdiction": country,
            "data_law": s(c.get("Data law (host country)")),
            "data_localization": group_yes_no_partial(c.get("Data-localization regime")),
            "data_localization_raw": s(c.get("Data-localization regime")),
            "fdi_screening": group_fdi(c.get("FDI screening status")),
            "fdi_screening_raw": s(c.get("FDI screening status")),
            "financing_model": s(c.get("Financing model")),
            "government_users": s(c.get("Government user(s)")),
            "development_incentive": s(c.get("Development incentive (host country)")),
            "zoning_controversy": s(c.get("Zoning / planning controversy")),
            "reg_quality": s(c.get("Regulatory quality (host country)")),
            "political_stability": s(c.get("Political stability (host country)")),
            "internet_freedom_fotn": if_score,
            "fotn_band": fotn_band(if_score),
            "wgi_rule_of_law": parse_score(j.get("WGI Rule of Law (2024, −2.5 to 2.5)")),

            "service_model": group_service_model(f.get("Service model")),
            "service_model_raw": s(f.get("Service model")),
            "include_flag": "Include" if re.match(
                r"^include", s(f.get("Include? (svc-model rule)")), re.I) else "Exclude",
            "include_flag_raw": s(f.get("Include? (svc-model rule)")),
            "verification": s(f.get("Verification (this audit)")),
            "notes": s(f.get("Notes")),
        })

    coded = [r for r in records if r["capacity_coded"]]
    by_country = defaultdict(lambda: {"n": 0, "coded": 0, "mw": 0.0})
    for r in records:
        b = by_country[r["country"]]
        b["n"] += 1
        if r["capacity_coded"]:
            b["coded"] += 1
            b["mw"] += r["capacity_mw"]

    meta = {
        "source_file": os.path.basename(xlsx_path),
        "n_facilities": len(records),
        "n_countries": len({r["country"] for r in records}),
        "n_operators": len({r["operator"] for r in records}),
        "capacity": {
            "n_coded": len(coded),
            "pct_coded": round(len(coded) / len(records), 4) if records else 0,
            "total_coded_mw": round(sum(r["capacity_mw"] for r in coded), 2),
            "uncoded_reasons": dict(Counter(
                r["capacity_uncoded_reason"] for r in records if not r["capacity_coded"])),
            "bases": dict(Counter(r["capacity_basis"] for r in coded)),
        },
        "coverage_by_country": [
            {"country": k, **{kk: (round(vv, 2) if isinstance(vv, float) else vv)
                              for kk, vv in v.items()}}
            for k, v in sorted(by_country.items(), key=lambda x: -x[1]["n"])
        ],
        "join_warnings": warnings,
        "placeholders": sorted(r["id"] for r in records if r["is_placeholder"]),
    }
    return records, meta


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xlsx", default=DEFAULT_XLSX, help="source workbook")
    ap.add_argument("--outdir", default=os.path.join(ROOT, "data"))
    ap.add_argument("--check", action="store_true",
                    help="print the schema + data-quality report, write nothing")
    args = ap.parse_args()

    if not os.path.exists(args.xlsx):
        sys.exit(f"workbook not found: {args.xlsx}")

    records, meta = build(args.xlsx)

    if args.check:
        print(f"source        {meta['source_file']}")
        print(f"facilities    {meta['n_facilities']}")
        print(f"countries     {meta['n_countries']}")
        print(f"operators     {meta['n_operators']}")
        cap = meta["capacity"]
        print(f"\ncapacity coded {cap['n_coded']}/{meta['n_facilities']} "
              f"({cap['pct_coded'] * 100:.1f}%)  total {cap['total_coded_mw']:,.0f} MW")
        print(f"  bases         {cap['bases']}")
        print(f"  uncoded       {cap['uncoded_reasons']}")
        print("\ncoverage by country (facilities / coded / MW):")
        for c in meta["coverage_by_country"]:
            print(f"  {c['country']:22} {c['n']:4} {c['coded']:4} {c['mw']:10,.0f}")
        print(f"\njoin warnings  {len(meta['join_warnings'])}")
        for w in meta["join_warnings"][:20]:
            print("  -", w)
        print(f"placeholders   {meta['placeholders']}")
        return

    os.makedirs(args.outdir, exist_ok=True)

    json_path = os.path.join(args.outdir, "consolidated.json")
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump({"meta": meta, "facilities": records}, fh, ensure_ascii=False, indent=1)

    csv_path = os.path.join(args.outdir, "consolidated.csv")
    # Imputed capacity is never written here — this file carries only what the
    # workbook actually contains.
    fields = list(records[0].keys()) if records else []
    with open(csv_path, "w", encoding="utf-8", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(records)

    print(f"wrote {json_path}  ({os.path.getsize(json_path):,} bytes)")
    print(f"wrote {csv_path}  ({os.path.getsize(csv_path):,} bytes)")
    print(f"{meta['n_facilities']} facilities · capacity coded for {meta['capacity']['n_coded']}"
          f" ({meta['capacity']['pct_coded'] * 100:.1f}%)")
    if meta["join_warnings"]:
        print(f"WARNING: {len(meta['join_warnings'])} join warnings — run with --check to list them")


if __name__ == "__main__":
    main()

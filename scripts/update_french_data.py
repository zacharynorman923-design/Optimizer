#!/usr/bin/env python3
"""Download Ken French Data Library files and rebuild every derived output.

    python scripts/update_french_data.py                  # download + rebuild
    python scripts/update_french_data.py --skip-download  # rebuild from data/raw/french/
    python scripts/update_french_data.py --from-dir DIR   # use zips you downloaded by hand

Outputs (see data/README.md for construction notes and caveats):
    data/raw/french/*.zip, data/raw/french/csv/*.csv, data/raw/french/download_log.csv
    data/processed/sleeves_monthly.csv          monthly total returns, decimals
    data/processed/sleeves_annual.csv           calendar-year returns, decimals
    data/processed/sleeve_metadata.csv          sleeve -> source, Morningstar category, dates
    data/processed/optimizer_returns.json       the same data bundled for the React app
    data/processed/stats.xlsx                   stats, correlations, calendar years, rolling 10y
    data/processed/dfat_*                       only when data/raw/dfat_monthly.csv is filled in
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import shutil
import sys
import time
import zipfile
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW_DIR = ROOT / "data" / "raw" / "french"
CSV_DIR = RAW_DIR / "csv"
OUT_DIR = ROOT / "data" / "processed"
DFAT_INPUT = ROOT / "data" / "raw" / "dfat_monthly.csv"

LIBRARY_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/Ken.French/data_library.html"
FTP_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/Ken.French/ftp/"
USER_AGENT = "Mozilla/5.0 (portfolio-optimizer data pipeline)"

FILES = {
    "ff3": "F-F_Research_Data_Factors_CSV.zip",
    "ff5": "F-F_Research_Data_5_Factors_2x3_CSV.zip",
    "us_me_bm": "6_Portfolios_2x3_CSV.zip",
    "us_me_op": "6_Portfolios_ME_OP_2x3_CSV.zip",
    "dev_me_bm": "Developed_ex_US_6_Portfolios_ME_BE-ME_CSV.zip",
    "em_me_bm": None,  # found on the library page; see find_em_zip()
}
EM_ZIP_PATTERN = re.compile(r"emerging.*6_portfolios.*be-?me.*_csv\.zip$", re.I)

# French's missing-value markers.
MISSING = (-99.99, -999.0)

# (id, display name, region, Morningstar category, source file, source column)
SLEEVES = [
    ("US_LargeCap", "US Large Cap (total market)", "US", "Large Blend", "ff3", "Mkt-RF + RF"),
    ("US_SmallValue", "US Small Value", "US", "Small Value", "us_me_bm", "SMALL HiBM"),
    ("US_SmallGrowth", "US Small Growth", "US", "Small Growth", "us_me_bm", "SMALL LoBM"),
    ("US_LargeValue", "US Large Value", "US", "Large Value", "us_me_bm", "BIG HiBM"),
    ("US_LargeGrowth", "US Large Growth", "US", "Large Growth", "us_me_bm", "BIG LoBM"),
    ("US_SmallRobust", "US Small Robust Profitability", "US", "Small Blend", "us_me_op", "SMALL HiOP"),
    ("US_SmallWeak", "US Small Weak Profitability", "US", "Small Blend", "us_me_op", "SMALL LoOP"),
    ("DevExUS_SmallValue", "Developed ex-US Small Value", "Developed ex-US", "Foreign Small/Mid Value", "dev_me_bm", "SMALL HiBM"),
    ("DevExUS_LargeValue", "Developed ex-US Large Value", "Developed ex-US", "Foreign Large Value", "dev_me_bm", "BIG HiBM"),
    ("DevExUS_Market", "Developed ex-US Market", "Developed ex-US", "Foreign Large Blend", "dev_me_bm", "cap-weighted six portfolios"),
    ("EM_SmallValue", "Emerging Markets Small Value", "Emerging", "Diversified Emerging Mkts", "em_me_bm", "SMALL HiBM"),
    ("EM_LargeValue", "Emerging Markets Large Value", "Emerging", "Diversified Emerging Mkts", "em_me_bm", "BIG HiBM"),
    ("EM_Market", "Emerging Markets Market", "Emerging", "Diversified Emerging Mkts", "em_me_bm", "cap-weighted six portfolios"),
    ("Cash", "Cash (1-month T-bill)", "US", "Money Market-Taxable", "ff3", "RF"),
]

WINDOWS = [
    ("Full", None, None),
    ("1990-present", "1990-01", None),
    ("2000-present", "2000-01", None),
    ("2016-2025", "2016-01", "2025-12"),
]


def log(msg: str) -> None:
    print(msg, flush=True)


# --------------------------------------------------------------------------- download


def http_get(session, url: str, attempts: int = 4):
    for i in range(attempts):
        try:
            resp = session.get(url, timeout=120)
            resp.raise_for_status()
            return resp
        except Exception as exc:  # network errors and 5xx: retry with backoff
            if i == attempts - 1:
                raise RuntimeError(f"download failed: {url}: {exc}") from exc
            wait = 2 ** (i + 1)
            log(f"  retry in {wait}s ({exc})")
            time.sleep(wait)


def find_em_zip(session) -> tuple[str, str]:
    """Scrape the data library page for the EM 6 portfolios (size x B/M) monthly CSV zip."""
    html = http_get(session, LIBRARY_URL).text
    hrefs = re.findall(r'href\s*=\s*"([^"]+?\.zip)"', html, flags=re.I)
    hits = [h for h in hrefs if EM_ZIP_PATTERN.search(h) and "daily" not in h.lower()]
    if not hits:
        raise RuntimeError(
            "Could not find the Emerging Markets 6 portfolios (ME x BE/ME) CSV link on "
            f"{LIBRARY_URL}. Pass it explicitly with --em-url."
        )
    url = urljoin(LIBRARY_URL, hits[0])
    return url.rsplit("/", 1)[-1], url


def obtain_zips(args) -> dict[str, Path]:
    """Return {file key: local zip path}, downloading or copying as requested."""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    names = dict(FILES)

    if args.skip_download or args.from_dir:
        src = Path(args.from_dir).expanduser() if args.from_dir else RAW_DIR
        em = sorted(p for p in src.glob("*.zip") if EM_ZIP_PATTERN.search(p.name)
                    and "daily" not in p.name.lower())
        if not em:
            raise FileNotFoundError(f"No Emerging Markets 6 portfolios zip in {src}")
        names["em_me_bm"] = em[0].name
        paths = {}
        for key, name in names.items():
            p = src / name
            if not p.exists():
                raise FileNotFoundError(f"Missing {p}")
            if src != RAW_DIR:
                shutil.copy2(p, RAW_DIR / name)
            paths[key] = RAW_DIR / name
        return paths

    import requests

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    session.verify = args.ca_bundle or True
    if args.em_url:
        names["em_me_bm"] = args.em_url.rsplit("/", 1)[-1]
        em_url = args.em_url
    else:
        names["em_me_bm"], em_url = find_em_zip(session)
        log(f"Emerging markets file found on library page: {names['em_me_bm']}")

    paths = {}
    for key, name in names.items():
        url = em_url if key == "em_me_bm" else FTP_URL + name
        log(f"Downloading {url}")
        data = http_get(session, url).content
        if not data.startswith(b"PK"):
            raise RuntimeError(f"{url} did not return a zip file")
        (RAW_DIR / name).write_bytes(data)
        paths[key] = RAW_DIR / name
    return paths


def extract(zips: dict[str, Path]) -> dict[str, Path]:
    """Unzip each archive into data/raw/french/csv/ and return {key: csv path}."""
    CSV_DIR.mkdir(parents=True, exist_ok=True)
    out = {}
    for key, zpath in zips.items():
        with zipfile.ZipFile(zpath) as zf:
            members = [m for m in zf.namelist() if m.lower().endswith(".csv") and not m.endswith("/")]
            if len(members) != 1:
                raise RuntimeError(f"{zpath.name}: expected one CSV, found {members}")
            target = CSV_DIR / Path(members[0]).name  # basename only: no path traversal
            target.write_bytes(zf.read(members[0]))
        out[key] = target
    return out


def log_data_cuts(csvs: dict[str, Path], zips: dict[str, Path]) -> pd.DataFrame:
    rows = []
    for key, path in csvs.items():
        first = path.read_text(encoding="latin-1").splitlines()[0].strip()
        cut = re.search(r"\b(\d{6})\b", first)
        rows.append({
            "file": zips[key].name,
            "csv": path.name,
            "first_line": first,
            "data_cut": cut.group(1) if cut else "",
            "processed_at": dt.datetime.now().isoformat(timespec="seconds"),
        })
        log(f"  {zips[key].name}: {first}")
    df = pd.DataFrame(rows)
    df.to_csv(RAW_DIR / "download_log.csv", index=False)
    return df


# --------------------------------------------------------------------------- parse


@dataclass
class Block:
    title: str
    columns: list[str]
    dates: list[str]
    values: list[list[float]]

    @property
    def freq(self) -> str:
        return "M" if len(self.dates[0]) == 6 else "A"

    def raw(self) -> pd.DataFrame:
        """Numbers as printed, missing markers -> NaN, indexed by month-end date or year."""
        df = pd.DataFrame(self.values, columns=self.columns, dtype=float)
        df = df.mask(df.isin(MISSING) | (df <= -99.99))
        if self.freq == "M":
            idx = pd.to_datetime(pd.Series(self.dates), format="%Y%m") + pd.offsets.MonthEnd(0)
            df.index = pd.DatetimeIndex(idx, name="date")
        else:
            df.index = pd.Index([int(d) for d in self.dates], name="year")
        return df

    def returns(self) -> pd.DataFrame:
        return self.raw() / 100.0


DATE_CELL = re.compile(r"^\d{4}(\d{2})?$")


def split_blocks(path: Path) -> list[Block]:
    """Split a French CSV into its stacked blocks.

    A block is a header row (empty first cell, column names after it) followed by rows
    whose first cell is YYYYMM or YYYY. Any text lines in between form the block's title.
    """
    blocks, title, cur = [], [], None
    for line in path.read_text(encoding="latin-1").splitlines():
        cells = [c.strip() for c in line.split(",")]
        if cur is not None and DATE_CELL.match(cells[0]):
            vals = [float(c) if c else np.nan for c in cells[1:1 + len(cur.columns)]]
            vals += [np.nan] * (len(cur.columns) - len(vals))
            cur.dates.append(cells[0])
            cur.values.append(vals)
            continue
        if cur is not None:
            if cur.dates:
                blocks.append(cur)
            cur = None
        if len(cells) > 1 and cells[0] == "" and all(cells[1:]) and not DATE_CELL.match(cells[1]):
            cur = Block(" | ".join(title), cells[1:], [], [])
            title = []
        elif line.strip():
            title.append(line.strip())
    if cur is not None and cur.dates:
        blocks.append(cur)
    return blocks


def pick(blocks: list[Block], freq: str, *words: str, path: Path) -> Block:
    """First block of the given frequency whose title contains all `words` (any of `|`-alternatives)."""
    for b in blocks:
        t = b.title.lower()
        if b.freq == freq and all(any(w in t for w in word.split("|")) for word in words):
            return b
    raise ValueError(f"{path.name}: no {freq} block with title containing {words}. "
                     f"Titles: {[b.title[:60] for b in blocks]}")


def factor_blocks(path: Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    blocks = [b for b in split_blocks(path) if "Mkt-RF" in b.columns]
    monthly = next(b for b in blocks if b.freq == "M")
    annual = next((b for b in blocks if b.freq == "A"), None)
    return monthly.returns(), (annual.returns() if annual else None)


def six_portfolio_blocks(path: Path, kind: str) -> dict[str, pd.DataFrame]:
    """Value-weighted monthly/annual returns plus size and count blocks, columns in canonical order.

    Columns come back renamed to SMALL Lo, SMALL Mid, SMALL Hi, BIG Lo, BIG Mid, BIG Hi + kind
    (e.g. 'SMALL HiBM'), after checking French's names match that order.
    """
    blocks = split_blocks(path)
    out = {
        "vw_monthly": pick(blocks, "M", "value weight", path=path).returns(),
        "vw_annual": pick(blocks, "A", "value weight", path=path).returns(),
    }
    try:
        out["n_firms"] = pick(blocks, "M", "number of firms", path=path).raw()
        out["avg_size"] = pick(blocks, "M", "firm size|average size|market cap", path=path).raw()
    except ValueError as exc:
        log(f"  warning: {exc}")
    canonical = [f"SMALL Lo{kind}", f"ME1 {kind}2", f"SMALL Hi{kind}",
                 f"BIG Lo{kind}", f"ME2 {kind}2", f"BIG Hi{kind}"]
    for name, df in out.items():
        cols = [re.sub(r"\s+", "", c).upper() for c in df.columns]
        ok = len(cols) == 6 and all(
            re.search(size, cols[i]) and re.search(tilt, cols[i])
            for i, size, tilt in [(0, "SMALL|ME1", "LO"), (2, "SMALL|ME1", "HI"),
                                  (3, "BIG|ME2", "LO"), (5, "BIG|ME2", "HI")])
        if not ok:
            raise ValueError(f"{path.name} [{name}]: unexpected columns {list(df.columns)}")
        df.columns = canonical
    return out


def cap_weighted(p: dict[str, pd.DataFrame], lag: int) -> pd.Series:
    """Cap-weight the six portfolios; weight = avg firm size x number of firms, lagged `lag` months."""
    cap = (p["avg_size"] * p["n_firms"]).where(p["n_firms"] > 0).shift(lag)
    ret = p["vw_monthly"]
    w = cap.reindex(ret.index).where(ret.notna())
    total = w.sum(axis=1, min_count=6)  # all six weights required
    return (ret * w).sum(axis=1, min_count=6) / total


def choose_size_lag(us: dict[str, pd.DataFrame], market: pd.Series) -> tuple[int, pd.DataFrame]:
    """Check which weight lag reproduces the official US market best, and use it internationally."""
    rows = []
    for lag in (0, 1):
        diff = (cap_weighted(us, lag) - market).dropna()
        rows.append({"lag_months": lag, "months": len(diff),
                     "tracking_error_ann": diff.std() * np.sqrt(12),
                     "mean_diff_ann": diff.mean() * 12,
                     "correlation": cap_weighted(us, lag).corr(market)})
    df = pd.DataFrame(rows)
    best = int(df.loc[df["tracking_error_ann"].idxmin(), "lag_months"])
    return best, df


# --------------------------------------------------------------------------- sleeves


def build_sleeves(csvs: dict[str, Path]) -> tuple[pd.DataFrame, dict]:
    ff3_m, ff3_a = factor_blocks(csvs["ff3"])
    ff5_m, _ = factor_blocks(csvs["ff5"])
    us = six_portfolio_blocks(csvs["us_me_bm"], "BM")
    op = six_portfolio_blocks(csvs["us_me_op"], "OP")
    dev = six_portfolio_blocks(csvs["dev_me_bm"], "BM")
    em = six_portfolio_blocks(csvs["em_me_bm"], "BM")

    market = (ff3_m["Mkt-RF"] + ff3_m["RF"]).rename("US_LargeCap")
    lag, lag_check = choose_size_lag(us, market)
    log(f"Cap-weight check on US six portfolios: lag {lag} months tracks Mkt-RF+RF best "
        f"(TE {lag_check['tracking_error_ann'].min():.2%}/yr)")

    def market_of(p, label):
        if "avg_size" not in p:
            log(f"  warning: {label}: no size/firm-count blocks, market sleeve skipped")
            return pd.Series(dtype=float)
        return cap_weighted(p, lag)

    s = {
        "US_LargeCap": market,
        "US_SmallValue": us["vw_monthly"]["SMALL HiBM"],
        "US_SmallGrowth": us["vw_monthly"]["SMALL LoBM"],
        "US_LargeValue": us["vw_monthly"]["BIG HiBM"],
        "US_LargeGrowth": us["vw_monthly"]["BIG LoBM"],
        "US_SmallRobust": op["vw_monthly"]["SMALL HiOP"],
        "US_SmallWeak": op["vw_monthly"]["SMALL LoOP"],
        "DevExUS_SmallValue": dev["vw_monthly"]["SMALL HiBM"],
        "DevExUS_LargeValue": dev["vw_monthly"]["BIG HiBM"],
        "DevExUS_Market": market_of(dev, "Developed ex-US"),
        "EM_SmallValue": em["vw_monthly"]["SMALL HiBM"],
        "EM_LargeValue": em["vw_monthly"]["BIG HiBM"],
        "EM_Market": market_of(em, "Emerging"),
        "Cash": ff3_m["RF"],
    }
    # Outer join: every sleeve keeps its own start date. Trim each sleeve's leading NaNs only.
    sleeves = pd.concat({k: v for k, v in s.items()}, axis=1).sort_index()
    sleeves.index.name = "date"

    annual_french = {
        "US_SmallValue": us["vw_annual"]["SMALL HiBM"], "US_SmallGrowth": us["vw_annual"]["SMALL LoBM"],
        "US_LargeValue": us["vw_annual"]["BIG HiBM"], "US_LargeGrowth": us["vw_annual"]["BIG LoBM"],
        "US_SmallRobust": op["vw_annual"]["SMALL HiOP"], "US_SmallWeak": op["vw_annual"]["SMALL LoOP"],
        "DevExUS_SmallValue": dev["vw_annual"]["SMALL HiBM"], "DevExUS_LargeValue": dev["vw_annual"]["BIG HiBM"],
        "EM_SmallValue": em["vw_annual"]["SMALL HiBM"], "EM_LargeValue": em["vw_annual"]["BIG HiBM"],
    }
    extras = {"rf": ff3_m["RF"], "ff5": ff5_m, "annual_french": annual_french, "lag_check": lag_check,
              "lag": lag, "ff3_annual": ff3_a}
    return sleeves, extras


# --------------------------------------------------------------------------- stats


def perf(r: pd.Series, rf: pd.Series) -> dict:
    r = r.dropna()
    n = len(r)
    if n < 12:
        return {}
    ex = r - rf.reindex(r.index)
    wealth = (1 + r).cumprod()
    dd = wealth / wealth.cummax().clip(lower=1.0) - 1  # include the starting $1 as a peak
    ex_sd = ex.std()
    return {
        "start": r.index[0].strftime("%Y-%m"),
        "end": r.index[-1].strftime("%Y-%m"),
        "months": n,
        "CAGR": wealth.iloc[-1] ** (12 / n) - 1,
        "Volatility": r.std() * np.sqrt(12),
        "Sharpe": ex.mean() * 12 / (ex_sd * np.sqrt(12)) if ex_sd > 1e-12 else np.nan,
        "Max Drawdown": dd.min(),
        "Worst 12M": ((1 + r).rolling(12).apply(np.prod, raw=True) - 1).min(),
    }


def window_stats(sleeves: pd.DataFrame, rf: pd.Series, start, end) -> pd.DataFrame:
    rows = []
    for col in sleeves:
        s = sleeves[col]
        first, last = s.first_valid_index(), s.last_valid_index()
        lo = pd.Timestamp(start) + pd.offsets.MonthEnd(0) if start else first
        hi = pd.Timestamp(end) + pd.offsets.MonthEnd(0) if end else last
        note = ""
        if first is None:
            note = "no data"
        elif first > lo:
            note = f"history starts {first:%Y-%m}, after window start"
        elif last < hi:
            note = f"history ends {last:%Y-%m}, before window end"
        elif s.loc[lo:hi].isna().any():
            note = "missing months inside window"
        row = {"sleeve": col}
        if not note:
            row.update(perf(s.loc[lo:hi], rf))
        row["note"] = note
        rows.append(row)
    df = pd.DataFrame(rows).set_index("sleeve")
    df["months"] = df["months"].astype("Int64")
    return df


def calendar_years(sleeves: pd.DataFrame) -> pd.DataFrame:
    g = sleeves.groupby(sleeves.index.year)
    out = g.apply(lambda x: (1 + x).prod(min_count=1) - 1).where(g.count() == 12)
    out.index.name = "year"
    return out.dropna(how="all")


def rolling_excess(sleeves: pd.DataFrame, a="US_SmallValue", b="US_LargeCap", months=120) -> pd.DataFrame:
    pair = sleeves[[a, b]].dropna()
    ann = (1 + pair).rolling(months).apply(np.prod, raw=True) ** (12 / months) - 1
    ann.columns = [f"{a} 10y ann.", f"{b} 10y ann."]
    ann["Excess (SV - LC)"] = ann.iloc[:, 0] - ann.iloc[:, 1]
    return ann.dropna()


def common_window(sleeves: pd.DataFrame) -> pd.DataFrame:
    start = max(sleeves[c].first_valid_index() for c in sleeves)
    end = min(sleeves[c].last_valid_index() for c in sleeves)
    return sleeves.loc[start:end].dropna()


def annual_check(cal: pd.DataFrame, french: dict) -> pd.DataFrame:
    rows = []
    for k, a in french.items():
        both = pd.concat([cal[k], a], axis=1, keys=["mine", "french"]).dropna()
        d = (both["mine"] - both["french"]).abs()
        rows.append({"sleeve": k, "years_compared": len(both),
                     "max_abs_diff": d.max(), "mean_abs_diff": d.mean()})
    return pd.DataFrame(rows).set_index("sleeve")


# --------------------------------------------------------------------------- DFAT


def ols(y: np.ndarray, X: np.ndarray):
    X = np.column_stack([np.ones(len(X)), X])
    beta, *_ = np.linalg.lstsq(X, y, rcond=None)
    resid = y - X @ beta
    n, k = X.shape
    sigma2 = resid @ resid / (n - k)
    se = np.sqrt(np.diag(sigma2 * np.linalg.inv(X.T @ X)))
    r2 = 1 - (resid @ resid) / ((y - y.mean()) @ (y - y.mean()))
    return beta, se, r2, 1 - (1 - r2) * (n - 1) / (n - k), n


def load_dfat(path: Path) -> pd.Series | None:
    df = pd.read_csv(path, dtype=str).dropna(how="all")
    if df.empty:
        return None
    d = df["date"].str.strip().str.replace(r"[^0-9]", "", regex=True).str[:6]
    idx = pd.to_datetime(d, format="%Y%m") + pd.offsets.MonthEnd(0)
    r = pd.Series(pd.to_numeric(df["return"], errors="coerce").values, index=idx, name="DFAT").dropna()
    if r.abs().max() > 1.0:
        log("  DFAT returns look like percent (|r| > 1); dividing by 100")
        r = r / 100
    return r.sort_index()


def dfat(ff5: pd.DataFrame) -> dict | None:
    if not DFAT_INPUT.exists():
        DFAT_INPUT.parent.mkdir(parents=True, exist_ok=True)
        DFAT_INPUT.write_text("date,return\n")
        log(f"\nDFAT: created template {DFAT_INPUT.relative_to(ROOT)}. Fill in monthly total returns "
            "(date as YYYY-MM-DD or YYYY-MM, return as a decimal, e.g. 0.0123) and re-run.")
        return None
    r = load_dfat(DFAT_INPUT)
    if r is None:
        log(f"\nDFAT: {DFAT_INPUT.relative_to(ROOT)} has no rows yet; skipping regression.")
        return None

    factors = ["Mkt-RF", "SMB", "HML", "RMW", "CMA"]
    data = pd.concat([r, ff5], axis=1, join="inner").dropna()
    if len(data) < 24:
        log(f"\nDFAT: only {len(data)} months overlap the 5-factor data; need at least 24. Skipping.")
        return None
    y = (data["DFAT"] - data["RF"]).values
    beta, se, r2, adj, n = ols(y, data[factors].values)
    names = ["alpha"] + factors
    reg = pd.DataFrame({"coef": beta, "std_err": se, "t_stat": beta / se}, index=pd.Index(names, name="term"))
    summary = pd.DataFrame({"coef": pd.Series({
        "alpha (annualized)": beta[0] * 12, "R-squared": r2, "Adj. R-squared": adj, "Months": n,
        "Sample": f"{data.index[0]:%Y-%m} to {data.index[-1]:%Y-%m}"}, dtype=object)})
    reg = pd.concat([reg.astype(object), summary])
    reg.index.name = "term"

    synthetic = ff5["RF"] + ff5[factors] @ beta[1:]  # betas only, no alpha
    first_actual = r.index[0]
    extended = pd.concat([synthetic[synthetic.index < first_actual], r]).rename("return")
    out = pd.DataFrame({
        "return": extended,
        "source": np.where(extended.index < first_actual, "synthetic", "actual"),
        "synthetic_return": synthetic.reindex(extended.index),
        "actual_return": r.reindex(extended.index),
    })
    out.index.name = "date"
    out.to_csv(OUT_DIR / "dfat_extended.csv", date_format="%Y-%m-%d", float_format="%.6f")
    reg.to_csv(OUT_DIR / "dfat_regression.csv")

    overlap = pd.concat([synthetic, r], axis=1, keys=["synthetic", "actual"], join="inner").dropna()
    chart_dfat(overlap)
    te = (overlap["actual"] - overlap["synthetic"]).std() * np.sqrt(12)
    log(f"\nDFAT regression ({n} months, R² {r2:.3f}, annualized alpha {beta[0] * 12:+.2%}); "
        f"synthetic vs actual tracking error {te:.2%}/yr")
    log(reg.to_string(float_format="{:.4f}".format))
    return {"regression": reg, "overlap": overlap}


def chart_dfat(overlap: pd.DataFrame) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    surface, ink, ink2, grid = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"
    colors = {"actual": "#2a78d6", "synthetic": "#eb6834"}
    labels = {"actual": "DFAT actual", "synthetic": "Synthetic (5-factor betas, no alpha)"}
    growth = (1 + overlap).cumprod()
    start = growth.index[0] - pd.offsets.MonthEnd(1)
    growth = pd.concat([pd.DataFrame({c: [1.0] for c in growth}, index=[start]), growth])

    fig, ax = plt.subplots(figsize=(9, 5), dpi=150, facecolor=surface)
    ax.set_facecolor(surface)
    for c in ["actual", "synthetic"]:
        ax.plot(growth.index, growth[c], color=colors[c], lw=2, label=labels[c])
        ax.annotate(f"{growth[c].iloc[-1]:.2f}", (growth.index[-1], growth[c].iloc[-1]),
                    xytext=(6, 0), textcoords="offset points", va="center", color=ink2, fontsize=9)
    ax.set_title("DFAT: growth of $1, synthetic vs actual (overlap period)", color=ink, loc="left", fontsize=12)
    ax.set_ylabel("Growth of $1", color=ink2)
    ax.grid(axis="y", color=grid, lw=0.8)
    for side in ["top", "right", "left"]:
        ax.spines[side].set_visible(False)
    ax.spines["bottom"].set_color(grid)
    ax.tick_params(colors=ink2, length=0)
    ax.legend(frameon=False, labelcolor=ink2, loc="upper left")
    fig.tight_layout()
    fig.savefig(OUT_DIR / "dfat_synthetic_vs_actual.png", facecolor=surface)
    plt.close(fig)


# --------------------------------------------------------------------------- outputs


def write_excel(path: Path, sheets: dict[str, pd.DataFrame], pct_cols: set[str], num_cols: set[str],
                pct_sheets: set[str]) -> None:
    with pd.ExcelWriter(path, engine="xlsxwriter") as xw:
        pct = xw.book.add_format({"num_format": "0.00%"})
        num = xw.book.add_format({"num_format": "0.00"})
        for name, df in sheets.items():
            df.to_excel(xw, sheet_name=name)
            ws = xw.sheets[name]
            ws.set_column(0, 0, 22)
            for i, col in enumerate(df.columns, start=1):
                fmt = pct if (name in pct_sheets or col in pct_cols) else num if col in num_cols else None
                ws.set_column(i, i, max(12, min(40, len(str(col)) + 2)), fmt)
            ws.freeze_panes(1, 1)


def metadata(sleeves: pd.DataFrame, zips: dict[str, Path]) -> pd.DataFrame:
    rows = []
    for sid, name, region, cat, key, col in SLEEVES:
        s = sleeves[sid]
        rows.append({
            "sleeve": sid, "name": name, "region": region, "morningstar_category": cat,
            "source_file": zips[key].name, "source_column": col,
            "start_date": f"{s.first_valid_index():%Y-%m-%d}" if s.notna().any() else "",
            "end_date": f"{s.last_valid_index():%Y-%m-%d}" if s.notna().any() else "",
            "months": int(s.notna().sum()),
        })
    return pd.DataFrame(rows)


def to_json_list(s: pd.Series) -> list:
    return [None if pd.isna(v) else round(float(v), 8) for v in s]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--skip-download", action="store_true", help="reuse zips already in data/raw/french/")
    ap.add_argument("--from-dir", help="take the zips from this folder (e.g. downloaded in a browser)")
    ap.add_argument("--em-url", help="explicit URL of the emerging markets 6 portfolios CSV zip")
    ap.add_argument("--ca-bundle", help="CA bundle path for HTTPS (for proxies)")
    args = ap.parse_args()

    zips = obtain_zips(args)
    log("Data-cut dates (first line of each CSV):")
    csvs = extract(zips)
    cuts = log_data_cuts(csvs, zips)

    sleeves, x = build_sleeves(csvs)
    rf = x["rf"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    sleeves.to_csv(OUT_DIR / "sleeves_monthly.csv", date_format="%Y-%m-%d", float_format="%.6f")
    cal = calendar_years(sleeves)
    cal.to_csv(OUT_DIR / "sleeves_annual.csv", float_format="%.6f")
    meta = metadata(sleeves, zips)
    meta.to_csv(OUT_DIR / "sleeve_metadata.csv", index=False)

    bundle = {
        "generated_at": dt.datetime.now().isoformat(timespec="seconds"),
        "source": "Kenneth R. French Data Library",
        "data_cut": dict(zip(cuts["file"], cuts["data_cut"])),
        "units": "decimal total return (0.01 = 1%)",
        "sleeves": meta.to_dict(orient="records"),
        "monthly": {"dates": [f"{d:%Y-%m-%d}" for d in sleeves.index],
                    "returns": {c: to_json_list(sleeves[c]) for c in sleeves}},
        "annual": {"years": [int(y) for y in cal.index],
                   "returns": {c: to_json_list(cal[c]) for c in cal}},
    }
    (OUT_DIR / "optimizer_returns.json").write_text(json.dumps(bundle, separators=(",", ":")))

    corr_data = common_window(sleeves)
    corr = corr_data.corr()
    corr.index.name = f"{corr_data.index[0]:%Y-%m} to {corr_data.index[-1]:%Y-%m}"
    notes = pd.DataFrame({"note": [
        "Source: Kenneth R. French Data Library. Returns are decimals (0.01 = 1%), monthly, USD.",
        "Paper portfolios: no fees, trading costs or taxes. French rebuilds full history on every update.",
        "Sharpe = annualized mean excess return over RF / annualized std of excess return.",
        "Max drawdown on month-end wealth; Worst 12M = worst rolling 12-month compounded return.",
        "A window's stats are blank (see note) if the sleeve does not cover the whole window.",
        f"Correlation window: {corr.index.name} (all sleeves present).",
        f"DevExUS_Market/EM_Market: six portfolios weighted by avg firm size x number of firms, "
        f"lagged {x['lag']} month(s) (lag chosen by tracking the US market; see Size_Lag_Check).",
        "Calendar_Year compounds monthly returns; only complete years are shown.",
    ]}, index=pd.RangeIndex(1, 9, name="#"))

    stat_cols = {"CAGR", "Volatility", "Max Drawdown", "Worst 12M"}
    sheets = {"Notes": notes, "Data_Cut": cuts.set_index("file")}
    for label, start, end in WINDOWS:
        sheets[f"Stats_{label.replace('-', '_')}"] = window_stats(sleeves, rf, start, end)
    sheets["Correlation"] = corr
    sheets["Calendar_Year"] = cal
    sheets["Rolling10y_SV_vs_LC"] = rolling_excess(sleeves)
    sheets["Annual_Check"] = annual_check(cal, x["annual_french"])
    sheets["Size_Lag_Check"] = x["lag_check"].set_index("lag_months")

    d = dfat(x["ff5"])
    if d:
        sheets["DFAT_Regression"] = d["regression"]
    write_excel(OUT_DIR / "stats.xlsx", sheets,
                pct_cols=stat_cols | {"tracking_error_ann", "mean_diff_ann", "max_abs_diff", "mean_abs_diff"},
                num_cols={"Sharpe", "correlation"} | set(corr.columns),
                pct_sheets={"Calendar_Year", "Rolling10y_SV_vs_LC"})

    log("\nSleeve histories:")
    log(meta[["sleeve", "start_date", "end_date", "months"]].to_string(index=False))
    log(f"\nWrote outputs to {OUT_DIR.relative_to(ROOT)}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())

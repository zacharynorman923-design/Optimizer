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
    "mom": "F-F_Momentum_Factor_CSV.zip",
}
EM_ZIP_PATTERN = re.compile(r"emerging.*6_portfolios.*be-?me.*_csv\.zip$", re.I)

AQR_DIR = ROOT / "data" / "raw" / "aqr"
AQR_URL = ("https://www.aqr.com/-/media/AQR/Documents/Insights/Data-Sets/"
           "Commodities-for-the-Long-Run-Index-Level-Data-Monthly.xlsx")
AQR_COLUMN = "Excess return of equal-weight commodities portfolio"
# HGER (Harbor Commodity All-Weather Strategy ETF) carries the commodity sleeve forward
# after AQR's last month. Daily dividend-adjusted closes; the last close of each month is used.
# Yahoo downsamples range=max (and interval=1mo) to weekly bars that straddle month-ends,
# so ask for an explicit date range. period2 is filled in at download time.
TSMOM_URL = ("https://www.aqr.com/-/media/AQR/Documents/Insights/Data-Sets/"
             "Time-Series-Momentum-Factors-Monthly.xlsx")
# AQMIX (AQR Managed Futures Strategy Fund, Class I) carries Trend forward after AQR's last month.
AQMIX_URL = ("https://query1.finance.yahoo.com/v8/finance/chart/AQMIX"
             "?period1=1230768000&period2={now}&interval=1d&events=div%7CcapitalGain")
HGER_URL = ("https://query1.finance.yahoo.com/v8/finance/chart/HGER"
            "?period1=1640995200&period2={now}&interval=1d&events=div")

H15_DIR = ROOT / "data" / "raw" / "h15"
H15_PAGE = "https://www.federalreserve.gov/datadownload/Choose.aspx?rel=H15"

# (sleeve, H.15 series in the daily Treasury constant-maturity package, maturity in years)
BONDS = [
    ("UST_1Y", "RIFLGFCY01_N.B", 1),
    ("UST_5Y", "RIFLGFCY05_N.B", 5),
    ("UST_10Y", "RIFLGFCY10_N.B", 10),
]

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
    ("UST_1Y", "US Treasury 1-year", "US", "Short Government", "h15", "par bond from month-end 1-year CMT yield"),
    ("UST_5Y", "US Treasury 5-year", "US", "Intermediate Government", "h15", "par bond from month-end 5-year CMT yield"),
    ("UST_10Y", "US Treasury 10-year", "US", "Long Government", "h15", "par bond from month-end 10-year CMT yield"),
    ("Commodities", "Commodities (equal-weight futures)", "Global", "Commodities Broad Basket", "aqr",
     "AQR equal-weight excess return + RF; HGER total return after AQR's last month"),
    ("Trend", "Trend-following (AQR TSMOM)", "Global", "Systematic Trend", "tsmom",
     "AQR time-series momentum factor (all assets) excess return + RF; AQMIX total return after AQR's last month"),
    ("Equity_LS", "Equity long/short (value + momentum)", "US", "Equity Market Neutral", "mom",
     "50% HML + 50% Mom (French), rebalanced monthly, + RF"),
]

# Asset class for the app's class limits (Equity / Fixed income / Alts).
ALTS = {"Commodities", "Trend", "Equity_LS"}
FIXED_INCOME = {"UST_1Y", "UST_5Y", "UST_10Y", "Cash"}


def asset_class(sid: str) -> str:
    return "Alts" if sid in ALTS else "Fixed income" if sid in FIXED_INCOME else "Equity"


# Sleeves the app leaves unticked until you tick them (e.g. data that ends early, which would
# cut the shared window short). Empty for now; the mechanism stays for future sleeves.
DEFAULT_OFF: set[str] = set()

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
    def heading(self) -> str:
        """The text line directly above the column header, e.g. 'Average Firm Size'."""
        return self.title.rsplit(" | ", 1)[-1]

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
    """First block of the given frequency whose heading contains all `words` (any of `|`-alternatives).

    Matching only the heading line matters: the first block's title also carries the file
    description, which mentions 'market cap' and 'value-weighted' in passing.
    """
    for b in blocks:
        t = b.heading.lower()
        if b.freq == freq and all(any(w in t for w in word.split("|")) for word in words):
            return b
    raise ValueError(f"{path.name}: no {freq} block with title containing {words}. "
                     f"Headings: {[b.heading[:60] for b in blocks]}")


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
    region_caps = {k: (p["avg_size"] * p["n_firms"]).where(p["n_firms"] > 0).sum(axis=1, min_count=6).shift(lag)
                   for k, p in (("US_LargeCap", us), ("DevExUS_Market", dev), ("EM_Market", em)) if "avg_size" in p}
    extras = {"rf": ff3_m["RF"], "ff3_m": ff3_m, "region_caps": region_caps, "ff5": ff5_m, "annual_french": annual_french, "lag_check": lag_check,
              "lag": lag, "ff3_annual": ff3_a}
    return sleeves, extras


# --------------------------------------------------------------------------- Treasury bonds (H.15)


def fetch_h15(skip_download: bool) -> Path:
    """Download the Fed's H.15 daily Treasury constant-maturity package to data/raw/h15/.

    The package link is read from the H.15 download page each time (the full-history daily
    package is the one with no observation limit), so a changed link doesn't break the refresh.
    """
    H15_DIR.mkdir(parents=True, exist_ok=True)
    path = H15_DIR / "H15_treasury_constant_maturity_daily.csv"
    if skip_download:
        if not path.exists():
            raise FileNotFoundError(f"Missing {path}; run without --skip-download")
        return path
    import html as htmllib
    import requests

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    page = http_get(session, H15_PAGE).text
    opts = [htmllib.unescape(v) for v in re.findall(r'value="(rel=H15[^"]*type=package)"', page)]
    full = [o for o in opts if "lastobs=&" in o]
    if not full:
        raise RuntimeError(f"No full-history H.15 package link found on {H15_PAGE}")
    url = "https://www.federalreserve.gov/datadownload/Output.aspx?" + full[0]
    log(f"Downloading {url}")
    text = http_get(session, url).text
    if "RIFLGFCY10_N.B" not in text:
        raise RuntimeError(f"{url} is not the daily Treasury constant-maturity package")
    path.write_text(text)
    return path


def read_h15(path: Path) -> pd.DataFrame:
    """The H.15 package as floats in percent. Six label rows precede the data; 'ND' = no data."""
    df = pd.read_csv(path, skiprows=5, index_col=0)
    df.index = pd.to_datetime(df.index)
    return df.apply(pd.to_numeric, errors="coerce")


def month_end_yields(s: pd.Series) -> pd.Series:
    """The last daily close of each month, indexed at month-end."""
    s = s.dropna()
    s = s.groupby(s.index.to_period("M")).last()
    s.index = s.index.to_timestamp() + pd.offsets.MonthEnd(0)
    return s


def bond_returns(yields_pct: pd.Series, maturity: float) -> pd.Series:
    """Monthly total return of a constant-maturity par bond, rebuilt from yields.

    At the end of month t-1 buy a par bond (price 1) paying coupon c = y(t-1), semiannually,
    with `maturity` years left. One month later it has maturity - 1/12 years left and is
    repriced at the new yield y(t):
        P = c/2 * (1 - (1 + y/2)^-n) / (y/2) + (1 + y/2)^-n,   n = 2 * (maturity - 1/12)
    Return = P - 1 + c/12 (price change plus one month's accrued coupon). Rolling into a fresh
    par bond each month keeps the maturity constant. A missing month makes that month's and
    the next month's return missing.
    """
    y = yields_pct / 100.0
    y = y.asfreq("ME")  # expose gaps as NaN so they don't get bridged
    c = y.shift(1)
    n = 2 * (maturity - 1 / 12)
    half = y / 2
    disc = (1 + half) ** (-n)
    annuity = np.where(np.abs(half) > 1e-10, (1 - disc) / half.where(np.abs(half) > 1e-10, 1), n)
    price = c / 2 * annuity + disc
    return (price - 1 + c / 12).rename(None)


def build_bonds(path: Path) -> tuple[dict[str, pd.Series], list[dict]]:
    h15 = read_h15(path)
    this_month = pd.Timestamp.today().to_period("M").to_timestamp()
    out = {}
    for sleeve, sid, maturity in BONDS:
        r = bond_returns(month_end_yields(h15[sid]), maturity).dropna()
        out[sleeve] = r[r.index < this_month]  # complete months only
    last = h15[[sid for _, sid, _ in BONDS]].dropna().index[-1]
    log(f"  H.15 Treasury yields: {h15.index[0]:%Y-%m-%d} to {last:%Y-%m-%d}")
    cuts = [{"file": "Federal Reserve H.15 (daily Treasury CMT)", "csv": path.name,
             "first_line": f"{h15.index[0]:%Y-%m-%d} to {last:%Y-%m-%d}",
             "data_cut": f"{last:%Y%m%d}",
             "processed_at": dt.datetime.now().isoformat(timespec="seconds")}]
    return out, cuts


# --------------------------------------------------------------------------- commodities (AQR + HGER)

EXTERNAL_SOURCES = {
    "h15": "Federal Reserve H.15 (daily)",
    "aqr": "AQR Commodities for the Long Run (monthly) + HGER (Yahoo Finance)",
    "tsmom": "AQR Time Series Momentum: Factors, Monthly + AQMIX (Yahoo Finance)",
}


def _download(url: str, path: Path, skip: bool, check) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if skip:
        if not path.exists():
            raise FileNotFoundError(f"Missing {path}; run without --skip-download")
        return path
    import requests

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    log(f"Downloading {url}")
    data = http_get(session, url).content
    if not check(data):
        raise RuntimeError(f"{url} returned something unexpected")
    path.write_bytes(data)
    return path


def read_aqr(path: Path) -> pd.Series:
    """AQR's equal-weight commodity futures excess return (over T-bills), month-end indexed."""
    raw = pd.read_excel(path, header=None)
    hdr = next(i for i, row in raw.iterrows() if AQR_COLUMN in row.values)
    col = list(raw.iloc[hdr]).index(AQR_COLUMN)
    data = raw.iloc[hdr + 1:, [0, col]].dropna()
    dates = pd.to_datetime(data.iloc[:, 0].astype(str).str[:10]) + pd.offsets.MonthEnd(0)
    return pd.Series(data.iloc[:, 1].astype(float).values, index=pd.DatetimeIndex(dates)).sort_index()


def read_yahoo_monthly(path: Path) -> pd.Series:
    """Monthly total returns from Yahoo daily data: last dividend-adjusted close of each month
    (complete months only). Used for HGER and AQMIX."""
    res = json.loads(path.read_text())["chart"]["result"][0]
    gmt = res.get("meta", {}).get("gmtoffset", 0)  # exchange-local dates, not UTC
    ts = pd.to_datetime(np.asarray(res["timestamp"]) + gmt, unit="s")
    adj = pd.Series(res["indicators"]["adjclose"][0]["adjclose"], index=ts, dtype=float).dropna()
    if pd.Series(adj.index).diff().median() > pd.Timedelta(days=3):
        raise ValueError("Yahoo returned weekly or monthly bars, not daily closes")
    adj = adj.groupby(adj.index.to_period("M")).last()
    adj.index = adj.index.to_timestamp() + pd.offsets.MonthEnd(0)
    this_month = pd.Timestamp.today().to_period("M").to_timestamp()
    return adj.pct_change().dropna()[lambda r: r.index < this_month]


def build_commodities(rf: pd.Series, skip: bool) -> tuple[pd.Series, pd.DataFrame, list[dict]]:
    """AQR excess return + RF through AQR's last month, then HGER's total return.

    Returns the spliced sleeve, a side-by-side table (for checking the overlap), and data-cut rows.
    """
    aqr_path = _download(AQR_URL, AQR_DIR / "Commodities-for-the-Long-Run-Index-Level-Data-Monthly.xlsx",
                         skip, lambda b: b.startswith(b"PK"))
    aqr_total = (read_aqr(aqr_path) + rf).dropna()  # RF (French) starts 1926-07
    try:
        hger_path = _download(HGER_URL.format(now=int(time.time())), AQR_DIR / "HGER_yahoo_daily.json", skip,
                              lambda b: b'"adjclose"' in b)
        hger = read_yahoo_monthly(hger_path)
    except Exception as exc:  # keep the rest of the refresh going; the sleeve just ends with AQR
        log(f"  WARNING: HGER unavailable ({exc}); Commodities ends at AQR's last month")
        hger_path = AQR_DIR / "HGER_yahoo_daily.json"
        hger = pd.Series(dtype=float, index=pd.DatetimeIndex([]))
    last_aqr = aqr_total.index[-1]
    sleeve = pd.concat([aqr_total, hger[hger.index > last_aqr]])
    table = pd.DataFrame({"return": sleeve,
                          "source": np.where(sleeve.index <= last_aqr, "AQR + RF", "HGER"),
                          "aqr_total": aqr_total.reindex(sleeve.index),
                          "hger_total": hger.reindex(sleeve.index)})
    table.index.name = "date"
    hger_span = f"{hger.index[0]:%Y-%m} to {hger.index[-1]:%Y-%m}" if len(hger) else "not available"
    log(f"  Commodities: AQR + RF {aqr_total.index[0]:%Y-%m} to {last_aqr:%Y-%m}, HGER {hger_span}")
    now = dt.datetime.now().isoformat(timespec="seconds")
    cuts = [
        {"file": "AQR Commodities for the Long Run", "csv": aqr_path.name,
         "first_line": f"data through {last_aqr:%Y-%m}", "data_cut": f"{last_aqr:%Y%m}", "processed_at": now},
        {"file": "HGER (Yahoo Finance)", "csv": hger_path.name,
         "first_line": hger_span, "data_cut": f"{hger.index[-1]:%Y%m}" if len(hger) else "",
         "processed_at": now},
    ]
    return sleeve, table, cuts


def splice_check(table: pd.DataFrame, a: str = "aqr_total", b: str = "hger_total",
                 label: str = "AQR / HGER") -> pd.DataFrame:
    """How closely the follow-on fund tracked the index it continues, over the months both exist."""
    both = table[[a, b]].dropna()
    if len(both) < 12:
        return pd.DataFrame({"note": [f"only {len(both)} overlapping months"]})
    d = both[b] - both[a]
    yr = (1 + both).groupby(both.index.year).prod() - 1
    rows = [("overlap", f"{both.index[0]:%Y-%m} to {both.index[-1]:%Y-%m}"), ("months", len(both)),
            ("correlation", both.corr().iloc[0, 1]), ("tracking error (ann.)", d.std() * np.sqrt(12)),
            ("mean difference (ann.)", d.mean() * 12)]
    rows += [(f"{y} {label}", f"{x:.1%} / {z:.1%}") for y, (x, z) in yr.iterrows()]
    return pd.DataFrame(rows, columns=["item", "value"]).set_index("item")


# --------------------------------------------------------------------------- hedge-strategy proxies


def read_tsmom(path: Path) -> pd.DataFrame:
    """AQR's time-series momentum factors (excess returns): TSMOM and the CM/EQ/FI/FX legs."""
    raw = pd.read_excel(path, header=None)
    hdr = next(i for i, row in raw.iterrows() if "TSMOM^CM" in list(row.values))
    cols = [c for c in raw.iloc[hdr] if isinstance(c, str) and c.startswith("TSMOM")]
    data = raw.iloc[hdr + 1:, : 1 + len(cols)].dropna()
    data.columns = ["date"] + cols
    data["date"] = pd.to_datetime(data["date"].astype(str).str[:10]) + pd.offsets.MonthEnd(0)
    return data.set_index("date").astype(float)


def build_hedge_proxies(csvs: dict[str, Path], ff3_m: pd.DataFrame, skip: bool) -> tuple[dict, pd.DataFrame, list[dict]]:
    """Trend = AQR TSMOM + RF (1985+), then AQMIX. Equity_LS = 50% HML + 50% Mom + RF (1927+).

    Both are paper long/short portfolios: no fees, trading or shorting costs.
    """
    rf = ff3_m["RF"]
    tsmom_path = _download(TSMOM_URL, AQR_DIR / "Time-Series-Momentum-Factors-Monthly.xlsx", skip,
                           lambda b: b.startswith(b"PK"))
    tsmom = read_tsmom(tsmom_path)
    mom_block = next(b for b in split_blocks(csvs["mom"]) if b.freq == "M")
    mom = mom_block.returns().iloc[:, 0]
    factor = (tsmom["TSMOM"] + rf).dropna()
    last = factor.index[-1]
    try:
        aqmix_path = _download(AQMIX_URL.format(now=int(time.time())), AQR_DIR / "AQMIX_yahoo_daily.json", skip,
                               lambda b: b'"adjclose"' in b)
        aqmix = read_yahoo_monthly(aqmix_path)
    except Exception as exc:  # the sleeve just ends at AQR's last month
        log(f"  WARNING: AQMIX unavailable ({exc}); Trend ends at AQR's last month")
        aqmix = pd.Series(dtype=float, index=pd.DatetimeIndex([]))
    trend = pd.concat([factor, aqmix[aqmix.index > last]])
    table = pd.DataFrame({"return": trend, "source": np.where(trend.index <= last, "AQR TSMOM + RF", "AQMIX"),
                          "factor_total": factor.reindex(trend.index), "fund_total": aqmix.reindex(trend.index)})
    table.index.name = "date"
    out = {"Trend": trend, "Equity_LS": (0.5 * ff3_m["HML"] + 0.5 * mom + rf).dropna()}
    span = f"{aqmix.index[0]:%Y-%m} to {aqmix.index[-1]:%Y-%m}" if len(aqmix) else "not available"
    log(f"  Trend: AQR TSMOM + RF {factor.index[0]:%Y-%m} to {last:%Y-%m}, AQMIX {span}; "
        f"Equity_LS (HML + Mom): {out['Equity_LS'].index[0]:%Y-%m} to {out['Equity_LS'].index[-1]:%Y-%m}")
    now = dt.datetime.now().isoformat(timespec="seconds")
    cuts = [{"file": "AQR Time Series Momentum: Factors, Monthly", "csv": tsmom_path.name,
             "first_line": f"data through {last:%Y-%m}", "data_cut": f"{last:%Y%m}", "processed_at": now},
            {"file": "AQMIX (Yahoo Finance)", "csv": "AQMIX_yahoo_daily.json", "first_line": span,
             "data_cut": f"{aqmix.index[-1]:%Y%m}" if len(aqmix) else "", "processed_at": now}]
    return out, table, cuts


# --------------------------------------------------------------------------- benchmarks

# Blended benchmarks for comparison (not optimizer inputs). Blends rebalance monthly, like
# published blended indexes. Stocks = French US market (≈ S&P 500); bonds = 5-year Treasury.
BLENDS = [  # (id, name, stock weight)
    ("BM_FI100", "100% fixed income (5-yr Treasury)", 0.0),
    ("BM_20_80", "20/80 stocks/bonds", 0.2),
    ("BM_40_60", "40/60 stocks/bonds", 0.4),
    ("BM_60_40", "60/40 stocks/bonds", 0.6),
    ("BM_80_20", "80/20 stocks/bonds", 0.8),
    ("BM_EQ100", "100% US stocks (≈ S&P 500)", 1.0),
]
# Optional real-world checks from Yahoo (not used in the app).
FUND_CHECKS = {"BM_60_40": "VBINX", "BM_World": "VT"}
YAHOO_DAILY = "https://query1.finance.yahoo.com/v8/finance/chart/{t}?period1=0&period2={now}&interval=1d&events=div%7CcapitalGain"


def build_benchmarks(sleeves: pd.DataFrame, region_caps: dict) -> tuple[pd.DataFrame, list[dict]]:
    stocks, bonds = sleeves["US_LargeCap"], sleeves["UST_5Y"]
    out, meta = {}, []
    for bid, name, w in BLENDS:
        out[bid] = (w * stocks + (1 - w) * bonds) if 0 < w < 1 else (stocks if w == 1 else bonds)
        meta.append({"id": bid, "name": name,
                     "composition": f"{w:.0%} US market + {1 - w:.0%} UST_5Y, rebalanced monthly" if 0 < w < 1
                     else ("US_LargeCap (French US market)" if w == 1 else "UST_5Y")})
    # all-world equity: US / developed ex-US / EM weighted by each region's total market value
    caps = pd.DataFrame(region_caps)
    rets = sleeves[list(caps.columns)]
    w = caps.reindex(rets.index).where(rets.notna())
    out["BM_World"] = (rets * w).sum(axis=1, min_count=len(caps.columns)) / w.sum(axis=1, min_count=len(caps.columns))
    meta.append({"id": "BM_World", "name": "All-world equity (cap-weighted)",
                 "composition": "US market + DevExUS_Market + EM_Market, weighted by each region's total market value"})
    bm = pd.DataFrame(out)
    bm.index.name = "date"
    for m in meta:
        sr = bm[m["id"]].dropna()
        m.update(start_date=f"{sr.index[0]:%Y-%m-%d}", end_date=f"{sr.index[-1]:%Y-%m-%d}")
    share = caps.div(caps.sum(axis=1), axis=0).dropna()
    log(f"  Benchmarks: {', '.join(m['id'] for m in meta)}; world index US share "
        f"{share['US_LargeCap'].iloc[0]:.0%} ({share.index[0]:%Y-%m}) -> {share['US_LargeCap'].iloc[-1]:.0%} ({share.index[-1]:%Y-%m})")
    return bm, meta


def benchmark_checks(bm: pd.DataFrame, skip: bool) -> pd.DataFrame:
    """Built benchmarks vs real funds over the months both exist (VBINX for 60/40, VT for world)."""
    rows = []
    for bid, ticker in FUND_CHECKS.items():
        try:
            path = _download(YAHOO_DAILY.format(t=ticker, now=int(time.time())), AQR_DIR / f"{ticker}_yahoo_daily.json",
                             skip, lambda b: b'"adjclose"' in b)
            fund = read_yahoo_monthly(path)
        except Exception as exc:
            log(f"  WARNING: {ticker} check skipped ({exc})")
            continue
        both = pd.concat([bm[bid], fund], axis=1, keys=["built", "fund"]).dropna()
        n = len(both)
        cagr = lambda r: (1 + r).prod() ** (12 / n) - 1
        rows.append({"benchmark": bid, "fund": ticker, "months": n,
                     "from": f"{both.index[0]:%Y-%m}", "to": f"{both.index[-1]:%Y-%m}",
                     "correlation": both.corr().iloc[0, 1], "tracking_error_ann": (both.fund - both.built).std() * np.sqrt(12),
                     "CAGR_built": cagr(both.built), "CAGR_fund": cagr(both.fund),
                     "vol_built": both.built.std() * np.sqrt(12), "vol_fund": both.fund.std() * np.sqrt(12)})
    return pd.DataFrame(rows).set_index("benchmark") if rows else pd.DataFrame({"note": ["no fund data"]})


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
            "source_file": zips[key].name if key in zips else EXTERNAL_SOURCES[key], "source_column": col,
            "start_date": f"{s.first_valid_index():%Y-%m-%d}" if s.notna().any() else "",
            "end_date": f"{s.last_valid_index():%Y-%m-%d}" if s.notna().any() else "",
            "months": int(s.notna().sum()),
            "default_on": sid not in DEFAULT_OFF,
            "asset_class": asset_class(sid),
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
    log("Treasury yields (Federal Reserve H.15):")
    bonds, bond_cuts = build_bonds(fetch_h15(args.skip_download))
    # month-end on the French grid; bond months after French's last month are kept too
    sleeves = sleeves.join(pd.DataFrame(bonds), how="outer")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    log("Commodities (AQR + HGER):")
    commodities, splice, com_cuts = build_commodities(x["rf"], args.skip_download)
    log("Hedge-strategy proxies (AQR trend, French value + momentum):")
    proxies, trend_table, proxy_cuts = build_hedge_proxies(csvs, x["ff3_m"], args.skip_download)
    trend_table.to_csv(OUT_DIR / "trend_splice.csv", date_format="%Y-%m-%d", float_format="%.6f")
    com_cuts += proxy_cuts
    sleeves = sleeves.join([commodities.rename("Commodities"), pd.DataFrame(proxies)], how="outer")
    sleeves = sleeves[[sid for sid, *_ in SLEEVES]]
    splice.to_csv(OUT_DIR / "commodities_splice.csv", date_format="%Y-%m-%d", float_format="%.6f")
    cuts = pd.concat([cuts, pd.DataFrame(bond_cuts + com_cuts)], ignore_index=True)
    rf = x["rf"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    sleeves.to_csv(OUT_DIR / "sleeves_monthly.csv", date_format="%Y-%m-%d", float_format="%.6f")
    log("Benchmarks:")
    bm, bm_meta = build_benchmarks(sleeves, x["region_caps"])
    bm = bm.reindex(sleeves.index)
    bm.to_csv(OUT_DIR / "benchmarks_monthly.csv", date_format="%Y-%m-%d", float_format="%.6f")
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
        "benchmarks": {"list": bm_meta, "returns": {c: to_json_list(bm[c]) for c in bm}},
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
    sheets["Commodities_Splice"] = splice_check(splice)
    sheets["Benchmarks_Full"] = window_stats(bm, rf, None, None)
    sheets["Benchmarks_Calendar"] = calendar_years(bm)
    sheets["Benchmark_Checks"] = benchmark_checks(bm, args.skip_download)
    sheets["Trend_Splice"] = splice_check(trend_table, "factor_total", "fund_total", "factor / AQMIX")

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

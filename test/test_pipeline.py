"""Tests for scripts/update_french_data.py (no network: small in-memory fixtures only).

    python3 -m unittest discover -s test -p "test_*.py"
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import update_french_data as u  # noqa: E402

FRENCH = """This file was created using the 202609 CRSP database. ME is market cap at the end of June.
It contains value- and equal-weighted returns for portfolios formed on ME and BE/ME.

  Average Value Weighted Returns -- Monthly
,SMALL LoBM,ME1 BM2,SMALL HiBM,BIG LoBM,ME2 BM2,BIG HiBM
192607,   1.00,   2.00,  -99.99,   4.00,   5.00,   6.00
192608,  -1.50,   0.50,   3.00,   4.00,   5.00,   6.00

  Average Equal Weighted Returns -- Monthly
,SMALL LoBM,ME1 BM2,SMALL HiBM,BIG LoBM,ME2 BM2,BIG HiBM
192607,   9.00,   9.00,   9.00,   9.00,   9.00,   9.00

  Average Value Weighted Returns -- Annual
,SMALL LoBM,ME1 BM2,SMALL HiBM,BIG LoBM,ME2 BM2,BIG HiBM
  1927,  10.00,  11.00,  12.00,  13.00,  14.00,  15.00

  Number of Firms in Portfolios
,SMALL LoBM,ME1 BM2,SMALL HiBM,BIG LoBM,ME2 BM2,BIG HiBM
192607,10,10,10,10,10,10
192608,10,10,10,10,10,10

  Average Market Cap
,SMALL LoBM,ME1 BM2,SMALL HiBM,BIG LoBM,ME2 BM2,BIG HiBM
192607,1,1,1,3,3,3
192608,1,1,1,3,3,3
"""


def tmp(text: str, name: str = "f.csv") -> Path:
    p = Path(tempfile.mkdtemp()) / name
    p.write_text(text)
    return p


def yahoo(days, closes) -> Path:
    ts = [int(pd.Timestamp(d + " 13:30").timestamp()) for d in days]
    doc = {"chart": {"result": [{"meta": {"gmtoffset": 0}, "timestamp": ts,
                                 "indicators": {"adjclose": [{"adjclose": closes}]}}]}}
    return tmp(json.dumps(doc), "y.json")


class FrenchParsing(unittest.TestCase):
    def test_blocks_and_headings(self):
        blocks = u.split_blocks(tmp(FRENCH))
        self.assertEqual([b.heading for b in blocks],
                         ["Average Value Weighted Returns -- Monthly", "Average Equal Weighted Returns -- Monthly",
                          "Average Value Weighted Returns -- Annual", "Number of Firms in Portfolios", "Average Market Cap"])
        self.assertEqual([b.freq for b in blocks], ["M", "M", "A", "M", "M"])

    def test_returns_missing_and_dates(self):
        p = u.six_portfolio_blocks(tmp(FRENCH), "BM")
        vw = p["vw_monthly"]
        self.assertEqual(str(vw.index[0].date()), "1926-07-31")           # month-end
        self.assertAlmostEqual(vw["SMALL LoBM"].iloc[0], 0.01)             # percent -> decimal
        self.assertTrue(np.isnan(vw["SMALL HiBM"].iloc[0]))                # -99.99 -> missing
        self.assertAlmostEqual(p["vw_annual"].loc[1927, "BIG HiBM"], 0.15)

    def test_size_block_is_not_the_returns_block(self):
        # the file description mentions "market cap"; the size block must still be the real one
        p = u.six_portfolio_blocks(tmp(FRENCH), "BM")
        self.assertEqual(p["avg_size"].iloc[0].tolist(), [1, 1, 1, 3, 3, 3])

    def test_cap_weighting(self):
        p = u.six_portfolio_blocks(tmp(FRENCH), "BM")
        mkt = u.cap_weighted(p, lag=0)
        self.assertTrue(np.isnan(mkt.iloc[0]))                             # a missing portfolio -> no market value
        expect = (1 * (-0.015 + 0.005 + 0.03) + 3 * (0.04 + 0.05 + 0.06)) / 12
        self.assertAlmostEqual(mkt.iloc[1], expect)


class Bonds(unittest.TestCase):
    idx = pd.date_range("2000-01-31", periods=3, freq="ME")

    def test_flat_yield_earns_the_coupon(self):
        r = u.bond_returns(pd.Series([5.0, 5.0, 5.0], self.idx), 10)
        self.assertAlmostEqual(r.iloc[1], 0.05 / 12)

    def test_rising_yield_loses_about_duration(self):
        r = u.bond_returns(pd.Series([5.0, 5.01, 5.01], self.idx), 10)
        self.assertAlmostEqual(r.iloc[1], 0.05 / 12 - 7.74 * 0.0001, places=5)

    def test_gap_stays_a_gap(self):
        r = u.bond_returns(pd.Series([5.0, 5.0], self.idx[[0, 2]]), 5)
        self.assertTrue(r.isna().all())


class YahooAndSplices(unittest.TestCase):
    def test_month_end_returns_and_partial_last_month(self):
        days = pd.bdate_range("2026-07-01", "2026-09-30").strftime("%Y-%m-%d").tolist()
        closes = [10.0 if d < "2026-08" else 10.5 if d < "2026-09" else 10.29 for d in days]
        full = u.read_yahoo_monthly(yahoo(days, closes))
        self.assertEqual([d.strftime("%Y-%m") for d in full.index], ["2026-08", "2026-09"])
        self.assertAlmostEqual(full.iloc[0], 0.05)
        self.assertAlmostEqual(full.iloc[1], -0.02)
        short = u.read_yahoo_monthly(yahoo(days[:-1], closes[:-1]))        # file stops a day early
        self.assertEqual([d.strftime("%Y-%m") for d in short.index], ["2026-08"])

    def test_weekly_bars_are_refused(self):
        days = pd.date_range("2026-01-05", periods=30, freq="W-MON").strftime("%Y-%m-%d").tolist()
        with self.assertRaises(ValueError):
            u.read_yahoo_monthly(yahoo(days, [10.0] * 30))

    def test_splice_uses_the_fund_from_its_first_month(self):
        idx = pd.date_range("2020-01-31", periods=6, freq="ME")
        proxy = pd.Series([0.01] * 6, idx)
        fund = pd.Series([0.05, 0.06, 0.07], idx[3:])
        t = u.splice_fund(proxy, fund, "proxy", "FUND")
        self.assertEqual(t["source"].tolist(), ["proxy"] * 3 + ["FUND"] * 3)
        self.assertEqual(t["return"].tolist(), [0.01] * 3 + [0.05, 0.06, 0.07])
        # no fund data: proxy only
        t2 = u.splice_fund(proxy, pd.Series(dtype=float, index=pd.DatetimeIndex([])), "proxy", "FUND")
        self.assertEqual(t2["source"].unique().tolist(), ["proxy"])


class Stats(unittest.TestCase):
    def test_worst_years(self):
        r = pd.Series([0.01] * 180)
        r.iloc[60:84] = -0.02
        self.assertAlmostEqual(u.worst_years(r, 5), (0.98 ** 24 * 1.01 ** 36) ** (1 / 5) - 1)
        self.assertTrue(np.isnan(u.worst_years(r.iloc[:50], 5)))

    def test_calendar_years_only_complete(self):
        idx = pd.date_range("2000-07-31", "2002-03-31", freq="ME")
        cal = u.calendar_years(pd.DataFrame({"a": 0.01}, index=idx))
        self.assertEqual(cal.index.tolist(), [2001])
        self.assertAlmostEqual(cal.loc[2001, "a"], 1.01 ** 12 - 1)

    def test_sleeve_classes(self):
        self.assertEqual(u.asset_class("Trend"), "Alts")
        self.assertEqual(u.asset_class("Cash"), "Fixed income")
        self.assertEqual(u.asset_class("Research_IG"), "Equity")
        ids = [s[0] for s in u.SLEEVES]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()

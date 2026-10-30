# Historical return data

Everything here is built by one script:

```bash
pip install -r requirements.txt
python scripts/update_french_data.py                  # re-download from Ken French and rebuild everything
python scripts/update_french_data.py --skip-download  # rebuild from the zips already in data/raw/french/
python scripts/update_french_data.py --from-dir ~/Downloads/french   # use zips you downloaded by hand
```

Re-run it whenever French posts new data (usually monthly). Every output under
`data/processed/` is regenerated from scratch on each run.

## Sources

All files come from the [Kenneth R. French Data Library](https://mba.tuck.dartmouth.edu/pages/faculty/Ken.French/data_library.html)
(`.../Ken.French/ftp/<file>`):

| File | Used for |
|---|---|
| `F-F_Research_Data_Factors_CSV.zip` | Mkt-RF and RF (US market, cash) |
| `F-F_Research_Data_5_Factors_2x3_CSV.zip` | 5 factors for the DFAT regression |
| AQR "Commodities for the Long Run: Index Level Data, Monthly" ([page](https://www.aqr.com/Insights/Datasets/Commodities-for-the-Long-Run-Index-Level-Data-Monthly)) | Commodity futures returns through AQR's last month |
| HGER (Harbor Commodity All-Weather Strategy ETF), daily dividend-adjusted closes from Yahoo Finance | Commodity returns after AQR's last month |
| `F-F_Momentum_Factor_CSV.zip` (French) | Momentum factor (Mom) for the equity long/short sleeve |
| AQR "Time Series Momentum: Factors, Monthly" ([page](https://www.aqr.com/Insights/Datasets/Time-Series-Momentum-Factors-Monthly)) | Trend-following sleeve |
| AQMIX (AQR Managed Futures Strategy Fund, Class I), daily dividend-adjusted closes from Yahoo Finance | Trend after AQR's last month |
| Federal Reserve H.15, daily Treasury constant-maturity yields ([download page](https://www.federalreserve.gov/datadownload/Choose.aspx?rel=H15)) | Yields for the Treasury sleeves |
| `6_Portfolios_2x3_CSV.zip` | US size × book-to-market portfolios |
| `6_Portfolios_ME_OP_2x3_CSV.zip` | US size × operating-profitability portfolios |
| `Developed_ex_US_6_Portfolios_ME_BE-ME_CSV.zip` | Developed ex-US size × B/M portfolios |
| Emerging markets 6 portfolios (ME × BE/ME) | EM size × B/M; the script finds the link on the library page (override with `--em-url`) |

Raw zips are saved to `data/raw/french/` and unzipped into `data/raw/french/csv/`. The first
line of each CSV (which states the database cut, e.g. "…using the 202608 CRSP database") is
printed on every run and saved to `data/raw/french/download_log.csv`.

## Sleeves

`data/processed/sleeves_monthly.csv` holds monthly total returns in decimals, one column per sleeve.
Each sleeve keeps its own start date: earlier months are blank, not truncated.

| Sleeve | Construction | Morningstar category |
|---|---|---|
| US_LargeCap | Mkt-RF + RF (the full US market; there is no separate large-cap index) | Large Blend |
| US_SmallValue | 6_Portfolios_2x3, SMALL HiBM | Small Value |
| US_SmallGrowth | 6_Portfolios_2x3, SMALL LoBM | Small Growth |
| US_LargeValue | 6_Portfolios_2x3, BIG HiBM | Large Value |
| US_LargeGrowth | 6_Portfolios_2x3, BIG LoBM | Large Growth |
| US_SmallRobust | 6_Portfolios_ME_OP_2x3, SMALL HiOP | Small Blend |
| US_SmallWeak | 6_Portfolios_ME_OP_2x3, SMALL LoOP | Small Blend |
| DevExUS_SmallValue / LargeValue | Developed ex-US six portfolios, SMALL HiBM / BIG HiBM | Foreign Small/Mid Value / Foreign Large Value |
| DevExUS_Market | Cap-weighted average of all six (see below) | Foreign Large Blend |
| EM_SmallValue / LargeValue / Market | Same as Developed, from the EM file | Diversified Emerging Mkts |
| Cash | RF (1-month T-bill) | Money Market-Taxable |

| Commodities | AQR equal-weight commodity futures excess return + RF; HGER total return after AQR's last month | Commodities Broad Basket |
| Trend | AQR time-series momentum factor (all assets) + RF − 2%/yr fee through 2025; AQMIX total return from January 2026 | Systematic Trend |
| Equity_LS | 50% HML + 50% Mom (French), rebalanced monthly, + RF | Equity Market Neutral |
| UST_1Y / UST_5Y / UST_10Y | H.15 1-, 5- and 10-year constant-maturity yields, built into total returns (see below) | Short / Intermediate / Long Government |

All six portfolio sleeves use French's **value-weighted** returns. Percentages are
converted to decimals, and `-99.99` / `-999` are treated as missing.

**International market sleeves.** The international six-portfolio files have no market
column, so the market is built from the six portfolios themselves. Each is weighted by
"Average Firm Size" (called "Average Market Cap" in the US files) × "Number of Firms" from the same file. The script decides whether that
size should be lagged a month by running the same construction on the US six portfolios
and keeping the lag that tracks the official US market (Mkt-RF + RF) best. The result is in
the `Size_Lag_Check` sheet. The six portfolios may not cover exactly the same stocks as French's
market factor, so treat this as a close approximation of the region's market return.

**Treasury sleeves (Federal Reserve H.15).** The Fed publishes yields, not returns, so the
script rebuilds monthly total returns. At each month-end it buys a par bond whose coupon
equals that month-end's constant-maturity yield. A month later the bond is repriced at the new
yield with one month less to maturity, and the month's return is the price change plus one
month of coupon. It then rolls into a fresh par bond, so maturity stays constant. These are the
same yields FRED republishes as `DGS1`/`DGS5`/`DGS10`. The script reads them from the Fed
directly because FRED refuses connections from the cloud environment this was built in.
- History starts in 1962. Yields are month-end values of the daily series. The raw file is
  saved to `data/raw/h15/`.
- **What this ignores:** the gap between a constant-maturity yield and any real bond's, and
  the small effect of coupon timing. Treat these as close approximations of Treasury index
  returns.
- Only complete months are kept.
- Corporate bonds aren't included yet. Moody's Aaa yields are only on FRED (the Fed dropped
  them from H.15 in 2016).

**Commodities (AQR + HGER).** Two sources joined end to end:
- **Through AQR's last month:** the equal-weight commodity futures portfolio from Levine, Ooi,
  Richardson & Sasseville, "Commodities for the Long Run" (*Financial Analysts Journal*, 2018),
  in AQR's updated dataset. AQR publishes returns in excess of T-bills, so the sleeve adds RF
  (the Cash sleeve), the same way US Market is Mkt-RF + RF. It starts in 1926-07, when RF
  begins, although AQR's data goes back to 1877. AQR's page says the file is updated monthly,
  but as of October 2026 its data ends in May 2025.
- **After that:** HGER's monthly total return, from the last dividend-adjusted daily close of
  each month on Yahoo Finance. HGER holds T-bills as collateral, so its return is on the same
  footing as AQR + RF. When AQR updates again, the switch-over moves later on its own.
- **How well they match:** over March 2022 to May 2025, HGER's monthly returns correlated
  0.86 with AQR + RF, with 6.2% a year tracking error and similar volatility (11.8% vs 11.7%).
  HGER returned about 3.4% a year more over that stretch, despite its 0.68% expense ratio.
  They follow different index rules, so months after the switch reflect HGER's index rather
  than a continuation of AQR's.
- **Fees:** the HGER months are actual fund returns, net of fees. The AQR months are a paper
  portfolio with no costs, like French's data.
- `commodities_splice.csv` shows both series side by side with the source of each month.
  The `Commodities_Splice` sheet in `stats.xlsx` holds the overlap statistics.
- AQR's disclosures: information purposes only, not investment advice, no warranty. The
  dataset is © 2018 Levine, Ooi, Richardson and Sasseville.

**Hedge-strategy proxies (Trend, Equity_LS).** There's no broad hedge fund index before
1990 (HFRI starts then), so these two sleeves stand in for two common hedge fund strategies,
built from academic long/short factors:
- **Trend:** AQR's time-series momentum factor from Moskowitz, Ooi & Pedersen, "Time Series
  Momentum" (*Journal of Financial Economics*, 2012), updated by AQR. Each month it goes
  long or short 58 futures and forwards (equity indexes, bonds, currencies, commodities)
  according to their past 12-month return. AQR publishes it as an excess return, so RF is
  added. It runs from 1985-01 to AQR's latest month, which is usually a few months behind
  French. From **January 2026** (`TREND_FUND_FROM` in the script) the sleeve uses **AQMIX**, AQR's
  own managed-futures mutual fund: its actual monthly returns after fees, from Yahoo with
  distributions reinvested. That way the current year matches the real fund. Earlier months stay on
  the factor, and if AQR's data ever ends before that date, AQMIX fills from AQR's last month.
  - **Fee haircut:** the factor months have **2% a year subtracted, as 2%/12 each month**
    (`TREND_FACTOR_FEE` in the script), a stand-in for fees and trading costs. The AQMIX
    months aren't adjusted, since they're already net of the fund's fees.
  - **How well they match:** over 2010-02 to 2026-05 the fund correlated 0.76 with the
    factor, with 8.5% a year tracking error.
  - **Why 2%:** before the haircut, the fund returned 4.8% a year against the factor's 6.9%,
    at lower volatility (9.9% vs 13.0%). That's a 2.1% a year gap. After the haircut the
    average difference is about 0.1% a year.
  - `trend_splice.csv` and the `Trend_Splice` sheet hold the comparison. AQR's century-long
    trend reconstruction isn't published as a download.
- **Equity_LS:** half value (HML) and half momentum (Mom), rebalanced monthly, plus RF. These
  are long/short US stock portfolios, the classic market-neutral pair, because value and
  momentum tend to offset each other. Runs from 1927-01.
- **Behaviour:** both act as expected. Trend gained +26.6% in 2008 and +26.5% in 2022, with
  about zero correlation to stocks. Equity_LS's correlation with stocks is −0.29, and it
  shows momentum's 2009 crash (−29.6%).
- **These are paper returns, before any fees, trading costs or the cost of shorting.**
  - **Trend is the most overstated.** (2026 is the exception: it's AQMIX's real return after fees.) It shows 15.7% a year since 1985 at a Sharpe of 0.98.
    It's now shown **after a 2% a year fee haircut** (13.3% a year since 1985, Sharpe 0.82),
    which matches AQMIX's real record on average. It's still a paper strategy, so treat it as
    optimistic.
  - **Equity_LS** ignores short-selling costs and momentum's high turnover.
  - Cap their weights, or read their results as an upper bound.

**Benchmarks (for comparison only; the optimizer doesn't use them).**
- **Blends:** built from the same data as the sleeves. *Stocks* = US_LargeCap (French's
  all-US market, the usual stand-in for the S&P 500). *Bonds* = UST_5Y (about the same
  interest-rate sensitivity as the Bloomberg US Aggregate, but Treasuries only).
  - Rebalanced monthly, as published blended indexes are.
  - **FI 100, 20/80, 40/60, 60/40, 80/20** start in 1962-02 (with the Treasuries).
    **US 100** starts in 1926-07.
- **World** (all-world equity, from 1990-07): the US market, DevExUS_Market and EM_Market,
  weighted each month by each region's total market value from French's files.
  - The US share goes from 33% (1990) to 49% (2000) to 56% (2026).
  - French counts companies' full market value, not just freely traded shares. That
    gives non-US markets a bit more weight than MSCI ACWI, where the US is about 64% today.
- **Checked against real funds:**
  - **60/40 vs Vanguard Balanced Index (VBINX), 1992–2026:** correlation 0.996, 8.3% vs
    8.4% a year.
  - **World vs Vanguard Total World (VT), 2008–2026:** correlation 0.993, 8.7% vs 8.8% a year.
  - The comparison is in the `Benchmark_Checks` sheet.

## Outputs (`data/processed/`)

| File | Contents |
|---|---|
| `sleeves_monthly.csv` | `date` (month-end, `YYYY-MM-DD`) + one column per sleeve, decimal total returns |
| `sleeves_annual.csv` | `year` + one column per sleeve; compounded monthly returns, complete calendar years only |
| `sleeve_metadata.csv` | `sleeve, name, region, morningstar_category, source_file, source_column, start_date, end_date, months, default_on, asset_class` |
| `optimizer_returns.json` | The three files above in one bundle for the React app (blank months are `null`) |
| `commodities_splice.csv` | The commodity sleeve with AQR and HGER side by side and the source of each month |
| `trend_splice.csv` | The Trend sleeve with the AQR factor and AQMIX side by side and the source of each month |
| `benchmarks_monthly.csv` | The seven benchmarks' monthly returns |
| `stats.xlsx` | One sheet per item, listed below |
| `dfat_extended.csv`, `dfat_regression.csv`, `dfat_synthetic_vs_actual.png` | Only when DFAT returns are provided |

`stats.xlsx` sheets:
- **Notes** and **Data_Cut**: method notes and the data-cut log.
- **Stats_Full**, **Stats_1990_present**, **Stats_2000_present**, **Stats_2016_2025**: CAGR, annualized volatility, Sharpe, max drawdown and worst 12-month return. A sleeve that does not cover the whole window is left blank with a note instead of being computed on partial data. For example, an international sleeve that starts after January 1990 is blank for 1990-present.
- **Correlation**: monthly returns over the longest window in which every sleeve exists.
- **Calendar_Year**: annual returns, for checking the optimizer's 2016–2025 backtest.
- **Rolling10y_SV_vs_LC**: rolling 120-month annualized returns of US_SmallValue and US_LargeCap and their difference.
- **Annual_Check**: compounded monthly returns compared with French's own annual blocks. Differences should be rounding-sized (a few hundredths of a percent).
- **Size_Lag_Check**: see the international market sleeves above.
- **Commodities_Splice**: how closely HGER tracked AQR over the months both exist.
- **Benchmarks_Full**, **Benchmarks_Calendar**, **Benchmark_Checks**: benchmark stats, calendar years, and the comparison with VBINX and VT.
- **Trend_Splice**: how closely AQMIX tracked AQR's trend factor over the months both exist.

Sharpe = annualized mean monthly excess return over RF ÷ annualized standard deviation of
excess returns (arithmetic, ×12 and ×√12).

## Optimizer input format

The app (`index.html`) reads `optimizer_returns.json`. The CSVs hold the same numbers
for spreadsheets or other tools.

- **Frequency:** monthly. Annual returns are pre-compounded in `sleeves_annual.csv` / `annual` in the JSON.
- **Units:** decimal total returns (`0.0123` = 1.23%), USD.
- **Dates:** month-end ISO dates (`2025-12-31`).
- **Columns / keys:** the sleeve ids above (e.g. `US_SmallValue`), stable across refreshes.
- **Missing:** blank cell in CSV, `null` in JSON. These only appear before a sleeve's start date.
  When running mean-variance over several sleeves, pick a window where all of them have data
  (`sleeve_metadata.csv` has each start date) rather than dropping rows sleeve-by-sleeve.
- **Category mapping:** `sleeve_metadata.csv` → `morningstar_category`, for mapping funds to sleeves.

JSON shape:

```json
{
  "generated_at": "...", "source": "...", "data_cut": {"<file>": "202608"}, "units": "...",
  "sleeves": [{"sleeve": "US_SmallValue", "name": "...", "morningstar_category": "Small Value", "start_date": "1926-07-31", ...}],
  "monthly": {"dates": ["1926-07-31", ...], "returns": {"US_SmallValue": [0.0123, ...], ...}},
  "annual":  {"years": [1927, ...],         "returns": {"US_SmallValue": [0.31, ...], ...}}
}
```

## DFAT factor regression and extension

1. Fill in `data/raw/dfat_monthly.csv` (columns `date,return`; date `YYYY-MM-DD` or `YYYY-MM`,
   return as a decimal). The script creates the empty template if it's missing and never
   overwrites it.
2. Re-run the script. It regresses DFAT − RF on the five factors (OLS) and reports alpha, betas,
   t-stats and R². Results go to the console, `dfat_regression.csv` and the `DFAT_Regression` sheet.
3. `dfat_extended.csv` holds a synthetic history from 1963-07 (RF + Σ β·factor, **no alpha**), with
   the actual returns spliced in from DFAT's first month onward (`source` = synthetic/actual).
   It also keeps both underlying series side by side.
4. `dfat_synthetic_vs_actual.png` plots growth of $1 for both over the overlap period.

DFAT has traded as an ETF only since June 2021, so the betas rest on a short sample. Adding the
predecessor mutual fund's returns (net of its fees) would lengthen it. The synthetic series has
no fees or alpha. Expect it to drift from what the fund would have earned.

## Caveats

- **Paper portfolios.** French's returns carry no fees, trading costs, taxes or cash drag.
  Real funds in the same categories will have earned less, especially in small cap and
  emerging markets, where trading costs are highest.
- **History is restated.** French rebuilds every series from scratch on each update (CRSP and
  Bloomberg revisions, methodology changes), so past returns can shift slightly between
  downloads. The data-cut log records which vintage produced the current outputs. Re-run the
  whole pipeline instead of appending new months to old files.
- **International data** are in USD and start around 1990. Each sleeve's actual start date is
  in `sleeve_metadata.csv`. Full-history stats for US sleeves cover a much longer period than
  international ones, so compare them on the common windows.
- **US_LargeCap is the total US market**, not a pure large-cap series. The BIG portfolios
  are the closer large-cap analogue.

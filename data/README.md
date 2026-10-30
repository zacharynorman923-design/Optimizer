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
| FRED `DGS1`, `DGS5`, `DGS10`, `AAA` | Treasury and Aaa corporate yields for the bond sleeves |
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

| UST_1Y / UST_5Y / UST_10Y | FRED `DGS1` / `DGS5` / `DGS10`, built into total returns (see below) | Short / Intermediate / Long Government |
| Corp_AAA | FRED `AAA` (Moody's seasoned Aaa corporate yield), built into total returns | Long-Term Bond |

All six portfolio sleeves use French's **value-weighted** returns. Percentages are
converted to decimals, and `-99.99` / `-999` are treated as missing.

**International market sleeves.** The international six-portfolio files have no market
column, so the market is built from the six portfolios themselves. Each is weighted by
"Average Firm Size" (called "Average Market Cap" in the US files) × "Number of Firms" from the same file. The script decides whether that
size should be lagged a month by running the same construction on the US six portfolios
and keeping the lag that tracks the official US market (Mkt-RF + RF) best. The result is in
the `Size_Lag_Check` sheet. The six portfolios may not cover exactly the same stocks as French's
market factor, so treat this as a close approximation of the region's market return.

**Bond sleeves (FRED).** FRED publishes yields, not returns, so the script rebuilds monthly
total returns. At each month-end it buys a par bond whose coupon equals that month's yield.
A month later the bond is repriced at the new yield with one month less to maturity, and the
month's return is the price change plus one month of coupon. It then rolls into a fresh par
bond, so maturity stays constant. Raw yields are saved to `data/raw/fred/`.
- **Treasuries:** month-end values of the daily constant-maturity yields, from 1962. Each is
  treated as a 1-, 5- or 10-year bond.
- **Aaa corporates:** Moody's yield exists only as a monthly *average* before 1983. To keep
  one consistent series back to 1919 the script uses the monthly average throughout,
  treated as a 20-year bond. Averages smooth the yield path, so this sleeve's volatility
  and its month-to-month moves are somewhat understated.
- **What this ignores:** defaults and downgrades (small for Aaa), callability, and the gap
  between a constant-maturity yield and a real bond's. Treat these as close approximations
  of index returns, not exact index returns.
- Only complete months are kept.

## Outputs (`data/processed/`)

| File | Contents |
|---|---|
| `sleeves_monthly.csv` | `date` (month-end, `YYYY-MM-DD`) + one column per sleeve, decimal total returns |
| `sleeves_annual.csv` | `year` + one column per sleeve; compounded monthly returns, complete calendar years only |
| `sleeve_metadata.csv` | `sleeve, name, region, morningstar_category, source_file, source_column, start_date, end_date, months` |
| `optimizer_returns.json` | The three files above in one bundle for the React app (blank months are `null`) |
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

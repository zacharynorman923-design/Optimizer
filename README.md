# Optimizer

A dependency-free web app for **mean-variance portfolio optimization** on Ken
French's research portfolios: US size/value/profitability, developed ex-US and
emerging markets, cash, US Treasuries and commodities, with history back to 1926. Pick sleeves and limits,
see the **efficient frontier**, and backtest the result **year by year** against
a benchmark.

**Live site:** https://zacharynorman923-design.github.io/Optimizer/ (once Pages is on; see [Deploying](#deploying))

No build step, no dependencies, no backend: just HTML, CSS and vanilla JS
modules. Installable as a PWA, and it works offline once loaded.

## What it does

- **Sleeves.** All 18 are on by default. Tick any subset and set a **minimum and maximum weight** for each.
  Presets: *All*, *US to 1926* (the five US style sleeves plus cash, 100 years of history) and *None*.
- **All the history there is.** The window defaults to the longest stretch every ticked sleeve
  covers. The app names the sleeves that set the start date and says how far back you'd get
  without them. *From* and *To* narrow the window.
- **Objectives:**
  - *Max Sharpe* (tangency)
  - *Min volatility*
  - *Max return at a volatility*
  - *Min volatility for a return*
  - *Equal weight*
  - *My own weights*, where you type weights in the sleeve list

  Every optimized result is long-only, fully invested and inside your limits.
- **Efficient frontier.** The frontier with the selected, max-Sharpe and min-volatility portfolios,
  the benchmark and each sleeve plotted. Tap the frontier to choose that risk level.
- **Backtest.**
  - **Metrics:** CAGR, volatility, Sharpe, max drawdown, worst 12 months, best and worst year,
    and the number of years ahead of the benchmark.
  - **Charts:** growth of $10,000 (log scale) and drawdowns.
  - **Rebalancing:** annual, quarterly, monthly or never.
- **Calendar years.** Portfolio minus benchmark for every year in the window, plus a
  year-by-year table. The current year shows as YTD.
- **Correlations.** A heatmap of monthly-return correlations over the same window.

Settings are remembered in your browser. Dark and light themes.

## How it computes

Returns are monthly decimal total returns from `data/processed/optimizer_returns.json`.

- **Expected return** = historical arithmetic mean × 12. **Risk** = sample covariance × 12.
  Sharpe ratios are measured against the 1-month T-bill (the Cash sleeve) over the same months.
- **Frontier:** sweeps a risk-aversion parameter `γ` through `min wᵀΣw − γ·μ·w`, solved by
  accelerated projected gradient descent (FISTA).
  - The projection onto `{Σw = 1, loᵢ ≤ wᵢ ≤ hiᵢ}` is exact: `wᵢ = clip(vᵢ − τ, loᵢ, hiᵢ)`, with `τ`
    found by bisection.
  - The max-return end is solved exactly by filling the best sleeves first.
- **Max Sharpe:** the best Sharpe on the frontier, refined by golden-section search on `γ`.
- **Target volatility / return:** found by bisecting `γ`, because both rise along the frontier.
  If a target is out of reach, the app says so and shows the nearest portfolio.
- **Backtest:** weights drift with returns between rebalances. Rebalancing happens at month-end
  (annual = December close).
- **Metrics:** defined exactly as in `data/processed/stats.xlsx`. The JS and Python numbers match.

`npm test` checks the optimizer against closed-form answers: minimum variance `Σ⁻¹1/1ᵀΣ⁻¹1` and
the tangency portfolio `Σ⁻¹(μ − rf)` when no limit binds. It also checks the limits, frontier
targets and backtest arithmetic.

## Data

The return series are built by `scripts/update_french_data.py`. The equity sleeves and
cash come from the
[Ken French Data Library](https://mba.tuck.dartmouth.edu/pages/faculty/Ken.French/data_library.html).
The 1-, 5- and 10-year Treasury sleeves (from 1962) are total returns rebuilt from the
Federal Reserve's H.15 constant-maturity yields. Commodities are AQR's long-run
commodity-futures index plus T-bills, continued with the HGER ETF after AQR's data ends
(May 2025 at present).

To refresh when French posts new data:

```bash
pip install -r requirements.txt
python scripts/update_french_data.py
git add data && git commit -m "Refresh French data" && git push
```

The app loads the data network-first, so the next visit picks up the new numbers.

## Running it locally

```bash
npm start          # serves at http://localhost:8080 (any static server works)
npm test           # optimizer + stats tests (node --test)
```

## Deploying

It's a static site, so **Settings → Pages → Deploy from a branch → `main` → `/ (root)`**
publishes it. Any static host works too, with no build command and `/` as the publish directory.

## Files

| File | Responsibility |
| --- | --- |
| `index.html` | Page structure: sleeves, settings, results |
| `css/styles.css` | Styling, dark and light themes, responsive |
| `js/data.js` | Loads the return bundle, sleeve coverage, common windows, slicing |
| `js/stats.js` | Metrics, calendar years, backtest, correlations (pure functions) |
| `js/optimize.js` | Moments, projection, frontier, max Sharpe, targets, risk contributions (pure functions) |
| `js/charts.js` | Inline-SVG charts: frontier, growth, drawdowns, year bars, heatmap |
| `js/app.js` | State, rendering, interactions, persistence |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA install and offline support |
| `scripts/update_french_data.py` | Downloads French's files and rebuilds everything in `data/` |
| `test/` | `node --test` suites for `stats.js` and `optimize.js` |

## A note on the numbers

- **The backtest is in-sample.** Weights are chosen on the same window they're tested on, so
  optimized portfolios look better than anyone could have done in real time. Max Sharpe in
  particular concentrates in whatever did best in the window.
- **These are paper portfolios.** No fees, trading costs, taxes or cash drag.
- **Treasury returns are rebuilt from yields**, so they are close to, not identical to, index
  returns. They are within about 1–2 points a year of published figures, with larger gaps in
  years of big rate moves.
- **Commodities join two sources.** AQR's paper index runs through May 2025, and HGER's
  actual net-of-fee returns follow. They correlated 0.86 where both exist, but they follow
  different index rules.
- **Max Sharpe likes short bonds.** With Treasuries ticked it usually loads up on the 1-year
  note, which is low-risk and had a high Sharpe ratio while rates fell. For a usable mix, try
  *Max return at a volatility* or cap the bond weights.
- **History gets restated.** French restates history on every update, so numbers can move
  slightly after a refresh.

This is a research and education tool. It is **not investment advice**, and past
performance doesn't predict future results.

/* =========================================================================
   Return statistics and the backtest. Pure functions only — no DOM, no
   storage — so every number the app shows can be unit-tested
   (see test/stats.test.js).

   Returns are monthly decimals (0.01 = 1%). Dates are month-end ISO strings
   'YYYY-MM-DD', compared as strings so nothing shifts with the time zone.
   ========================================================================= */

export const yearOf = (iso) => Number(iso.slice(0, 4));
export const monthOf = (iso) => Number(iso.slice(5, 7));

export function mean(xs) {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

export function stdev(xs) {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / (xs.length - 1));
}

/* Growth of `start` through a return series; the first value is `start` itself. */
export function wealth(returns, start = 1) {
  const out = [start];
  for (const r of returns) out.push(out[out.length - 1] * (1 + r));
  return out;
}

/* Drawdown from the running peak at each point of a wealth path (≤ 0). */
export function drawdowns(path) {
  let peak = -Infinity;
  return path.map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
}

/* Worst compounded return over any `n` consecutive months. */
export function worstRolling(returns, n = 12) {
  if (returns.length < n) return NaN;
  let worst = Infinity;
  for (let i = n; i <= returns.length; i++) {
    let g = 1;
    for (let k = i - n; k < i; k++) g *= 1 + returns[k];
    worst = Math.min(worst, g - 1);
  }
  return worst;
}

/* Compounded return of each complete calendar year, plus a trailing partial
   year flagged `partial` (year-to-date). A partial first year is dropped. */
export function calendarYears(dates, returns) {
  const years = [];
  let cur = null;
  dates.forEach((d, i) => {
    const y = yearOf(d);
    if (!cur || cur.year !== y) { cur = { year: y, growth: 1, months: 0 }; years.push(cur); }
    cur.growth *= 1 + returns[i];
    cur.months += 1;
  });
  return years
    .filter((y, i) => y.months === 12 || i === years.length - 1)
    .map((y) => ({ year: y.year, ret: y.growth - 1, partial: y.months < 12, months: y.months }));
}

/* Summary metrics, defined exactly as in data/processed/stats.xlsx:
   CAGR, annualized volatility (σ·√12), Sharpe = annualized mean excess over
   RF / annualized σ of excess, max drawdown on month-end wealth (the starting
   value counts as a peak), worst rolling 12 months. */
export function metrics(returns, rf) {
  const n = returns.length;
  const path = wealth(returns);
  const excess = returns.map((r, i) => r - rf[i]);
  const exSd = stdev(excess);
  const years = n / 12;
  return {
    months: n,
    cagr: path[n] ** (1 / years) - 1,
    vol: stdev(returns) * Math.sqrt(12),
    sharpe: exSd > 1e-12 ? (mean(excess) * 12) / (exSd * Math.sqrt(12)) : NaN,
    maxDD: Math.min(...drawdowns(path)),
    worst12: worstRolling(returns, 12),
    growth: path[n],
  };
}

/* Portfolio backtest with drifting weights.
   `matrix[t][i]` is sleeve i's return in month t; `weights` sum to 1.
   rebalance: 'monthly' | 'quarterly' | 'annual' | 'never'. Rebalancing
   happens at the END of a month (after its return), so 'annual' resets to
   target weights at each December close. */
export function backtest(dates, matrix, weights, rebalance = 'annual') {
  let w = weights.slice();
  const out = [];
  dates.forEach((d, t) => {
    const r = matrix[t];
    let port = 0;
    for (let i = 0; i < w.length; i++) port += w[i] * r[i];
    out.push(port);
    // drift
    const grown = w.map((wi, i) => wi * (1 + r[i]));
    const total = grown.reduce((a, b) => a + b, 0);
    w = grown.map((g) => g / total);
    const m = monthOf(d);
    const reset = rebalance === 'monthly'
      || (rebalance === 'quarterly' && m % 3 === 0)
      || (rebalance === 'annual' && m === 12);
    if (reset) w = weights.slice();
  });
  return out;
}

/* Pearson correlation matrix of the columns of `matrix` (T × n). */
export function correlation(matrix) {
  const n = matrix[0].length;
  const cols = Array.from({ length: n }, (_, i) => matrix.map((row) => row[i]));
  const mu = cols.map(mean);
  const sd = cols.map(stdev);
  const C = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < matrix.length; t++) s += (cols[i][t] - mu[i]) * (cols[j][t] - mu[j]);
      const c = s / (matrix.length - 1) / (sd[i] * sd[j]);
      C[i][j] = C[j][i] = i === j ? 1 : c;
    }
  }
  return C;
}

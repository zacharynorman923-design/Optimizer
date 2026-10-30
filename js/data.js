/* =========================================================================
   Loading the return bundle built by scripts/update_french_data.py
   (data/processed/optimizer_returns.json) and slicing it into the matrix the
   optimizer and backtest work on. Pure functions apart from loadBundle().
   ========================================================================= */

export const DATA_URL = 'data/processed/optimizer_returns.json';

export async function loadBundle(url = DATA_URL) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Couldn't load ${url} (HTTP ${res.status})`);
  return res.json();
}

/* Monthly returns of a sleeve or a benchmark (both are aligned to bundle.monthly.dates). */
export const seriesOf = (bundle, id) => bundle.monthly.returns[id] || (bundle.benchmarks && bundle.benchmarks.returns[id]);

/* First and last month (ISO dates) each sleeve and benchmark has data for. */
export function coverage(bundle) {
  const { dates, returns } = bundle.monthly;
  const out = {};
  const all = { ...returns, ...(bundle.benchmarks ? bundle.benchmarks.returns : {}) };
  for (const [id, series] of Object.entries(all)) {
    const first = series.findIndex((v) => v !== null);
    let last = series.length - 1;
    while (last >= 0 && series[last] === null) last--;
    out[id] = { start: dates[first], end: dates[last] };
  }
  return out;
}

/* The longest window every selected sleeve covers, and which sleeves set its start. */
export function commonWindow(cov, ids) {
  if (!ids.length) return null;
  const start = ids.map((id) => cov[id].start).sort().at(-1);
  const end = ids.map((id) => cov[id].end).sort()[0];
  const binding = ids.filter((id) => cov[id].start === start);
  // how far back the window would go without the binding sleeves
  const rest = ids.filter((id) => cov[id].start !== start);
  const next = rest.length ? rest.map((id) => cov[id].start).sort().at(-1) : null;
  // and which sleeves cut the end short (their data stops before the others')
  const latest = ids.map((id) => cov[id].end).sort().at(-1);
  const endBinding = end < latest ? ids.filter((id) => cov[id].end === end) : [];
  return { start, end, binding, next, endBinding, latest };
}

/* Rows of returns for `ids` between two ISO dates (inclusive), plus RF. */
export function slice(bundle, ids, start, end, rfId = 'Cash') {
  const { dates, returns } = bundle.monthly;
  const out = { dates: [], matrix: [], rf: [] };
  dates.forEach((d, t) => {
    if (d < start || d > end) return;
    const row = ids.map((id) => returns[id][t]);
    if (row.some((v) => v === null) || returns[rfId][t] === null) return;
    out.dates.push(d);
    out.matrix.push(row);
    out.rf.push(returns[rfId][t]);
  });
  return out;
}

/* Column of one sleeve or benchmark over the same dates as a slice (null where it has no data). */
export function column(bundle, id, dates) {
  const idx = new Map(bundle.monthly.dates.map((d, t) => [d, t]));
  const series = seriesOf(bundle, id);
  return dates.map((d) => series[idx.get(d)]);
}

/* Short labels for charts and narrow screens. */
export const SHORT = {
  US_LargeCap: 'US Market', US_SmallValue: 'US SV', US_SmallGrowth: 'US SG',
  US_LargeValue: 'US LV', US_LargeGrowth: 'US LG', US_SmallRobust: 'US S Robust',
  US_SmallWeak: 'US S Weak', DevExUS_SmallValue: 'Dev SV', DevExUS_LargeValue: 'Dev LV',
  DevExUS_Market: 'Dev Mkt', EM_SmallValue: 'EM SV', EM_LargeValue: 'EM LV',
  EM_Market: 'EM Mkt', Cash: 'Cash',
  UST_1Y: 'UST 1Y', UST_5Y: 'UST 5Y', UST_10Y: 'UST 10Y', Commodities: 'Cmdty', Trend: 'Trend', Equity_LS: 'Eq L/S',
  BM_FI100: 'FI 100', BM_20_80: '20/80', BM_40_60: '40/60', BM_60_40: '60/40', BM_80_20: '80/20',
  BM_EQ100: 'US 100', BM_World: 'World',
};

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

/* First and last month (ISO dates) each sleeve has data for. */
export function coverage(bundle) {
  const { dates, returns } = bundle.monthly;
  const out = {};
  for (const [id, series] of Object.entries(returns)) {
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
  return { start, end, binding, next };
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

/* Column of one sleeve over the same dates as a slice. */
export function column(bundle, id, dates) {
  const idx = new Map(bundle.monthly.dates.map((d, t) => [d, t]));
  return dates.map((d) => bundle.monthly.returns[id][idx.get(d)]);
}

/* Short labels for charts and narrow screens. */
export const SHORT = {
  US_LargeCap: 'US Market', US_SmallValue: 'US SV', US_SmallGrowth: 'US SG',
  US_LargeValue: 'US LV', US_LargeGrowth: 'US LG', US_SmallRobust: 'US S Robust',
  US_SmallWeak: 'US S Weak', DevExUS_SmallValue: 'Dev SV', DevExUS_LargeValue: 'Dev LV',
  DevExUS_Market: 'Dev Mkt', EM_SmallValue: 'EM SV', EM_LargeValue: 'EM LV',
  EM_Market: 'EM Mkt', Cash: 'Cash',
};

/* =========================================================================
   Mean-variance optimization. Pure functions only (see test/optimize.test.js).

   Every portfolio is long-only and fully invested, with per-sleeve limits and optional
   limits on asset classes (disjoint groups of sleeves, e.g. Equity / Fixed Income / Alts):
       Σw = 1,  lo_i ≤ w_i ≤ hi_i,  L_g ≤ Σ_{i∈g} w_i ≤ U_g
   Expected returns are historical arithmetic means and risk is the sample
   covariance of monthly returns, both annualized (×12).

   The frontier is traced by sweeping a risk-aversion parameter γ through
       min  wᵀΣw − γ·(μ·w)
   solved by accelerated projected gradient descent (FISTA). Projection onto
   the feasible set is exact: w_i = clip(v_i − τ − σ_g, lo_i, hi_i), with a
   class shift σ_g that is zero unless the class total would break its limit
   (then it puts the total on that limit), and τ found by bisection so the
   weights sum to 1. Because the classes don't overlap, each one can be
   settled independently for a given τ.
   ========================================================================= */

import { mean } from './stats.js';

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const matVec = (M, v) => M.map((row) => dot(row, v));

export const portReturn = (w, mu) => dot(w, mu);
export const portVol = (w, cov) => Math.sqrt(Math.max(0, dot(w, matVec(cov, w))));
export const portSharpe = (w, mu, cov, rf) => (portReturn(w, mu) - rf) / portVol(w, cov);

/* Annualized mean vector, covariance matrix and mean risk-free rate. */
export function moments(matrix, rf) {
  const n = matrix[0].length, T = matrix.length;
  const cols = Array.from({ length: n }, (_, i) => matrix.map((row) => row[i]));
  const mu = cols.map((c) => mean(c) * 12);
  const m = cols.map(mean);
  const cov = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (cols[i][t] - m[i]) * (cols[j][t] - m[j]);
      cov[i][j] = cov[j][i] = (s / (T - 1)) * 12;
    }
  }
  return { mu, cov, rf: mean(rf) * 12 };
}

/* Why the limits can't be met, or null if they can. */
export function boundsError(lo, hi, groups = []) {
  for (let i = 0; i < lo.length; i++) {
    if (lo[i] > hi[i] + 1e-12) return `a minimum is above its maximum (${(lo[i] * 100).toFixed(0)}% > ${(hi[i] * 100).toFixed(0)}%)`;
  }
  const sLo = lo.reduce((a, b) => a + b, 0), sHi = hi.reduce((a, b) => a + b, 0);
  if (sLo > 1 + 1e-9) return `the minimums add up to ${(sLo * 100).toFixed(0)}%, over 100%`;
  if (sHi < 1 - 1e-9) return `the maximums add up to ${(sHi * 100).toFixed(0)}%, under 100%`;
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  for (const g of groups) {
    const gl = g.members.reduce((a, i) => a + lo[i], 0), gh = g.members.reduce((a, i) => a + hi[i], 0);
    if (g.lo > g.hi + 1e-12) return `the ${g.name} minimum is above its maximum (${pct(g.lo)} > ${pct(g.hi)})`;
    if (!g.members.length && g.lo > 1e-12) return `no ${g.name} sleeves are ticked, but ${g.name} has a ${pct(g.lo)} minimum`;
    if (gl > g.hi + 1e-9) return `the ${g.name} sleeve minimums add up to ${pct(gl)}, above the ${g.name} maximum of ${pct(g.hi)}`;
    if (gh < g.lo - 1e-9) return `the ${g.name} sleeve maximums add up to ${pct(gh)}, below the ${g.name} minimum of ${pct(g.lo)}`;
  }
  const [mins, maxs] = effectiveTotals(lo, hi, groups);
  if (mins > 1 + 1e-9) return `with the asset-class limits, the minimums add up to ${pct(mins)}, over 100%`;
  if (maxs < 1 - 1e-9) return `with the asset-class limits, the most that can be invested is ${pct(maxs)}, under 100%`;
  return null;
}

/* Smallest and largest total weight the limits allow, counting each class at its tighter bound. */
function effectiveTotals(lo, hi, groups) {
  const grouped = new Set(groups.flatMap((g) => g.members));
  let mins = 0, maxs = 0;
  lo.forEach((l, i) => { if (!grouped.has(i)) { mins += l; maxs += hi[i]; } });
  for (const g of groups) {
    mins += Math.max(g.lo, g.members.reduce((a, i) => a + lo[i], 0));
    maxs += Math.min(g.hi, g.members.reduce((a, i) => a + hi[i], 0));
  }
  return [mins, maxs];
}

const clip = (x, l, h) => Math.min(h, Math.max(l, x));

/* Shift s so that Σ_{i∈m} clip(v_i − s) = target (bisection; the sum falls as s rises). */
function shiftFor(v, lo, hi, m, target) {
  let a = Math.min(...m.map((i) => v[i] - hi[i])) - 1, b = Math.max(...m.map((i) => v[i] - lo[i])) + 1;
  for (let k = 0; k < 100; k++) {
    const mid = (a + b) / 2;
    if (m.reduce((s, i) => s + clip(v[i] - mid, lo[i], hi[i]), 0) > target) a = mid; else b = mid;
  }
  return (a + b) / 2;
}

/* Nearest point to v in { Σw = 1, lo ≤ w ≤ hi, L_g ≤ Σ_g w ≤ U_g } (Euclidean).
   groups: [{ members: [index…], lo, hi }], disjoint; sleeves in no group are unconstrained by class. */
export function project(v, lo, hi, groups = []) {
  if (!groups.length) {
    const all = v.map((_, i) => i);
    const tau = shiftFor(v, lo, hi, all, 1);
    return v.map((vi, i) => clip(vi - tau, lo[i], hi[i]));
  }
  const grouped = new Set(groups.flatMap((g) => g.members));
  const free = v.map((_, i) => i).filter((i) => !grouped.has(i));
  // each class total, clamped to the tighter of its own limits and its sleeves' limits
  const bounds = groups.map((g) => [
    Math.max(g.lo, g.members.reduce((a, i) => a + lo[i], 0)),
    Math.min(g.hi, g.members.reduce((a, i) => a + hi[i], 0)),
  ]);
  const total = (tau) => {
    let s = 0;
    for (const i of free) s += clip(v[i] - tau, lo[i], hi[i]);
    groups.forEach((g, k) => {
      let gs = 0;
      for (const i of g.members) gs += clip(v[i] - tau, lo[i], hi[i]);
      s += clip(gs, bounds[k][0], bounds[k][1]);
    });
    return s;
  };
  let a = Math.min(...v.map((vi, i) => vi - hi[i])) - 1, b = Math.max(...v.map((vi, i) => vi - lo[i])) + 1;
  for (let k = 0; k < 100; k++) {
    const mid = (a + b) / 2;
    if (total(mid) > 1) a = mid; else b = mid;
  }
  const tau = (a + b) / 2;
  const w = v.map((vi, i) => clip(vi - tau, lo[i], hi[i]));
  groups.forEach((g, k) => {
    if (!g.members.length) return;
    const gs = g.members.reduce((s, i) => s + w[i], 0);
    const target = clip(gs, bounds[k][0], bounds[k][1]);
    if (Math.abs(target - gs) < 1e-15) return;
    const sh = shiftFor(v, lo, hi, g.members, target);
    for (const i of g.members) w[i] = clip(v[i] - sh, lo[i], hi[i]);
  });
  return w;
}

/* Largest eigenvalue of a symmetric PSD matrix (power iteration). */
function maxEigen(M) {
  let v = M.map(() => 1), lambda = 0;
  for (let k = 0; k < 100; k++) {
    const Mv = matVec(M, v);
    const norm = Math.sqrt(dot(Mv, Mv)) || 1;
    lambda = norm / Math.sqrt(dot(v, v));
    v = Mv.map((x) => x / norm);
  }
  return lambda;
}

/* min wᵀΣw − γ·μ·w over the feasible set (FISTA, warm-startable). */
export function solve(ctx, gamma, warm) {
  const { mu, cov, lo, hi, step } = ctx;
  let x = project(warm || mu.map(() => 1 / mu.length), lo, hi, ctx.groups);
  let y = x.slice(), t = 1;
  for (let k = 0; k < 5000; k++) {
    const g = matVec(cov, y).map((gi, i) => 2 * gi - gamma * mu[i]);
    const xNew = project(y.map((yi, i) => yi - step * g[i]), lo, hi, ctx.groups);
    const tNew = (1 + Math.sqrt(1 + 4 * t * t)) / 2;
    let change = 0;
    y = xNew.map((xi, i) => { change = Math.max(change, Math.abs(xi - x[i])); return xi + ((t - 1) / tNew) * (xi - x[i]); });
    x = xNew; t = tNew;
    if (change < 1e-11) break;
  }
  return x;
}

/* Highest-return feasible portfolio (exact LP solution for disjoint classes): start at the
   sleeve minimums, bring each class up to its minimum with its best sleeves, then spend what's
   left on the best sleeves overall without breaking a sleeve or class maximum. */
export function maxReturn(mu, lo, hi, groups = []) {
  const w = lo.slice();
  const byMu = (ix) => ix.slice().sort((a, b) => mu[b] - mu[a]);
  const groupOf = new Map();
  groups.forEach((g, k) => g.members.forEach((i) => groupOf.set(i, k)));
  const gsum = (k) => groups[k].members.reduce((s, i) => s + w[i], 0);
  groups.forEach((g, k) => {
    let need = Math.max(0, g.lo - gsum(k));
    for (const i of byMu(g.members)) {
      const add = Math.min(hi[i] - w[i], need);
      w[i] += add; need -= add;
    }
  });
  let left = 1 - w.reduce((a, b) => a + b, 0);
  for (const i of byMu(mu.map((_, i) => i))) {
    const k = groupOf.get(i);
    const room = k === undefined ? Infinity : groups[k].hi - gsum(k);
    const add = Math.max(0, Math.min(hi[i] - w[i], left, room));
    w[i] += add; left -= add;
  }
  return w;
}

/* Everything the solvers share for one set of inputs. */
export function context(mu, cov, rf, lo, hi, groups = []) {
  const L = 2 * maxEigen(cov) || 1;
  const scale = cov.reduce((s, row, i) => s + row[i], 0) / mu.length / (mean(mu.map(Math.abs)) || 1);
  return { mu, cov, rf, lo, hi, groups, step: 1 / L, gMin: scale * 1e-4, gMax: scale * 1e4 };
}

const point = (ctx, w, gamma) => {
  const ret = portReturn(w, ctx.mu), vol = portVol(w, ctx.cov);
  return { w, gamma, ret, vol, sharpe: (ret - ctx.rf) / vol };
};

/* The efficient frontier from minimum variance to maximum return. */
export function frontier(ctx, steps = 60) {
  const pts = [];
  let warm = null;
  pts.push(point(ctx, (warm = solve(ctx, 0)), 0));
  for (let k = 0; k <= steps; k++) {
    const gamma = ctx.gMin * (ctx.gMax / ctx.gMin) ** (k / steps);
    warm = solve(ctx, gamma, warm);
    pts.push(point(ctx, warm, gamma));
  }
  pts.push(point(ctx, maxReturn(ctx.mu, ctx.lo, ctx.hi, ctx.groups), Infinity));
  // keep the efficient (rising-return) part, drop near-duplicates
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || (p.ret > last.ret + 1e-6 && Math.abs(p.vol - last.vol) + Math.abs(p.ret - last.ret) > 2e-4)) out.push(p);
  }
  return out;
}

export const minVariance = (ctx) => point(ctx, solve(ctx, 0), 0);

/* Tangency portfolio: best Sharpe on the frontier grid, refined by
   golden-section search on log γ between its neighbours. */
export function maxSharpe(ctx, front) {
  let best = 0;
  front.forEach((p, i) => { if (p.sharpe > front[best].sharpe) best = i; });
  const g = (i) => front[Math.max(0, Math.min(front.length - 1, i))].gamma;
  let a = Math.log(Math.max(g(best - 1), ctx.gMin)), b = Math.log(Math.min(g(best + 1), ctx.gMax));
  if (!(b > a)) return front[best];
  const phi = (Math.sqrt(5) - 1) / 2;
  const at = (lg) => point(ctx, solve(ctx, Math.exp(lg), front[best].w), Math.exp(lg));
  let c = b - phi * (b - a), d = a + phi * (b - a), pc = at(c), pd = at(d);
  for (let k = 0; k < 40; k++) {
    if (pc.sharpe > pd.sharpe) { b = d; d = c; pd = pc; c = b - phi * (b - a); pc = at(c); }
    else { a = c; c = d; pc = pd; d = a + phi * (b - a); pd = at(d); }
  }
  const p = pc.sharpe > pd.sharpe ? pc : pd;
  return p.sharpe >= front[best].sharpe ? p : front[best];
}

/* Frontier portfolio whose `metric` ('vol' | 'ret') equals `target`.
   Both rise monotonically with γ, so bisect log γ. Out-of-range targets
   return the nearest end of the frontier with `clamped` set. */
export function frontierTarget(ctx, front, metric, target) {
  const first = front[0], last = front[front.length - 1];
  if (target <= first[metric]) return { ...first, clamped: target < first[metric] - 1e-6 ? 'low' : null };
  if (target >= last[metric]) return { ...last, clamped: target > last[metric] + 1e-6 ? 'high' : null };
  let k = front.findIndex((p) => p[metric] >= target);
  const hiP = front[k], loP = front[k - 1];
  if (!isFinite(hiP.gamma)) {
    // between the last γ point and the exact max-return corner: interpolate weights
    const f = (target - loP[metric]) / (hiP[metric] - loP[metric]);
    return { ...point(ctx, loP.w.map((w, i) => w + f * (hiP.w[i] - w)), NaN), clamped: null };
  }
  let a = Math.log(Math.max(loP.gamma, ctx.gMin)), b = Math.log(hiP.gamma), p = hiP;
  for (let it = 0; it < 50; it++) {
    const m = (a + b) / 2;
    p = point(ctx, solve(ctx, Math.exp(m), p.w), Math.exp(m));
    if (p[metric] < target) a = m; else b = m;
  }
  return { ...p, clamped: null };
}

/* Each sleeve's share of portfolio variance: wᵢ(Σw)ᵢ / wᵀΣw. */
export function riskContributions(w, cov) {
  const Sw = matVec(cov, w);
  const total = dot(w, Sw);
  return w.map((wi, i) => (wi * Sw[i]) / total);
}

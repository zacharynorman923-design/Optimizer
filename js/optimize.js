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

   Limits relative to a class ("Large Value ≤ 30% of Equity") are linear but
   couple a sleeve to its whole class:  lo_r·Σ_g w ≤ w_i ≤ hi_r·Σ_g w. Each is a
   halfspace a·w ≤ 0 through the origin. With any of those present the solver
   switches to ADMM in the OSQP form (Stellato et al. 2020): every limit becomes
   a row of l ≤ Aw ≤ u, one small matrix is factored once, and each iteration is
   a couple of multiplications. projectAll (Dykstra's algorithm) gives the exact
   nearest point when one is needed on its own (e.g. equal weight).
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
export function boundsError(lo, hi, groups = [], rel = [], names = []) {
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
  if (!rel.length) return null;
  const nm = (i) => names[i] || `sleeve ${i + 1}`;
  for (const r of rel) {
    if (r.lo > r.hi + 1e-12) return `${nm(r.i)}'s minimum share of ${r.group} is above its maximum (${pct(r.lo)} > ${pct(r.hi)})`;
  }
  const byGroup = {};
  rel.forEach((r) => { (byGroup[r.group] = byGroup[r.group] || []).push(r); });
  for (const [g, rs] of Object.entries(byGroup)) {
    const sLo = rs.reduce((a, r) => a + r.lo, 0);
    if (sLo > 1 + 1e-9) return `the minimum shares of ${g} add up to ${pct(sLo)}, over 100% of ${g}`;
    if (rs.length === rs[0].members.length) {
      const sHi = rs.reduce((a, r) => a + r.hi, 0);
      if (sHi < 1 - 1e-9) return `the maximum shares of ${g} add up to ${pct(sHi)}, so ${g} can't be filled`;
    }
  }
  // anything else: try to find a portfolio that meets every limit
  const halves = relativeHalfspaces(rel, lo.length);
  const w = projectAll(lo.map(() => 1 / lo.length), lo, hi, groups, halves);
  const worst = Math.max(0, ...halves.map((h) => dot(h.a, w)));
  if (worst > 1e-6) return 'the share-of-class limits conflict with the other limits';
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

/* Halfspaces a·w ≤ 0 for limits relative to a class.
   rel: [{ i, members: [indices in the class, including i], lo, hi }] with lo/hi as shares of the class. */
export function relativeHalfspaces(rel, n) {
  const out = [];
  for (const r of rel) {
    if (r.hi < 1 - 1e-12) {           // w_i − hi·Σ_g w ≤ 0
      const a = new Array(n).fill(0);
      r.members.forEach((j) => { a[j] -= r.hi; });
      a[r.i] += 1;
      out.push({ a, aa: dot(a, a) });
    }
    if (r.lo > 1e-12) {               // lo·Σ_g w − w_i ≤ 0
      const a = new Array(n).fill(0);
      r.members.forEach((j) => { a[j] += r.lo; });
      a[r.i] -= 1;
      out.push({ a, aa: dot(a, a) });
    }
  }
  return out;
}

/* Nearest point to v satisfying the sleeve, class and relative limits (Dykstra's algorithm). */
export function projectAll(v, lo, hi, groups = [], halves = [], maxIter = 20000) {
  if (!halves.length) return project(v, lo, hi, groups);
  const n = v.length;
  let x = v.slice(), p = new Array(n).fill(0), y = x;
  const q = halves.map(() => new Array(n).fill(0));
  for (let it = 0; it < maxIter; it++) {
    y = project(x.map((xi, i) => xi + p[i]), lo, hi, groups);
    p = x.map((xi, i) => xi + p[i] - y[i]);
    if (it === 0 && halves.every((h) => dot(h.a, y) <= 1e-12)) return y; // nothing relative binds
    x = y;
    halves.forEach((h, k) => {
      const z = x.map((xi, i) => xi + q[k][i]);
      const d = dot(h.a, z);
      const xk = d > 0 ? z.map((zi, i) => zi - (d / h.aa) * h.a[i]) : z;
      q[k] = z.map((zi, i) => zi - xk[i]);
      x = xk;
    });
    let gap = 0;
    for (let i = 0; i < n; i++) gap = Math.max(gap, Math.abs(x[i] - y[i]));
    if (gap < 1e-12) break;
  }
  return y; // exactly within the sleeve/class limits; relative limits met to within ~1e-12
}


/* ---------------------------------------------------------------- ADMM (OSQP form)
   min ½wᵀPw + qᵀw  s.t.  l ≤ Aw ≤ u, with P = 2Σ. Used when relative limits are present. */
const RHO = 0.1, SIGMA = 1e-6, ALPHA = 1.6, BIG = 1e20;

function cholesky(M) {
  const n = M.length, L = M.map(() => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = M[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-300)) : s / L[j][j];
    }
  }
  return L;
}
function cholSolve(L, b) {
  const n = b.length, y = new Array(n);
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i][k] * y[k]; y[i] = s / L[i][i]; }
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= L[k][i] * y[k]; y[i] = s / L[i][i]; }
  return y;
}

function buildQP(cov, lo, hi, groups, halves) {
  const n = lo.length, A = [], l = [], u = [], R = [];
  const row = (a, lb, ub, r) => { A.push(a); l.push(lb); u.push(ub); R.push(r); };
  row(new Array(n).fill(1), 1, 1, RHO * 1e3);                       // fully invested (equality)
  for (let i = 0; i < n; i++) { const a = new Array(n).fill(0); a[i] = 1; row(a, lo[i], hi[i], RHO); }
  for (const g of groups) { const a = new Array(n).fill(0); g.members.forEach((i) => { a[i] = 1; }); row(a, g.lo, g.hi, RHO); }
  for (const h of halves) row(h.a, -BIG, 0, RHO);
  const P = cov.map((r) => r.map((x) => 2 * x));
  const M = P.map((r, i) => r.map((x, j) => x + (i === j ? SIGMA : 0) + A.reduce((s, a, k) => s + R[k] * a[i] * a[j], 0)));
  return { A, l, u, R, P, L: cholesky(M), n, m: A.length };
}

function admm(qp, q, warm) {
  const { A, l, u, R, P, L, n, m } = qp;
  let x = warm && warm.x ? warm.x.slice() : new Array(n).fill(1 / n);
  let z = A.map((a) => dot(a, x)).map((v, j) => Math.min(u[j], Math.max(l[j], v)));
  let y = warm && warm.y ? warm.y.slice() : new Array(m).fill(0);
  const qn = Math.max(1, ...q.map(Math.abs));
  for (let it = 0; it < 50000; it++) {
    const rhs = x.map((xi, i) => SIGMA * xi - q[i]);
    for (let j = 0; j < m; j++) { const c = R[j] * z[j] - y[j]; if (c) for (let i = 0; i < n; i++) rhs[i] += A[j][i] * c; }
    const xt = cholSolve(L, rhs);
    for (let j = 0; j < m; j++) {
      const zr = ALPHA * dot(A[j], xt) + (1 - ALPHA) * z[j];
      const zn = Math.min(u[j], Math.max(l[j], zr + y[j] / R[j]));
      y[j] += R[j] * (zr - zn);
      z[j] = zn;
    }
    for (let i = 0; i < n; i++) x[i] = ALPHA * xt[i] + (1 - ALPHA) * x[i];
    if (it % 10 === 9) {
      let prim = 0, dual = 0;
      for (let j = 0; j < m; j++) prim = Math.max(prim, Math.abs(dot(A[j], x) - z[j]));
      const g = P.map((r, i) => dot(r, x) + q[i]);
      for (let j = 0; j < m; j++) if (y[j]) for (let i = 0; i < n; i++) g[i] += A[j][i] * y[j];
      for (const gi of g) dual = Math.max(dual, Math.abs(gi));
      if (prim < 1e-11 && dual < 1e-9 * qn) break;
    }
  }
  return { x, y };
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
  if (ctx.qp) {
    const r = admm(ctx.qp, mu.map((m) => -gamma * m), { x: warm, y: ctx.lastY });
    ctx.lastY = r.y;
    return r.x.map((v, i) => Math.min(hi[i], Math.max(lo[i], v))); // drop ±1e-12 solver noise
  }
  let x = projectAll(warm || mu.map(() => 1 / mu.length), lo, hi, ctx.groups, ctx.halves);
  let y = x.slice(), t = 1;
  for (let k = 0; k < 5000; k++) {
    const g = matVec(cov, y).map((gi, i) => 2 * gi - gamma * mu[i]);
    const xNew = projectAll(y.map((yi, i) => yi - step * g[i]), lo, hi, ctx.groups, ctx.halves);
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

/* Highest-return portfolio under every limit. Without relative limits the greedy fill is exact.
   With them, project a point far along μ: argmin ‖w − Kμ‖² = argmax μ·w (ties: smallest ‖w‖).
   K is "far enough" once the answer stops changing (here 1,000× the largest μ); much farther
   and Dykstra needs far more iterations to converge. */
export function maxReturnAll(ctx) {
  if (!ctx.halves.length) return maxReturn(ctx.mu, ctx.lo, ctx.hi, ctx.groups);
  const K = 1e3 / (Math.max(...ctx.mu.map(Math.abs)) || 1);
  return projectAll(ctx.mu.map((m) => m * K), ctx.lo, ctx.hi, ctx.groups, ctx.halves, 200000);
}

/* Everything the solvers share for one set of inputs. */
export function context(mu, cov, rf, lo, hi, groups = [], rel = []) {
  const L = 2 * maxEigen(cov) || 1;
  const scale = cov.reduce((s, row, i) => s + row[i], 0) / mu.length / (mean(mu.map(Math.abs)) || 1);
  const halves = relativeHalfspaces(rel, mu.length);
  const qp = halves.length ? buildQP(cov, lo, hi, groups, halves) : null;
  return { mu, cov, rf, lo, hi, groups, halves, qp, step: 1 / L, gMin: scale * 1e-4, gMax: scale * 1e4 };
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
  pts.push(point(ctx, maxReturnAll(ctx), Infinity));
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

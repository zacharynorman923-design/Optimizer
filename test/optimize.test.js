import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as O from '../js/optimize.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const sum = (w) => w.reduce((a, b) => a + b, 0);

// Small 2x2/3x3 linear algebra for closed-form checks.
function inv3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [
    [A, -(b * i - c * h), b * f - c * e],
    [B, a * i - c * g, -(a * f - c * d)],
    [C, -(a * h - b * g), a * e - b * d],
  ].map((row) => row.map((x) => x / det));
}
const mv = (M, v) => M.map((r) => r.reduce((s, x, j) => s + x * v[j], 0));

const mu = [0.08, 0.10, 0.12];
const cov = [
  [0.04, 0.006, 0.004],
  [0.006, 0.0625, 0.01],
  [0.004, 0.01, 0.09],
];
const rf = 0.02;
const open = [0, 0, 0], full = [1, 1, 1];

test('projection lands on the feasible set and is the identity there', () => {
  const p = O.project([0.9, 0.5, -0.2], [0, 0.1, 0], [0.6, 1, 1]);
  near(sum(p), 1);
  assert.ok(p[0] <= 0.6 + 1e-12 && p[1] >= 0.1 - 1e-12 && p[2] >= -1e-12);
  const inside = [0.2, 0.3, 0.5];
  O.project(inside, open, full).forEach((x, i) => near(x, inside[i]));
});

test('min variance matches the closed form Σ⁻¹1 / 1ᵀΣ⁻¹1 when no limit binds', () => {
  const ctx = O.context(mu, cov, rf, open, full);
  const x = mv(inv3(cov), [1, 1, 1]);
  const exact = x.map((v) => v / sum(x));
  O.minVariance(ctx).w.forEach((w, i) => near(w, exact[i], 1e-6));
});

test('max Sharpe matches the tangency portfolio Σ⁻¹(μ − rf) when no limit binds', () => {
  const ctx = O.context(mu, cov, rf, open, full);
  const x = mv(inv3(cov), mu.map((m) => m - rf));
  const exact = x.map((v) => v / sum(x));
  const p = O.maxSharpe(ctx, O.frontier(ctx));
  p.w.forEach((w, i) => near(w, exact[i], 2e-4));
  near(p.sharpe, O.portSharpe(exact, mu, cov, rf), 1e-7);
});

test('limits are respected and bind where they should', () => {
  const lo = [0.5, 0, 0], hi = [1, 1, 0.1];
  const ctx = O.context(mu, cov, rf, lo, hi);
  for (const p of [O.minVariance(ctx), O.maxSharpe(ctx, O.frontier(ctx))]) {
    near(sum(p.w), 1);
    p.w.forEach((w, i) => assert.ok(w >= lo[i] - 1e-9 && w <= hi[i] + 1e-9, `w${i}=${w}`));
  }
  assert.deepEqual(O.maxReturn(mu, lo, hi).map((w) => +w.toFixed(9)), [0.5, 0.4, 0.1]);
});

test('frontier rises from min variance to max return, and targets are hit', () => {
  const ctx = O.context(mu, cov, rf, open, full);
  const f = O.frontier(ctx);
  for (let i = 1; i < f.length; i++) assert.ok(f[i].ret > f[i - 1].ret && f[i].vol >= f[i - 1].vol - 1e-9);
  near(f.at(-1).ret, 0.12);
  near(O.frontierTarget(ctx, f, 'vol', 0.2).vol, 0.2, 1e-6);
  near(O.frontierTarget(ctx, f, 'ret', 0.1).ret, 0.1, 1e-6);
  assert.equal(O.frontierTarget(ctx, f, 'ret', 0.5).clamped, 'high');
  assert.equal(O.frontierTarget(ctx, f, 'vol', 0.01).clamped, 'low');
});

test('impossible limits are explained', () => {
  assert.match(O.boundsError([0.6, 0.6, 0], full), /minimums add up to 120%/);
  assert.match(O.boundsError(open, [0.3, 0.3, 0.3]), /maximums add up to 90%/);
  assert.equal(O.boundsError(open, full), null);
});

test('risk contributions sum to 1', () => {
  near(sum(O.riskContributions([0.2, 0.3, 0.5], cov)), 1);
});

// ---------------------------------------------------------------- asset-class limits
// Deterministic pseudo-random numbers so failures reproduce.
function rng(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const feasible = (w, lo, hi, groups) => Math.abs(sum(w) - 1) < 1e-8
  && w.every((x, i) => x >= lo[i] - 1e-9 && x <= hi[i] + 1e-9)
  && groups.every((g) => { const t = g.members.reduce((s, i) => s + w[i], 0); return t >= g.lo - 1e-8 && t <= g.hi + 1e-8; });

// 7 sleeves: 3 equity, 2 bonds, 1 alt, 1 unclassified
const LO7 = [0, 0, 0.05, 0, 0, 0, 0], HI7 = [0.5, 0.5, 0.5, 0.4, 0.4, 0.3, 1];
const G7 = [
  { name: 'Equity', members: [0, 1, 2], lo: 0.4, hi: 0.6 },
  { name: 'Fixed income', members: [3, 4], lo: 0.2, hi: 0.5 },
  { name: 'Alts', members: [5], lo: 0, hi: 0.1 },
];

test('class-limited projection is feasible and is the nearest point (variational inequality)', () => {
  const r = rng(7);
  for (let trial = 0; trial < 200; trial++) {
    const v = LO7.map(() => r() * 2 - 0.5);
    const p = O.project(v, LO7, HI7, G7);
    assert.ok(feasible(p, LO7, HI7, G7), `infeasible ${p}`);
    // (v − p)·(q − p) ≤ 0 for every feasible q
    for (let k = 0; k < 30; k++) {
      const q = O.project(LO7.map(() => r() * 2 - 0.5), LO7, HI7, G7);
      assert.ok(dot(v.map((x, i) => x - p[i]), q.map((x, i) => x - p[i])) <= 1e-7);
    }
  }
});

test('class-limited max return beats every feasible portfolio', () => {
  const r = rng(11);
  for (let trial = 0; trial < 50; trial++) {
    const m = LO7.map(() => r() * 0.2);
    const w = O.maxReturn(m, LO7, HI7, G7);
    assert.ok(feasible(w, LO7, HI7, G7), `infeasible ${w}`);
    for (let k = 0; k < 200; k++) {
      const q = O.project(LO7.map(() => r() * 2 - 0.5), LO7, HI7, G7);
      assert.ok(dot(m, q) <= dot(m, w) + 1e-9);
    }
  }
});

test('optimizer results respect class limits', () => {
  const mu4 = [0.10, 0.06, 0.08, 0.03], cov4 = [
    [0.04, 0.01, 0.012, 0.001], [0.01, 0.03, 0.008, 0.0], [0.012, 0.008, 0.05, 0.002], [0.001, 0.0, 0.002, 0.004]];
  const lo4 = [0, 0, 0, 0], hi4 = [1, 1, 1, 1];
  const g4 = [{ name: 'Equity', members: [0, 2], lo: 0.3, hi: 0.5 }, { name: 'Fixed income', members: [1, 3], lo: 0.5, hi: 0.7 }];
  const ctx = O.context(mu4, cov4, 0.02, lo4, hi4, g4);
  const f = O.frontier(ctx);
  for (const p of [...f, O.minVariance(ctx), O.maxSharpe(ctx, f), O.frontierTarget(ctx, f, 'vol', 0.12)]) {
    assert.ok(feasible(p.w, lo4, hi4, g4), `infeasible ${p.w}`);
  }
});

test('impossible class limits are explained', () => {
  const g = (lo, hi) => [{ name: 'Alts', members: [2], lo, hi }];
  assert.match(O.boundsError([0, 0, 0], [1, 1, 0.1], g(0.2, 0.5)), /Alts sleeve maximums add up to 10%, below the Alts minimum of 20%/);
  assert.match(O.boundsError([0, 0, 0.3], [1, 1, 1], g(0, 0.2)), /Alts sleeve minimums add up to 30%, above the Alts maximum of 20%/);
  assert.match(O.boundsError([0, 0, 0], [1, 1, 1], [{ name: 'Alts', members: [], lo: 0.1, hi: 1 }]), /no Alts sleeves are ticked/);
  assert.match(O.boundsError([0, 0, 0], [1, 1, 1], [{ name: 'Equity', members: [0], lo: 0.7, hi: 1 }, { name: 'Alts', members: [2], lo: 0.4, hi: 1 }]), /minimums add up to 110%/);
  assert.equal(O.boundsError([0, 0, 0], [1, 1, 1], g(0, 0.3)), null);
});

// ------------------------------------------------- limits as a share of the class
// Equity = sleeves 0,1,2: sleeve 0 at most 30% of Equity, sleeve 1 at least 20% of Equity.
// Fixed income = 3,4: sleeve 4 between 40% and 60% of Fixed income.
const REL7 = [
  { i: 0, group: 'Equity', members: [0, 1, 2], lo: 0, hi: 0.3 },
  { i: 1, group: 'Equity', members: [0, 1, 2], lo: 0.2, hi: 1 },
  { i: 4, group: 'Fixed income', members: [3, 4], lo: 0.4, hi: 0.6 },
];
const H7 = O.relativeHalfspaces(REL7, 7);
const relOk = (w) => REL7.every((r) => {
  const t = r.members.reduce((s, j) => s + w[j], 0);
  return w[r.i] <= r.hi * t + 1e-8 && w[r.i] >= r.lo * t - 1e-8;
});

test('share-of-class projection is feasible and is the nearest point', () => {
  const r = rng(23);
  for (let trial = 0; trial < 100; trial++) {
    const v = LO7.map(() => r() * 2 - 0.5);
    const p = O.projectAll(v, LO7, HI7, G7, H7);
    assert.ok(feasible(p, LO7, HI7, G7) && relOk(p), `infeasible ${p}`);
    for (let k = 0; k < 20; k++) {
      const q = O.projectAll(LO7.map(() => r() * 2 - 0.5), LO7, HI7, G7, H7);
      assert.ok(dot(v.map((x, i) => x - p[i]), q.map((x, i) => x - p[i])) <= 1e-6);
    }
  }
});

test('share-of-class max return beats every feasible portfolio', () => {
  const r = rng(29);
  const mu7 = LO7.map(() => 0.1), cov7 = LO7.map((_, i) => LO7.map((__, j) => (i === j ? 0.04 : 0.005)));
  for (let trial = 0; trial < 30; trial++) {
    const m = LO7.map(() => r() * 0.2);
    const ctx = O.context(m, cov7, 0.02, LO7, HI7, G7, REL7);
    const w = O.maxReturnAll(ctx);
    assert.ok(feasible(w, LO7, HI7, G7) && relOk(w), `infeasible ${w}`);
    for (let k = 0; k < 100; k++) {
      const q = O.projectAll(LO7.map(() => r() * 2 - 0.5), LO7, HI7, G7, H7);
      assert.ok(dot(m, q) <= dot(m, w) + 1e-7);
    }
  }
});

test('optimizer results respect share-of-class limits', () => {
  const m = [0.12, 0.08, 0.10, 0.04, 0.05, 0.07, 0.03];
  const cov7 = LO7.map((_, i) => LO7.map((__, j) => (i === j ? 0.01 + 0.01 * i : 0.004)));
  const ctx = O.context(m, cov7, 0.02, LO7, HI7, G7, REL7);
  const f = O.frontier(ctx);
  for (const p of [...f, O.minVariance(ctx), O.maxSharpe(ctx, f), O.frontierTarget(ctx, f, 'vol', 0.11)]) {
    assert.ok(feasible(p.w, LO7, HI7, G7) && relOk(p.w), `infeasible ${p.w}`);
  }
});

test('impossible share-of-class limits are explained', () => {
  const g = [{ name: 'Equity', members: [0, 1], lo: 0, hi: 1 }];
  const names = ['US LV', 'US LG', 'Cash'];
  const rel = (a, b) => [{ i: 0, group: 'Equity', members: [0, 1], ...a }, { i: 1, group: 'Equity', members: [0, 1], ...b }];
  assert.match(O.boundsError([0, 0, 0], [1, 1, 1], g, rel({ lo: 0.6, hi: 1 }, { lo: 0.5, hi: 1 }), names), /minimum shares of Equity add up to 110%/);
  assert.match(O.boundsError([0, 0, 0], [1, 1, 1], g, rel({ lo: 0.5, hi: 0.4 }, { lo: 0, hi: 1 }), names), /US LV's minimum share of Equity is above its maximum/);
  assert.equal(O.boundsError([0, 0, 0], [1, 1, 1], g, rel({ lo: 0, hi: 0.3 }, { lo: 0, hi: 1 }), names), null);
});

// ------------------------------------------------- max Sharpe with a vol cap / return floor
test('max Sharpe within limits matches a brute-force search along the frontier', () => {
  const ctx = O.context(mu, cov, rf, open, full);
  const f = O.frontier(ctx, 200);
  const free = O.maxSharpe(ctx, f);
  // no limits, or limits that don't bind: the tangency portfolio
  near(O.maxSharpeWithin(ctx, f, {}).sharpe, free.sharpe, 1e-12);
  assert.equal(O.maxSharpeWithin(ctx, f, { maxVol: free.vol + 0.05, minRet: free.ret - 0.01 }).binding, null);
  const capBelow = (f[0].vol + free.vol) / 2; // between min-vol and tangency volatility
  for (const lim of [{ maxVol: capBelow }, { minRet: free.ret + 0.01 }, { maxVol: 0.2, minRet: 0.1 }]) {
    const p = O.maxSharpeWithin(ctx, f, lim);
    assert.ok(!p.infeasible);
    if (lim.maxVol != null) assert.ok(p.vol <= lim.maxVol + 1e-6, `vol ${p.vol}`);
    if (lim.minRet != null) assert.ok(p.ret >= lim.minRet - 1e-6, `ret ${p.ret}`);
    // nothing on a dense frontier that meets the limits does better
    const ok = f.filter((q) => (lim.maxVol == null || q.vol <= lim.maxVol) && (lim.minRet == null || q.ret >= lim.minRet));
    for (const q of ok) assert.ok(q.sharpe <= p.sharpe + 1e-6);
  }
  assert.equal(O.maxSharpeWithin(ctx, f, { maxVol: capBelow }).binding, 'maxVol');
  assert.equal(O.maxSharpeWithin(ctx, f, { minRet: free.ret + 0.01 }).binding, 'minRet');
});

test('impossible vol cap / return floor are explained', () => {
  const ctx = O.context(mu, cov, rf, open, full);
  const f = O.frontier(ctx);
  assert.match(O.maxSharpeWithin(ctx, f, { maxVol: 0.01 }).infeasible, /lowest volatility available/);
  assert.match(O.maxSharpeWithin(ctx, f, { minRet: 0.5 }).infeasible, /highest return available/);
  assert.match(O.maxSharpeWithin(ctx, f, { maxVol: 0.16, minRet: 0.115 }).infeasible, /takes .* volatility, above the 16.0% cap/);
});

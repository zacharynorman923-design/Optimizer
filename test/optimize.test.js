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

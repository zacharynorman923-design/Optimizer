import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/stats.js';
import * as O from '../js/optimize.js';
import { solveObjective, walkForward, turnover } from '../js/objectives.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
function rng(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }

// 20 years of made-up monthly data for 4 sleeves, a T-bill and a benchmark
function history(seed = 3, years = 20) {
  const r = rng(seed), dates = [], matrix = [], rf = [], benchR = [];
  for (let y = 2000; y < 2000 + years; y++) for (let m = 1; m <= 12; m++) {
    dates.push(`${y}-${String(m).padStart(2, '0')}-28`);
    const mk = (r() - 0.45) * 0.1;
    matrix.push([mk + (r() - 0.5) * 0.02, 0.6 * mk + (r() - 0.45) * 0.04, (r() - 0.48) * 0.02, 0.002 + (r() - 0.5) * 0.004]);
    rf.push(0.002); benchR.push(mk);
  }
  return { dates, matrix, rf, benchR };
}
const drain = (gen) => { let x = gen.next(); while (!x.done) x = gen.next(); return x.value; };
const open4 = { lo: [0, 0, 0, 0], hi: [1, 1, 1, 1] };

test('solveObjective: max Sharpe with wide limits equals the plain tangency portfolio', () => {
  const h = history();
  const res = solveObjective({ objective: 'maxSharpe', opts: { sharpeMaxVol: 99, sharpeMinRet: -99 }, ...h, ...open4 });
  const mo = O.moments(h.matrix, h.rf), ctx = O.context(mo.mu, mo.cov, mo.rf, open4.lo, open4.hi);
  const direct = O.maxSharpe(ctx, O.frontier(ctx));
  near(res.chosen.sharpe, direct.sharpe, 1e-9);
});

test('solveObjective: blank max-Sharpe limits follow the benchmark (vol cap, CAGR + 1% floor)', () => {
  const h = history();
  const res = solveObjective({ objective: 'maxSharpe', ...h, ...open4 });
  near(res.limits.maxVol, S.stdev(h.benchR) * Math.sqrt(12));
  near(res.limits.minRet, S.metrics(h.benchR, h.rf).cagr + 0.01);
  const t = solveObjective({ objective: 'targetVol', ...h, ...open4 });
  near(t.limits.maxVol, S.stdev(h.benchR) * Math.sqrt(12));
});

test('solveObjective: custom weights are scaled to 100% and ignore limits', () => {
  const h = history();
  const res = solveObjective({ objective: 'custom', opts: { custom: [30, 30, 0, 0] }, ...h, lo: [0, 0, 0.5, 0], hi: [1, 1, 1, 1], limitsOk: false });
  res.chosen.w.forEach((w, i) => near(w, [0.5, 0.5, 0, 0][i]));
  assert.match(res.msg, /add up to 60.0%/);
});

test('walk-forward: re-optimizes each December and tests only later months', () => {
  const h = history();
  const wf = drain(walkForward({ objective: 'minVar', matrix: h.matrix, rf: h.rf, benchR: h.benchR, ...open4 }, { dates: h.dates, minTrainMonths: 120 }));
  assert.equal(wf.steps.length, 10);               // Decembers of 2009..2018
  assert.equal(wf.steps[0].trainEnd, '2009-12-28');
  assert.equal(wf.dates[0], '2010-01-28');
  assert.equal(wf.returns.length, 120);
  assert.equal(wf.firstIndex, 120);
});

test('walk-forward never looks ahead: changing later data leaves earlier decisions unchanged', () => {
  const h = history(), g = history();
  // wreck everything from 2015 on in the second copy
  g.matrix = g.matrix.map((row, t) => (g.dates[t] >= '2015' ? row.map((x) => -3 * x + 0.01) : row));
  const run = (d) => drain(walkForward({ objective: 'maxSharpe', matrix: d.matrix, rf: d.rf, benchR: d.benchR, ...open4 }, { dates: d.dates, minTrainMonths: 120 }));
  const a = run(h), b = run(g);
  for (let k = 0; k < a.steps.length; k++) {
    if (a.steps[k].trainEnd < '2015') a.steps[k].w.forEach((w, i) => near(w, b.steps[k].w[i], 1e-12));
  }
  // and the tested returns before 2015 are identical too
  a.dates.forEach((d, t) => { if (d < '2015') near(a.returns[t], b.returns[t], 1e-12); });
  assert.ok(a.steps.some((s, k) => s.trainEnd >= '2015' && s.w.some((w, i) => Math.abs(w - b.steps[k].w[i]) > 1e-6)));
});

test('walk-forward with fixed custom weights equals a plain backtest of them; turnover is zero', () => {
  const h = history();
  const base = { objective: 'custom', opts: { custom: [50, 20, 20, 10] }, matrix: h.matrix, rf: h.rf, benchR: h.benchR, ...open4, limitsOk: false };
  const wf = drain(walkForward(base, { dates: h.dates, minTrainMonths: 120 }));
  const plain = S.backtest(h.dates.slice(120), h.matrix.slice(120), [0.5, 0.2, 0.2, 0.1], 'annual');
  wf.returns.forEach((r, t) => near(r, plain[t], 1e-12));
  near(turnover(wf.steps), 0);
});

test('walk-forward needs enough history', () => {
  const h = history(3, 5);
  const wf = drain(walkForward({ objective: 'minVar', matrix: h.matrix, rf: h.rf, ...open4 }, { dates: h.dates, minTrainMonths: 120 }));
  assert.equal(wf.steps.length, 0);
  assert.equal(wf.firstIndex, -1);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../js/stats.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test('wealth, drawdowns and worst 12 months on a known path', () => {
  const r = [0.1, -0.5, 0.2];
  const w = S.wealth(r);
  near(w[3], 1.1 * 0.5 * 1.2);
  near(Math.min(...S.drawdowns(w)), -0.5);
  near(S.worstRolling([...Array(12).fill(0.01), -0.2], 12), 1.01 ** 11 * 0.8 - 1);
});

test('max drawdown counts the starting value as a peak', () => {
  near(S.metrics([-0.1, 0.05], [0, 0]).maxDD, -0.1);
});

test('metrics: CAGR, vol and Sharpe for a constant series', () => {
  const r = Array(24).fill(0.01), rf = Array(24).fill(0.002);
  const m = S.metrics(r, rf);
  near(m.cagr, 1.01 ** 12 - 1);
  near(m.vol, 0, 1e-12);
  assert.ok(Number.isNaN(m.sharpe)); // zero excess volatility
});

test('calendar years compound complete years and flag the trailing partial year', () => {
  const dates = [], r = [];
  for (let y = 2000; y <= 2002; y++) for (let m = 1; m <= 12; m++) {
    if (y === 2000 && m < 7) continue; // partial first year: dropped
    if (y === 2002 && m > 3) continue; // partial last year: kept as YTD
    dates.push(`${y}-${String(m).padStart(2, '0')}-28`); r.push(0.01);
  }
  const cy = S.calendarYears(dates, r);
  assert.deepEqual(cy.map((c) => c.year), [2001, 2002]);
  near(cy[0].ret, 1.01 ** 12 - 1);
  assert.equal(cy[1].partial, true);
  near(cy[1].ret, 1.01 ** 3 - 1);
});

test('backtest: monthly rebalance is the weighted average every month', () => {
  const dates = ['2000-01-31', '2000-02-29'];
  const M = [[0.1, -0.1], [0.05, 0.0]];
  const out = S.backtest(dates, M, [0.5, 0.5], 'monthly');
  near(out[0], 0); near(out[1], 0.025);
});

test('backtest: without rebalancing, weights drift with returns', () => {
  const dates = ['2000-01-31', '2000-02-29'];
  const M = [[1.0, 0.0], [0.1, 0.0]]; // sleeve 0 doubles, then +10%
  const out = S.backtest(dates, M, [0.5, 0.5], 'never');
  near(out[0], 0.5);
  near(out[1], (2 / 3) * 0.1); // 2:1 after month one
});

test('backtest: annual rebalance resets only at December close', () => {
  const dates = ['2000-11-30', '2000-12-31', '2001-01-31'];
  const M = [[1.0, 0.0], [0.0, 0.0], [0.1, 0.0]];
  const out = S.backtest(dates, M, [0.5, 0.5], 'annual');
  near(out[2], 0.05); // back to 50/50 for January
});

test('correlation of a series with itself and its negative', () => {
  const a = [0.01, 0.03, -0.02, 0.05];
  const C = S.correlation(a.map((x) => [x, -x, 2 * x]));
  near(C[0][1], -1); near(C[0][2], 1); near(C[1][1], 1);
});

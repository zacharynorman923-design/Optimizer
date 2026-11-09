/* =========================================================================
   Objectives: turn a block of history plus the user's settings into a
   portfolio. Pure functions only — no DOM, no storage — so the same code
   runs for the main result, for each step of the walk-forward test, and in
   the unit tests (see test/objectives.test.js).
   ========================================================================= */

import * as S from './stats.js';
import * as O from './optimize.js';

const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;

/* Solve one objective on one block of history.

   matrix[t][i]  monthly returns of the ticked sleeves; rf[t] the T-bill; benchR[t] the benchmark
   lo, hi, groups, rel   the limits (see optimize.js); limitsOk=false ignores them (custom weights)
   opts          { target, sharpeMaxVol, sharpeMinRet, alphaMinBeta, alphaMaxBeta, blConfidence,
                   blDelta } in the units the user types (percent, or beta), null = default;
                 custom: the user's own weights per sleeve
   refMix        Black-Litterman reference weights per sleeve (need not sum to 1)

   Returns { chosen: {w, ret, vol, sharpe}, msg, mo, ctx, ab, bench, front(), sharpeP(),
             limits: the vol cap / return floor actually used, auto: the benchmark defaults,
             bl: Black-Litterman returns }. */
export function solveObjective({
  objective, opts = {}, matrix, rf, benchR = null, lo, hi, groups = [], rel = [],
  limitsOk = true, refMix = null, benchLabel = 'the benchmark', steps = 60,
}) {
  const n = lo.length;
  const mo = O.moments(matrix, rf);
  const L = limitsOk ? { lo, hi, groups, rel } : { lo: lo.map(() => 0), hi: hi.map(() => 1), groups: [], rel: [] };
  const ctx = O.context(mo.mu, mo.cov, mo.rf, L.lo, L.hi, L.groups, L.rel);
  let frontCache = null, sharpeCache = null; // only built when an objective (or the chart) needs them
  const front = () => (frontCache || (frontCache = O.frontier(ctx, steps)));
  const sharpeP = () => (sharpeCache || (sharpeCache = O.maxSharpe(ctx, front())));
  const evalW = (w) => {
    const ret = O.portReturn(w, mo.mu), vol = O.portVol(w, mo.cov);
    return { w, ret, vol, sharpe: (ret - mo.rf) / vol };
  };

  // the benchmark over the same months: annualized mean and volatility, CAGR, and sleeve alpha/beta
  const benchOk = !!benchR && benchR.every((v) => v !== null && v !== undefined);
  const bench = benchOk
    ? { ret: S.mean(benchR) * 12, vol: S.stdev(benchR) * Math.sqrt(12), cagr: S.metrics(benchR, rf).cagr } : null;
  const ab = benchOk ? O.alphaBeta(matrix, benchR, rf) : null;

  const out = { mo, ctx, ab, bench, front, sharpeP, msg: '', limits: { maxVol: null, minRet: null }, auto: null, bl: null };
  const num = (v) => (v !== null && v !== undefined && Number.isFinite(v) ? v : null);

  switch (objective) {
    case 'blackLitterman': {
      // reference portfolio = the benchmark's mix, over the ticked sleeves it uses
      let wRef = refMix ? refMix.slice() : new Array(n).fill(0);
      const covered = wRef.reduce((a, b) => a + b, 0);
      let refNote = `the ${benchLabel} mix`;
      if (covered <= 1e-9) { wRef = wRef.map(() => 1 / n); refNote = `equal weight (the ${benchLabel} mix uses sleeves that aren't ticked)`; }
      else if (covered < 0.999) { wRef = wRef.map((w) => w / covered); refNote = `the ${benchLabel} mix, rescaled to the ticked sleeves it uses`; }
      const conf = (num(opts.blConfidence) ?? 50) / 100;
      const delta = num(opts.blDelta) ?? 2.5;
      const blr = O.blackLitterman({ cov: mo.cov, mu: mo.mu, rf: mo.rf, wRef, delta, confidence: conf });
      const bctx = O.context(blr.posterior, mo.cov, mo.rf, L.lo, L.hi, L.groups, L.rel);
      const bp = O.maxSharpe(bctx, O.frontier(bctx, steps));
      out.chosen = evalW(bp.w);
      out.bl = blr;
      out.msg = `Black-Litterman: max Sharpe on returns blended ${Math.round(conf * 100)}% toward history from the equilibrium of ${refNote} (δ ${delta}). `
        + `Expected return on the blended view: ${pct(O.portReturn(bp.w, blr.posterior))}; the figures above use history.`;
      break;
    }
    case 'maxAlpha': {
      const minBeta = num(opts.alphaMinBeta), maxBeta = num(opts.alphaMaxBeta);
      const r = ab ? O.maxAlpha({ alpha: ab.alpha, beta: ab.beta, cov: mo.cov, ...L, minBeta, maxBeta })
        : { infeasible: 'the benchmark has no data for part of this window', range: [NaN, NaN] };
      if (r.infeasible) {
        out.msg = `No portfolio within these limits has that beta to ${benchLabel}: ${r.infeasible}`
          + (Number.isFinite(r.range[0]) ? ` (available: ${r.range[0].toFixed(2)} to ${r.range[1].toFixed(2)})` : '') + '. Showing max Sharpe instead.';
        out.chosen = sharpeP();
      } else {
        out.chosen = evalW(r.w);
        const top2 = r.w.slice().sort((a, b) => b - a).slice(0, 2).reduce((a, b) => a + b, 0);
        if (minBeta == null && maxBeta == null) out.msg = 'With no beta limit, max alpha just piles into the highest-alpha sleeves. Set a beta range to make it meaningful.';
        else if (top2 > 0.95) out.msg = `Alpha and beta both scale linearly with the weights, so the best answer sits in one or two sleeves (here ${pct(top2, 0)}). Add sleeve or asset-class limits to spread it out.`;
      }
      break;
    }
    case 'minVar': out.chosen = front()[0]; break;
    case 'targetVol':
    case 'targetRet': {
      const metric = objective === 'targetVol' ? 'vol' : 'ret';
      // a blank box follows the benchmark: its volatility, or its CAGR (as in the Benchmarks table)
      const auto = bench ? (metric === 'vol' ? bench.vol : bench.cagr) : sharpeP()[metric];
      const target = num(opts.target) != null ? opts.target / 100 : auto;
      out.auto = { metric, target: auto, fromBench: !!bench };
      out.limits = metric === 'vol' ? { maxVol: target, minRet: null } : { maxVol: null, minRet: target };
      out.chosen = O.frontierTarget(ctx, front(), metric, target);
      const what = metric === 'vol' ? 'volatility' : 'return';
      if (out.chosen.clamped === 'low') out.msg = `No portfolio within these limits has ${what} as low as ${pct(target)}. Showing the lowest available: ${pct(out.chosen[metric])}.`;
      if (out.chosen.clamped === 'high') out.msg = `No portfolio within these limits reaches ${pct(target)} ${what}. Showing the highest available: ${pct(out.chosen[metric])}.`;
      break;
    }
    case 'equal':
      out.chosen = evalW(O.projectAll(lo.map(() => 1 / n), L.lo, L.hi, L.groups, O.relativeHalfspaces(L.rel, n)));
      break;
    case 'custom': {
      const raw = (opts.custom || []).map((x) => num(x) ?? 0);
      const tot = raw.reduce((a, b) => a + b, 0);
      const w = tot ? raw.map((x) => x / tot) : lo.map(() => 1 / n);
      out.chosen = evalW(w);
      if (tot && Math.abs(tot - 100) > 0.05) out.msg = `Your weights add up to ${tot.toFixed(1)}%, so they've been scaled to 100%.`;
      if (!tot) out.msg = 'No weights entered yet, so this shows equal weight. Type weights in the right-hand column of the sleeve list.';
      const outside = groups.filter((g) => { const t = g.members.reduce((a, i) => a + w[i], 0); return t < g.lo - 1e-6 || t > g.hi + 1e-6; });
      if (tot && outside.length) out.msg += `${out.msg ? ' ' : ''}Your weights are outside the ${outside.map((g) => g.name).join(' and ')} limit${outside.length > 1 ? 's' : ''} (limits don't apply to your own weights).`;
      break;
    }
    default: { // maxSharpe
      // blank boxes follow the benchmark: its volatility as the cap, its CAGR + 1% as the floor
      const auto = bench ? { maxVol: bench.vol, minRet: bench.cagr + 0.01 } : { maxVol: null, minRet: null };
      const lim = {
        maxVol: num(opts.sharpeMaxVol) != null ? opts.sharpeMaxVol / 100 : auto.maxVol,
        minRet: num(opts.sharpeMinRet) != null ? opts.sharpeMinRet / 100 : auto.minRet,
      };
      out.auto = { ...auto, fromBench: !!bench };
      out.limits = lim;
      out.chosen = O.maxSharpeWithin(ctx, front(), lim);
      const sp = sharpeP();
      const free = `Unconstrained max Sharpe: ${pct(sp.ret)} return, ${pct(sp.vol)} volatility, Sharpe ${sp.sharpe.toFixed(2)}.`;
      if (out.chosen.infeasible) out.msg = `No portfolio meets ${lim.maxVol != null && lim.minRet != null ? 'both limits' : 'that limit'}: ${out.chosen.infeasible}. Showing the closest one.`;
      else if (out.chosen.binding === 'maxVol') out.msg = `Volatility capped at ${pct(lim.maxVol)}, so this is the best Sharpe at or under the cap. ${free}`;
      else if (out.chosen.binding === 'minRet') out.msg = `Return floor of ${pct(lim.minRet)}, so this is the best Sharpe that earns at least that. ${free}`;
    }
  }
  return out;
}

/* Walk-forward (out-of-sample) test.

   At each December close with at least `minTrainMonths` of history, solve the objective using
   ONLY the months up to and including that December (an expanding window from the start), then
   hold those weights for the following calendar year. The stitched monthly returns are what the
   rule would have earned without seeing the future.

   A generator, so the page can show progress and stay responsive: each step yields
   { done, total }, and the generator returns
   { dates, returns, steps: [{ trainEnd, w }], firstIndex } (firstIndex = first tested month). */
export function* walkForward(base, { dates, minTrainMonths = 120, rebalance = 'annual', steps = 30 }) {
  const cuts = [];
  dates.forEach((d, t) => { if (S.monthOf(d) === 12 && t + 1 >= minTrainMonths && t < dates.length - 1) cuts.push(t); });
  const out = { dates: [], returns: [], steps: [], firstIndex: cuts.length ? cuts[0] + 1 : -1 };
  for (let k = 0; k < cuts.length; k++) {
    const t = cuts[k], end = k + 1 < cuts.length ? cuts[k + 1] : dates.length - 1;
    const res = solveObjective({
      ...base, steps,
      matrix: base.matrix.slice(0, t + 1), rf: base.rf.slice(0, t + 1),
      benchR: base.benchR ? base.benchR.slice(0, t + 1) : null,
    });
    const w = res.chosen.w;
    const td = dates.slice(t + 1, end + 1);
    const r = S.backtest(td, base.matrix.slice(t + 1, end + 1), w, rebalance);
    out.dates.push(...td); out.returns.push(...r);
    out.steps.push({ trainEnd: dates[t], w });
    yield { done: k + 1, total: cuts.length };
  }
  return out;
}

/* Average one-way turnover between consecutive walk-forward weight sets (0.10 = 10% a year). */
export function turnover(steps) {
  if (steps.length < 2) return 0;
  let s = 0;
  for (let k = 1; k < steps.length; k++) s += steps[k].w.reduce((a, w, i) => a + Math.abs(w - steps[k - 1].w[i]), 0) / 2;
  return s / (steps.length - 1);
}

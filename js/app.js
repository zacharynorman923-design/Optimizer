/* =========================================================================
   Optimizer — state, rendering, interactions, persistence.
   The math lives in stats.js / optimize.js; this file only wires it to the page.
   ========================================================================= */

import { loadBundle, coverage, commonWindow, slice, column, SHORT } from './data.js';

const BENCH_IDS = ['BM_FI100', 'BM_20_80', 'BM_40_60', 'BM_60_40', 'BM_80_20', 'BM_EQ100', 'BM_World'];
import * as S from './stats.js';
import * as O from './optimize.js';
import { solveObjective, walkForward, turnover } from './objectives.js';
import * as C from './charts.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = C.pct;
const ym = (iso) => iso.slice(0, 7);

const KEY = 'optimizer-state-v1', THEME_KEY = 'optimizer-theme';
// The app's one version number, shown in the data line so it's easy to tell which version a
// phone is running. (sw.js no longer carries a version of its own.)
const APP_VERSION = 'v23';
const US_1926 = ['US_LargeCap', 'US_SmallValue', 'US_SmallGrowth', 'US_LargeValue', 'US_LargeGrowth', 'Cash'];
const CLASSES = ['Equity', 'Fixed income', 'Alts'];
const OBJECTIVES = {
  maxSharpe: 'Max Sharpe', minVar: 'Min volatility', targetVol: 'Max return at a volatility', maxAlpha: 'Max alpha at a beta', blackLitterman: 'Black-Litterman',
  targetRet: 'Min volatility for a return', equal: 'Equal weight', custom: 'My own weights',
};

let bundle, cov, sleeves, ids, defaultOn = {};
// the max-Sharpe limits actually used (the benchmark defaults when the boxes are blank)
let sharpeLim = { maxVol: null, minRet: null };
// ticked unless you've changed it; some sleeves start unticked (see default_on in the data)
const isOn = (id) => (id in state.include ? state.include[id] : defaultOn[id] !== false);
let state = {
  include: {}, lo: {}, hi: {}, custom: {}, classLo: {}, classHi: {}, limitOf: {}, objective: 'maxSharpe', target: null,
  sharpeMaxVol: null, sharpeMinRet: null, alphaMinBeta: null, alphaMaxBeta: 1, blConfidence: null, blDelta: null,
  start: 'earliest', end: 'latest', rebalance: 'annual', benchmark: 'US_LargeCap',
};

/* ------------------------------ persistence ------------------------------ */
function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode */ } }
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (s && typeof s === 'object') state = { ...state, ...s };
  } catch (e) { /* ignore */ }
}
function applyTheme(t) { document.documentElement.dataset.theme = t; }
try { applyTheme(localStorage.getItem(THEME_KEY) || 'dark'); } catch (e) { applyTheme('dark'); }
$('themeBtn').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(t);
  try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* ignore */ }
};

/* ------------------------------- controls -------------------------------- */
const bound = (map, id, dflt) => (Number.isFinite(map[id]) ? map[id] : dflt);

const classOf = (s) => s.asset_class || 'Equity';

function renderSleeves() {
  $('sleeves').innerHTML = CLASSES.map((c) => {
    const rows = sleeves.filter((s) => classOf(s) === c);
    return rows.length ? `<div class="sleeve-group">${c}</div>` + rows.map(sleeveRow).join('') : '';
  }).join('');
}

function classMembers(c) {
  const names = sleeves.filter((s) => classOf(s) === c).map((s) => SHORT[s.sleeve] || s.sleeve);
  return names.length > 5 ? `${names.length} sleeves (see the sleeve list)` : names.join(', ');
}

function renderClasses() {
  $('classes').innerHTML = CLASSES.map((c) => `<div class="class-row" data-class="${c}">
      <div class="c-name">${c}<small>${classMembers(c)}</small></div>
      <input class="num-in lo" type="number" inputmode="decimal" min="0" max="100" step="1" value="${bound(state.classLo, c, 0)}" aria-label="${c} minimum %">
      <input class="num-in hi" type="number" inputmode="decimal" min="0" max="100" step="1" value="${bound(state.classHi, c, 100)}" aria-label="${c} maximum %">
      <div class="c-now"></div>
    </div>`).join('');
}

$('classes').addEventListener('input', (e) => {
  const row = e.target.closest('.class-row'); if (!row) return;
  const map = e.target.classList.contains('lo') ? state.classLo : state.classHi;
  const v = parseFloat(e.target.value);
  if (Number.isFinite(v)) map[row.dataset.class] = Math.max(0, Math.min(100, v)); else delete map[row.dataset.class];
  update(250);
});

const relMode = (id) => state.limitOf[id] === 'class';
const CLASS_SHORT = { Equity: 'Eq', 'Fixed income': 'FI', Alts: 'Alts' };

function sleeveRow(s) {
  const on = isOn(s.sleeve);
  return `<div class="sleeve${on ? '' : ' off'}" data-id="${s.sleeve}">
    <input type="checkbox" ${on ? 'checked' : ''} aria-label="Include ${esc(s.name)}">
    <div class="s-name">${esc(s.name)}<span class="s-meta">from ${ym(s.start_date)} · ${esc(s.morningstar_category)}</span>
      <label class="s-mode">% of <select class="mode" aria-label="Min and max are a percent of">
        <option value="port"${relMode(s.sleeve) ? '' : ' selected'}>portfolio</option>
        <option value="class"${relMode(s.sleeve) ? ' selected' : ''}>${esc({ Equity: 'equity', 'Fixed income': 'fixed inc.', Alts: 'alts' }[classOf(s)])}</option></select></label></div>
    <input class="num-in lo" type="number" inputmode="decimal" min="0" max="100" step="1" value="${bound(state.lo, s.sleeve, 0)}" aria-label="Minimum %" ${on ? '' : 'disabled'}>
    <input class="num-in hi" type="number" inputmode="decimal" min="0" max="100" step="1" value="${bound(state.hi, s.sleeve, 100)}" aria-label="Maximum %" ${on ? '' : 'disabled'}>
    <div class="s-w"></div>
  </div>`;
}

$('sleeves').addEventListener('change', (e) => {
  const row = e.target.closest('.sleeve'); if (!row) return;
  const id = row.dataset.id;
  if (e.target.classList.contains('mode')) {
    if (e.target.value === 'class') state.limitOf[id] = 'class'; else delete state.limitOf[id];
  }
  if (e.target.type === 'checkbox') {
    state.include[id] = e.target.checked;
    row.classList.toggle('off', !e.target.checked);
    row.querySelectorAll('.num-in').forEach((i) => { i.disabled = !e.target.checked; });
  }
  update();
});
$('sleeves').addEventListener('input', (e) => {
  const row = e.target.closest('.sleeve'); if (!row) return;
  const id = row.dataset.id, v = parseFloat(e.target.value);
  const map = e.target.classList.contains('lo') ? state.lo : e.target.classList.contains('hi') ? state.hi : state.custom;
  if (Number.isFinite(v)) map[id] = Math.max(0, Math.min(100, v)); else delete map[id];
  update(250);
});

// Back to defaults: sleeves 0–100% of the portfolio, classes 0–100%, no custom weights.
// Which sleeves are ticked, the objective and the window stay as they are.
const LIMIT_KEYS = ['lo', 'hi', 'limitOf', 'custom', 'classLo', 'classHi', 'sharpeMaxVol', 'sharpeMinRet'];
let undoLimits = null; // the limits as they were before the last reset
function applyLimits(v) {
  Object.assign(state, v);
  renderSleeves();
  renderClasses();
  update();
}
$('resetBtn').onclick = () => {
  undoLimits = JSON.parse(JSON.stringify(Object.fromEntries(LIMIT_KEYS.map((k) => [k, state[k]]))));
  applyLimits({ lo: {}, hi: {}, limitOf: {}, custom: {}, classLo: {}, classHi: {}, sharpeMaxVol: null, sharpeMinRet: null });
  $('undoBtn').classList.remove('hidden');
};
$('undoBtn').onclick = () => {
  if (undoLimits) applyLimits(undoLimits);
  undoLimits = null;
  $('undoBtn').classList.add('hidden');
};

document.querySelectorAll('[data-preset]').forEach((b) => {
  b.onclick = () => {
    const p = b.dataset.preset;
    ids.forEach((id) => { state.include[id] = p === 'all' || (p === 'us' && US_1926.includes(id)); });
    if (p === 'us') { state.start = 'earliest'; if (!US_1926.includes(state.benchmark)) state.benchmark = 'US_LargeCap'; }
    renderSleeves();
    update();
  };
});

for (const [el, key] of [['objective', 'objective'], ['rebalance', 'rebalance'], ['benchSel', 'benchmark'], ['startSel', 'start'], ['endSel', 'end']]) {
  $(el).addEventListener('change', (e) => {
    state[key] = e.target.value;
    if (key === 'objective') state.target = null; // back to the benchmark default
    update();
  });
}
for (const [el, key] of [['sharpeMaxVol', 'sharpeMaxVol'], ['sharpeMinRet', 'sharpeMinRet'], ['alphaMinBeta', 'alphaMinBeta'], ['alphaMaxBeta', 'alphaMaxBeta'], ['blConfidence', 'blConfidence'], ['blDelta', 'blDelta']]) {
  $(el).addEventListener('input', (e) => {
    const v = parseFloat(e.target.value);
    state[key] = Number.isFinite(v) ? v : null;
    update(350);
  });
}

$('target').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  state.target = Number.isFinite(v) ? v : null;
  update(350);
});

// tap the frontier to pick that risk level
$('frontierChart').addEventListener('click', (e) => {
  const h = e.target.closest('[data-vol]'); if (!h) return;
  state.objective = 'targetVol';
  state.target = +(parseFloat(h.dataset.vol) * 100).toFixed(1);
  update();
});

let timer = null, resizeTimer = null, redraw = null;
let lastW = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastW) return; // ignore mobile toolbar show/hide
  lastW = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => redraw && redraw(), 150);
});
function update(delay = 0) {
  clearTimeout(timer);
  timer = setTimeout(() => { save(); run(); }, delay);
}

/* --------------------------------- run ----------------------------------- */
function status(msg, kind = 'warn') {
  $('status').className = msg ? `status ${kind}` : 'status hidden';
  $('status').innerHTML = msg || '';
}

function syncControls(win) {
  $('objective').value = state.objective;
  $('rebalance').value = state.rebalance;
  $('benchSel').value = state.benchmark;
  const tgt = state.objective === 'targetVol' || state.objective === 'targetRet';
  // Max Sharpe swaps the target box for its optional volatility cap and return floor
  const ms = state.objective === 'maxSharpe', ma = state.objective === 'maxAlpha', bl = state.objective === 'blackLitterman';
  $('targetFld').classList.toggle('hidden', ms || ma || bl);
  document.querySelectorAll('.bl-opt').forEach((el) => el.classList.toggle('hidden', !bl));
  $('blBox').classList.toggle('hidden', !bl);
  document.querySelectorAll('.sharpe-lim').forEach((el) => el.classList.toggle('hidden', !ms));
  document.querySelectorAll('.alpha-lim').forEach((el) => el.classList.toggle('hidden', !ma));
  for (const k of ['sharpeMaxVol', 'sharpeMinRet', 'alphaMinBeta', 'alphaMaxBeta', 'blConfidence', 'blDelta']) {
    if (document.activeElement !== $(k)) $(k).value = state[k] != null ? state[k] : '';
  }
  $('targetFld').classList.toggle('disabled', !tgt);
  $('target').disabled = !tgt;
  $('targetLbl').textContent = state.objective === 'targetRet' ? 'Target return (%)' : 'Target volatility (%)';
  if (document.activeElement !== $('target')) $('target').value = tgt && state.target != null ? state.target : '';
  $('wHead').textContent = state.objective === 'custom' ? 'Yours' : 'Weight';

  const y0 = S.yearOf(win.start), y1 = S.yearOf(win.end);
  const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
  $('startSel').innerHTML = `<option value="earliest">Earliest (${ym(win.start)})</option>`
    + years.slice(1).map((y) => `<option value="${y}">Jan ${y}</option>`).join('');
  $('endSel').innerHTML = `<option value="latest">Latest (${ym(win.end)})</option>`
    + years.slice(0, -1).reverse().map((y) => `<option value="${y}">Dec ${y}</option>`).join('');
  if (!years.slice(1).includes(Number(state.start))) state.start = 'earliest';
  if (!years.slice(0, -1).includes(Number(state.end))) state.end = 'latest';
  $('startSel').value = state.start;
  $('endSel').value = state.end;
}

function run() {
  const inc = ids.filter(isOn);
  if (!inc.length) { $('history').innerHTML = ''; status('Tick at least one sleeve.', 'err'); $('results').classList.add('hidden'); syncControls({ start: cov.Cash.start, end: cov.Cash.end }); return; }
  if (!ids.includes(state.benchmark) && !(state.benchmark in cov)) state.benchmark = 'US_LargeCap';

  // the window every ticked sleeve, the benchmark and cash share
  const win = commonWindow(cov, [...new Set([...inc, state.benchmark, 'Cash'])]);
  syncControls(win);
  const start = state.start === 'earliest' ? win.start : `${state.start}-01-01`;
  const end = state.end === 'latest' ? win.end : `${state.end}-12-31`;
  const s = slice(bundle, inc, start, end);
  renderHistory(win, s, inc);
  if (s.dates.length < 24) { status('Pick a window of at least two years.', 'err'); $('results').classList.add('hidden'); return; }

  // limits in "% of portfolio" mode are sleeve bounds; in "% of class" mode they're shares of the class
  const lo = inc.map((id) => (relMode(id) ? 0 : bound(state.lo, id, 0) / 100));
  const hi = inc.map((id) => (relMode(id) ? 1 : bound(state.hi, id, 100) / 100));
  const groups = CLASSES.map((c) => ({
    name: c,
    members: inc.map((id, i) => [id, i]).filter(([id]) => classOf(sleeves.find((s) => s.sleeve === id)) === c).map(([, i]) => i),
    lo: bound(state.classLo, c, 0) / 100,
    hi: bound(state.classHi, c, 100) / 100,
  }));
  const rel = inc.map((id, i) => [id, i]).filter(([id]) => relMode(id)).map(([id, i]) => {
    const g = groups.find((x) => x.members.includes(i));
    return { i, group: g.name, members: g.members, lo: bound(state.lo, id, 0) / 100, hi: bound(state.hi, id, 100) / 100 };
  });
  const bad = O.boundsError(lo, hi, groups, rel, inc.map((id) => SHORT[id] || id));
  if (bad && state.objective !== 'custom') {
    status(`These limits can't all be met: ${bad}.`, 'err'); $('results').classList.add('hidden'); return;
  }

  // solve the chosen objective (js/objectives.js); the same call drives the walk-forward test
  const benchR = column(bundle, state.benchmark, s.dates);
  const bl = SHORT[state.benchmark] || state.benchmark;
  const bmMeta = bundle.benchmarks.list.find((x) => x.id === state.benchmark);
  const refMix = bmMeta ? bmMeta.weights : { [state.benchmark]: 1 };
  const problem = {
    objective: state.objective,
    opts: { target: state.target, sharpeMaxVol: state.sharpeMaxVol, sharpeMinRet: state.sharpeMinRet,
      alphaMinBeta: state.alphaMinBeta, alphaMaxBeta: state.alphaMaxBeta, blConfidence: state.blConfidence,
      blDelta: state.blDelta, custom: inc.map((id) => bound(state.custom, id, 0)) },
    matrix: s.matrix, rf: s.rf, benchR, lo, hi, groups, rel, limitsOk: !bad,
    refMix: inc.map((id) => refMix[id] || 0), benchLabel: bl,
  };
  const res = solveObjective(problem);
  const { mo, ctx, ab, chosen } = res;
  const front = res.front(), sharpeP = res.sharpeP(), minP = front[0];
  const msg = res.msg;
  sharpeLim = res.limits;

  // placeholders show the benchmark defaults in use
  const p1 = (v) => (v * 100).toFixed(1);
  if (state.objective === 'maxSharpe' && res.auto) {
    $('sharpeMaxVol').placeholder = res.auto.fromBench ? `${bl}: ${p1(res.auto.maxVol)}` : 'no cap';
    $('sharpeMinRet').placeholder = res.auto.fromBench ? `${bl} CAGR + 1: ${p1(res.auto.minRet)}` : 'no floor';
  }
  if (res.auto && res.auto.metric) {
    $('target').placeholder = res.auto.fromBench ? `${bl}${res.auto.metric === 'vol' ? '' : ' CAGR'}: ${p1(res.auto.target)}` : '';
  }
  if (res.bl) {
    $('blTable').innerHTML = `<table><thead><tr><th>Sleeve</th><th title="Historical mean">Hist.</th><th title="Equilibrium (implied by the reference mix)">Equil.</th><th title="Black-Litterman blend">Blend</th><th>Weight</th></tr></thead><tbody>`
      + inc.map((id, k) => `<tr><td>${esc(SHORT[id] || id)}</td><td>${pct(mo.mu[k])}</td><td>${pct(res.bl.prior[k])}</td><td>${pct(res.bl.posterior[k])}</td><td>${pct(chosen.w[k])}</td></tr>`).join('')
      + '</tbody></table>';
  }
  status(msg ? esc(msg) : '', 'warn');
  $('results').classList.remove('hidden');

  // backtest the chosen weights and the benchmark over the same months
  const portR = S.backtest(s.dates, s.matrix, chosen.w, state.rebalance);
  wfIds = inc;
  wfSetup({ problem, s, benchR, chosen, bl });
  const pa = chosen.w.reduce((a, w, i) => a + w * ab.alpha[i], 0), pb = chosen.w.reduce((a, w, i) => a + w * ab.beta[i], 0);
  $('abLine').textContent = `Against ${SHORT[state.benchmark] || state.benchmark}: alpha ${pa >= 0 ? '+' : ''}${pct(pa)} a year · beta ${pb.toFixed(2)}`;
  const pm = S.metrics(portR, s.rf), bm = S.metrics(benchR, s.rf);
  const py = S.calendarYears(s.dates, portR), by = S.calendarYears(s.dates, benchR);
  const years = py.map((p, i) => ({ year: p.year, partial: p.partial, port: p.ret, bench: by[i].ret }));

  renderWeights(inc, chosen, ctx);
  renderClassMix(groups, chosen.w);
  renderKpis(chosen, pm);
  const corr = S.correlation(s.matrix);
  redraw = () => {
    renderFrontier(inc, mo, front, chosen, sharpeP, minP, s.dates);
    renderBenchmarks(s, portR, pm);
    renderBacktest(s, portR, benchR, pm, bm, years);
    renderYears(years);
    C.heatmap($('heatmap'), corr, inc.map((id) => SHORT[id] || id));
  };
  redraw();
}

/* ------------------------------ walk-forward ------------------------------ */
let wfJob = null;   // inputs captured from the latest run()
let wfToken = 0;    // bumps whenever settings change, so a running test stops

function wfSetup(job) {
  wfJob = job;
  wfToken++;
  $('wfOut').classList.add('hidden');
  $('wfBtn').disabled = false;
  const years = job.s.dates.length / 12, need = Number($('wfTrain').value);
  $('wfNote').textContent = years < need + 1
    ? `This window is ${years.toFixed(1)} years long, shorter than the ${need}-year training period plus a year to test. Pick a shorter training period or a longer window.`
    : 'Not run yet for these settings.';
}

$('wfTrain').addEventListener('change', () => wfJob && wfSetup(wfJob));
$('wfBtn').onclick = async () => {
  if (!wfJob) return;
  const { problem, s, benchR, chosen, bl } = wfJob;
  const token = ++wfToken;
  $('wfBtn').disabled = true;
  $('wfOut').classList.add('hidden');
  const gen = walkForward(problem, { dates: s.dates, minTrainMonths: Number($('wfTrain').value) * 12, rebalance: state.rebalance });
  let step = gen.next();
  while (!step.done) {
    $('wfNote').textContent = `Re-optimizing year ${step.value.done} of ${step.value.total}…`;
    await new Promise((r) => setTimeout(r, 0)); // let the page repaint
    if (token !== wfToken) return;              // settings changed mid-run
    step = gen.next();
  }
  $('wfBtn').disabled = false;
  const wf = step.value;
  if (!wf.steps.length) { $('wfNote').textContent = 'Not enough history for that training period.'; return; }

  // the same out-of-sample months for all three
  const a = wf.firstIndex, rf = s.rf.slice(a);
  const inS = S.backtest(s.dates.slice(a), s.matrix.slice(a), chosen.w, state.rebalance);
  const bR = benchR.slice(a);
  const rows = [['Walk-forward', wf.returns], ['In-sample weights', inS], [bl, bR]].map(([name, r]) => ({ name, r, m: S.metrics(r, rf) }));
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
  $('wfTable').innerHTML = '<table><thead><tr><th></th><th>CAGR</th><th>Vol</th><th>Sharpe</th><th>Max DD</th><th>Worst 12M</th></tr></thead><tbody>'
    + rows.map((x, k) => `<tr class="${k === 0 ? 'port' : ''}"><td>${esc(x.name)}</td><td>${pct(x.m.cagr)}</td><td>${pct(x.m.vol)}</td><td>${f2(x.m.sharpe)}</td><td>${pct(x.m.maxDD)}</td><td>${pct(x.m.worst12)}</td></tr>`).join('')
    + '</tbody></table>';
  const colors = ['var(--accent)', 'var(--gold)', 'var(--accent-2)'];
  const series = rows.map((x, k) => ({ label: x.name, values: S.wealth(x.r, 10000), color: colors[k] }));
  $('wfLegend').innerHTML = series.map((x) => `<span><i class="lg-line" style="background:${x.color}"></i>${esc(x.label)}</span>`).join('');
  $('wfOut').classList.remove('hidden');
  C.growthChart($('wfChart'), wf.dates, series);
  const gap = rows[1].m.cagr - rows[0].m.cagr;
  const last = wf.steps.at(-1);
  const top = last.w.map((w, i) => [SHORT[wfIds[i]] || wfIds[i], w]).filter((x) => x[1] >= 0.005).sort((x, y) => y[1] - x[1]).slice(0, 6);
  $('wfNote').innerHTML = `Tested on <b>${ym(wf.dates[0])} → ${ym(wf.dates.at(-1))}</b>: ${wf.steps.length} yearly re-optimizations, each using only data up to that December. `
    + `Hindsight was worth <b>${gap >= 0 ? '+' : ''}${pct(gap)} a year</b> (in-sample weights ${pct(rows[1].m.cagr)} vs walk-forward ${pct(rows[0].m.cagr)}). `
    + `Average turnover ${pct(turnover(wf.steps), 0)} a year. Latest weights (from ${ym(last.trainEnd)}): ${top.map(([n, w]) => `${esc(n)} ${pct(w, 0)}`).join(', ')}.`;
};
let wfIds = [];

/* ------------------------------- renderers ------------------------------- */
function renderHistory(win, s, inc) {
  const name = (id) => SHORT[id] || id;
  const yrs = (s.dates.length / 12).toFixed(1);
  let h = s.dates.length
    ? `Window: <b>${ym(s.dates[0])} → ${ym(s.dates.at(-1))}</b> (${yrs} years, ${s.dates.length} months). `
    : '';
  if (state.start === 'earliest') {
    const bind = win.binding.filter((id) => inc.includes(id));
    h += win.next && bind.length
      ? `It starts in ${ym(win.start)} because that's when ${bind.map(name).join(', ')} begin${bind.length === 1 ? 's' : ''}. Untick ${bind.length === 1 ? 'it' : 'them'} to go back to ${ym(win.next)}.`
      : 'That is all the history these sleeves have.';
  } else {
    h += `Narrowed from the earliest shared month, ${ym(win.start)}.`;
  }
  const endBind = win.endBinding.filter((id) => inc.includes(id));
  if (state.end === 'latest' && endBind.length) {
    h += ` It ends in ${ym(win.end)} because ${endBind.map(name).join(', ')} ${endBind.length === 1 ? 'has' : 'have'} no data after that (the rest run to ${ym(win.latest)}).`;
  }
  $('history').innerHTML = h;
}

function renderWeights(inc, chosen, ctx) {
  const rc = O.riskContributions(chosen.w, ctx.cov);
  const order = inc.map((_, i) => i).sort((a, b) => chosen.w[b] - chosen.w[a]);
  const max = Math.max(...chosen.w);
  $('weights').innerHTML = `<div class="wrow head"><span>Sleeve</span><span></span><span class="n">Weight</span><span class="n">Risk</span></div>`
    + order.filter((i) => chosen.w[i] >= 0.0005).map((i) => `<div class="wrow">
      <span class="nm" title="${esc(inc[i])}">${esc(SHORT[inc[i]] || inc[i])}</span>
      <span class="bar"><i style="width:${(chosen.w[i] / max) * 100}%"></i></span>
      <span class="n">${pct(chosen.w[i])}</span><span class="n r">${pct(Math.abs(rc[i]) < 0.005 ? 0 : rc[i], 0)}</span></div>`).join('');
  const zero = order.filter((i) => chosen.w[i] < 0.0005).map((i) => SHORT[inc[i]] || inc[i]);
  if (zero.length) $('weights').innerHTML += `<p class="note small">0%: ${esc(zero.join(', '))}</p>`;

  // weight column in the sleeve list
  document.querySelectorAll('.sleeve').forEach((row) => {
    const i = inc.indexOf(row.dataset.id), cell = row.querySelector('.s-w');
    if (state.objective === 'custom') {
      if (!cell.querySelector('input')) cell.innerHTML = `<input class="num-in cw" type="number" inputmode="decimal" min="0" max="100" step="1" aria-label="Your weight %">`;
      const inp = cell.querySelector('input');
      inp.disabled = i < 0;
      if (document.activeElement !== inp) inp.value = Number.isFinite(state.custom[row.dataset.id]) ? state.custom[row.dataset.id] : '';
    } else if (i < 0) {
      cell.textContent = '';
    } else if (relMode(row.dataset.id)) {
      const c = classOf(sleeves.find((x) => x.sleeve === row.dataset.id));
      const tot = inc.reduce((a, id, j) => a + (classOf(sleeves.find((x) => x.sleeve === id)) === c ? chosen.w[j] : 0), 0);
      cell.innerHTML = `${pct(chosen.w[i], 0)}<small>${tot > 1e-9 ? pct(chosen.w[i] / tot, 0) : '—'} of ${CLASS_SHORT[c]}</small>`;
    } else {
      cell.textContent = pct(chosen.w[i], 0);
    }
  });
}

function renderClassMix(groups, w) {
  const totals = groups.map((g) => g.members.reduce((a, i) => a + w[i], 0));
  document.querySelectorAll('.class-row').forEach((row) => {
    const k = CLASSES.indexOf(row.dataset.class), g = groups[k], t = totals[k];
    const cell = row.querySelector('.c-now');
    cell.textContent = g.members.length ? pct(t, 0) : '—';
    cell.classList.toggle('off-limit', g.members.length > 0 && (t < g.lo - 1e-6 || t > g.hi + 1e-6));
  });
  $('classMix').textContent = groups.map((g, k) => `${g.name} ${pct(totals[k], 0)}`).join(' · ');
}

function renderKpis(chosen, pm) {
  const lims = state.objective === 'maxSharpe'
    ? [sharpeLim.maxVol != null && `vol ≤ ${pct(sharpeLim.maxVol)}`, sharpeLim.minRet != null && `return ≥ ${pct(sharpeLim.minRet)}`].filter(Boolean)
    : state.objective === 'targetVol' ? [sharpeLim.maxVol != null && `vol ${pct(sharpeLim.maxVol)}`].filter(Boolean)
    : state.objective === 'targetRet' ? [sharpeLim.minRet != null && `return ${pct(sharpeLim.minRet)}`].filter(Boolean)
    : state.objective === 'maxAlpha'
      ? [state.alphaMinBeta != null && `β ≥ ${state.alphaMinBeta}`, state.alphaMaxBeta != null && `β ≤ ${state.alphaMaxBeta}`].filter(Boolean) : [];
  $('portTag').textContent = OBJECTIVES[state.objective] + (lims.length ? ` (${lims.join(', ')})` : '');
  const k = (label, v) => `<div class="kpi"><div class="k">${label}</div><div class="v">${v}</div></div>`;
  $('kpis').innerHTML = k('Return', pct(chosen.ret)) + k('Volatility', pct(chosen.vol))
    + k('Sharpe', Number.isFinite(chosen.sharpe) ? chosen.sharpe.toFixed(2) : '—') + k('CAGR', pct(pm.cagr));
}

/* Annualized mean and volatility of a sleeve/benchmark over the window, or null if it has gaps there. */
function point(id, dates) {
  const r = column(bundle, id, dates);
  if (r.some((v) => v === null || v === undefined)) return null;
  return { ret: S.mean(r) * 12, vol: S.stdev(r) * Math.sqrt(12) };
}

function renderFrontier(inc, mo, front, chosen, sharpeP, minP, dates) {
  const bi = inc.indexOf(state.benchmark);
  const benchPt = point(state.benchmark, dates);
  const sleevePts = inc.map((id, i) => ({ label: SHORT[id] || id, vol: Math.sqrt(mo.cov[i][i]), ret: mo.mu[i] }))
    .filter((_, i) => i !== bi);
  const marks = [
    { ...minP, label: 'Min volatility', cls: 'mk-minvar' },
    { ...sharpeP, label: 'Max Sharpe', cls: 'mk-sharpe' },
  ];
  for (const id of BENCH_IDS) {
    if (id === state.benchmark) continue;
    const p = point(id, dates);
    const same = p && benchPt && Math.abs(p.ret - benchPt.ret) < 1e-9 && Math.abs(p.vol - benchPt.vol) < 1e-9;
    if (p && !same) marks.push({ ...p, label: bundle.benchmarks.list.find((b) => b.id === id).name, cls: 'mk-bm', text: SHORT[id] });
  }
  if (benchPt) marks.push({ ...benchPt, label: `Benchmark: ${benchName(state.benchmark)}`, cls: 'mk-bench', text: SHORT[state.benchmark] });
  marks.push({ ...chosen, label: `Selected: ${OBJECTIVES[state.objective]}`, cls: 'mk-sel' });
  C.frontierChart($('frontierChart'), front, sleevePts, marks);
}

function renderBacktest(s, portR, benchR, pm, bm, years) {
  const bl = SHORT[state.benchmark] || state.benchmark;
  const reb = { annual: 'rebalanced annually', quarterly: 'rebalanced quarterly', monthly: 'rebalanced monthly', never: 'buy and hold' }[state.rebalance];
  $('btTag').textContent = `${ym(s.dates[0])} → ${ym(s.dates.at(-1))} · ${reb}`;
  const full = years.filter((y) => !y.partial);
  const best = (k) => Math.max(...full.map((y) => y[k])), worst = (k) => Math.min(...full.map((y) => y[k]));
  const beat = full.filter((y) => y.port > y.bench).length;
  const row = (label, a, b) => `<tr><td>${label}</td><td>${a}</td><td>${b}</td></tr>`;
  $('mtable').innerHTML = `<table><thead><tr><th></th><th>Portfolio</th><th>${esc(bl)}</th></tr></thead><tbody>`
    + row('CAGR', pct(pm.cagr), pct(bm.cagr))
    + row('Volatility', pct(pm.vol), pct(bm.vol))
    + row('Sharpe', pm.sharpe.toFixed(2), Number.isFinite(bm.sharpe) ? bm.sharpe.toFixed(2) : '—')
    + row('Max drawdown', pct(pm.maxDD), pct(bm.maxDD))
    + row('Worst 12 months', pct(pm.worst12), pct(bm.worst12))
    + row('Worst 5 years (a year)', pct(pm.worst5y), pct(bm.worst5y))
    + row('Worst 10 years (a year)', pct(pm.worst10y), pct(bm.worst10y))
    + (full.length ? row('Best year', pct(best('port')), pct(best('bench'))) + row('Worst year', pct(worst('port')), pct(worst('bench'))) : '')
    + (full.length ? row('Years ahead of benchmark', `${beat} of ${full.length}`, '') : '')
    + row('$10,000 became', C.money(10000 * pm.growth), C.money(10000 * bm.growth))
    + '</tbody></table>';

  const pw = S.wealth(portR, 10000), bw = S.wealth(benchR, 10000);
  const series = [
    { label: 'Portfolio', values: pw, color: 'var(--accent)' },
    { label: bl, values: bw, color: 'var(--accent-2)' },
  ];
  $('growthLegend').innerHTML = series.map((x) => `<span><i class="lg-line" style="background:${x.color}"></i>${esc(x.label)}</span>`).join('');
  C.growthChart($('growthChart'), s.dates, series);
  C.drawdownChart($('ddChart'), s.dates, S.drawdowns(pw), { dd: S.drawdowns(bw), color: 'var(--accent-2)', label: bl });
}

const benchName = (id) => (bundle.benchmarks.list.find((b) => b.id === id) || sleeves.find((x) => x.sleeve === id) || {}).name || id;

function renderBenchmarks(s, portR, pm) {
  $('bmTag').textContent = `${ym(s.dates[0])} → ${ym(s.dates.at(-1))}`;
  const rows = [{ id: 'port', name: 'Your portfolio', m: pm }];
  for (const id of BENCH_IDS) {
    const r = column(bundle, id, s.dates);
    const ok = r.every((v) => v !== null && v !== undefined);
    rows.push({ id, name: benchName(id), m: ok ? S.metrics(r, s.rf) : null, r: ok ? r : null, from: cov[id].start });
  }
  const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
  $('btable').innerHTML = `<table><thead><tr><th></th><th>CAGR</th><th>Vol</th><th>Sharpe</th><th>Max DD</th><th>Worst 12M</th><th>Worst 5Y</th><th>Worst 10Y</th></tr></thead><tbody>`
    + rows.map((x) => `<tr class="${x.id === 'port' ? 'port' : ''}${x.id === state.benchmark ? ' sel' : ''}"><td title="${esc(x.name)}">${esc(x.id === 'port' ? 'Yours' : SHORT[x.id])}</td>`
      + (x.m ? `<td>${pct(x.m.cagr)}</td><td>${pct(x.m.vol)}</td><td>${f2(x.m.sharpe)}</td><td>${pct(x.m.maxDD)}</td><td>${pct(x.m.worst12)}</td><td>${pct(x.m.worst5y)}</td><td>${pct(x.m.worst10y)}</td>`
        : `<td colspan="7" class="muted">starts ${ym(x.from)}, after this window begins</td>`) + '</tr>').join('')
    + '</tbody></table>';

  const cols = rows.filter((x) => x.id === 'port' || x.r);
  const yrs = cols.map((x) => S.calendarYears(s.dates, x.id === 'port' ? portR : x.r));
  $('bytable').innerHTML = `<table><thead><tr><th>Year</th>${cols.map((x) => `<th>${esc(x.id === 'port' ? 'Yours' : SHORT[x.id])}</th>`).join('')}</tr></thead><tbody>`
    + yrs[0].slice().reverse().map((y, k) => {
      const i = yrs[0].length - 1 - k;
      return `<tr><td>${y.year}${y.partial ? ' YTD' : ''}</td>${yrs.map((c) => `<td>${pct(c[i].ret)}</td>`).join('')}</tr>`;
    }).join('') + '</tbody></table>';
}

function renderYears(years) {
  const bl = SHORT[state.benchmark] || state.benchmark;
  const full = years.filter((y) => !y.partial);
  $('cyTag').textContent = full.length ? `${full[0].year}–${full.at(-1).year}${years.at(-1).partial ? ' + YTD' : ''}` : '';
  $('cyTitle').innerHTML = `Portfolio minus ${esc(bl)} <span class="muted">· tap a bar</span>`;
  C.yearBars($('yearChart'), years, bl);
  const sign = (v) => `<span class="${v >= 0 ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${pct(v)}</span>`;
  $('ytable').innerHTML = `<table><thead><tr><th>Year</th><th>Portfolio</th><th>${esc(bl)}</th><th>Diff</th></tr></thead><tbody>`
    + years.slice().reverse().map((y) => `<tr><td>${y.year}${y.partial ? ' YTD' : ''}</td><td>${pct(y.port)}</td><td>${pct(y.bench)}</td><td>${sign(y.port - y.bench)}</td></tr>`).join('')
    + '</tbody></table>';
}

/* --------------------------------- boot ---------------------------------- */
(async function boot() {
  restore();
  try {
    bundle = await loadBundle();
  } catch (e) {
    $('dataLine').textContent = '';
    status(`${esc(e.message)}. Run <code>python scripts/update_french_data.py</code> to build it.`, 'err');
    return;
  }
  cov = coverage(bundle);
  sleeves = bundle.sleeves;
  ids = sleeves.map((s) => s.sleeve);
  sleeves.forEach((s) => { defaultOn[s.sleeve] = s.default_on !== false; });
  const cut = [...new Set(Object.values(bundle.data_cut))].join(', ');
  $('dataLine').textContent = `Ken French Data Library · data cut ${cut} · built ${bundle.generated_at.slice(0, 10)} · app ${APP_VERSION}`;
  $('benchSel').innerHTML = `<optgroup label="Benchmarks">${bundle.benchmarks.list.map((b) => `<option value="${b.id}">${esc(b.name)}</option>`).join('')}</optgroup>`
    + `<optgroup label="Sleeves">${sleeves.map((s) => `<option value="${s.sleeve}">${esc(s.name)}</option>`).join('')}</optgroup>`;
  renderSleeves();
  renderClasses();
  run();
})();

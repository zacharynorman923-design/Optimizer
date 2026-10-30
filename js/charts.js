/* =========================================================================
   Inline-SVG charts (no chart library). Each function renders into a
   container element; SVGs use a viewBox and scale to 100% width. Colours
   come from CSS variables so they follow the light/dark theme.

   Hover/tap: any element with a `data-tip` attribute shows that text in the
   container's tooltip. Line charts add a crosshair that reads the nearest
   month.
   ========================================================================= */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const pct = (v, d = 1) => (Number.isFinite(v) ? `${(v * 100).toFixed(d)}%` : '—');
export const money = (v) => (v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 0 : 1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e4 ? 0 : 1)}k` : `$${v.toFixed(0)}`);

function scaler(min, max, a, b) {
  if (max === min) max = min + 1;
  return (v) => a + (b - a) * ((v - min) / (max - min));
}

/* Draw at the container's real pixel width so 11px text stays 11px on a phone. */
const widthOf = (el) => Math.max(300, Math.round(el.clientWidth || 860));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* Round axis ticks covering [min, max] (the last tick is ≥ max). */
function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = [];
  const top = Math.ceil(max / step - 1e-9) * step;
  for (let v = Math.floor(min / step + 1e-9) * step; v <= top + 1e-12; v += step) out.push(+v.toFixed(12));
  return out;
}

function yearTicks(dates, maxTicks = 7) {
  const ticks = [];
  let last = null;
  dates.forEach((d, i) => { const y = d.slice(0, 4); if (y !== last) { ticks.push({ i, label: y }); last = y; } });
  const step = Math.max(1, Math.ceil(ticks.length / maxTicks));
  const nice = [1, 2, 5, 10, 20, 25, 50].find((s) => s >= step) || step;
  return ticks.filter((t) => Number(t.label) % nice === 0);
}

/* ------------------------------- tooltips -------------------------------- */
function wireTips(el, crosshair) {
  let tip = el.querySelector('.tip');
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip hidden'; el.appendChild(tip); }
  el.style.position = 'relative';
  const show = (html, evt) => {
    tip.innerHTML = html;
    tip.classList.remove('hidden');
    const box = el.getBoundingClientRect();
    const x = evt.clientX - box.left, y = evt.clientY - box.top;
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(4, Math.min(box.width - w - 4, x - w / 2))}px`;
    tip.style.top = `${Math.max(4, y - tip.offsetHeight - 14)}px`;
  };
  const hide = () => { tip.classList.add('hidden'); if (crosshair) crosshair.hide(); };
  el.onpointermove = el.onpointerdown = (evt) => {
    const t = evt.target.closest('[data-tip]');
    if (t) { show(t.dataset.tip, evt); return; }
    if (crosshair) { const html = crosshair.at(evt); if (html) { show(html, evt); return; } }
    hide();
  };
  el.onpointerleave = hide;
}

/* Map a pointer event to SVG viewBox x. */
function svgX(svg, evt, W) {
  const r = svg.getBoundingClientRect();
  return ((evt.clientX - r.left) / r.width) * W;
}

/* ---------------------------- efficient frontier ------------------------- */
/* front: [{vol, ret, sharpe}]; sleeves: [{label, vol, ret}];
   marks: [{label, vol, ret, cls}] drawn on top (selected, max Sharpe, …). */
export function frontierChart(el, front, sleeves, marks) {
  const W = widthOf(el), H = clamp(W * 0.66, 260, 400), P = { t: 16, r: 14, b: 40, l: 52 };
  const all = [...front, ...sleeves, ...marks];
  const xs = all.map((p) => p.vol), ys = all.map((p) => p.ret);
  const xT = niceTicks(0, Math.max(...xs) * 1.04, W < 500 ? 4 : 6);
  const yT = niceTicks(Math.min(0, ...ys), Math.max(...ys) * 1.04, 5);
  const X = scaler(xT[0], xT.at(-1), P.l, W - P.r), Y = scaler(yT[0], yT.at(-1), H - P.b, P.t);
  let g = '';
  yT.forEach((v) => {
    g += `<line class="c-grid" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/>`;
    g += `<text class="c-axis" x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end">${pct(v, 0)}</text>`;
  });
  xT.forEach((v) => { g += `<text class="c-axis" x="${X(v)}" y="${H - 18}" text-anchor="middle">${pct(v, 0)}</text>`; });
  g += `<text class="c-axis" x="${(P.l + W - P.r) / 2}" y="${H - 2}" text-anchor="middle">Volatility (annualized)</text>`;
  g += `<text class="c-axis" transform="translate(12 ${(P.t + H - P.b) / 2}) rotate(-90)" text-anchor="middle">Return (annualized mean)</text>`;

  const line = front.map((p, i) => `${i ? 'L' : 'M'}${X(p.vol).toFixed(1)} ${Y(p.ret).toFixed(1)}`).join('');
  g += `<path d="${line}" style="fill:none;stroke:var(--accent)" stroke-width="2.5" stroke-linejoin="round"/>`;
  // invisible fat hit targets along the frontier: tap to pick that portfolio
  front.forEach((p) => {
    g += `<circle class="hit" cx="${X(p.vol)}" cy="${Y(p.ret)}" r="11" data-vol="${p.vol}" `
      + `data-tip="${esc(`<b>Frontier</b><br>Return ${pct(p.ret)} · Vol ${pct(p.vol)}<br>Sharpe ${p.sharpe.toFixed(2)}<br><i>tap to use this risk level</i>`)}"/>`;
  });
  sleeves.forEach((s) => {
    g += `<circle class="c-sleeve" cx="${X(s.vol)}" cy="${Y(s.ret)}" r="5"/>`;
    g += `<circle class="hit" cx="${X(s.vol)}" cy="${Y(s.ret)}" r="12" data-tip="${esc(`<b>${s.label}</b><br>Return ${pct(s.ret)} · Vol ${pct(s.vol)}`)}"/>`;
  });
  marks.forEach((m) => {
    if (m.text) g += `<text class="c-mklabel" x="${X(m.vol) + 8}" y="${Y(m.ret) - 7}">${esc(m.text)}</text>`;
    g += `<circle class="mk ${m.cls}" cx="${X(m.vol)}" cy="${Y(m.ret)}" r="${m.cls === 'mk-sel' ? 10 : m.cls === 'mk-bm' ? 4.5 : 6}" `
      + `data-tip="${esc(`<b>${m.label}</b><br>Return ${pct(m.ret)} · Vol ${pct(m.vol)}${m.sharpe != null ? `<br>Sharpe ${m.sharpe.toFixed(2)}` : ''}`)}"/>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Efficient frontier">${g}</svg>`;
  wireTips(el);
}

/* ------------------------------ growth (log) ----------------------------- */
/* series: [{label, values (wealth path, len = dates+1), color}] */
export function growthChart(el, dates, series) {
  const W = widthOf(el), H = clamp(W * 0.58, 220, 340), P = { t: 14, r: 12, b: 30, l: 50 };
  const n = dates.length;
  const lv = series.flatMap((s) => s.values).map(Math.log);
  const lo = Math.min(...lv), hi = Math.max(...lv);
  const X = scaler(0, n, P.l, W - P.r), Y = scaler(lo, hi + (hi - lo) * 0.04, H - P.b, P.t);
  let g = '';
  // log grid at 1-2-5 steps
  const vals = [];
  for (let e = Math.floor(lo / Math.LN10); e <= Math.ceil(hi / Math.LN10); e++) for (const m of [1, 2, 5]) vals.push(m * 10 ** e);
  let grid = vals.filter((v) => Math.log(v) >= lo && Math.log(v) <= hi);
  if (grid.length > (W < 500 ? 5 : 7)) grid = grid.filter((v) => /^1/.test(String(v)));
  grid.forEach((v) => {
    const y = Y(Math.log(v));
    g += `<line class="c-grid" x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}"/><text class="c-axis" x="${P.l - 8}" y="${y + 4}" text-anchor="end">${money(v)}</text>`;
  });
  yearTicks(dates, Math.floor(W / 90)).forEach((t) => { g += `<text class="c-axis" x="${X(t.i + 1)}" y="${H - 10}" text-anchor="middle">${t.label}</text>`; });
  series.forEach((s) => {
    const d = s.values.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(Math.log(v)).toFixed(1)}`).join('');
    g += `<path d="${d}" style="fill:none;stroke:${s.color}" stroke-width="2" stroke-linejoin="round"/>`;
  });
  g += `<line class="xhair hidden" y1="${P.t}" y2="${H - P.b}"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Growth of $10,000, log scale">${g}</svg>`;
  const svg = el.querySelector('svg'), xh = el.querySelector('.xhair');
  wireTips(el, {
    at(evt) {
      const i = Math.round(scaler(P.l, W - P.r, 0, n)(svgX(svg, evt, W)));
      if (i < 1 || i > n) return null;
      xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.classList.remove('hidden');
      return `<b>${dates[i - 1].slice(0, 7)}</b>` + series.map((s) => `<br><span class="sw" style="background:${s.color}"></span>${esc(s.label)} ${money(s.values[i])}`).join('');
    },
    hide() { xh.classList.add('hidden'); },
  });
}

/* ------------------------------- drawdowns ------------------------------- */
export function drawdownChart(el, dates, dd, overlay) {
  const W = widthOf(el), H = clamp(W * 0.36, 150, 200), P = { t: 12, r: 12, b: 26, l: 50 };
  const n = dates.length;
  const ticks = niceTicks(Math.min(...dd, ...overlay.dd, -0.01), 0, 3);
  const X = scaler(0, n, P.l, W - P.r), Y = scaler(ticks[0], 0, H - P.b, P.t);
  let g = '';
  ticks.forEach((v) => {
    g += `<line class="c-grid" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="c-axis" x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end">${pct(v, 0)}</text>`;
  });
  yearTicks(dates, Math.floor(W / 90)).forEach((t) => { g += `<text class="c-axis" x="${X(t.i + 1)}" y="${H - 8}" text-anchor="middle">${t.label}</text>`; });
  const area = `M${X(0)} ${Y(0)}` + dd.map((v, i) => `L${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('') + `L${X(n)} ${Y(0)}Z`;
  g += `<path d="${area}" style="fill:var(--down-soft);stroke:var(--down)" stroke-width="1.2"/>`;
  g += `<path d="${overlay.dd.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(v).toFixed(1)}`).join('')}" style="fill:none;stroke:${overlay.color}" stroke-width="1.6"/>`;
  g += `<line class="xhair hidden" y1="${P.t}" y2="${H - P.b}"/>`;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Drawdowns">${g}</svg>`;
  const svg = el.querySelector('svg'), xh = el.querySelector('.xhair');
  wireTips(el, {
    at(evt) {
      const i = Math.round(scaler(P.l, W - P.r, 0, n)(svgX(svg, evt, W)));
      if (i < 1 || i > n) return null;
      xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.classList.remove('hidden');
      return `<b>${dates[i - 1].slice(0, 7)}</b><br>Portfolio ${pct(dd[i])}<br>${esc(overlay.label)} ${pct(overlay.dd[i])}`;
    },
    hide() { xh.classList.add('hidden'); },
  });
}

/* --------------------- calendar-year excess return bars ------------------ */
/* rows: [{year, port, bench, partial}] */
export function yearBars(el, rows, benchLabel) {
  const W = widthOf(el), H = clamp(W * 0.5, 180, 240), P = { t: 14, r: 8, b: 28, l: 46 };
  const diffs = rows.map((r) => r.port - r.bench);
  const yT = niceTicks(Math.min(0, ...diffs), Math.max(0, ...diffs), 4);
  const Y = scaler(yT[0], yT.at(-1), H - P.b, P.t);
  const slot = (W - P.l - P.r) / rows.length, bw = Math.max(1.5, slot - 2);
  let g = '';
  yT.forEach((v) => {
    g += `<line class="${v === 0 ? 'c-zero' : 'c-grid'}" x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}"/><text class="c-axis" x="${P.l - 8}" y="${Y(v) + 4}" text-anchor="end">${pct(v, 0)}</text>`;
  });
  const every = [1, 2, 5, 10, 20, 25].find((s) => rows.length / s <= Math.floor(W / 80)) || 50;
  rows.forEach((r, i) => {
    const d = diffs[i], x = P.l + i * slot + (slot - bw) / 2;
    const y0 = Y(0), y1 = Y(d);
    const tip = `<b>${r.year}${r.partial ? ' YTD' : ''}</b><br>Portfolio ${pct(r.port)}<br>${esc(benchLabel)} ${pct(r.bench)}<br>Difference ${d >= 0 ? '+' : ''}${pct(d)}`;
    g += `<rect class="${d >= 0 ? 'bar-up' : 'bar-down'}${r.partial ? ' partial' : ''}" x="${x.toFixed(1)}" y="${Math.min(y0, y1).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y0)).toFixed(1)}" rx="${Math.min(2, bw / 3)}"/>`;
    g += `<rect class="hit" x="${(P.l + i * slot).toFixed(1)}" y="${P.t}" width="${slot.toFixed(1)}" height="${H - P.t - P.b}" data-tip="${esc(tip)}"/>`;
    if (r.year % every === 0) g += `<text class="c-axis" x="${(x + bw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle">${r.year}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Calendar-year return minus benchmark">${g}</svg>`;
  wireTips(el);
}

/* --------------------------- correlation heatmap ------------------------- */
export function heatmap(el, C, labels) {
  const n = labels.length, cell = 44, padL = 92, padT = 92, size = cell * n;
  let g = '';
  labels.forEach((l, i) => {
    g += `<text class="c-axis" x="${padL - 8}" y="${padT + i * cell + cell / 2 + 4}" text-anchor="end">${esc(l)}</text>`;
    g += `<text class="c-axis" transform="translate(${padL + i * cell + cell / 2 + 4} ${padT - 8}) rotate(-60)">${esc(l)}</text>`;
  });
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const c = C[i][j];
    const fill = c >= 0 ? `color-mix(in srgb, var(--accent) ${Math.round(c * 85)}%, var(--panel-2))`
      : `color-mix(in srgb, var(--warm) ${Math.round(-c * 85)}%, var(--panel-2))`;
    const x = padL + j * cell, y = padT + i * cell;
    g += `<rect x="${x + 1}" y="${y + 1}" width="${cell - 2}" height="${cell - 2}" rx="4" style="fill:${fill}" data-tip="${esc(`<b>${labels[i]} × ${labels[j]}</b><br>ρ = ${c.toFixed(2)}`)}"/>`;
    g += `<text class="c-cell${Math.abs(c) > 0.6 ? ' strong' : ''}" x="${x + cell / 2}" y="${y + cell / 2 + 4}" text-anchor="middle">${c.toFixed(2)}</text>`;
  }
  el.innerHTML = `<svg viewBox="0 0 ${padL + size + 8} ${padT + size + 8}" role="img" aria-label="Correlation matrix">${g}</svg>`;
  wireTips(el);
}

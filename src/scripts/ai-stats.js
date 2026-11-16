import { summarizeAIUsage, summarizeEfficiency, OUTCOMES, formatDuration } from '../lib/ai-usage.js';
import { formatUSD, planDescription } from '../lib/model-cost.js';
import { watchSubmissionUpdates } from '../lib/ai-activity.js';

const root = document.querySelector('[data-ai-stats]');
if (root?.dataset.api) initialize(root);
function initialize(root) {
  const api = root.dataset.api.replace(/\/$/, '');
  const $ = id => document.getElementById(id);
  const period = $('ai-stats-period');
  const fmt = n => n.toLocaleString('en-GB');
  const money = n => n ? formatUSD(n) : '$0.0000';
  // amounts in the usage section: cents from a dollar up, finer below
  const usd = n => n >= 1 ? `$${n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : money(n);
  const node = (tag, text, cls) => { const el = document.createElement(tag); el.textContent = text; if (cls) el.className = cls; return el; };
  const compact = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)} B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e4 ? `${Math.round(n / 1e3)} k` : fmt(Math.round(n));
  const pct = (part, whole) => whole ? `${Math.round((part / whole) * 100)}%` : '0%';
  // the price per million tokens a cost comes to
  const rate = (cost, tokens) => { const r = (cost / tokens) * 1e6; return `$${r.toFixed(r < 0.1 ? 3 : 2)}/M`; };
  const PARTS = { input: '#6cb0f5', cacheRead: '#8fd18a', cacheWrite: '#b9a0e8', output: '#c9a35a', reported: '#8a8f98' };
  // a stacked bar of the parts, with a key giving each part's value and share
  function bar(title, total, parts, show) {
    const all = parts.reduce((t, [, v]) => t + v, 0), box = node('div', '');
    const head = node('div', '', 'usage-bar-title'); head.append(node('span', title), node('span', total));
    const track = node('div', '', 'usage-bar'), key = node('ul', '', 'usage-key');
    for (const [label, value, color] of parts) {
      if (!value) continue;
      const seg = node('i', ''); seg.style.setProperty('--c', color); seg.style.width = `${(value / all) * 100}%`; seg.title = `${label}: ${show(value)}`;
      const li = node('li', ''), dot = node('i', ''); dot.style.setProperty('--c', color);
      li.append(dot, label, node('b', show(value)), node('span', pct(value, all)));
      track.append(seg); key.append(li);
    }
    box.append(head, track, key);
    return box;
  }
  // tokens, and under them what the priced runs' tokens of that kind cost and the price per
  // million they come to (none for runs whose cost OpenCode reported as one sum)
  function tokenCell(tokens, cost, estTokens, notes = []) {
    const td = node('td', compact(tokens), 'num'); td.title = `${fmt(tokens)} tokens`;
    if (estTokens) td.append(node('small', `${usd(cost)} · ${rate(cost, estTokens)}`));
    for (const [text, cls] of notes) if (tokens && text) td.append(node('small', text, cls));
    return td;
  }
  function modelRow(row, hasPlan) {
    const tr = document.createElement('tr'), none = row.unpriced === row.runs;
    if (none) tr.className = 'unpriced';
    const name = node('td', row.label, 'model-cell');
    if (!row.total) { name.title = row.model; name.append(node('small', [row.providerName, row.effort].filter(Boolean).join(' · '))); }
    tr.append(name, node('td', fmt(row.runs), 'num'),
      tokenCell(row.fresh, row.costInput, row.estFresh),
      tokenCell(row.cached, row.costCacheRead, row.estCached, [[`${pct(row.cached, row.fresh + row.cached + row.cacheWrite)} of input`], [row.cachedAtInput ? 'at input price' : '', 'warn']]),
      tokenCell(row.output, row.costOutput, row.estOutput));
    const cost = node('td', none ? 'no price' : usd(row.cost), 'num');
    if (row.reported) cost.append(node('small', row.reportedRuns === row.runs - row.unpriced ? 'reported by OpenCode' : `${usd(row.reported)} reported`));
    if (row.costCacheWrite >= 0.01) cost.append(node('small', `${usd(row.costCacheWrite)} cache writes`));
    if (!none && row.unpriced) cost.append(node('small', `${fmt(row.unpriced)} ${row.unpriced === 1 ? 'run' : 'runs'} without cost`));
    tr.append(cost);
    if (hasPlan) {
      const plan = node('td', row.planCost ? usd(row.planCost) : '—', 'num');
      if (row.plan) plan.append(node('small', row.plan.multiplier ? `API ÷ ${row.plan.multiplier}` : `$${row.plan.price_usd} buys $${row.plan.allowance_usd}`));
      else if (!row.total && !none) plan.append(node('small', 'paid as used'));
      tr.append(plan);
    }
    const priced = row.runs - row.unpriced;
    tr.append(node('td', priced && row.cost ? money(row.cost / priced) : '—', 'num'));
    return tr;
  }
  let busy = false, pending = false;
  async function refresh() {
    if (document.hidden) return;
    if (busy) { pending = true; return; }
    busy = true;
    const selected = period.value;
    try {
      const response = await fetch(`${api}/v1/stats/ai?period=${selected}`, { credentials:'omit', signal:AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error('unavailable');
      const data = await response.json();
      if (selected !== period.value) { pending = true; return; }
      const {rows, totals} = summarizeAIUsage(data.usage, data.plan);
      const hasPlan = rows.some(row => row.plan);
      const read = totals.fresh + totals.cached + totals.cacheWrite;
      const tiles = [
        [fmt(totals.runs), 'Research runs'], [fmt(totals.running), 'Running now'],
        [compact(read), `Tokens read, ${pct(totals.cached, read)} from cache`],
        [compact(totals.output), `Tokens written, ${pct(totals.reasoning, totals.output)} reasoning`],
        [usd(totals.cost), totals.unpriced ? `API cost of the ${fmt(totals.runs - totals.unpriced)} priced runs` : 'API cost'],
        ...(hasPlan ? [[usd(totals.planCost), 'Plan share: what the runs used of subscriptions']] : []),
      ];
      $('ai-stats-tiles').replaceChildren(...tiles.map(([value,label]) => {
        const tile = node('div', '', 'tile'); tile.append(node('div',value,'big'),node('div',label,'label')); return tile;
      }));
      $('ai-stats-split').replaceChildren(
        bar('Tokens, all models', compact(read + totals.output), [
          ['Fresh input', totals.fresh, PARTS.input], ['Cache reads', totals.cached, PARTS.cacheRead],
          ['Cache writes', totals.cacheWrite, PARTS.cacheWrite], ['Output', totals.output, PARTS.output]], compact),
        bar('API cost, priced models', usd(totals.cost), [
          ['Fresh input', totals.costInput, PARTS.input], ['Cache reads', totals.costCacheRead, PARTS.cacheRead],
          ['Cache writes', totals.costCacheWrite, PARTS.cacheWrite], ['Output', totals.costOutput, PARTS.output],
          ['Reported by OpenCode, not split', totals.reported, PARTS.reported]], usd));
      $('ai-stats-models').replaceChildren(...rows.map(row => modelRow(row, hasPlan)));
      $('ai-stats-total').replaceChildren(modelRow({ ...totals, label: 'All models', total: true }, hasPlan));
      root.querySelector('[data-plan-cost]').hidden = !hasPlan;
      $('ai-stats-status').textContent = `${rows.length ? 'Updated' : 'No research runs recorded for this period. Updated'} ${new Date(data.updated_at * 1000).toLocaleTimeString()}.`;
      const atInput = [...new Set(rows.filter(r => r.cachedAtInput && r.cached).map(r => `${r.label} on ${r.providerName}`))];
      // one line per provider and plan: "Swancloud, 15× plan (API value ÷ 15): Muse…, Claude Haiku 5.5"
      const byPlan = new Map();
      for (const r of rows.filter(r => r.plan)) {
        const key = `${r.providerName}, ${planDescription(r.plan)}`;
        byPlan.set(key, new Set([...(byPlan.get(key) ?? []), r.label]));
      }
      const plans = [...byPlan].map(([key, labels]) => `${key}: ${[...labels].join(', ')}`);
      const unpriced = rows.filter(r => r.unpriced).map(r => r.unpriced === r.runs ? r.model : `${r.model} (${fmt(r.unpriced)} of ${fmt(r.runs)} runs, no cost reported)`);
      const notes = [
        'API cost is what the tokens come to at each provider’s price per million tokens (src/lib/models.js), at the peak price for runs started in peak hours. Where OpenCode reports a run’s cost (pay-as-you-go keys such as xAI’s), that figure is used, and it is not split by kind of token.',
        ...(atInput.length ? [`No cache price was supplied for ${atInput.join(', ')}, so their cache reads are counted at the fresh-input price (marked “at input price”); the real cost is probably lower.`] : []),
        ...(hasPlan ? [`Plan share divides the API cost by what a subscription includes: the part of a monthly plan the runs used, not a separate bill. ${plans.join('; ')}. Models with no plan are paid as used.`] : []),
        ...(totals.unpriced ? [`${fmt(totals.unpriced)} ${totals.unpriced === 1 ? 'run' : 'runs'} (${compact(totals.unpricedTokens)} tokens) used models with no known price and are left out of every cost: ${unpriced.join(', ')}.`] : []),
        'Startup connectivity probes are excluded. Running and interrupted runs may have incomplete telemetry. Budget reservations are counted separately.',
      ];
      $('ai-stats-note').replaceChildren(...notes.map(t => node('li', t)));
      lastEfficiency = summarizeEfficiency(data.usage, data.durations ?? [], data.plan);
      drawEfficiency(lastEfficiency);
      $('ai-stats-content').hidden = false;
    } catch {
      if (selected === period.value) $('ai-stats-status').textContent = 'AI usage is unavailable. Start or update the backend; this page retries automatically.';
    } finally {
      busy = false;
      if (pending) { pending = false; refresh(); }
    }
  }
  // per model, what a new report, an update and an out-of-scope submission cost and take
  const COLORS = { new: '#6cb0f5', update: '#8fd18a', out_of_scope: '#c9a35a' };
  // costs as API prices or as the plan share (where a plan covers the model); the reader's choice
  let lastEfficiency = null, mode = 'api';
  try { if (localStorage.getItem('ai-cost-mode') === 'plan') mode = 'plan'; } catch { /* no storage */ }
  const avg = (o) => (mode === 'plan' ? o?.planAvgCost : o?.avgCost);
  const perNew = (m) => (mode === 'plan' ? m.planPerNew : m.perNew);
  $('ai-eff-mode').addEventListener('click', (e) => {
    const next = e.target.closest('[data-mode]')?.dataset.mode;
    if (!next || next === mode) return;
    mode = next;
    try { localStorage.setItem('ai-cost-mode', mode); } catch { /* no storage */ }
    if (lastEfficiency) drawEfficiency(lastEfficiency);
  });
  const MIN_RUNS = 3;
  const label = (m) => { const el = node('span', '', 'eff-label'); el.append(node('span', m.name), node('small', [m.provider, m.effort].filter(Boolean).join(' · ') || ' ')); el.title = m.model; return el; };
  const tip = (title, total, rows) => JSON.stringify({ t: title, s: total, rows });
  function panel(key, title, help, rows, value, text, extra, costs = false) {
    const box = node('div', '', 'eff-panel');
    const h = node('h4', ''); const dot = node('i', ''); dot.style.setProperty('--c', COLORS[key]); h.append(dot, title);
    box.append(h, node('p', help));
    const list = rows.filter((m) => (m.outcomes[key]?.runs ?? 0) >= MIN_RUNS && value(m) != null).sort((a, b) => value(a) - value(b));
    if (!list.length) { box.append(node('p', 'Not enough runs yet.', 'eff-empty')); return box; }
    const max = Math.max(...list.map((m) => extra?.(m) ?? value(m))) || 1;
    const ol = node('ol', '', 'eff-bars');
    list.forEach((m, i) => {
      const o = m.outcomes[key], li = node('li', '');
      if (i === 0 && list.length > 1) li.className = 'eff-best';
      li.tabIndex = 0;
      li.style.setProperty('--c', COLORS[key]);
      li.dataset.tip = tip(`${m.name} · ${title}`, `${fmt(o.runs)} runs${m.provider ? ` via ${m.provider}` : ''}${m.effort ? `, ${m.effort}` : ''}`, [
        ['', 'Average API price', o.avgCost == null ? '—' : money(o.avgCost)],
        ...(m.onPlan ? [['', 'Average plan share', money(o.planAvgCost)]] : []), ['', 'Average time', formatDuration(o.avgSeconds)],
        ['', 'Median time', formatDuration(o.median)], ['', 'Slowest tenth from', formatDuration(o.p90)]]);
      const track = node('span', '', 'eff-track'), bar = node('i', '');
      bar.style.width = `${(value(m) / max) * 100}%`;
      track.append(bar);
      if (extra?.(m) != null) { const tick = node('b', ''); tick.style.left = `${(extra(m) / max) * 100}%`; track.append(tick); }
      const num = node('span', text(m), 'eff-num');
      if (costs && mode === 'plan' && m.onPlan) num.append(node('span', 'plan', 'eff-plan'));
      li.append(label(m), num, track);
      ol.append(li);
    });
    box.append(ol);
    return box;
  }
  function drawEfficiency(models) {
    const box = $('ai-efficiency');
    box.hidden = !models.some((m) => OUTCOMES.some(([k]) => (m.outcomes[k]?.runs ?? 0) >= MIN_RUNS));
    if (box.hidden) return;
    const anyPlan = models.some((m) => m.onPlan);
    $('ai-eff-mode').hidden = !anyPlan;
    if (!anyPlan) mode = 'api';
    for (const b of $('ai-eff-mode').querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === mode));
    $('ai-eff-mode-note').textContent = mode === 'plan' ? 'As plan share: what the runs take of a subscription where a plan covers the model (marked “plan”); other models at API price.' : 'At API prices (or the cost OpenCode reports), whatever plan the model runs on.';
    $('ai-eff-cost').replaceChildren(...OUTCOMES.map(([key, title, help]) => panel(key, title, help, models, (m) => avg(m.outcomes[key]), (m) => money(avg(m.outcomes[key])), null, true)));
    $('ai-eff-time').replaceChildren(...OUTCOMES.map(([key, title, help]) => panel(key, title, help, models, (m) => m.outcomes[key]?.median, (m) => formatDuration(m.outcomes[key].median), (m) => m.outcomes[key]?.p90)));
    const cell = (o) => {
      const td = node('td', o?.runs ? (avg(o) == null ? '—' : money(avg(o))) : '–', 'num');
      if (o?.runs) td.append(node('small', `${fmt(o.runs)} · ${formatDuration(o.median ?? o.avgSeconds)}`));
      return td;
    };
    $('ai-eff-rows').replaceChildren(...models.map((m) => {
      const tr = document.createElement('tr'), name = node('td', m.name);
      name.append(node('small', [m.provider, m.effort].filter(Boolean).join(' · ')));
      tr.append(name, node('td', fmt(m.runs), 'num'), node('td', perNew(m) == null ? '—' : `${money(perNew(m))}${mode === 'plan' && m.onPlan ? ' plan' : ''}`, 'num'),
        cell(m.outcomes.new), cell(m.outcomes.update), cell(m.outcomes.out_of_scope), cell(m.outcomes.unfinished));
      return tr;
    }));
    $('ai-eff-note').textContent = 'Each cell: average cost per run, then runs · median time. "All in" divides everything the model ran, failed and rejected runs included, by the new reports it wrote. Duplicates, too little evidence and reviews are counted in the runs but not shown apart. Costs follow the switch above the charts: API prices (reported, or estimated from tokens) or plan share.';
  }
  period.addEventListener('change', () => { $('ai-stats-content').hidden = true; $('ai-stats-status').textContent = 'Loading AI usage…'; refresh(); });
  watchSubmissionUpdates(api, refresh);
  const timer = setInterval(refresh, 30000);
  window.addEventListener('pagehide', () => clearInterval(timer), {once:true});
  refresh();
}

import { runCost, costParts, planCost, modelPlan, isPriced } from './model-cost.js';
import { modelParts, modelInfo, isPeak, MODELS, PROVIDER_NAMES } from './models.js';
export { modelParts };

const SUMS = ['runs', 'running', 'input', 'output', 'cached', 'reasoning', 'fresh', 'cacheWrite', 'cost', 'planCost', 'unpriced',
  'reported', 'reportedRuns', 'costInput', 'costCacheRead', 'costCacheWrite', 'costOutput', 'unpricedTokens',
  'estFresh', 'estCached', 'estCacheWrite', 'estOutput'];

// Per model ("provider/model#variant") and in total: runs, tokens and what they cost.
// Tokens: `fresh` input, `cached` (cache reads), `cacheWrite`, `output` with `reasoning` in it, and
// `input` = fresh + cached + cacheWrite. Cost: `cost` is the API price; of it, `reported` is what
// OpenCode reported for its runs and the cost… parts what the rest comes to at models.js prices,
// for the est… tokens of those runs.
// `cachedAtInput`: no cache price was supplied, so cache reads are counted as fresh input.
// `unpriced` runs (and their `unpricedTokens`) have no price and are left out of the costs.
export function summarizeAIUsage(buckets, plan) {
  const models = new Map();
  for (const b of buckets) {
    const parts = modelParts(b.model), info = modelInfo(b.model);
    const row = models.get(b.model) || {
      model: b.model || 'Not recorded', ...parts, label: MODELS[parts.name]?.name ?? parts.name, providerName: PROVIDER_NAMES[parts.provider] ?? parts.provider,
      priced: Boolean(info), cachedAtInput: Boolean(info && info.cached == null), plan: modelPlan(b.model, plan),
      // the model's prices off-peak and, where it has peak hours, in them; `peakRuns` started in them
      price: info, peakRuns: 0,
      ...Object.fromEntries(SUMS.map((k) => [k, 0])),
    };
    if (info?.peak && !(b.cost_usd > 0) && isPeak(b.started_at, b.model)) row.peakRuns += b.runs;
    const fresh = b.input_tokens || 0, cached = b.cache_read_tokens || 0, write = b.cache_write_tokens || 0;
    const output = (b.output_tokens || 0) + (b.reasoning_tokens || 0);
    row.runs += b.runs;
    row.running += b.running;
    row.fresh += fresh;
    row.cached += cached;
    row.cacheWrite += write;
    row.input += fresh + cached + write;
    row.output += output;
    row.reasoning += b.reasoning_tokens || 0;
    if (b.cost_usd > 0) { row.reported += b.cost_usd; row.reportedRuns += b.runs; }
    else if (isPriced(b.model)) {
      const c = costParts(b);
      row.costInput += c.input; row.costCacheRead += c.cacheRead; row.costCacheWrite += c.cacheWrite; row.costOutput += c.output;
      row.estFresh += fresh; row.estCached += cached; row.estCacheWrite += write; row.estOutput += output;
    } else { row.unpriced += b.runs; row.unpricedTokens += fresh + cached + write + output; }
    row.cost += runCost(b);
    row.planCost = planCost(row.cost, plan, b.model);
    models.set(b.model, row);
  }
  const rows = [...models.values()].sort((a,b) => b.cost-a.cost || b.runs-a.runs || a.model.localeCompare(b.model));
  const totals = rows.reduce((sum, row) => {
    for (const key of SUMS) sum[key] += row[key];
    return sum;
  }, Object.fromEntries(SUMS.map((k) => [k, 0])));
  return { rows, totals };
}

// What each kind of work costs and takes per model: the outcome categories the service groups runs
// by (backend store.categorySQL); new reports, updates and out-of-scope submissions are compared.
export const OUTCOMES = [
  ['new', 'New report', 'A report about an event the tracker did not have'],
  ['update', 'Update', 'Another source or detail for a report it had'],
  ['out_of_scope', 'Outside scope', 'Not cannabis enforcement, or the Index’s matter'],
];
export const OTHER_OUTCOMES = [['other', 'Other outcomes'], ['unfinished', 'Failed or unfinished']];

// per model: for each outcome, the runs, cost (as summarizeAIUsage works it out), the average cost
// and time per run, and the median and p90 times; `perNew` is the cost of everything the model ran
// (failures and rejections included) for each new report it wrote. Costs are API prices; the
// `plan…` twins are the plan share where a plan covers the model (`onPlan`), else the same price.
export function summarizeEfficiency(buckets, durations = [], plan = null) {
  const models = new Map();
  const blank = () => ({ runs: 0, cost: 0, priced: 0, timed: 0, seconds: 0, median: null, p90: null });
  for (const b of buckets) {
    const m = models.get(b.model) || { model: b.model || '', runs: 0, cost: 0, outcomes: {} };
    const o = m.outcomes[b.category || 'unfinished'] ||= blank();
    const cost = runCost(b), priced = b.cost_usd > 0 || isPriced(b.model);
    o.runs += b.runs; o.timed += b.timed || 0; o.seconds += b.duration_seconds || 0;
    if (priced) { o.cost += cost; o.priced += b.runs; }
    m.runs += b.runs; if (priced) m.cost += cost;
    models.set(b.model, m);
  }
  for (const d of durations) {
    const o = models.get(d.model)?.outcomes[d.category];
    if (o) { o.median = d.median_seconds; o.p90 = d.p90_seconds; }
  }
  return [...models.values()].map((m) => {
    for (const o of Object.values(m.outcomes)) {
      o.avgCost = o.priced ? o.cost / o.priced : null;
      o.avgSeconds = o.timed ? o.seconds / o.timed : null;
      // what the run takes of a subscription where one covers the model, else its API price
      o.planAvgCost = o.avgCost == null ? null : planCost(o.avgCost, plan, m.model) || o.avgCost;
    }
    const made = m.outcomes.new?.runs || 0, perNew = made && m.cost ? m.cost / made : null;
    return { ...m, ...modelParts(m.model), perNew, planPerNew: perNew == null ? null : planCost(perNew, plan, m.model) || perNew, onPlan: Boolean(modelPlan(m.model, plan)) };
  }).sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model));
}

// "45 s", "3 min 20 s", "1 h 5 min"
export function formatDuration(seconds) {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(s / 3600)} h${Math.round((s % 3600) / 60) ? ` ${Math.round((s % 3600) / 60)} min` : ''}`;
}

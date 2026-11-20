// The saved runs (benchmark/results/*.json) and the case files, for the benchmark's pages.
import * as yaml from "js-yaml";
import { apiCostParts, costParts, modelPlan } from "../../src/lib/model-cost.js";
import { MODELS, apiPrice, standardModel } from "../../src/lib/models.js";
import { aggregate, entryKey, proseOf, sameModel, trackerKey, trackerProse } from "../lib/prose-score.mjs";

const files = import.meta.glob("../results/*.json", { eager: true, import: "default" });
const proseFiles = import.meta.glob("../results/prose/*.json", { eager: true, import: "default" });
const caseFiles = import.meta.glob("../cases/*.yaml", { eager: true, query: "?raw", import: "default" });

export const runs = Object.values(files)
  .filter((run) => run?.schema === 1 && run.summary)
  .sort((a, b) => (b.summary.score ?? -1) - (a.summary.score ?? -1) || b.started_at.localeCompare(a.started_at));

export const cases = Object.values(caseFiles)
  .map((text) => yaml.load(text))
  .sort((a, b) => a.id.localeCompare(b.id));

// How the texts read, ranked by judging models (judge-prose.mjs), all judges pooled.
export const prose = aggregate(Object.values(proseFiles));
export const trackerProseScore = trackerProse(prose);
const proseTip = (name, p) => (p
  ? tip(name, `prose ${score(p.score)} of 100 · ${p.cases} cases judged`, [
    ...Object.entries(p.judges).map(([judge, value]) => ["", `Judge ${judge}`, score(value)]),
    ...(p.vs ? [["", "Ranked above the tracker's own text", `${Math.round((100 * p.beats) / p.vs)}%`]] : []),
  ])
  : tip(name, prose.judges.length ? "no report text of it has been judged" : "no prose judgments yet"));

export const FAMILIES = { "new-event": "New events", "known-event": "Already covered", "out-of-scope": "Out of scope" };
export const FAMILY_NOTE = {
  "new-event": "A real event the tracker does not have yet. The model has to recognise it and write the report: facts, figures, sources, photos. Some have a look-alike in the tracker (same place, same day or same weight) that it must not be merged into.",
  "known-event": "Another page about an event the tracker already has: a reprint, a translation, a headline about the other drugs in the raid, a later step in the case. The model has to find the report and add to it, not write a second one.",
  "out-of-scope": "A page that looks relevant and is not: synthetic cannabinoids, a law change, statistics, cannabis only in passing.",
};
export const CAPABILITIES = {
  recognised: ["Recognised", "Saw that the page reports a cannabis enforcement event and wrote a report"],
  facts: ["Facts", "Country, date of the event, kind of event and place on the map"],
  figures: ["Figures", "Kilograms, plants, hectares, people, money: right numbers, converted units, nothing invented"],
  classification: ["Classification", "Product, case stage, setting, agencies, smuggling route"],
  corroboration: ["Corroboration", "Found other outlets reporting the same event and used them"],
  photos: ["Photos", "Linked real photos of the event with a working address; left out stand-in pictures"],
  text: ["Text", "The report says the key points and lists what stays open"],
  grounding: ["Grounding", "Sentences and figures backed by a quotation found in the opened source"],
};

// Runs are compared only within one set: the same cases, the same run settings, the same scoring rules.
export const setOf = (run) => `${run.cases_hash}·${run.protocol_hash}·${run.scorer_version}`;

export function sets() {
  const groups = new Map();
  for (const run of runs) {
    const key = run.full_set && run.complete ? setOf(run) : "partial";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const full = [...groups.entries()].filter(([key]) => key !== "partial").map(([key, list]) => ({ key, runs: list, latest: list.map((r) => r.started_at).sort().at(-1) }));
  full.sort((a, b) => b.latest.localeCompare(a.latest));
  return { full, partial: groups.get("partial") || [] };
}

export const day = (iso) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
export const score = (value) => (value == null ? "–" : String(Math.round(value)));
export const band = (value) => (value == null ? "none" : value >= 85 ? "pass" : value >= 50 ? "part" : "fail");
export const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));

// ── Charts ────────────────────────────────────────────────────────────────────────────────────
// Verdict colours are the same three everywhere, always in this order, always with their word
// beside them (benchmark.css; chosen to stay apart for colour-blind readers, not green against red).
export const VERDICTS = [
  ["pass", "Pass", "var(--b-pass)"],
  ["partial", "Partial", "var(--b-part)"],
  ["fail", "Fail", "var(--b-fail)"],
  ["off", "Unfinished or not counted", "var(--b-off)"],
];
export function verdictCounts(run) {
  const v = run.summary.verdicts;
  return { pass: v.pass || 0, partial: v.partial || 0, fail: v.fail || 0, off: (v.error || 0) + (v.skipped || 0) + (v.spoiled || 0) };
}
// Heat cells show what was lost: the further a score is from 100, the stronger the wash.
export const heat = (value) => (value == null ? "" : `--loss:${Math.round(Math.max(0, Math.min(100, 100 - value)))}`);
export const tip = (t, s, rows) => JSON.stringify({ t, s, ...(rows ? { rows } : {}) });
export const modelName = (run) => run.subject.model + (run.subject.effort ? `#${run.subject.effort}` : "");
export const subjectLine = (run) => `${run.subject.harness}${run.subject.harness_version ? ` ${run.subject.harness_version.replace(/^\D+/, "")}` : ""} · ${run.subject.provider}`;
export const verdictOf = (value) => (value == null ? "off" : value >= 85 ? "pass" : value >= 50 ? "partial" : "fail");

// ── Tokens and cost ───────────────────────────────────────────────────────────────────────────
// A run's tokens per case, by kind: fresh input, input read from the provider's cache, and output
// (reasoning included). Every repeat of every case counts.
export function tokenSplit(run) {
  const u = run.summary.usage;
  const n = Math.max(1, run.summary.attempts);
  const per = (value) => Math.round((value || 0) / n);
  const split = { fresh: per(u.input_tokens), cached: per(u.cache_read_tokens) + per(u.cache_write_tokens), output: per(u.output_tokens) + per(u.reasoning_tokens) };
  return { ...split, total: split.fresh + split.cached + split.output };
}
export const tokensPerCase = (run) => tokenSplit(run).total;

// What one case costs. The headline is the tokens at the maker's own list price (models.js `api`):
// the same basis for every provider and plan, so models compare. Beside it, where known, the
// price at the provider that served the run, its subscription share, and what the harness reported.
// null when the model has no list price.
const recordedModel = (run) => run.subject.recorded || `${run.subject.provider}/${run.subject.model}`;
export function costOf(run, usage = run.summary.usage, attempts = run.summary.attempts) {
  const n = Math.max(1, attempts);
  const model = recordedModel(run);
  const tokens = { model, started_at: Date.parse(run.started_at) / 1000, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, reasoning_tokens: usage.reasoning_tokens, cache_read_tokens: usage.cache_read_tokens, cache_write_tokens: usage.cache_write_tokens || 0 };
  const list = apiCostParts(tokens);
  if (!list) return null;
  const price = apiPrice(model);
  const atProvider = costParts(tokens)?.total ?? null;
  const plan = modelPlan(model);
  return {
    perCase: list.total / n,
    total: list.total,
    unconfirmed: Boolean(price.unconfirmed),
    source: price.source,
    providerPerCase: atProvider == null ? null : atProvider / n,
    planPerCase: atProvider != null && plan?.multiplier > 0 ? atProvider / n / plan.multiplier : null,
    planMultiplier: plan?.multiplier || null,
    reportedPerCase: usage.cost_usd > 0 ? usage.cost_usd / n : null,
  };
}
export const costRows = (cost) => [
  ["", "At the maker's list price", usd(cost.perCase)],
  ...(cost.providerPerCase != null ? [["", "At the provider's price", usd(cost.providerPerCase)]] : []),
  ...(cost.planPerCase != null ? [["", `Share of its plan (÷${cost.planMultiplier})`, usd(cost.planPerCase)]] : []),
  ...(cost.reportedPerCase != null ? [["", "Reported by the harness", usd(cost.reportedPerCase)]] : []),
  ["", "Price source", `${cost.source}${cost.unconfirmed ? " (unconfirmed)" : ""}`],
];

// ── One model and variant, across runs and providers ──────────────────────────────────────────
// The model a run used, without its provider, maker prefix or free-promotion suffix, with its effort:
// "swancloud/deepseek-v4.1-flash#max" and "opencode-go/deepseek-v4.1-flash#max" are one variant.
export function variantOf(run) {
  const key = standardModel(recordedModel(run)) || run.subject.model.split("/").pop();
  const effort = run.subject.effort ? `#${run.subject.effort}` : "";
  return { key: `${key}${effort}`, name: `${MODELS[key]?.name ?? key}${effort ? ` · ${run.subject.effort}` : ""}`, model: key };
}

// ── Rows for the leaderboard, heat table and case matrix ──────────────────────────────────────
const repeatsOf = (run) => Math.max(1, Math.round(run.summary.attempts / Math.max(1, run.summary.cases)));
const familyRows = (get) => Object.keys(FAMILIES).map((family) => ["", FAMILIES[family], score(get(family))]);

// one run as a row; `label` "subject" names it by harness and provider (on its variant's page)
export function runRow(run, base, label = "model") {
  const s = run.summary;
  const where = `${run.subject.harness} · ${run.subject.provider}`;
  return {
    id: run.id, href: `${base}benchmark/${run.id}/`,
    name: label === "model" ? modelName(run) : where,
    sub: `${label === "model" ? subjectLine(run) : `${String(run.subject.harness_version || "").replace(/^\D+/, "")} · ${day(run.started_at)}`}${repeatsOf(run) > 1 ? ` · ${repeatsOf(run)} repeats` : ""}${run.label ? ` · ${run.label}` : ""}`,
    score: s.score, range: s.attempt_scores.length > 1 ? [Math.min(...s.attempt_scores), Math.max(...s.attempt_scores)] : null,
    scoreRows: [...familyRows((family) => s.families[family]?.score), ...(s.attempt_scores.length > 1 ? s.attempt_scores.map((value, i) => ["", `Repeat ${i + 1}`, String(value)]) : [])],
    v: verdictCounts(run), attempts: s.attempts, min: s.usage.minutes_per_case, steps: s.usage.steps_per_case, t: tokenSplit(run), cost: costOf(run),
    families: Object.fromEntries(Object.keys(FAMILIES).map((family) => [family, s.families[family]?.score])),
    capabilities: Object.fromEntries(Object.entries(s.capabilities).map(([key, value]) => [key, value.score])),
    prose: proseOf([run], prose),
    caseScore: (id) => run.cases.find((item) => item.id === id)?.score,
    caseHref: (id) => `${base}benchmark/${run.id}/#${id}`,
  };
}

// one model and variant, pooled over its runs, as a row that opens the variant's page
export function variantRow(g, base) {
  const href = `${base}benchmark/model/${g.slug}/`;
  return {
    id: g.key, href, name: g.name,
    sub: `${g.runs.length} ${g.runs.length === 1 ? "run" : "runs"} · ${g.providers.join(", ")}`,
    score: g.score, range: g.repeatScores.length > 1 ? [Math.min(...g.repeatScores), Math.max(...g.repeatScores)] : null,
    scoreRows: [...familyRows((family) => g.families[family]), ...g.runs.map((run) => ["", `${run.subject.harness} · ${run.subject.provider}${repeatsOf(run) > 1 ? ` ×${repeatsOf(run)}` : ""}`, score(run.summary.score)])],
    v: { pass: g.verdicts.pass, partial: g.verdicts.partial, fail: g.verdicts.fail, off: g.verdicts.error + g.verdicts.skipped + g.verdicts.spoiled },
    attempts: g.attempts, min: g.minutes, steps: null, t: g.tokens,
    // a provider's own price or plan says nothing for a pool of several providers
    cost: g.cost && g.providers.length > 1 ? { ...g.cost, providerPerCase: null, planPerCase: null, reportedPerCase: null } : g.cost,
    families: g.families, capabilities: g.capabilities,
    prose: proseOf(g.runs, prose),
    caseScore: (id) => g.caseScores.get(id),
    caseHref: (id) => `${href}#case-${id}`,
  };
}

// the variant's page address: "deepseek-v4.1-flash#max" → "deepseek-v4-1-flash-max"
export const variantSlug = (key) => key.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export const caseHref = (base, id) => `${base}benchmark/case/${id}/`;
export const attemptId = (caseId, index) => `attempt-${caseId}-${index + 1}`;

export function caseAnalysis(id, base) {
  const current = new Set(sets().full[0]?.runs.map((run) => run.id));
  const variants = new Map();
  const attempts = [];
  for (const run of runs) {
    const item = run.cases.find((result) => result.id === id);
    if (!item) continue;
    const variant = variantOf(run);
    if (!variants.has(variant.key)) variants.set(variant.key, { ...variant, runs: [], current: [] });
    const group = variants.get(variant.key);
    group.runs.push(run);
    item.attempts.forEach((attempt, index) => {
      const row = {
        key: entryKey(id, run.id, index),
        href: `${base}benchmark/${run.id}/#${attemptId(id, index)}`,
        name: variant.name, subject: subjectLine(run), timestamp: run.started_at,
        repeat: item.attempts.length > 1 ? index + 1 : null,
        current: current.has(run.id),
        attempt,
      };
      attempts.push(row);
      if (row.current) group.current.push(row);
    });
  }

  const models = [...variants.values()].map((group) => {
    const scores = group.current.map(({ attempt }) => attempt.score).filter((value) => value != null);
    return {
      name: group.name,
      href: group.current.length ? `${base}benchmark/model/${variantSlug(group.key)}/#case-${id}` : null,
      score: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      low: scores.length > 1 ? Math.min(...scores) : null,
      high: scores.length > 1 ? Math.max(...scores) : null,
      pass: group.current.filter(({ attempt }) => attempt.verdict === "pass").length,
      scored: scores.length,
      count: group.current.length,
      prose: proseOf(group.runs, prose, id),
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (b.prose?.score ?? -1) - (a.prose?.score ?? -1) || a.name.localeCompare(b.name));

  const notes = new Map();
  for (const file of Object.values(proseFiles)) {
    if (!file?.judge?.id) continue;
    for (const round of file.rounds || []) {
      if (round.case !== id || round.ranking.length < 2) continue;
      for (const [key, note] of Object.entries(round.notes || {})) {
        if (!note || sameModel(file.judge.model, round.models?.[key])) continue;
        if (!notes.has(key)) notes.set(key, new Map());
        const byJudge = notes.get(key);
        if (!byJudge.has(file.judge.id)) byJudge.set(file.judge.id, new Set());
        byJudge.get(file.judge.id).add(note);
      }
    }
  }
  const rating = (key) => {
    const entry = prose.entries.get(key);
    return entry && {
      score: entry.score,
      judges: Object.entries(entry.judges).map(([judge, value]) => ({ judge, score: value, notes: [...(notes.get(key)?.get(judge) ?? [])] })),
    };
  };
  const texts = attempts.flatMap((row) => {
    const result = rating(row.key);
    return result ? [{ ...row, rating: result }] : [];
  }).sort((a, b) => b.rating.score - a.rating.score);
  attempts.sort((a, b) => Number(b.current) - Number(a.current) || (b.attempt.score ?? -1) - (a.attempt.score ?? -1) || a.name.localeCompare(b.name));
  return { models, attempts, texts, reference: rating(trackerKey(id)) };
}

// the ranked runs (newest full set) pooled by variant, with every other run of the same variant
export function rankedVariants() {
  const { full } = sets();
  const pooled = byVariant(full[0]?.runs ?? []);
  for (const variant of pooled) variant.others = runs.filter((run) => variantOf(run).key === variant.key && !variant.runs.includes(run));
  return pooled;
}

const median = (values) => {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Pools every case result of the given runs by variant: a case's score is the mean of all its
// results, from every run and provider, and the variant's score the mean over cases, as for one run.
export function byVariant(list) {
  const groups = new Map();
  for (const run of list) {
    const v = variantOf(run);
    if (!groups.has(v.key)) groups.set(v.key, { ...v, runs: [] });
    groups.get(v.key).runs.push(run);
  }
  return [...groups.values()].map((group) => {
    const perCase = new Map();
    const usage = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0 };
    const seconds = [];
    const verdicts = { pass: 0, partial: 0, fail: 0, error: 0, skipped: 0, spoiled: 0 };
    let attempts = 0;
    for (const run of group.runs) {
      for (const item of run.cases) {
        if (!perCase.has(item.id)) perCase.set(item.id, { family: item.family, scores: [] });
        for (const a of item.attempts) {
          attempts += 1;
          verdicts[a.verdict] = (verdicts[a.verdict] || 0) + 1;
          if (a.score != null) perCase.get(item.id).scores.push(a.score);
          for (const key of Object.keys(usage)) usage[key] += a.usage?.[key] || 0;
          if (a.usage?.seconds != null) seconds.push(a.usage.seconds);
        }
      }
    }
    const caseMeans = [...perCase.values()].filter((c) => c.scores.length).map((c) => ({ family: c.family, mean: c.scores.reduce((x, y) => x + y, 0) / c.scores.length }));
    const avg = (rows) => (rows.length ? Math.round((rows.reduce((x, r) => x + r.mean, 0) / rows.length) * 10) / 10 : null);
    const families = Object.fromEntries(Object.keys(FAMILIES).map((family) => [family, avg(caseMeans.filter((c) => c.family === family))]));
    // every repeat of every run, for the range the score moves in
    const repeatScores = group.runs.flatMap((run) => (run.summary.attempt_scores.length ? run.summary.attempt_scores : [run.summary.score])).filter((value) => value != null);
    const first = group.runs[0];
    const n = Math.max(1, attempts);
    const split = { fresh: Math.round(usage.input_tokens / n), cached: Math.round((usage.cache_read_tokens + usage.cache_write_tokens) / n), output: Math.round((usage.output_tokens + usage.reasoning_tokens) / n) };
    // report parts: each run's part score, weighted by how many case results it rests on
    const capabilities = {};
    for (const key of Object.keys(CAPABILITIES)) {
      const parts = group.runs.map((run) => [run.summary.capabilities[key]?.score, run.summary.attempts]).filter(([value]) => value != null);
      const weight = parts.reduce((sum, [, w]) => sum + w, 0);
      if (weight) capabilities[key] = Math.round((parts.reduce((sum, [value, w]) => sum + value * w, 0) / weight) * 10) / 10;
    }
    return {
      ...group,
      slug: variantSlug(group.key),
      score: avg(caseMeans),
      caseScores: new Map([...perCase.entries()].filter(([, c]) => c.scores.length).map(([id, c]) => [id, c.scores.reduce((x, y) => x + y, 0) / c.scores.length])),
      capabilities,
      families,
      repeatScores,
      providers: [...new Set(group.runs.map((run) => `${run.subject.harness} · ${run.subject.provider}`))],
      attempts,
      verdicts,
      tokens: { ...split, total: split.fresh + split.cached + split.output },
      minutes: seconds.length ? Math.round((median(seconds) / 60) * 10) / 10 : null,
      cost: costOf(first, usage, attempts),
    };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
}

// "$0.023", "$1.20"; a dash when the model has no price
export const proseTipOf = (row) => proseTip(row.name, row.prose);
export const usd = (value) => (value == null ? "–" : value >= 1 ? `$${value.toFixed(2)}` : value >= 0.01 ? `$${value.toFixed(3)}` : `$${value.toFixed(4)}`);

// A run's files: results/<id>.json (scores and what the site shows) and results/raw/<id>.json.gz
// (everything the service returned, so the run can be scored again when the rules change).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { FAMILIES } from "./cases.mjs";
import { DIMENSIONS, SCORER_VERSION, WEIGHTS, scoreCase, summarize } from "./score.mjs";
import { RESULTS } from "./util.mjs";

const rawFile = (id) => path.join(RESULTS, "raw", `${id}.json.gz`);
const runFile = (id) => path.join(RESULTS, `${id}.json`);

export function saveRaw(id, raw) {
  fs.mkdirSync(path.dirname(rawFile(id)), { recursive: true });
  fs.writeFileSync(rawFile(id), zlib.gzipSync(JSON.stringify(raw)));
}

export function loadRaw(id) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(rawFile(id))).toString("utf8"));
}

export function listRuns() {
  if (!fs.existsSync(RESULTS)) return [];
  return fs.readdirSync(RESULTS).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).sort();
}

export const loadRun = (id) => JSON.parse(fs.readFileSync(runFile(id), "utf8"));

// meta: what was run (subject, protocol, commits, times). cases: the case files. raw: { caseId: [records] }.
export function buildRun(meta, cases, raw) {
  const scored = [];
  for (const item of cases) {
    // a case that was renamed keeps the output recorded under its earlier id
    const all = raw[item.id] || (item.formerly || []).map((id) => raw[id]).find(Boolean) || [];
    // one result per submission (an earlier version could save a stopped run's cases twice)
    const seen = new Set();
    const records = all.filter((record) => !record.submission_id || (!seen.has(record.submission_id) && seen.add(record.submission_id)));
    if (!records.length) continue;
    scored.push({
      id: item.id,
      title: item.title,
      family: item.family,
      tests: item.tests || [],
      why: item.why.trim(),
      submit: item.submit,
      expect: item.expect,
      attempts: records.map((record) => scoreCase(item, record)),
    });
  }
  return {
    schema: 1,
    ...meta,
    scorer_version: SCORER_VERSION,
    weights: WEIGHTS,
    dimensions: DIMENSIONS,
    families: FAMILIES,
    summary: summarize(scored),
    cases: scored,
  };
}

export function saveRun(run) {
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(runFile(run.id), JSON.stringify(run, null, 1) + "\n");
  return runFile(run.id);
}

const pad = (text, width) => String(text).padEnd(width);
const num = (value) => (value == null ? "  –" : String(Math.round(value)).padStart(3));

export function printRun(run) {
  const s = run.summary;
  const lines = [];
  lines.push("", `${run.subject.id}   harness ${run.subject.harness} ${run.subject.harness_version || ""}`.trim());
  lines.push(`Score ${s.score ?? "–"} / 100   (${s.cases} cases, ${s.attempts} runs: ${s.verdicts.pass} pass, ${s.verdicts.partial} partial, ${s.verdicts.fail} fail${s.verdicts.error ? `, ${s.verdicts.error} did not finish` : ""}${s.verdicts.skipped ? `, ${s.verdicts.skipped} skipped` : ""}${s.verdicts.spoiled ? `, ${s.verdicts.spoiled} spoiled` : ""})${run.complete ? "" : "   NOT FINISHED"}`);
  if (s.attempt_scores.length > 1) lines.push(`Per repeat: ${s.attempt_scores.join(", ")}`);
  lines.push("", "By kind of case:");
  for (const [key, value] of Object.entries(s.families)) lines.push(`  ${pad(FAMILIES[key], 22)} ${num(value.score)}   (${value.cases} cases)`);
  if (Object.keys(s.capabilities).length) {
    lines.push("", "Inside the reports it wrote (new events):");
    const names = { recognised: "Recognised as an event", ...DIMENSIONS };
    for (const [key, value] of Object.entries(s.capabilities)) lines.push(`  ${pad(names[key], 22)} ${num(value.score)}   (${value.cases} cases)`);
  }
  lines.push("", "Cases:");
  for (const item of run.cases) {
    const last = item.attempts[item.attempts.length - 1];
    lines.push(`  ${num(item.score)}  ${pad(item.id, 36)} ${last.decision.got}${last.decision.note ? ` (${last.decision.note.slice(0, 80)})` : ""}`);
  }
  const u = s.usage;
  lines.push("", `Typical case: ${u.minutes_per_case ?? "?"} min, ${u.steps_per_case ?? "?"} steps. Tokens: ${u.input_tokens.toLocaleString("en")} in, ${u.output_tokens.toLocaleString("en")} out${u.cost_usd ? `, $${u.cost_usd}` : ""}.`);
  console.log(lines.join("\n"));
}

export function printTable(runs) {
  const rows = runs.map((run) => ({
    subject: run.subject.id,
    score: run.summary.score,
    new: run.summary.families["new-event"]?.score,
    known: run.summary.families["known-event"]?.score,
    scope: run.summary.families["out-of-scope"]?.score,
    cases: run.summary.cases,
    repeats: Math.round(run.summary.attempts / Math.max(1, run.summary.cases)),
    set: run.complete && run.full_set ? `${run.cases_hash}/p${run.protocol?.version}/s${run.scorer_version}` : run.complete ? "some cases only" : "not finished",
    id: run.id,
  }));
  const ranked = (row) => (/^(not finished|some cases only)$/.test(row.set) ? 0 : 1);
  rows.sort((a, b) => ranked(b) - ranked(a) || (b.score ?? -1) - (a.score ?? -1));
  console.log(`${pad("Harness @ provider / model # effort", 58)} Score  New Known Scope  Cases  Set`);
  for (const row of rows) console.log(`${pad(row.subject, 58)} ${num(row.score)}   ${num(row.new)}  ${num(row.known)}   ${num(row.scope)}  ${String(row.cases).padStart(3)}×${row.repeats}  ${row.set}  ${row.id}`);
}

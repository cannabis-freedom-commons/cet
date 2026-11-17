#!/usr/bin/env node
// Judge how the report texts read. For each case, every text the runs wrote (and the tracker's own
// published text) goes to a judging model through Claude Code or OpenCode, shuffled and without
// model names; it ranks them best first. Each judge keeps its rounds in
// results/prose/<judge>.json; the site pools all judges. See benchmark/README.md, "Prose".
//
// A case is judged again only when it has fewer than --rounds rounds by this judge that showed all
// of its current texts (new runs add texts), so the command can be run after every new run.
import { parseArgs } from "node:util";
import { loadCases } from "./lib/cases.mjs";
import { askOpenCode, openCodeVersion } from "./lib/prose-opencode.mjs";
import { aggregate, proseOf, trackerProse } from "./lib/prose-score.mjs";
import { MIN_TEXTS, askClaude, claudeVersion, collectEntries, fullRounds, loadAllJudges, loadJudge, promptFor, readRanking, rubric, rubricHash, saveJudge, shuffleLabels } from "./lib/prose.mjs";
import { listRuns, loadRun } from "./lib/results.mjs";
import { BENCH, parseSubject, readJSON } from "./lib/util.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string" },
    effort: { type: "string" },
    rounds: { type: "string", default: "1" },
    concurrency: { type: "string", default: "2" },
    cases: { type: "string", default: "" },
    scores: { type: "boolean" },
    "dry-run": { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
if (values.help) {
  console.log(`Usage: npm run benchmark:prose -- [opencode@provider/model#effort] [options]

Without a positional model, use Claude Code with --model (default claude-opus-5-5)
and --effort (default medium). With OpenCode, put the optional effort in the model spec.

  --cases a,b        judge only these cases
  --rounds N         complete rounds per case (default 1)
  --concurrency N    rounds run at once (default 2)
  --dry-run          list pending rounds without calling a model
  --scores           print pooled scores without calling a model`);
  process.exit(0);
}
const target = Number(values.rounds);
const concurrency = Number(values.concurrency);
const only = values.cases.split(",").filter(Boolean);
const runs = listRuns().map(loadRun);

if (values.scores) {
  printScores();
  process.exit(0);
}

let judge;
try {
  if (![target, concurrency].every((n) => Number.isInteger(n) && n > 0)) {
    throw new Error("--rounds and --concurrency need positive integers");
  }
  if (positionals.length > 1 || (positionals.length && (values.model !== undefined || values.effort !== undefined))) {
    throw new Error("Use one OpenCode model spec or the Claude Code --model and --effort options");
  }
  if (positionals.length) {
    const subject = parseSubject(positionals[0]);
    if (subject.harness !== "opencode") throw new Error("Use opencode@provider/model#effort for an OpenCode judge");
    judge = { id: subject.id, tool: "opencode", model: `${subject.provider}/${subject.model}`, effort: subject.effort };
  } else {
    const model = values.model ?? "claude-opus-5-5";
    const effort = values.effort ?? "medium";
    judge = { id: `${model}${effort ? `#${effort}` : ""}`, tool: "claude", model, effort };
  }
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const { id, tool, model, effort } = judge;
const isOpenCode = tool === "opencode";
const protocol = readJSON(`${BENCH}/protocol.json`);
const work = collectEntries(runs, loadCases(only), { reportsCommit: protocol.reports_commit });
const file = loadJudge(judge);
const system = rubric();
const hash = rubricHash();

const jobs = [];
for (const { item, entries } of work) {
  const keys = entries.map((entry) => entry.key);
  for (let n = fullRounds(file, item.id, keys); n < target; n += 1) jobs.push({ item, entries });
}

const chars = jobs.reduce((sum, job) => sum + promptFor(job.item, shuffleLabels(job.entries)).length, 0);
console.log(`Judge ${id} via the ${tool} CLI · ${work.length} cases with ${MIN_TEXTS} or more texts · ${jobs.length} rounds to run (${target} a case) · about ${Math.round(chars / 4 / 1000)}k input tokens`);
if (values["dry-run"]) {
  for (const job of jobs) console.log(`  ${job.item.id}: ${job.entries.length} texts`);
  process.exit(0);
}
if (!jobs.length) {
  console.log("Nothing to judge: every case has enough rounds by this judge. Use --rounds N for more.");
  printScores();
  process.exit(0);
}

try {
  file.judge.tool_version = isOpenCode ? openCodeVersion() : claudeVersion();
} catch (error) {
  console.error(`Could not run OpenCode: ${error.code || error.message}`);
  process.exit(1);
}
const askJudge = isOpenCode ? askOpenCode : askClaude;
let done = 0;
let failed = 0;
const spent = { input: 0, output: 0, usd: 0 };
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const labelled = shuffleLabels(job.entries);
    const prompt = promptFor(job.item, labelled);
    let lastError;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const { answer, usage } = await askJudge({ model, effort, system, prompt });
        const { ranking, notes } = readRanking(answer, labelled);
        file.rounds.push({
          case: job.item.id,
          at: new Date().toISOString(),
          rubric: hash,
          shown: labelled.map((entry) => entry.key),
          ranking,
          notes,
          models: Object.fromEntries(job.entries.map((entry) => [entry.key, entry.model])),
          usage,
        });
        saveJudge(file); // every round is kept at once, so a stop loses only rounds in flight
        done += 1;
        spent.input += usage.input_tokens + usage.cache_read_tokens + usage.cache_write_tokens;
        spent.output += usage.output_tokens;
        spent.usd += usage.cost_usd;
        console.log(`  ${job.item.id}: ranked ${ranking.length} texts (${usage.seconds}s${usage.cost_usd ? `, $${usage.cost_usd.toFixed(3)}` : ""})`);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        // a login or quota problem will not go away on its own: stop everything
        if (/authenticat|login|OAuth|rate limit|usage limit|credit/i.test(error.message)) {
          console.error(`Stopped: ${error.message}`);
          next = jobs.length;
          break;
        }
      }
    }
    if (lastError) {
      failed += 1;
      console.error(`  ${job.item.id}: not judged: ${lastError.message}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
console.log(`\n${done} rounds saved, ${failed} failed. Tokens ${spent.input} in, ${spent.output} out${spent.usd ? `, $${spent.usd.toFixed(2)}` : ""}.`);
printScores();
if (failed) process.exitCode = 1;

function printScores() {
  const agg = aggregate(loadAllJudges());
  if (!agg.judges.length) {
    console.log("No prose judgments yet.");
    return;
  }
  console.log(`\nProse (0-100, place among the texts on the same event), judges: ${agg.judges.map((j) => `${j.id} (${j.rounds} rounds, ${j.cases} cases)`).join(", ")}`);
  const bySubject = new Map();
  for (const run of runs) bySubject.set(run.subject.id, [...(bySubject.get(run.subject.id) || []), run]);
  const rows = [...bySubject].map(([subject, list]) => [subject, proseOf(list, agg)]).filter(([, prose]) => prose);
  const own = trackerProse(agg);
  if (own) rows.push(["(the tracker's own published texts)", own]);
  rows.sort((a, b) => b[1].score - a[1].score);
  for (const [subject, prose] of rows) {
    const vs = prose.vs ? `  beats the tracker's text ${Math.round((100 * prose.beats) / prose.vs)}%` : "";
    console.log(`  ${subject.padEnd(62)} ${String(prose.score).padStart(5)}  ${String(prose.cases).padStart(2)} cases${vs}`);
  }
}

#!/usr/bin/env node
// Show the saved runs, or score them again from what the service returned (after a case's answer
// or a scoring rule changed). No model is called.
//   node benchmark/score.mjs                 table of all runs
//   node benchmark/score.mjs <run id>        one run in full
//   node benchmark/score.mjs --rescore       score every saved run again with today's cases and rules
import fs from "node:fs";
import path from "node:path";
import { casesHash, loadCases } from "./lib/cases.mjs";
import { buildRun, listRuns, loadRaw, loadRun, printRun, printTable, saveRun } from "./lib/results.mjs";
import { RESULTS } from "./lib/util.mjs";

const args = process.argv.slice(2);
const rescore = args.includes("--rescore");
const ids = args.filter((arg) => !arg.startsWith("--"));
const known = listRuns();
const wanted = ids.length ? ids.map((id) => known.find((run) => run === id || run.includes(id)) || id) : known;

if (!known.length) {
  console.log("No benchmark runs yet. Start one with: node benchmark/run.mjs <harness@provider/model#effort>");
  process.exit(0);
}

const runs = [];
for (const id of wanted) {
  if (!known.includes(id)) {
    console.error(`No run "${id}". Runs: ${known.join(", ")}`);
    process.exit(2);
  }
  let run = loadRun(id);
  if (rescore) {
    if (!fs.existsSync(path.join(RESULTS, "raw", `${id}.json.gz`))) {
      console.error(`${id}: no saved service output (results/raw/${id}.json.gz), cannot score it again`);
      continue;
    }
    const raw = loadRaw(id);
    const cases = loadCases().filter((item) => raw[item.id] || (item.formerly || []).some((id) => raw[id]));
    const { schema, scorer_version, weights, dimensions, families, summary, cases: old, ...meta } = run;
    // the set a run is compared within is the cases as they are now scored
    // and a run that lacks cases added since is no longer a full run (finish it with --extend)
    run = buildRun({ ...meta, cases_hash: casesHash(), full_set: meta.full_set && cases.length === loadCases().length }, cases, raw);
    saveRun(run);
    console.log(`Scored again: ${id}  ${summary.score} → ${run.summary.score}`);
  }
  runs.push(run);
}

if (ids.length === 1 && runs.length === 1) printRun(runs[0]);
else printTable(runs);

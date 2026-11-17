#!/usr/bin/env node
// Which cases tell models apart, and which subjects can be told apart at all. Reads the saved runs;
// no model is called.
//   node benchmark/cases-report.mjs            newest set of complete runs
//   node benchmark/cases-report.mjs --all      every complete run, whatever its set (rough look)
//   node benchmark/cases-report.mjs --json     the same as JSON
import { FAMILIES } from "./lib/cases.mjs";
import { FLAGS, analyse, pickRuns, setOf } from "./lib/discrimination.mjs";
import { listRuns, loadRun } from "./lib/results.mjs";

const args = process.argv.slice(2);
const runs = pickRuns(listRuns().map(loadRun), { all: args.includes("--all") });
if (!runs.length) {
  console.log("No complete runs of all cases yet.");
  process.exit(0);
}
const report = analyse(runs);
if (args.includes("--json")) {
  console.log(JSON.stringify({ sets: [...new Set(runs.map(setOf))], flags: FLAGS, ...report }, null, 1));
  process.exit(0);
}

const pad = (text, width) => String(text ?? "–").padEnd(width);
const num = (value, width = 5) => String(value ?? "–").padStart(width);
const lines = [];
lines.push(`${report.runs} complete runs, ${report.subjects} subjects, set ${[...new Set(runs.map(setOf))].join(", ")}`);
if (report.subjects < 5) lines.push("Few subjects: the figures below are rough.");

lines.push("", "Cases, most useful first");
lines.push("  Value: spread × r. Spread: how far subjects' scores differ. Top: the same among the stronger half.");
lines.push("  r: whether subjects strong elsewhere also do well here. Noise: how far one subject's repeats differ.");
lines.push("");
lines.push(`  ${pad("Case", 36)} ${pad("Kind", 13)} Value  Mean   Min  Pass% Spread   Top     r  Noise  Flags`);
for (const row of report.cases) {
  lines.push(`  ${pad(row.id, 36)} ${pad(row.family, 13)} ${num(row.value)} ${num(row.mean)} ${num(row.min)} ${num(row.pass_rate, 6)} ${num(row.spread, 6)} ${num(row.top_spread)} ${num(row.r)} ${num(row.noise, 6)}  ${row.flags.join(", ")}`);
}

lines.push("", "By kind of case");
for (const [family, value] of Object.entries(report.families)) {
  lines.push(`  ${pad(FAMILIES[family] || family, 22)} ${num(value.cases, 3)} cases, mean ${value.mean}, typical spread ${value.spread}, ${value.ceiling} at the ceiling`);
}

const flagged = Object.keys(FLAGS).map((flag) => [flag, report.cases.filter((row) => row.flags.includes(flag))]).filter(([, rows]) => rows.length);
if (flagged.length) {
  lines.push("", "To look at");
  for (const [flag, rows] of flagged) lines.push(`  ${flag} (${rows.length}): ${FLAGS[flag]}`, `    ${rows.map((row) => row.id).join(", ")}`);
}

lines.push("", "Subjects with a 95% range (cases drawn again with replacement)");
lines.push("  * = its range reaches the best subject's score: not shown to be worse than the best.");
for (const range of report.ranges) {
  lines.push(`  ${range.tied_with_best ? "*" : " "} ${pad(range.subject, 58)} ${num(range.score)}  ${num(range.low)} – ${num(range.high, 0)}   ${range.cases} cases × ${range.repeats}`);
}
console.log(lines.join("\n"));

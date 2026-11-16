#!/usr/bin/env node
// Run the benchmark for one harness + provider + model:
//   node benchmark/run.mjs opencode@swancloud/muse-spark-1.3-contributor#xhigh
//   node benchmark/run.mjs muse@muse-spark-1.3#xhigh --repeat 3
//   node benchmark/run.mjs opencode@provider/model --cases out-of-scope,us-clifton-park-pounds
// See benchmark/README.md.
import fs from "node:fs";
import path from "node:path";
import { buildBackend, cancelJob, harnessVersion, isTerminal, jobFailure, startBackend, submit, submission, tail } from "./lib/backend.mjs";
import { casesHash, loadCases } from "./lib/cases.mjs";
import { collectCase } from "./lib/collect.mjs";
import { buildRun, listRuns, loadRaw, loadRun, printRun, saveRaw, saveRun } from "./lib/results.mjs";
import { finalOutcome, scoreCase } from "./lib/score.mjs";
import { createSnapshot } from "./lib/snapshot.mjs";
import { BENCH, REPO, WORK, git, parseSubject, readJSON, sha, sleep, slugify } from "./lib/util.mjs";

function usage(message) {
  if (message) console.error(`${message}\n`);
  console.error(`Usage: node benchmark/run.mjs <harness@provider/model#effort> [options]

  opencode@swancloud/muse-spark-1.3-contributor#xhigh    OpenCode, provider swancloud
  muse@muse-spark-1.3#xhigh                              Meta's Muse agent

Options:
  --cases a,b        only these cases or families (new-event, known-event, out-of-scope)
  --repeat N         run every case N times (default 1; 3 shows how much a model varies)
  --concurrency N    cases researched at once (default from protocol.json)
  --label "text"     a note shown with the run
  --keep             keep the run's working files in benchmark/.work
  --extend <run id>  run the cases a saved run lacks (new cases, or a run that was stopped)
                     with the same harness, provider and model, and add them to that run
  --list             list the cases and exit`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const options = { repeat: 1, cases: null, label: "", keep: false, list: false };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => argv[(i += 1)] ?? usage(`${arg} needs a value`);
    if (arg === "--cases") options.cases = value().split(",").map((s) => s.trim()).filter(Boolean);
    else if (arg === "--repeat") options.repeat = Number(value());
    else if (arg === "--concurrency") options.concurrency = Number(value());
    else if (arg === "--label") options.label = value();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--extend") options.extend = value();
    else if (arg === "--list") options.list = true;
    else if (arg === "--help" || arg === "-h") usage();
    else if (arg.startsWith("--")) usage(`Unknown option ${arg}`);
    else rest.push(arg);
  }
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 10) usage("--repeat takes 1 to 10");
  if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 8)) usage("--concurrency takes 1 to 8");
  return { options, rest };
}

// One line per slow step, with how long it took, so a waiting run never looks stuck.
async function step(label, work) {
  const started = Date.now();
  process.stdout.write(`  ${label}… `);
  try {
    const value = await work();
    console.log(`done (${Math.round((Date.now() - started) / 1000)} s)`);
    return value;
  } catch (error) {
    console.log("failed");
    throw error;
  }
}

const clock = (seconds) => (seconds == null ? "" : `${Math.floor(seconds / 60)}m${String(Math.round(seconds % 60)).padStart(2, "0")}s`);

// One pass: a fresh snapshot and a fresh private service, every case submitted once.
async function pass({ name, cases, allCases, subject, protocol, concurrency, binary, commit, runDir, log, records }) {
  const runId = path.basename(runDir);
  const dir = path.join(runDir, name);
  // what a stopped earlier run of the same id left behind is only its working files
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const snapshot = await step("Copying the reports, without the answers", () => createSnapshot({ dir: path.join(dir, "repo"), commit, reportsCommit: protocol.reports_commit, cases: allCases }));
  const instance = await step(`Starting the service and waiting for the model's first reply (${subject.id})`, () => startBackend({ binary, subject, protocol, concurrency, dir, repo: snapshot.dir }));
  running.add(instance);
  console.log(`  ${cases.length} pages submitted; ${concurrency} researched at a time, a few minutes each.`);
  try {
    const pending = new Map();
    for (const item of cases) {
      try {
        pending.set(item.id, { item, id: await submit(instance, item.submit), started: 0 });
      } catch (error) {
        records.set(item.id, { case: item.id, status: "error", error: `The service refused the page: ${error.message}` });
        log(item, records.get(item.id));
      }
    }
    const deadline = protocol.case_deadline_minutes * 60000;
    let silent = 0; // cases where the model never took a step
    let answered = 0;
    let beat = Date.now();
    while (pending.size) {
      await sleep(5000);
      if (Date.now() - beat > 120000) {
        beat = Date.now();
        const working = [...pending.values()].filter((entry) => entry.started).map((entry) => `${entry.item.id} (${clock((Date.now() - entry.started) / 1000)})`);
        console.log(`      … ${working.length ? `working on ${working.join(", ")}` : "waiting for the service"}; ${pending.size - working.length} waiting`);
      }
      if (instance.child.exitCode !== null) throw new Error(`The research service stopped. See ${instance.logFile}:\n${tail(instance.logFile)}`);
      for (const [key, entry] of [...pending]) {
        let sub;
        try {
          sub = await submission(instance, entry.id);
        } catch {
          continue;
        }
        const status = sub.status;
        if (status !== "queued" && !entry.started) entry.started = Date.now();
        const late = entry.started && Date.now() - entry.started > deadline;
        // The first attempt counts: when the service puts a case back for another try, it ends here.
        const notes = (sub.history || []).map((step) => String(step.explanation || ""));
        const stops = notes.filter((note) => note.includes("stopped before its first model step")).length;
        let ended = null;
        if (!isTerminal(status) && notes.some((note) => note.includes("The last attempt did not finish"))) {
          const reason = jobFailure(instance, sub.case_id) || "The research attempt did not finish.";
          const models = /ran out of time|without a final answer|instead of the JSON answer|rejected by the result check|missing final result/.test(reason);
          ended = { status: models ? "failed" : "error", reason };
        } else if (!isTerminal(status) && stops >= 3) {
          ended = { status: "error", reason: "The research agent stopped three times before its first model step: the harness or the provider is not answering." };
          silent += 1;
        }
        if (!isTerminal(status) && !late && !ended) continue;
        if (ended || late) cancelJob(instance, sub.case_id);
        if (isTerminal(status)) await sleep(2000); // the service packs the job's files right after
        const record = await collectCase(instance, entry.item, entry.id, { timedOut: late, ended });
        if ((record.steps || 0) > 0) {
          answered += 1;
          silent = 0;
        }
        records.set(key, record);
        pending.delete(key);
        log(entry.item, record);
        beat = Date.now();
        if (silent >= 3) {
          const what = answered ? `stopped answering after ${answered} cases` : "never started";
          throw new Error(`The model ${what}: ${subject.id} is not running in this harness right now (provider down, out of credit or quota, or a wrong name). Stopped so the remaining cases are not wasted; continue later with --extend ${runId}.\n${tail(instance.logFile, 3)}`);
        }
      }
    }
  } finally {
    running.delete(instance);
    await instance.stop();
    fs.rmSync(path.join(dir, "repo"), { recursive: true, force: true });
  }
  return records;
}

const running = new Set();
let onStop = null; // saves the cases finished so far
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    console.error("\nStopping the research service…");
    try {
      onStop?.();
    } catch {
      // nothing finished yet
    }
    await Promise.all([...running].map((instance) => instance.stop()));
    process.exit(130);
  });
}

async function main() {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const allCases = loadCases();
  if (options.list) {
    for (const item of allCases) console.log(`${item.family.padEnd(13)} ${item.id.padEnd(36)} ${item.title}`);
    return;
  }
  // --extend: the same subject as the saved run, and only the cases it has no result for
  let earlier = null;
  if (options.extend) {
    const found = listRuns().filter((name) => name === options.extend || name.includes(options.extend));
    if (found.length !== 1) usage(found.length ? `"${options.extend}" matches several runs: ${found.join(", ")}` : `No saved run matches "${options.extend}"`);
    earlier = { run: loadRun(found[0]), raw: loadRaw(found[0]) };
    if (rest.length && parseSubject(rest[0]).id !== earlier.run.subject.id) usage(`Run ${found[0]} is ${earlier.run.subject.id}; a run is extended with the same harness, provider and model`);
    rest.splice(0, rest.length, earlier.run.subject.id);
    options.repeat = earlier.run.repeat;
  }
  if (rest.length !== 1) usage(rest.length ? "Give one harness@provider/model#effort" : "");
  const subject = parseSubject(rest[0]);
  // a case counts as done when it has a result that was scored; unfinished and spoiled ones run again
  const keysOf = (item) => [item.id, ...(item.formerly || [])];
  const usable = (item, record) => !["error", "spoiled"].includes(scoreCase(item, record).verdict);
  const has = (item) => earlier && keysOf(item).some((key) => (earlier.raw[key] || []).some((record) => usable(item, record)));
  const cases = loadCases(options.cases).filter((item) => !has(item));
  if (earlier) for (const item of cases) for (const key of keysOf(item)) delete earlier.raw[key];
  if (earlier && !cases.length) {
    console.log(`Run ${earlier.run.id} already has every case.`);
    return;
  }
  const protocol = readJSON(path.join(BENCH, "protocol.json"));
  if (earlier && sha(JSON.stringify({ ...protocol, concurrency: undefined })).slice(0, 12) !== earlier.run.protocol_hash) {
    usage(`protocol.json has changed since run ${earlier.run.id}; its cases would not be comparable. Start a new run instead.`);
  }
  const concurrency = options.concurrency || protocol.concurrency;

  const commit = (await git(REPO, "rev-parse", "HEAD")).trim();
  const dirty = (await git(REPO, "status", "--porcelain", "--", "backend", "docs", ".opencode", ".claude", "src/data", "scripts")).trim() !== "";
  subject.harness_version = await harnessVersion(subject.harness);
  const started = new Date();
  const stamp = started.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);
  const id = earlier ? earlier.run.id : `${stamp}-${slugify(subject.id)}`;
  const runDir = path.join(WORK, id);
  fs.mkdirSync(runDir, { recursive: true });

  console.log(`Benchmark run ${id}`);
  console.log(`  ${subject.harness} ${subject.harness_version} · provider ${subject.provider} · model ${subject.model}${subject.effort ? ` · effort ${subject.effort}` : ""}`);
  console.log(`  ${cases.length} cases × ${options.repeat}, ${concurrency} at once; tracker ${commit.slice(0, 10)}${dirty ? " (with uncommitted changes)" : ""}, reports as of ${protocol.reports_commit.slice(0, 10)}`);
  const binary = await step("Building the research service", () => buildBackend(runDir));

  const meta = {
    id,
    label: options.label || earlier?.run.label || "",
    subject,
    started_at: earlier ? earlier.run.started_at : started.toISOString(),
    // cases added to the run later: when, and on which tracker code
    ...(earlier ? { extended: [...(earlier.run.extended || []), { at: started.toISOString(), cases: cases.map((item) => item.id), tracker_commit: commit, harness_version: subject.harness_version }] } : {}),
    finished_at: null,
    complete: false,
    repeat: options.repeat,
    concurrency,
    protocol,
    protocol_hash: sha(JSON.stringify({ ...protocol, concurrency: undefined })).slice(0, 12),
    cases_hash: casesHash(),
    full_set: (earlier ? Object.keys(earlier.raw).length + cases.length : cases.length) >= allCases.length && !options.cases,
    tracker: earlier ? earlier.run.tracker : { commit, reports_commit: protocol.reports_commit, uncommitted_changes: dirty },
  };
  const raw = earlier ? earlier.raw : {};
  const scoredCases = () => allCases.filter((item) => [item.id, ...(item.formerly || [])].some((key) => raw[key]));
  let done = 0;
  const total = cases.length * options.repeat;
  const save = () => {
    saveRaw(id, raw);
    return saveRun(buildRun(meta, scoredCases(), raw));
  };

  for (let attempt = 1; attempt <= options.repeat; attempt += 1) {
    let todo = cases;
    for (let round = 0; round <= protocol.retry_errors && todo.length; round += 1) {
      const retrying = round > 0;
      if (retrying) console.log(`  Trying ${todo.length} unfinished case${todo.length > 1 ? "s" : ""} again…`);
      const records = new Map();
      const kept = new Set(); // a stop can come twice (Ctrl-C, then the service ending)
      const keep = (final) => {
        const again = [];
        for (const item of todo) {
          if (kept.has(item.id)) continue;
          const record = records.get(item.id);
          if (!record && !final) continue; // a stopped pass keeps only what it finished
          kept.add(item.id);
          const entry = record || { case: item.id, status: "error", error: "No result was collected." };
          entry.attempt = attempt;
          if (final && finalOutcome(entry) === "error" && round < protocol.retry_errors) again.push(item);
          else (raw[item.id] ||= []).push(entry);
        }
        return again;
      };
      onStop = () => {
        keep(false);
        if (Object.keys(raw).length) console.error(`Saved what was finished: ${path.relative(REPO, save())}`);
      };
      try {
        await pass({
        records,
        name: `repeat${attempt}${retrying ? `-retry${round}` : ""}`,
        cases: todo,
        allCases,
        subject,
        protocol,
        concurrency,
        binary,
        commit,
        runDir,
        log: (item, record) => {
          const scored = scoreCase(item, record);
          const final = round === protocol.retry_errors || finalOutcome(record) !== "error";
          if (final) done += 1;
          // saved case by case: a crash or power cut loses at most the cases still being researched
          if (final && !kept.has(item.id)) {
            kept.add(item.id);
            record.attempt = attempt;
            (raw[item.id] ||= []).push(record);
            save();
          }
          console.log(`  [${String(done).padStart(String(total).length)}/${total}] ${item.id.padEnd(36)} ${String(scored.score ?? "–").padStart(5)}  ${scored.decision.got}  ${clock(record.seconds)}${final ? "" : "  (will retry)"}`);
        },
      });
      } catch (error) {
        keep(false);
        if (Object.keys(raw).length) console.error(`  Saved what was finished: ${path.relative(REPO, save())}`);
        throw error;
      }
      onStop = null;
      todo = keep(true);
    }
    save();
  }
  meta.finished_at = new Date().toISOString();
  meta.complete = true;
  const file = save();
  if (!options.keep) fs.rmSync(runDir, { recursive: true, force: true });
  printRun(buildRun(meta, scoredCases(), raw));
  console.log(`\nSaved ${path.relative(REPO, file)}. Build the site to see it at /benchmark/.`);
}

main().catch(async (error) => {
  await Promise.all([...running].map((instance) => instance.stop()));
  console.error(`\nBenchmark stopped: ${error.message}`);
  process.exit(1);
});

// The prose judge: gathers every report text the runs wrote for a case, shows them to a judging
// model without model names and in a shuffled order, and records its ranking. Scoring is in
// prose-score.mjs. The judge is run through the Claude Code CLI (`claude -p`), so it uses the
// login of whoever runs it and any model that CLI accepts.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as yaml from "js-yaml";
import { entryKey, trackerKey } from "./prose-score.mjs";
import { BENCH, REPO, readJSON, sha, slugify } from "./util.mjs";

export const PROSE = path.join(BENCH, "results", "prose");
export const MIN_TEXTS = 3; // a ranking of fewer texts says little

// What the judge reads of a text: title, summary and body, without citation marks and pictures.
export function textOf(report) {
  const clean = (text) => String(text || "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\s*\[@[^\]]+\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return [`# ${clean(report.title)}`, clean(report.summary), clean(report.body)].filter(Boolean).join("\n\n");
}

// The tracker's published report on a case's event, as it was at the benchmark's fixed reports
// commit (the version the cases hide), or as it is now if that commit lacks it.
function trackerReport(item, commit) {
  const slug = item.setup?.hide?.[0];
  if (!slug) return null;
  let markdown = null;
  try {
    const file = execFileSync("git", ["ls-tree", "-r", "--name-only", commit, "reports"], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 26 })
      .split("\n").find((line) => line.endsWith(`/${slug}.md`));
    if (file) markdown = execFileSync("git", ["show", `${commit}:${file}`], { cwd: REPO, encoding: "utf8", maxBuffer: 1 << 24 });
  } catch {
    // no such commit here: fall back to the working copy
  }
  if (!markdown) {
    const found = findFile(path.join(REPO, "reports"), `${slug}.md`);
    if (found) markdown = fs.readFileSync(found, "utf8");
  }
  const match = markdown?.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;
  const meta = yaml.load(match[1]) || {};
  return { title: meta.title, summary: meta.summary, body: match[2] };
}

function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFile(full, name);
      if (found) return found;
    } else if (entry.name === name) return full;
  }
  return null;
}

// Every text written for each case, from every saved run (finished or not: a text is a text),
// plus the tracker's own. Only cases with at least MIN_TEXTS model texts.
export function collectEntries(runs, cases, { reportsCommit } = {}) {
  const out = [];
  for (const item of cases) {
    const entries = [];
    for (const run of runs) {
      const scored = run.cases.find((c) => c.id === item.id);
      scored?.attempts.forEach((attempt, index) => {
        if (!attempt.report?.body) return;
        entries.push({ key: entryKey(item.id, run.id, index), model: run.subject.recorded || `${run.subject.provider}/${run.subject.model}`, text: textOf(attempt.report) });
      });
    }
    if (entries.length < MIN_TEXTS) continue;
    const own = reportsCommit ? trackerReport(item, reportsCommit) : null;
    if (own) entries.push({ key: trackerKey(item.id), model: "tracker", text: textOf(own) });
    out.push({ item, entries });
  }
  return out;
}

// The rubric: the tracker's own writing rules (docs/WRITING.md, "How it reads"), and what the judge
// leaves to the fixed scorer.
export function rubric() {
  const writing = fs.readFileSync(path.join(REPO, "docs", "WRITING.md"), "utf8");
  const reads = writing.match(/## 3\. How it reads\n([\s\S]*?)\n## 4\./)?.[1].trim() || "";
  return `You judge the writing of short news reports for the Cannabis Enforcement Tracker, a public record of cannabis seizures, raids, arrests, trials, sentences and executions.

You will get several reports about the same real event, each written by a different writer. Rank them from best written to worst written.

Judge the prose only: how well each text tells a reader what happened. Facts, figures, sources and photos are checked separately against the sources, so do not try to verify them and do not reward a text for containing more facts. But a text that contradicts itself, mixes in a different event, or leaves the reader unsure what happened is badly written.

The tracker's own writing rules:

${reads}

What makes a report read well:
- The opening says what happened, where, when and to whom; a reader who stops after two sentences knows the event.
- Events are told in a clear order; background (earlier raids, other cases) is marked as background.
- Plain, neutral sentences; no police-press-release tone, no padding, no repetition, no hedging that says nothing.
- Local terms and agencies are explained once.
- The title says what happened with the key number, in under 90 characters, and fits the text.
- The summary stands on its own.
- Within 150-400 words. Longer is not better: a tight text that says the same in fewer words ranks higher.

Ignore formatting differences that do not affect reading. Do not guess who wrote a text. Answer with the ranking only. Give each text a note of at most 12 words naming what decided its place.`;
}

export const rubricHash = () => sha(rubric()).slice(0, 12);

export const RANKING_SCHEMA = {
  type: "object",
  properties: {
    ranking: {
      type: "array",
      description: "Every text exactly once, best written first.",
      items: {
        type: "object",
        properties: { id: { type: "string" }, note: { type: "string" } },
        required: ["id", "note"],
        additionalProperties: false,
      },
    },
  },
  required: ["ranking"],
  additionalProperties: false,
};

// a fresh order and fresh labels for every round, so place and label carry no meaning
export function shuffleLabels(entries, random = Math.random) {
  const order = [...entries];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order.map((entry, i) => ({ ...entry, label: `T${String(i + 1).padStart(2, "0")}` }));
}

export function promptFor(item, labelled) {
  const parts = [`Event: ${item.title}`, `There are ${labelled.length} texts. Rank all ${labelled.length}, best written first, using their ids.`, ""];
  for (const entry of labelled) parts.push(`<text id="${entry.label}">`, entry.text, "</text>", "");
  return parts.join("\n");
}

// the judge's answer → keys in ranked order and notes; throws when a text is missing or doubled
export function readRanking(answer, labelled) {
  const byLabel = new Map(labelled.map((entry) => [entry.label, entry.key]));
  const seen = new Set();
  const ranking = [];
  const notes = {};
  for (const row of answer?.ranking || []) {
    const id = String(row.id).trim().toUpperCase();
    const key = byLabel.get(id);
    if (!key) throw new Error(`unknown text id ${row.id}`);
    if (seen.has(key)) throw new Error(`text ${id} ranked twice`);
    seen.add(key);
    ranking.push(key);
    notes[key] = String(row.note || "").slice(0, 300);
  }
  const missing = labelled.filter((entry) => !seen.has(entry.key)).map((entry) => entry.label);
  if (missing.length) throw new Error(`texts not ranked: ${missing.join(", ")}`);
  return { ranking, notes };
}

// One call to the Claude Code CLI that carries only the rubric and the texts: no tools, no MCP
// servers, no skills or commands, no user or project settings, in an empty folder so no project
// instructions load. The texts go in once; the answer is the ranking JSON and nothing else.
export function askClaude({ model, effort, system, prompt, timeoutMs = 15 * 60 * 1000 }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prose-judge-"));
  const args = ["-p", "--model", model, "--output-format", "json", "--json-schema", JSON.stringify(RANKING_SCHEMA), "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "local", "--no-session-persistence", "--system-prompt", system];
  if (effort) args.push("--effort", effort);
  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      let result;
      try {
        result = JSON.parse(out);
      } catch {
        return reject(new Error(`claude exited ${code}: ${(err || out).trim().slice(0, 400)}`));
      }
      if (result.is_error) return reject(new Error(`claude: ${String(result.result || result.subtype).slice(0, 400)}`));
      let answer = result.structured_output;
      if (!answer) {
        try {
          answer = JSON.parse(String(result.result).replace(/^```(?:json)?\s*|\s*```$/g, ""));
        } catch {
          return reject(new Error("claude: the answer is not the ranking JSON"));
        }
      }
      const u = result.usage || {};
      resolve({
        answer,
        usage: {
          input_tokens: u.input_tokens || 0,
          cache_read_tokens: u.cache_read_input_tokens || 0,
          cache_write_tokens: u.cache_creation_input_tokens || 0,
          output_tokens: u.output_tokens || 0,
          cost_usd: result.total_cost_usd || 0,
          seconds: Math.round((result.duration_ms || 0) / 1000),
        },
      });
    });
    child.stdin.end(prompt);
  });
}

export function claudeVersion() {
  try {
    return execFileSync("claude", ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

// a judge is the model and effort; its file keeps all its rounds
export const judgeId = (model, effort) => `${model}${effort ? `#${effort}` : ""}`;
export const judgeFile = (id) => path.join(PROSE, `${slugify(`claude-${id}`)}.json`);

export function loadJudge(id, meta) {
  return readJSON(judgeFile(id), null) || { schema: 1, judge: { id, tool: "claude", ...meta }, rounds: [] };
}

export function saveJudge(file) {
  fs.mkdirSync(PROSE, { recursive: true });
  fs.writeFileSync(judgeFile(file.judge.id), JSON.stringify(file, null, 1) + "\n");
}

export function loadAllJudges() {
  if (!fs.existsSync(PROSE)) return [];
  return fs.readdirSync(PROSE).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(PROSE, name), "utf8")));
}

// rounds of this judge that showed every text the case has now
export const fullRounds = (file, caseId, keys) => file.rounds.filter((r) => r.case === caseId && keys.every((key) => r.ranking.includes(key))).length;

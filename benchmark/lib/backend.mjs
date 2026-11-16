// One private copy of the tracker's own research service: the same program that researches
// submissions in production, started against a benchmark snapshot with its own database, on its own
// port. It collects no news, has no Nostr keys, commits only to the snapshot and can push nowhere.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { REPO, WORK, freePort, sh, sleep, startProcess, stopProcess } from "./util.mjs";

const TERMINAL = new Set(["committed", "published", "duplicate", "not_relevant", "insufficient_evidence", "routed_to_cfi", "needs_review", "failed", "source_unavailable"]);
export const isTerminal = (status) => TERMINAL.has(status);

// Each run builds its own copy (a second or two with Go's cache), so two runs at once, or a run
// started after the backend's code changed, never share or replace each other's program.
export async function buildBackend(dir = path.join(WORK, "bin")) {
  const binary = path.join(dir, "tracker");
  fs.mkdirSync(dir, { recursive: true });
  await sh("go", ["build", "-o", binary, "./cmd/tracker"], { cwd: path.join(REPO, "backend") });
  return binary;
}

export async function harnessVersion(harness) {
  try {
    return (await sh(harness === "muse" ? process.env.MUSE_BIN || "muse" : process.env.OPENCODE_BIN || "opencode", ["--version"])).trim().split("\n")[0];
  } catch {
    return "";
  }
}

// Only what the benchmark decides goes into the service's environment; everything that could
// publish, harvest or talk to the production service is switched off whatever the shell has set.
function environment({ subject, protocol, concurrency, port, dir, repo }) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(RESEARCH_|HARVEST_|NOSTR_|GITHUB_|PUBLISH_|WORKER_|REPO_|OPERATOR_|INGEST_|METRICS_|TRACKER_|DEMO_|TRUSTED_|PUBLIC_|SUBMISSIONS_)/.test(key)) delete env[key];
  }
  return {
    ...env,
    HTTP_ADDR: `127.0.0.1:${port}`,
    DATABASE_PATH: path.join(dir, "tracker.sqlite"),
    WORKSPACE_PATH: path.join(dir, "jobs"),
    REPO_PATH: repo,
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    CORS_ORIGINS: `http://127.0.0.1:${port}`,
    LOG_LEVEL: "info",
    RESEARCH_MODE: "local",
    RESEARCH_RUNNER: "local",
    RESEARCH_AGENTS: JSON.stringify([{ model: subject.agent, max_workers: concurrency }]),
    RESEARCH_MAX_STEPS: String(protocol.max_steps),
    RESEARCH_TIMEOUT_SECONDS: String(protocol.timeout_seconds),
    RESEARCH_WEBSEARCH: protocol.websearch,
    RESEARCH_CONTEXT: protocol.context,
    RESEARCH_SCREEN: String(protocol.screen),
    RESEARCH_DAILY_CENTS: "0",
    SOURCE_BROWSER: String(protocol.source_browser),
    RAW_AI_LOGS: "true",
    AUTO_PUBLISH: "true",
    AUTO_PUSH: "false",
    REPO_SYNC: "false",
    HARVEST_GOOGLE_NEWS_ENABLED: "false",
    HARVEST_BING_NEWS_ENABLED: "false",
    HARVEST_GDELT_ENABLED: "false",
    HARVEST_QUEUE_TARGET: "0",
    // loopback only: lifts the public intake's hourly limits for the benchmark's own submissions
    DEV_CONTROLS: "true",
  };
}

export async function startBackend({ binary, subject, protocol, concurrency, dir, repo }) {
  fs.mkdirSync(path.join(dir, "jobs"), { recursive: true });
  const port = await freePort();
  const logFile = path.join(dir, "backend.log");
  const child = startProcess(binary, [], { cwd: dir, env: environment({ subject, protocol, concurrency, port, dir, repo }), logFile });
  const base = `http://127.0.0.1:${port}`;
  const api = async (route, init) => {
    const response = await fetch(base + route, { ...init, signal: AbortSignal.timeout(30000) });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!response.ok) throw Object.assign(new Error(`${route}: HTTP ${response.status} ${typeof body === "string" ? body.slice(0, 200) : JSON.stringify(body).slice(0, 200)}`), { status: response.status });
    return body;
  };
  const instance = { child, port, base, dir, logFile, api, stop: () => stopProcess(child) };

  // listening, then the service's own model check (one short probe of the harness and provider)
  const deadline = Date.now() + 180000;
  let last = "";
  let failed = "";
  for (;;) {
    if (child.exitCode !== null) throw new Error(`The research service stopped while starting. See ${logFile}:\n${tail(logFile)}`);
    try {
      const status = await api("/v1/status");
      last = String(status.reason || "");
      if (status.processing === true) break;
      if (/test failed|startup checks|is unavailable/i.test(last)) failed = last;
    } catch {
      // not listening yet
    }
    if (failed) {
      await instance.stop();
      throw new Error(`This harness, provider and model did not answer the service's start check, so nothing was run.\n  ${failed}\n  Check the name with \`opencode models\` (or \`muse\`), and that the provider is signed in.`);
    }
    if (Date.now() > deadline) {
      await instance.stop();
      throw new Error(`The model did not pass the research service's start check in time${last ? `: ${last}` : ""}\nSee ${logFile}:\n${tail(logFile)}`);
    }
    await sleep(1500);
  }
  return instance;
}

export function tail(file, lines = 15) {
  try {
    return fs.readFileSync(file, "utf8").trim().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

// The benchmark counts a case's first research attempt. The service would try a failed one again
// (up to eight times in production); marking its job done makes the service drop it within seconds.
export function cancelJob(instance, caseId) {
  try {
    const db = new DatabaseSync(path.join(instance.dir, "tracker.sqlite"), { timeout: 5000 });
    db.prepare("UPDATE jobs SET status='done',lease_until=0,lease_token='' WHERE ref=? AND kind<>'publish'").run(caseId);
    db.close();
    return true;
  } catch {
    return false;
  }
}

// Why the service gave up on a case's attempt, from its own log (the public status does not say).
export function jobFailure(instance, caseId) {
  let reason = "";
  try {
    for (const line of fs.readFileSync(instance.logFile, "utf8").split("\n")) {
      if (!line.includes("job processing failed") || !line.includes(caseId)) continue;
      reason = JSON.parse(line).error || reason;
    }
  } catch {
    // no log, no reason
  }
  return reason;
}

export async function submit(instance, url) {
  const accepted = await instance.api("/v1/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, note: "" }) });
  return accepted.id;
}

export const submission = (instance, id) => instance.api(`/v1/submissions/${id}`);
export const activity = (instance, id) => instance.api(`/v1/submissions/${id}/ai`);

// Small shared helpers: paths, subjects (harness + provider + model + effort), processes.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const BENCH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = path.resolve(BENCH, "..");
export const WORK = path.join(BENCH, ".work");
export const RESULTS = path.join(BENCH, "results");

const run = promisify(execFile);

export async function sh(cmd, args, options = {}) {
  const { stdout } = await run(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...options });
  return stdout;
}

export const git = (cwd, ...args) => sh("git", args, { cwd });

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (fallback !== undefined && error.code === "ENOENT") return fallback;
    throw error;
  }
}

export const sha = (text) => createHash("sha256").update(text).digest("hex");

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A benchmark subject is always three things plus the effort: the harness that drives the model,
// the provider that serves it and the model itself. "opencode@swancloud/muse-spark-1.3-contributor#xhigh",
// "muse@muse-spark-1.3#xhigh". The harness may be left out for OpenCode ("swancloud/model#effort").
export function parseSubject(raw) {
  const text = String(raw || "").trim();
  let harness = "opencode";
  let rest = text;
  const at = text.indexOf("@");
  if (at > 0) {
    harness = text.slice(0, at);
    rest = text.slice(at + 1);
  }
  if (!["opencode", "muse"].includes(harness)) {
    throw new Error(`Unknown harness "${harness}" in "${text}": use opencode@provider/model#effort or muse@model#effort`);
  }
  const [name, effort = ""] = rest.split("#");
  let provider;
  let model;
  if (harness === "muse") {
    if (name.includes("/")) throw new Error(`"${text}": the Muse harness takes a model without a provider (muse@muse-spark-1.3#xhigh)`);
    provider = "muse";
    model = name;
  } else {
    const slash = name.indexOf("/");
    if (slash <= 0) throw new Error(`"${text}": OpenCode needs provider/model (opencode@swancloud/muse-spark-1.3-contributor#xhigh)`);
    provider = name.slice(0, slash);
    model = name.slice(slash + 1);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(provider) || !/^[A-Za-z0-9_./:-]+$/.test(model) || (effort && !/^[A-Za-z0-9_.-]+$/.test(effort))) {
    throw new Error(`"${text}" is not a valid harness@provider/model#effort`);
  }
  const tail = effort ? `#${effort}` : "";
  return {
    id: `${harness}@${harness === "muse" ? model : `${provider}/${model}`}${tail}`,
    harness,
    provider,
    model,
    effort,
    // what the tracker service takes in RESEARCH_AGENTS
    agent: harness === "muse" ? `muse@${model}${tail}` : `${provider}/${model}${tail}`,
    // what the service records as created_by_model
    recorded: `${harness === "muse" ? "muse" : provider}/${model}${tail}`,
  };
}

export const slugify = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

export function startProcess(cmd, args, { cwd, env, logFile }) {
  const log = fs.openSync(logFile, "a");
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  return child;
}

export async function stopProcess(child, graceMs = 15000) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), graceMs);
  await exited;
  clearTimeout(timer);
}

export function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, "");
  } catch {
    return "";
  }
}

// The same page under its usual variants: scheme, www/m/amp host, trailing slash, tracking query.
export function normalizeURL(url) {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|outputType$|amp$)/i.test(key)) u.searchParams.delete(key);
    }
    const query = u.searchParams.toString();
    return `${domainOf(url)}${decodeURIComponent(u.pathname).replace(/\/(amp\/?)?$/, "")}${query ? `?${query}` : ""}`.toLowerCase();
  } catch {
    return String(url || "").toLowerCase();
  }
}

// What one case left behind in the private research service: the service's verdict, the model's
// answer, the report it would publish, what the run cost and which pages it opened.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { activity, isTerminal, submission } from "./backend.mjs";
import { domainOf } from "./util.mjs";

const EVIDENCE_CHARS = 30000;
// the tracker's own site and API hold the answers to the hidden cases
const OWN_SITES = /(^|\.)(cannabisfreedom\.fyi|cannabisfreedom\.org)$/;

function readMaybeZstd(file) {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  if (fs.existsSync(file + ".zst")) return zlib.zstdDecompressSync(fs.readFileSync(file + ".zst"));
  return null;
}

function jobDirs(instance, caseId) {
  const root = path.join(instance.dir, "jobs");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((name) => name.startsWith(caseId + "-")).map((name) => path.join(root, name));
}

// steps, tool calls, searches and opened pages, from the harness's own event log
function toolUse(dirs) {
  const tools = {};
  const searches = [];
  const fetches = [];
  const ownSeen = new Set();
  let steps = 0;
  for (const dir of dirs) {
    const log = readMaybeZstd(path.join(dir, "research-events.jsonl"));
    if (!log) continue;
    for (const line of log.toString("utf8").split("\n")) {
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event.type === "step_start") steps += 1;
      if (event.type !== "tool_use" || !event.part?.tool) continue;
      const tool = event.part.tool;
      tools[tool] = (tools[tool] || 0) + 1;
      const input = event.part.state?.input || {};
      if (tool === "websearch" && input.query) searches.push(String(input.query).slice(0, 200));
      if (tool === "websearch") {
        for (const match of String(event.part.state?.output || "").matchAll(/https?:\/\/[a-z0-9.-]*cannabisfreedom\.(?:fyi|org)[^\s"')\]>]*/gi)) ownSeen.add(match[0].slice(0, 200));
      }
      if (tool === "webfetch" && input.url) fetches.push({ url: String(input.url).slice(0, 500), ok: event.part.state?.status === "completed" });
    }
  }
  return { steps, tools, searches, fetches, own_site_seen: [...ownSeen].slice(0, 8) };
}

function evidence(dirs) {
  const byURL = new Map();
  for (const dir of dirs) {
    for (const name of fs.readdirSync(dir)) {
      if (!/^evidence-\d+-[0-9a-f]+\.json(\.zst)?$/.test(name)) continue;
      const data = readMaybeZstd(path.join(dir, name.replace(/\.zst$/, "")));
      if (!data) continue;
      try {
        const item = JSON.parse(data.toString("utf8"));
        const text = String(item.text || item.content || "").replace(/\s+/g, " ").slice(0, EVIDENCE_CHARS);
        if (item.url && text) byURL.set(item.url, { url: item.url, final_url: item.final_url || "", text });
      } catch {
        // an unreadable capture is simply not evidence
      }
    }
  }
  return [...byURL.values()];
}

async function checkMedia(media) {
  const checks = [];
  for (const item of media || []) {
    const url = item.media_url;
    if (!url) {
      checks.push({ media_url: "", ok: false, note: "no media_url" });
      continue;
    }
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36", range: "bytes=0-4095", accept: "image/avif,image/webp,image/*,video/*,*/*;q=0.5" },
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      await response.body?.cancel();
      const media_type = /^(image|video)\//.test(type) || /mpegurl|dash\+xml|octet-stream/.test(type);
      // a video's own page on a video host is a valid media_url for a video
      const page = item.kind === "video" && /^text\/html/.test(type);
      checks.push({ media_url: url, ok: response.ok && (media_type || page), status: response.status, type });
    } catch (error) {
      checks.push({ media_url: url, ok: null, note: String(error.cause?.code || error.name || "unreachable") });
    }
  }
  return checks;
}

export async function collectCase(instance, item, id, { timedOut = false, ended = null } = {}) {
  let sub;
  try {
    sub = await submission(instance, id);
  } catch (error) {
    return { case: item.id, submission_id: id, status: "error", error: `The service did not answer: ${error.message}` };
  }
  let act = {};
  try {
    act = (await activity(instance, id)).activity || {};
  } catch {
    // usage stays unknown
  }
  const dirs = jobDirs(instance, sub.case_id);
  const use = toolUse(dirs);
  const result = sub.result || null;
  const runs = (act.runs || []).map((run) => ({
    model: run.model,
    status: run.status,
    outcome: run.outcome || "",
    seconds: run.finished_at && run.started_at ? run.finished_at - run.started_at : null,
    input_tokens: run.input_tokens,
    output_tokens: run.output_tokens,
    reasoning_tokens: run.reasoning_tokens,
    cache_read_tokens: run.cache_read_tokens,
    cache_write_tokens: run.cache_write_tokens,
    cost_usd: run.cost_usd,
  }));
  const history = (sub.history || []).map((entry) => ({ status: entry.status, at: entry.created_at, note: String(entry.explanation || "").slice(0, 600) }));
  const first = history.find((entry) => entry.status === "fetching") || history[0];
  const last = history[history.length - 1];
  const opened = [...use.fetches.map((fetch) => fetch.url), ...(result?.sources || []).map((source) => source.url)];
  return {
    case: item.id,
    submission_id: id,
    status: ended ? ended.status : isTerminal(sub.status) ? sub.status : timedOut ? "timeout" : sub.status,
    ...(ended ? { failure: ended.reason } : {}),
    explanation: sub.explanation || "",
    report_slug: sub.report_slug || "",
    history,
    seconds: first && last ? last.at - first.at : null,
    result,
    validation: sub.validation || null,
    draft_path: sub.draft_path || "",
    draft_markdown: sub.draft_markdown || "",
    source_check: sub.source_check ? { title: sub.source_check.metadata?.title || sub.source_check.title || "", rendered: sub.source_check.rendered } : null,
    runs,
    ...use,
    evidence: evidence(dirs),
    media_checks: await checkMedia(result?.media),
    // the model read the tracker's own published pages, where the hidden answer is
    own_site: [...new Set(opened.filter((url) => OWN_SITES.test(domainOf(url))))],
  };
}

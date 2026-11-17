import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RANKING_SCHEMA } from "./prose.mjs";
import { isOpenCode2 } from "./util.mjs";

const binary = () => process.env.OPENCODE_BIN || "opencode";

export function openCodeVersion() {
  const version = execFileSync(binary(), ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
  if (!isOpenCode2(version)) {
    throw new Error("OpenCode 2 is required. Update OpenCode or set OPENCODE_BIN to a v2 executable.");
  }
  return version;
}

function readResponse(stdout, seconds) {
  const usage = { input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0, cost_usd: 0, seconds };
  const texts = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("OpenCode returned an invalid JSON event stream");
    }
    if (event.type === "error") {
      const error = event.error;
      throw new Error(`OpenCode: ${String(error?.data?.message || error?.message || error?.name || error?.type || "run failed").slice(0, 400)}`);
    }
    if (event.type === "tool_use") throw new Error("OpenCode attempted to use a tool during the prose judgment");
    if (event.type === "text" && typeof event.part?.text === "string") texts.push(event.part.text);
    if (event.type === "step_finish") {
      const tokens = event.part?.tokens;
      usage.input_tokens += tokens?.input || 0;
      usage.cache_read_tokens += tokens?.cache?.read || 0;
      usage.cache_write_tokens += tokens?.cache?.write || 0;
      usage.output_tokens += (tokens?.output || 0) + (tokens?.reasoning || 0);
      usage.cost_usd += event.part?.cost || 0;
    }
  }
  try {
    const answer = JSON.parse(texts.join("").trim().replace(/^```(?:json)?\s*|\s*```$/gi, ""));
    return { answer, usage };
  } catch {
    throw new Error("OpenCode: the answer is not the ranking JSON");
  }
}

export async function askOpenCode({ model, effort, system, prompt, timeoutMs = 15 * 60 * 1000 }) {
  const instruction = `${system}\n\nReturn exactly one JSON object matching this schema:\n${JSON.stringify(RANKING_SCHEMA)}`;
  const agent = { description: "Rank report prose", mode: "primary" };
  const deny = [{ action: "*", resource: "*", effect: "deny" }];
  const policies = ["tool.use", "skill.use", "mcp.use"].map((action) => ({ action, resource: "*", effect: "deny" }));
  const config = { snapshots: false, policies, permissions: deny, agents: { "prose-judge": { ...agent, system: instruction, permissions: deny } } };
  const args = [
    "run", "--standalone", "--format", "json",
    "--title", "Prose benchmark", "--agent", "prose-judge",
    "--model", effort ? `${model}#${effort}` : model,
  ];
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "prose-judge-"));
  const env = {
    ...process.env,
    PWD: cwd,
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
    NO_COLOR: "1",
  };
  const started = Date.now();
  try {
    return await new Promise((resolve, reject) => {
      const child = execFile(binary(), args, { cwd, env, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return reject(new Error("OpenCode exceeded the output limit"));
        if (error?.killed) return reject(new Error(`OpenCode timed out after ${timeoutMs / 1000}s`));
        let result;
        try {
          result = readResponse(stdout, Math.round((Date.now() - started) / 1000));
        } catch (parseError) {
          if (error && !stdout.trim()) return reject(new Error(`OpenCode: ${stderr.trim().slice(0, 400) || error.code}`));
          return reject(parseError);
        }
        if (error) return reject(new Error(`OpenCode exited with code ${error.code}`));
        resolve(result);
      });
      child.stdin.on("error", () => {}); // A CLI that exits early may close stdin before we finish writing.
      child.stdin.end(prompt);
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

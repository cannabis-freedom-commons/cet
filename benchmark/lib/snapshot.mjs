// The repository a benchmark run researches against: a private clone of the tracker at one commit,
// with each case's answer taken out (or put back to an earlier version), so the model has to do the
// work the report shows. Nothing here touches the real checkout or its remote.
import fs from "node:fs";
import path from "node:path";
import { REPO, git, normalizeURL } from "./util.mjs";

export const OWN_SITE_NOTE = `The tracker's own website (tracker.cannabisfreedom.fyi) and the Cannabis Freedom Index site
(cannabisfreedom.fyi) are never sources. If a web search returns one of their pages, ignore it: do
not open it, do not cite it, and take no facts and no report names from it. What the tracker
already has is only what tracker_find_reports and tracker_get_report (or the report files in this
workspace) return.`;

const IDENTITY = ["-c", "user.name=benchmark", "-c", "user.email=benchmark@localhost", "-c", "commit.gpgsign=false"];

export function reportFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(path.join(root, "reports"));
  return files;
}

// url -> slugs of the reports citing it (sources and media pages), read from the front matter text.
export function citedURLs(root) {
  const cited = new Map();
  for (const file of reportFiles(root)) {
    const text = fs.readFileSync(file, "utf8");
    const end = text.indexOf("\n---", 4);
    const front = end > 0 ? text.slice(0, end) : text;
    const slug = path.basename(file, ".md");
    for (const match of front.matchAll(/^\s+(?:-\s+)?url:\s*['"]?(\S+?)['"]?\s*$/gm)) {
      const key = normalizeURL(match[1]);
      if (!cited.has(key)) cited.set(key, new Set());
      cited.get(key).add(slug);
    }
  }
  return cited;
}

// commit: the tracker's code, prompts and editorial rules (normally HEAD, what you run today).
// reportsCommit: the reports every run sees (pinned in protocol.json), so that all models are
// asked the same question against the same coverage, however many reports were added since.
export async function createSnapshot({ dir, commit, reportsCommit, cases }) {
  await git(REPO, "clone", "--shared", "--no-checkout", "--quiet", "--", REPO, dir);
  // The clone must never be able to push anywhere, whatever the service is told.
  await git(dir, "remote", "remove", "origin");
  await git(dir, "checkout", "--quiet", "--detach", commit);
  await git(dir, "checkout", "--quiet", "-B", "main");
  if (reportsCommit && reportsCommit !== commit) {
    await git(dir, "rm", "-r", "--quiet", "reports");
    await git(dir, "checkout", reportsCommit, "--", "reports", "src/lib/report-aliases.js");
  }
  fs.appendFileSync(path.join(dir, ".git", "info", "exclude"), "\nnode_modules\n");

  const bySlug = new Map(reportFiles(dir).map((file) => [path.basename(file, ".md"), file]));
  const changed = [];
  for (const item of cases) {
    const setup = item.setup || {};
    for (const slug of setup.hide || []) {
      const file = bySlug.get(slug);
      if (!file) throw new Error(`${item.id}: report "${slug}" to hide is not in the tracker at ${commit.slice(0, 10)}`);
      fs.rmSync(file);
      bySlug.delete(slug);
      changed.push(`hide ${slug}`);
    }
    // an earlier version of a report, as it was before a source or a later court step was added
    for (const restore of setup.restore || []) {
      const content = await git(REPO, "show", `${restore.commit}:${restore.path}`);
      const slug = path.basename(restore.path, ".md");
      const current = bySlug.get(slug);
      if (current) fs.rmSync(current);
      const target = path.join(dir, restore.path);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
      bySlug.set(slug, target);
      changed.push(`restore ${slug}@${restore.commit.slice(0, 10)}`);
    }
  }
  // The live tracker publishes the very reports the cases hide, and web search finds them. One
  // paragraph is added to the agent's instructions in this copy only (production does not have it).
  const agent = path.join(dir, ".opencode/agents/enforcement-researcher.md");
  fs.appendFileSync(agent, `\n${OWN_SITE_NOTE}\n`);
  await git(dir, "add", "-A", "reports", "src/lib/report-aliases.js", ".opencode/agents/enforcement-researcher.md");
  await git(dir, ...IDENTITY, "commit", "--quiet", "--allow-empty", "-m", "Benchmark snapshot: case answers removed");

  // The service opens pages and checks drafts with the repository's own scripts.
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");

  // A submitted page a report still cites is answered "duplicate" by the service before any model
  // runs, which would test nothing: stop instead of measuring it.
  const cited = citedURLs(dir);
  const problems = [];
  for (const item of cases) {
    const slugs = cited.get(normalizeURL(item.submit));
    if (slugs) problems.push(`${item.id}: ${item.submit} is still cited by ${[...slugs].join(", ")}`);
  }
  if (problems.length) throw new Error(`The snapshot would answer these cases by itself:\n  ${problems.join("\n  ")}`);
  const head = (await git(dir, "rev-parse", "HEAD")).trim();
  return { dir, head, changed };
}

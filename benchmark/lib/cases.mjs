// Benchmark cases: one YAML file per real page, with what a careful researcher makes of it.
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { BENCH, sha } from "./util.mjs";

export const FAMILIES = {
  "new-event": "New events",
  "known-event": "Already covered",
  "out-of-scope": "Out of scope",
};
const OUTCOMES = ["new_event", "existing_case", "additional_source", "duplicate", "not_relevant", "insufficient_evidence", "routed_to_cfi"];
const TYPES = ["eradication", "seizure", "raid", "arrest", "prosecution", "sentence", "execution", "death"];

const dir = path.join(BENCH, "cases");

function check(item, file) {
  const problems = [];
  const need = (ok, message) => ok || problems.push(message);
  need(item.id === path.basename(file, ".yaml"), "id must equal the file name");
  need(typeof item.title === "string" && item.title.length > 5, "title missing");
  need(FAMILIES[item.family], `family must be one of ${Object.keys(FAMILIES).join(", ")}`);
  need(/^https?:\/\//.test(item.submit || ""), "submit must be a URL");
  need(typeof item.why === "string" && item.why.length > 40, "why (what the case tests) missing");
  const expect = item.expect || {};
  need(expect.outcome && Object.keys(expect.outcome).length > 0, "expect.outcome missing");
  for (const outcome of Object.keys(expect.outcome || {})) need(OUTCOMES.includes(outcome), `unknown outcome ${outcome}`);
  if (item.family === "known-event") need(typeof expect.existing_report === "string", "expect.existing_report missing");
  if (item.family === "new-event") {
    need(expect.country && expect.date?.value && expect.type && expect.place?.coordinates?.length === 2, "new-event cases need country, date, type and place");
    for (const type of Object.keys(expect.type || {})) need(TYPES.includes(type), `unknown type ${type}`);
  }
  if (expect.date?.value instanceof Date) expect.date.value = expect.date.value.toISOString().slice(0, 10);
  if (expect.date?.also) {
    expect.date.also = Object.fromEntries(Object.entries(expect.date.also).map(([key, value]) => [new Date(key).toISOString().slice(0, 10), value]));
  }
  const patterns = [
    ...(expect.mentions || []),
    ...(expect.must_not_say || []),
    ...(expect.open_questions || []),
  ].flatMap((entry) => entry.any || []);
  for (const pattern of [...patterns, ...(expect.figures?.prison?.match || [])]) {
    try {
      new RegExp(pattern, "i");
    } catch {
      problems.push(`bad pattern ${pattern}`);
    }
  }
  if (problems.length) throw new Error(`${path.basename(file)}: ${problems.join("; ")}`);
  return item;
}

export function loadCases(only) {
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".yaml")).sort();
  let cases = files.map((name) => {
    const file = path.join(dir, name);
    return check(yaml.load(fs.readFileSync(file, "utf8")), file);
  });
  if (only?.length) {
    const wanted = new Set(only);
    const known = new Set(cases.map((item) => item.id));
    const missing = only.filter((id) => !known.has(id) && !FAMILIES[id]);
    if (missing.length) throw new Error(`No such case or family: ${missing.join(", ")}`);
    cases = cases.filter((item) => wanted.has(item.id) || wanted.has(item.family));
  }
  return cases;
}

// Changes whenever a case file changes: results of different case sets are not compared.
export function casesHash() {
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".yaml")).sort();
  return sha(files.map((name) => name + "\n" + fs.readFileSync(path.join(dir, name), "utf8")).join("\n")).slice(0, 12);
}

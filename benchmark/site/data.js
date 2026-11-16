// The saved runs (benchmark/results/*.json) and the case files, for the benchmark's pages.
import * as yaml from "js-yaml";

const files = import.meta.glob("../results/*.json", { eager: true, import: "default" });
const caseFiles = import.meta.glob("../cases/*.yaml", { eager: true, query: "?raw", import: "default" });

export const runs = Object.values(files)
  .filter((run) => run?.schema === 1 && run.summary)
  .sort((a, b) => (b.summary.score ?? -1) - (a.summary.score ?? -1) || b.started_at.localeCompare(a.started_at));

export const cases = Object.values(caseFiles)
  .map((text) => yaml.load(text))
  .sort((a, b) => a.id.localeCompare(b.id));

export const FAMILIES = { "new-event": "New events", "known-event": "Already covered", "out-of-scope": "Out of scope" };
export const FAMILY_NOTE = {
  "new-event": "A real event the tracker does not have yet. The model has to recognise it and write the report: facts, figures, sources, photos. Some have a look-alike in the tracker (same place, same day or same weight) that it must not be merged into.",
  "known-event": "Another page about an event the tracker already has: a reprint, a translation, a headline about the other drugs in the raid, a later step in the case. The model has to find the report and add to it, not write a second one.",
  "out-of-scope": "A page that looks relevant and is not: synthetic cannabinoids, a law change, statistics, cannabis only in passing.",
};
export const CAPABILITIES = {
  recognised: ["Recognised", "Saw that the page reports a cannabis enforcement event and wrote a report"],
  facts: ["Facts", "Country, date of the event, kind of event and place on the map"],
  figures: ["Figures", "Kilograms, plants, hectares, people, money: right numbers, converted units, nothing invented"],
  classification: ["Classification", "Product, case stage, setting, agencies, smuggling route"],
  corroboration: ["Corroboration", "Found other outlets reporting the same event and used them"],
  photos: ["Photos", "Linked real photos of the event with a working address; left out stand-in pictures"],
  text: ["Text", "The report says the key points and lists what stays open"],
  grounding: ["Grounding", "Sentences and figures backed by a quotation found in the opened source"],
};

// Runs are compared only within one set: the same cases, the same run settings, the same scoring rules.
export const setOf = (run) => `${run.cases_hash}·${run.protocol_hash}·${run.scorer_version}`;

export function sets() {
  const groups = new Map();
  for (const run of runs) {
    const key = run.full_set && run.complete ? setOf(run) : "partial";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const full = [...groups.entries()].filter(([key]) => key !== "partial").map(([key, list]) => ({ key, runs: list, latest: list.map((r) => r.started_at).sort().at(-1) }));
  full.sort((a, b) => b.latest.localeCompare(a.latest));
  return { full, partial: groups.get("partial") || [] };
}

export const day = (iso) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
export const score = (value) => (value == null ? "–" : String(Math.round(value)));
export const band = (value) => (value == null ? "none" : value >= 85 ? "pass" : value >= 50 ? "part" : "fail");
export const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n || 0));

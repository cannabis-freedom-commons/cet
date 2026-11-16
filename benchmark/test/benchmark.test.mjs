// The benchmark's own rules: case files are well formed, subjects parse, and the scorer gives the
// scores its documentation promises. No model, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { FAMILIES, loadCases } from "../lib/cases.mjs";
import { finalOutcome, outletOf, scoreCase, summarize } from "../lib/score.mjs";
import { normalizeURL, parseSubject } from "../lib/util.mjs";

const cases = loadCases();
const byId = Object.fromEntries(cases.map((item) => [item.id, item]));

test("case files load, with unique ids and pages, and every family present", () => {
  assert.ok(cases.length >= 20);
  assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
  assert.equal(new Set(cases.map((item) => normalizeURL(item.submit))).size, cases.length);
  for (const family of Object.keys(FAMILIES)) assert.ok(cases.some((item) => item.family === family), family);
  // a case never shares a submitted page's outlet list with nothing to find: new events name their answer
  for (const item of cases.filter((c) => c.family === "new-event")) assert.equal(item.expect.outcome.new_event, 1, item.id);
});

test("a subject is harness, provider, model and effort", () => {
  assert.deepEqual(
    (({ id, harness, provider, model, effort, agent }) => ({ id, harness, provider, model, effort, agent }))(parseSubject("opencode@swancloud/muse-spark-1.3-contributor#xhigh")),
    { id: "opencode@swancloud/muse-spark-1.3-contributor#xhigh", harness: "opencode", provider: "swancloud", model: "muse-spark-1.3-contributor", effort: "xhigh", agent: "swancloud/muse-spark-1.3-contributor#xhigh" },
  );
  assert.equal(parseSubject("swancloud/x").id, "opencode@swancloud/x");
  assert.equal(parseSubject("openrouter/inclusionai/ling-3.2-flash:free").model, "inclusionai/ling-3.2-flash:free");
  const muse = parseSubject("muse@muse-spark-1.3#xhigh");
  assert.deepEqual([muse.harness, muse.provider, muse.agent], ["muse", "muse", "muse@muse-spark-1.3#xhigh"]);
  assert.throws(() => parseSubject("cursor@x/y"));
  assert.throws(() => parseSubject("opencode@model-without-provider"));
  assert.throws(() => parseSubject("muse@provider/model"));
});

test("one outlet under its hosts", () => {
  assert.equal(outletOf("https://english.ajel.sa/a"), outletOf("ajel.sa"));
  assert.equal(outletOf("https://m.example.co.uk/x"), "example.co.uk");
  assert.notEqual(outletOf("https://a.com/x"), outletOf("https://b.com/x"));
});

test("the service's final status is the outcome that is scored", () => {
  assert.equal(finalOutcome({ status: "committed", result: { outcome: "additional_source" } }), "additional_source");
  assert.equal(finalOutcome({ status: "routed_to_cfi" }), "routed_to_cfi");
  assert.equal(finalOutcome({ status: "needs_review" }), "insufficient_evidence");
  assert.equal(finalOutcome({ status: "failed" }), "failed");
  assert.equal(finalOutcome({ status: "timeout" }), "error");
});

test("out-of-scope and known-event cases are scored on the decision alone", () => {
  const scope = byId["sn-kush-synthetic-name"];
  assert.equal(scoreCase(scope, { status: "not_relevant" }).score, 100);
  assert.equal(scoreCase(scope, { status: "insufficient_evidence" }).score, 50);
  assert.equal(scoreCase(scope, { status: "committed", result: { outcome: "new_event" } }).score, 0);
  assert.equal(scoreCase(scope, { status: "failed" }).verdict, "fail");
  assert.equal(scoreCase(scope, { status: "timeout" }).verdict, "error");

  const known = byId["us-eagle-point-reprint"];
  const target = known.expect.existing_report;
  assert.equal(scoreCase(known, { status: "duplicate", report_slug: target }).score, 100);
  assert.equal(scoreCase(known, { status: "committed", report_slug: target, result: { outcome: "additional_source", existing_report: target } }).score, 100);
  assert.equal(scoreCase(known, { status: "duplicate", report_slug: "some-other-report" }).score, 0, "the wrong report is no match");
  assert.equal(scoreCase(known, { status: "committed", report_slug: "a-second-report", result: { outcome: "new_event" } }).score, 0);
});

function clifton(changes = {}) {
  const result = {
    outcome: "new_event", country: "us/ny", incident_date: "2026-09-08", type: "seizure", also: ["arrest"], place: "Clifton Park", coordinates: [42.86, -73.77],
    figures: { kg_seized: 221.81, arrested: 2, charged: 2 },
    details: { products: [{ product: "flower", kg: 221.81 }], case_stage: "charged", setting: ["vehicle"] },
    title: "Two charged after 489 pounds of cannabis seized in Clifton Park",
    summary: "Deputies seized 489 pounds during a traffic stop. Both men were charged.",
    sources: [{ url: "https://wnyt.com/a", publisher: "WNYT" }, { url: "https://dailyvoice.com/b", publisher: "Daily Voice" }],
    media: [{ kind: "photo", url: "https://dailyvoice.com/b", media_url: "https://edge.dailyvoice.com/upload/489_pounds_of_weed.jpg?width=720", caption: "The seized cannabis" }],
    uncertainties: ["No court outcome was reported."],
    ...changes,
  };
  return {
    status: "committed", report_slug: "x", result,
    draft_markdown: "---\nstatus: verified\nopen_questions:\n  - No court outcome was reported.\n---\n\nDeputies found 489 pounds of cannabis in a traffic stop. [@1] Both were charged. [@2]\n",
    validation: { facts: 2, confirmed: 2 },
    evidence: [], media_checks: [{ media_url: result.media?.[0]?.media_url, ok: true }], runs: [],
  };
}

test("a complete, correct report scores 100; each mistake costs its part", () => {
  const item = byId["us-clifton-park-pounds"];
  assert.equal(scoreCase(item, clifton()).score, 100);

  const pounds = scoreCase(item, clifton({ figures: { kg_seized: 489, arrested: 2 } }));
  assert.equal(pounds.dimensions.figures.score, 0.25, "wrong weight, and it is the pounds trap");
  assert.ok(pounds.score < 90);

  const state = scoreCase(item, clifton({ country: "us" }));
  assert.equal(state.dimensions.facts.checks[0].score, 0.5);

  const alone = scoreCase(item, clifton({ sources: [{ url: "https://wnyt.com/a", publisher: "WNYT" }] }));
  assert.equal(alone.dimensions.corroboration.score, 0.5);

  const noPhoto = scoreCase(item, clifton({ media: [] }));
  assert.equal(noPhoto.dimensions.photos.score, 0);
  assert.equal(noPhoto.score, 90);

  const rejected = scoreCase(item, { status: "not_relevant", result: { outcome: "not_relevant" } });
  assert.equal(rejected.score, 0, "no report where one was due");
  assert.equal(rejected.dimensions.facts.score, 0);
});

test("a source is counted only when it is about the event", () => {
  const item = byId["us-clifton-park-pounds"];
  const raw = clifton({ sources: [{ url: "https://wnyt.com/a", publisher: "WNYT" }, { url: "https://unknown.example/story", publisher: "Unknown" }] });
  raw.evidence = [{ url: "https://unknown.example/story", text: "A report on road works in another county." }];
  const off = scoreCase(item, raw);
  assert.equal(off.dimensions.corroboration.score, 0.5 * 0.75, "one real outlet of two, and one page about something else");
  raw.evidence = [{ url: "https://unknown.example/story", text: "Deputies seized 489 pounds in Clifton Park; Wilbur was jailed." }];
  assert.equal(scoreCase(item, raw).dimensions.corroboration.score, 1);
});

test("a stand-in picture kept where no photo of the event exists scores zero for photos", () => {
  const item = byId["in-manesar-roundup"];
  const base = {
    status: "committed", draft_markdown: "---\nstatus: verified\n---\nText.\n", validation: { facts: 1, confirmed: 1 }, evidence: [], runs: [],
    result: { outcome: "new_event", country: "in", incident_date: "2026-11-11", type: "seizure", coordinates: [28.35, 76.94], figures: { kg_seized: 12 }, details: { products: [{ product: "flower" }] }, title: "12 kg seized at Nainwal Cut", sources: [], media: [] },
  };
  assert.equal(scoreCase(item, base).dimensions.photos.score, 1);
  base.result.media = [{ kind: "photo", media_url: "https://static.toiimg.com/photo.jpg" }];
  assert.equal(scoreCase(item, base).dimensions.photos.score, 0);
});

test("a run's score is the mean over cases, each case the mean of its repeats", () => {
  const summary = summarize([
    { id: "a", family: "out-of-scope", attempts: [{ score: 100, verdict: "pass", decision: { score: 1 }, usage: {} }, { score: 0, verdict: "fail", decision: { score: 0 }, usage: {} }] },
    { id: "b", family: "known-event", attempts: [{ score: 100, verdict: "pass", decision: { score: 1 }, usage: {} }, { score: 100, verdict: "pass", decision: { score: 1 }, usage: {} }] },
    { id: "c", family: "out-of-scope", attempts: [{ score: null, verdict: "skipped", decision: { score: 0 }, usage: {} }] },
  ]);
  assert.equal(summary.score, 75);
  assert.deepEqual(summary.attempt_scores, [100, 50]);
  assert.equal(summary.families["out-of-scope"].score, 50);
  assert.equal(summary.verdicts.skipped, 1);
});

test("an answer that names the hidden report came from the live site and is not counted", () => {
  const item = byId["sa-asir-execution"];
  const hidden = item.setup.hide[0];
  const leaked = scoreCase(item, { status: "failed", explanation: "The proposed duplicate names a report that is no longer available.", result: { outcome: "duplicate", existing_report: hidden } });
  assert.equal(leaked.verdict, "spoiled");
  assert.equal(leaked.score, null);
  const merged = scoreCase(item, { status: "committed", report_slug: hidden, result: { outcome: "additional_source", existing_report: hidden } });
  assert.equal(merged.verdict, "spoiled");
  // a merge into another, visible report is an ordinary wrong answer
  assert.equal(scoreCase(item, { status: "committed", report_slug: "saudi-asir-five-ethiopians-november-executed", result: { outcome: "additional_source", existing_report: "saudi-asir-five-ethiopians-november-executed" } }).score, 0);
  const summary = summarize([{ id: item.id, family: item.family, attempts: [leaked] }, { id: "b", family: "out-of-scope", attempts: [{ score: 100, verdict: "pass", decision: { score: 1 }, usage: {} }] }]);
  assert.equal(summary.score, 100);
  assert.equal(summary.verdicts.spoiled, 1);
});

test("the tracker's own pages in search results are flagged", () => {
  const item = byId["sn-kush-synthetic-name"];
  const seen = scoreCase(item, { status: "not_relevant", own_site_seen: ["https://tracker.cannabisfreedom.fyi/report/x/"] });
  assert.equal(seen.score, 100);
  assert.equal(seen.flags.length, 1);
});

test("look-alike cases keep the neighbouring event's figures out", () => {
  const item = byId["in-agartala-same-platform"];
  const base = (figures) => ({
    status: "committed", draft_markdown: "---\nstatus: verified\n---\nRailway police estimated the 5.525 kg found on platform 1 at 2.5 lakh rupees.\n", validation: { facts: 1, confirmed: 1 }, evidence: [], runs: [],
    result: { outcome: "new_event", country: "in", incident_date: "2026-11-13", type: "seizure", coordinates: [23.79, 91.28], figures, details: { products: [{ product: "flower" }] }, title: "Man held with 5.525 kg at Agartala station", sources: [], media: [] },
  });
  assert.equal(scoreCase(item, base({ kg_seized: 5.525, arrested: 1, value: { amount: 250000, currency: "INR" } })).dimensions.figures.score, 1);
  const headline = scoreCase(item, base({ kg_seized: 5.525, arrested: 1, value: { amount: 500000, currency: "INR" } }));
  assert.ok(Math.abs(headline.dimensions.figures.score - (2 / 3) * 0.5) < 1e-9, "the headline's value is wrong and is the trap");
});

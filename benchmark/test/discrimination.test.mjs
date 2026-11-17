// The case report: which cases separate subjects, and each subject's range. No model, no network.
import assert from "node:assert/strict";
import test from "node:test";
import { analyse, pickRuns } from "../lib/discrimination.mjs";

const run = (subject, scores, extra = {}) => ({
  id: `${subject}-${extra.id || 1}`,
  subject: { id: subject },
  complete: true,
  full_set: true,
  cases_hash: "h",
  protocol: { version: 1 },
  scorer_version: 1,
  ...extra,
  cases: Object.entries(scores).map(([id, values]) => ({ id, family: "new-event", attempts: [values].flat().map((score) => ({ score })) })),
});

// a strong, a middling and a weak subject; "easy" everyone passes, "hard" follows strength,
// "odd" goes against it
const runs = [
  run("strong", { easy: 100, hard: 100, mid: 90, odd: 40 }),
  run("middle", { easy: 100, hard: 50, mid: 60, odd: 50 }),
  run("weak", { easy: 100, hard: 0, mid: 20, odd: 60 }),
];

test("a case everyone passes is at the ceiling and worth nothing", () => {
  const easy = analyse(runs).cases.find((row) => row.id === "easy");
  assert.deepEqual(easy.flags, ["ceiling"]);
  assert.equal(easy.value, 0);
});

test("a case that follows the subjects' strength ranks first; one against it is flagged", () => {
  const { cases } = analyse(runs);
  assert.equal(cases[0].id, "hard");
  assert.ok(cases[0].r > 0.9);
  assert.ok(cases.find((row) => row.id === "odd").flags.includes("inverse"));
});

test("repeats of one subject are pooled, not counted as more subjects", () => {
  const repeated = [...runs, run("strong", { easy: 100, hard: 80, mid: 90, odd: 40 }, { id: 2 })];
  const report = analyse(repeated);
  assert.equal(report.subjects, 3);
  assert.equal(report.ranges.find((range) => range.subject === "strong").repeats, 2);
});

test("ranges hold the score, and only runs of the newest full set are compared", () => {
  for (const range of analyse(runs).ranges) assert.ok(range.low <= range.score && range.score <= range.high);
  const old = run("old", { easy: 0 }, { cases_hash: "older", finished_at: "2020" });
  const partial = run("partial", { easy: 0 }, { full_set: false });
  assert.equal(pickRuns([...runs.map((r) => ({ ...r, finished_at: "2026" })), old, partial]).length, 3);
});

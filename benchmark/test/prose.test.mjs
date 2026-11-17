// The prose judge's rules: places become scores, judges pool with equal weight, a judge's own
// model is not counted, and a ranking that drops or doubles a text is refused. No model is called.
import assert from "node:assert/strict";
import test from "node:test";
import { aggregate, entryKey, judgeEntries, proseOf, sameModel, trackerKey, trackerProse } from "../lib/prose-score.mjs";
import { promptFor, readRanking, rubric, shuffleLabels, textOf } from "../lib/prose.mjs";

const A = entryKey("c1", "runA", 0);
const B = entryKey("c1", "runB", 0);
const T = trackerKey("c1");
const models = { [A]: "swancloud/alpha-1", [B]: "openai/beta-2", [T]: "tracker" };
const judge = (id, model, rankings) => ({ judge: { id, model }, rounds: rankings.map((ranking) => ({ case: "c1", ranking, models })) });
const run = (id) => ({ id, subject: { id }, cases: [{ id: "c1", attempts: [{ score: 90 }] }] });

test("best place is 100, worst 0, and rounds average", () => {
  const scores = judgeEntries(judge("j", "claude-x", [[A, T, B], [T, A, B]]));
  assert.equal(scores.get(A).score, 75);
  assert.equal(scores.get(B).score, 0);
  assert.equal(scores.get(T).score, 75);
  assert.deepEqual([scores.get(A).beats, scores.get(A).vs], [1, 2]);
});

test("each judge counts once, however many rounds it ran", () => {
  const many = judge("j1", "claude-x", [[A, B], [A, B], [A, B]]);
  const one = judge("j2", "claude-y", [[B, A]]);
  const agg = aggregate([many, one]);
  assert.equal(agg.entries.get(A).score, 50);
  assert.deepEqual(agg.entries.get(A).judges, { j1: 100, j2: 0 });
  assert.deepEqual(proseOf([run("runA")], agg).judges, { j1: 100, j2: 0 });
  assert.equal(proseOf([run("nobody")], agg), null);
});

test("a judge does not score its own model's texts", () => {
  assert.ok(sameModel("claude-opus-5-5", "swancloud/claude-opus-5-5"));
  assert.ok(!sameModel("claude-opus-5-5", "claude-haiku-5-5"));
  const scores = judgeEntries(judge("j", "alpha-1", [[A, B, T]]));
  assert.equal(scores.has(A), false);
  assert.equal(scores.get(B).score, 50);
  assert.equal(trackerProse(aggregate([judge("j", "z", [[T, A, B]])])).score, 100);
});

test("a ranking must hold every text exactly once", () => {
  const labelled = shuffleLabels([{ key: A }, { key: B }, { key: T }], () => 0.5);
  assert.deepEqual(labelled.map((e) => e.label), ["T01", "T02", "T03"]);
  const [x, y, z] = labelled;
  assert.deepEqual(readRanking({ ranking: [{ id: z.label, note: "n" }, { id: x.label, note: "" }, { id: y.label, note: "" }] }, labelled).ranking, [z.key, x.key, y.key]);
  assert.throws(() => readRanking({ ranking: [{ id: x.label }, { id: y.label }] }, labelled), /not ranked/);
  assert.throws(() => readRanking({ ranking: [{ id: x.label }, { id: x.label }, { id: z.label }] }, labelled), /twice/);
  assert.throws(() => readRanking({ ranking: [{ id: "T99" }] }, labelled), /unknown/);
});

test("the judge sees text without citations or pictures, and no model names", () => {
  const text = textOf({ title: "Ten held", summary: "Police held ten.", body: "Police held ten [@1].\n\n![x](http://p.jpg)\nMore [@2, @3]." });
  assert.equal(text, "# Ten held\n\nPolice held ten.\n\nPolice held ten.\n\nMore.");
  const prompt = promptFor({ title: "Event" }, shuffleLabels([{ key: A, model: "swancloud/alpha-1", text: "x" }]));
  assert.ok(!prompt.includes("alpha") && !prompt.includes("runA"));
  assert.match(rubric(), /How it reads|Lead with people/);
});

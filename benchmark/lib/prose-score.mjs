// How the prose judgments become scores. No file access, so the site (data.js) and the judge
// command use the same rules.
//
// A judgment file (results/prose/<judge>.json) belongs to one judge (a model and effort, run through
// a tool) and holds its rounds. A round is one case: the judge saw every report text written for
// it, in a shuffled order without model names, and ranked them best first. Within a round a text
// scores by its place: best 100, worst 0. A text's score from one judge is the mean over that
// judge's rounds; its overall prose score the mean over judges, each judge counting once however
// many rounds it ran. So more rounds make one judge steadier, and more judges add more views.
//
// Entry keys: "<case id>/<run id>/<attempt index>", and "<case id>/tracker" for the report the
// tracker published on that event (the hidden answer), ranked with the rest as a yardstick.

export const entryKey = (caseId, runId, index) => `${caseId}/${runId}/${index}`;
export const trackerKey = (caseId) => `${caseId}/tracker`;
export const isTracker = (key) => key.endsWith("/tracker");

// "openai/gpt-6.1-terra" and "claude-opus-5-5" → comparable names, to keep a judge from scoring
// texts its own model wrote
const bare = (model) => String(model || "").toLowerCase().split("/").pop().split("#")[0].replace(/[^a-z0-9]+/g, "-").replace(/-(free|contributor)$/, "");
export const sameModel = (a, b) => Boolean(a && b) && bare(a) === bare(b);

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const round1 = (value) => (value == null ? null : Math.round(value * 10) / 10);

// one judge: each text's mean place over its rounds, and how often it ranked above the tracker's text
export function judgeEntries(file) {
  const out = new Map();
  for (const r of file.rounds || []) {
    const n = r.ranking.length;
    if (n < 2) continue;
    const trackerAt = r.ranking.findIndex(isTracker);
    r.ranking.forEach((key, place) => {
      if (sameModel(file.judge.model, r.models?.[key])) return; // its own model's text: not counted
      const entry = out.get(key) || { places: [], beats: 0, vs: 0 };
      entry.places.push((100 * (n - 1 - place)) / (n - 1));
      if (trackerAt >= 0 && !isTracker(key)) {
        entry.vs += 1;
        if (place < trackerAt) entry.beats += 1;
      }
      out.set(key, entry);
    });
  }
  return new Map([...out].map(([key, entry]) => [key, { score: mean(entry.places), rounds: entry.places.length, beats: entry.beats, vs: entry.vs }]));
}

// all judges: { judges: [{id, rounds, cases}], entries: Map key → { score, judges: {id: score}, beats, vs } }
export function aggregate(files) {
  const judges = [];
  const entries = new Map();
  for (const file of files) {
    if (!file?.judge?.id || !file.rounds?.length) continue;
    judges.push({ id: file.judge.id, model: file.judge.model, effort: file.judge.effort, rounds: file.rounds.length, cases: new Set(file.rounds.map((r) => r.case)).size });
    for (const [key, value] of judgeEntries(file)) {
      const entry = entries.get(key) || { judges: {}, beats: 0, vs: 0 };
      entry.judges[file.judge.id] = value.score;
      entry.beats += value.beats;
      entry.vs += value.vs;
      entries.set(key, entry);
    }
  }
  for (const entry of entries.values()) entry.score = mean(Object.values(entry.judges));
  return { judges, entries };
}

// A model's (or one run's) prose score: per case the mean of its judged texts, then the mean over
// the cases where it wrote one. The same per judge, for the tooltip. null when nothing was judged.
export function proseOf(runs, agg) {
  const perCase = new Map();
  let beats = 0;
  let vs = 0;
  for (const run of runs) {
    for (const item of run.cases || []) {
      item.attempts.forEach((_, index) => {
        const entry = agg.entries.get(entryKey(item.id, run.id, index));
        if (!entry) return;
        const values = perCase.get(item.id) || [];
        values.push(entry);
        perCase.set(item.id, values);
        beats += entry.beats;
        vs += entry.vs;
      });
    }
  }
  if (!perCase.size) return null;
  const caseMean = (pick) => mean([...perCase.values()].map((values) => mean(values.map(pick).filter((v) => v != null))).filter((v) => v != null));
  const judges = {};
  for (const judge of agg.judges) {
    const value = caseMean((entry) => entry.judges[judge.id] ?? null);
    if (value != null) judges[judge.id] = round1(value);
  }
  return { score: round1(caseMean((entry) => entry.score)), cases: perCase.size, judges, beats, vs };
}

// the tracker's own published texts, as a yardstick row
export function trackerProse(agg) {
  const values = [...agg.entries].filter(([key]) => isTracker(key)).map(([, entry]) => entry);
  if (!values.length) return null;
  const judges = {};
  for (const judge of agg.judges) {
    const own = values.map((entry) => entry.judges[judge.id]).filter((v) => v != null);
    if (own.length) judges[judge.id] = round1(mean(own));
  }
  return { score: round1(mean(values.map((entry) => entry.score))), cases: values.length, judges };
}

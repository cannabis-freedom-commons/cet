// Which cases tell models apart? Item analysis over saved runs: for each case, how far the subjects'
// scores spread, whether the strong subjects score higher on it than the weak ones, and how much one
// subject's repeats differ. Also each subject's score with a range from resampling the cases, so a
// few points between two rows can be read as a difference or as noise. Fixed rules, no model.

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const sd = (values) => {
  if (values.length < 2) return null;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
};
const round = (value, digits = 1) => (value == null || Number.isNaN(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits);

function pearson(xs, ys) {
  if (xs.length < 3) return null;
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// a small seeded generator, so the same runs always give the same ranges
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const setOf = (run) => `${run.cases_hash}/p${run.protocol?.version}/s${run.scorer_version}`;

// The runs that are compared: complete runs of all cases, in the set of the newest such run
// (or in every set with all: true, which mixes scoring rules and should only be a rough look).
export function pickRuns(runs, { all = false } = {}) {
  const full = runs.filter((run) => run.complete && run.full_set);
  if (all || !full.length) return full;
  const newest = [...full].sort((a, b) => String(a.finished_at || a.id).localeCompare(String(b.finished_at || b.id))).at(-1);
  return full.filter((run) => setOf(run) === setOf(newest));
}

// Every attempt's score per subject and case. Repeats of one subject (in one run or several) are
// pooled, so a subject run three times does not count three times between subjects.
export function collect(runs) {
  const subjects = new Map();
  const cases = new Map();
  for (const run of runs) {
    const subject = run.subject.id;
    if (!subjects.has(subject)) subjects.set(subject, new Map());
    const byCase = subjects.get(subject);
    for (const item of run.cases) {
      if (!cases.has(item.id)) cases.set(item.id, { id: item.id, title: item.title, family: item.family });
      const scores = item.attempts.map((attempt) => attempt.score).filter((score) => typeof score === "number");
      if (!scores.length) continue;
      byCase.set(item.id, [...(byCase.get(item.id) || []), ...scores]);
    }
  }
  return { subjects, cases };
}

// Flags, in plain words. Thresholds are on the 0-100 case score.
const CEILING = 95; // every subject at least this: the case separates no one
const PASS = 85; // the scorer's own pass line
export const FLAGS = {
  ceiling: `every subject scores ${CEILING} or more: separates no one`,
  "mostly-pass": `at least 90% of subjects pass (${PASS}+): separates only the weakest`,
  floor: "average below 40: check the answer before trusting it",
  inverse: "strong subjects do worse here than weak ones: check the answer and the scoring",
  noisy: "one subject's repeats differ more than subjects differ: mostly luck",
};

export function analyse(runs, { samples = 2000, seed = 1 } = {}) {
  const { subjects, cases } = collect(runs);
  const subjectMean = new Map(); // subject → case → mean of its attempts
  for (const [subject, byCase] of subjects) {
    subjectMean.set(subject, new Map([...byCase].map(([id, scores]) => [id, mean(scores)])));
  }

  const rows = [];
  for (const meta of cases.values()) {
    const values = [];
    const rest = [];
    const within = [];
    for (const [subject, byCase] of subjectMean) {
      if (!byCase.has(meta.id)) continue;
      const others = [...byCase].filter(([id]) => id !== meta.id).map(([, value]) => value);
      if (!others.length) continue;
      values.push(byCase.get(meta.id));
      rest.push(mean(others));
      const attempts = subjects.get(subject).get(meta.id);
      if (attempts.length > 1) within.push(sd(attempts) ** 2);
    }
    if (!values.length) continue;
    const between = sd(values);
    const noise = within.length >= 2 ? Math.sqrt(mean(within)) : null;
    const r = pearson(values, rest);
    // spread among the stronger half: does the case still separate the subjects that matter?
    const ranked = values.map((value, i) => [rest[i], value]).sort((a, b) => b[0] - a[0]);
    const top = ranked.slice(0, Math.ceil(ranked.length / 2)).map(([, value]) => value);
    const passRate = values.filter((value) => value >= PASS).length / values.length;
    const flags = [];
    if (Math.min(...values) >= CEILING) flags.push("ceiling");
    else if (passRate >= 0.9) flags.push("mostly-pass");
    if (mean(values) < 40) flags.push("floor");
    if (r != null && r < -0.1) flags.push("inverse");
    if (noise != null && between != null && noise > between) flags.push("noisy");
    rows.push({
      ...meta,
      subjects: values.length,
      mean: round(mean(values)),
      min: round(Math.min(...values)),
      max: round(Math.max(...values)),
      spread: round(between),
      top_spread: round(sd(top)),
      pass_rate: round(passRate * 100, 0),
      r: round(r, 2),
      noise: round(noise),
      flags,
    });
  }

  // a case is worth more the more it spreads the subjects and the more that spread follows their
  // overall strength; ceiling cases come out at 0
  for (const row of rows) row.value = round(((row.spread || 0) * Math.max(0, row.r ?? 0)), 1);
  rows.sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || (a.mean ?? 0) - (b.mean ?? 0));

  // each subject's score with a 95% range from drawing its cases again with replacement
  const random = rng(seed);
  const ranges = [];
  for (const [subject, byCase] of subjectMean) {
    const values = [...byCase.values()];
    const draws = [];
    for (let i = 0; i < samples; i += 1) {
      let sum = 0;
      for (let j = 0; j < values.length; j += 1) sum += values[Math.floor(random() * values.length)];
      draws.push(sum / values.length);
    }
    draws.sort((a, b) => a - b);
    const attempts = [...subjects.get(subject).values()].reduce((n, scores) => n + scores.length, 0);
    ranges.push({
      subject,
      cases: values.length,
      repeats: round(attempts / values.length, 1),
      score: round(mean(values)),
      low: round(draws[Math.floor(samples * 0.025)]),
      high: round(draws[Math.min(samples - 1, Math.floor(samples * 0.975))]),
    });
  }
  ranges.sort((a, b) => b.score - a.score);
  // the subjects that cannot be told apart from the best one: their range reaches its score
  const best = ranges[0];
  for (const range of ranges) range.tied_with_best = Boolean(best) && range.high >= best.score;

  const families = {};
  for (const row of rows) {
    const family = (families[row.family] ||= { cases: 0, ceiling: 0, mean: [], spread: [] });
    family.cases += 1;
    if (row.flags.includes("ceiling")) family.ceiling += 1;
    family.mean.push(row.mean);
    family.spread.push(row.spread || 0);
  }
  for (const family of Object.values(families)) {
    family.mean = round(mean(family.mean));
    family.spread = round(mean(family.spread));
  }

  return { runs: runs.length, subjects: subjectMean.size, cases: rows, families, ranges };
}

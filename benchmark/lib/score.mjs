// Scoring: what the research service ended with for a case, compared with the case's answer.
// Everything here is a plain rule on recorded output (no judge model), so a run can be scored
// again at any time and two runs are compared by the same rules.
import * as yaml from "js-yaml";
import { domainOf, normalizeURL } from "./util.mjs";

export const SCORER_VERSION = 1;

// How much each part of a written report counts. A case that should produce a report and does not
// scores zero on all of them; a case that should produce none is scored on the decision alone.
export const WEIGHTS = { facts: 20, figures: 20, classification: 10, corroboration: 15, photos: 10, text: 15, grounding: 10 };

export const DIMENSIONS = {
  facts: "Facts",
  figures: "Figures and units",
  classification: "Classification",
  corroboration: "Corroboration",
  photos: "Photos",
  text: "Report text",
  grounding: "Grounding",
};

const REJECTIONS = ["duplicate", "not_relevant", "insufficient_evidence", "routed_to_cfi"];

// The service's final status, as one of the outcomes a case can expect.
export function finalOutcome(raw) {
  if (raw.status === "committed" || raw.status === "published") return raw.result?.outcome || "new_event";
  if (REJECTIONS.includes(raw.status)) return raw.status;
  if (raw.status === "needs_review") return "insufficient_evidence";
  if (raw.status === "failed") return "failed";
  if (raw.status === "source_unavailable") return "source_unavailable";
  return "error";
}

const clamp = (value) => Math.max(0, Math.min(1, value));
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const list = (value) => (value == null ? [] : Array.isArray(value) ? value : [value]);
const matches = (patterns, text) => list(patterns).some((pattern) => new RegExp(pattern, "iu").test(text));

function near(got, want, tolerance = 0.005) {
  if (typeof got !== "number" || typeof want !== "number") return false;
  return Math.abs(got - want) <= Math.max(Math.abs(want) * tolerance, 1e-9);
}

function kilometres([lat1, lon1], [lat2, lon2]) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

const days = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 86400000);

// One outlet under its hosts: english.ajel.sa and ajel.sa, m.site.co.uk and site.co.uk.
export function outletOf(url) {
  const labels = (url.includes("/") ? domainOf(url) : url.toLowerCase().replace(/^www\./, "")).split(".");
  const second = labels[labels.length - 2];
  const wide = labels[labels.length - 1]?.length === 2 && ["co", "com", "org", "net", "gov", "gob", "go", "ac", "edu", "or", "ne"].includes(second);
  return labels.slice(wide ? -3 : -2).join(".");
}

export function parseReport(markdown) {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(markdown || "");
  if (!match) return { front: {}, body: "" };
  let front = {};
  try {
    front = yaml.load(match[1]) || {};
  } catch {
    // an unparsable draft has no front matter to show
  }
  const body = markdown.slice(match[0].length).replace(/\s*\[@[\d,\s]+\]/g, "").trim();
  return { front, body };
}

function figureAt(figures, key) {
  return key.split(".").reduce((value, part) => (value == null ? undefined : value[part]), figures || {});
}

function show(value) {
  if (value === undefined || value === null || value === "") return "none";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

const check = (label, score, expected, got, note = "") => ({ label, score: clamp(score), expected: show(expected), got: show(got), ...(note ? { note } : {}) });

function facts(expect, result) {
  const checks = [];
  checks.push(check("Country", expect.country[result.country] ?? 0, Object.keys(expect.country)[0], result.country));

  const date = String(result.incident_date || "");
  let dateScore = 0;
  if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const off = days(date, expect.date.value);
    const tolerance = expect.date.tolerance_days || 0;
    if (off === 0) dateScore = 1;
    else if (expect.date.direction === "before" ? off < 0 && -off <= tolerance : Math.abs(off) <= tolerance) dateScore = 1;
    else dateScore = expect.date.also?.[date] ?? 0;
  }
  const range = expect.date.tolerance_days ? ` (${expect.date.direction === "before" ? "or up to" : "within"} ${expect.date.tolerance_days} days${expect.date.direction === "before" ? " earlier" : ""})` : "";
  checks.push(check("Date of the event", dateScore, expect.date.value + range, date));

  const also = list(result.also);
  let typeScore = expect.type[result.type] ?? 0;
  if (!typeScore && also.some((type) => expect.type[type] === 1)) typeScore = 0.5;
  checks.push(check("Kind of event", typeScore, Object.keys(expect.type).filter((type) => expect.type[type] === 1).join(" or "), [result.type, ...also].filter(Boolean).join(" + ")));

  const point = result.coordinates;
  let placeScore = 0;
  let distance = null;
  if (Array.isArray(point) && point.length === 2 && point.every((n) => typeof n === "number")) {
    distance = kilometres(point, expect.place.coordinates);
    placeScore = distance <= expect.place.within_km ? 1 : distance <= expect.place.within_km * 3 ? 0.5 : 0;
  }
  checks.push(check("Place on the map", placeScore, `within ${expect.place.within_km} km of ${expect.place.coordinates.join(", ")}`, distance == null ? "no coordinates" : `${result.place || ""} (${Math.round(distance)} km away)`));
  return { score: mean(checks.map((c) => c.score)), checks };
}

function figures(expect, result) {
  const got = result.figures || {};
  const checks = [];
  for (const [key, want] of Object.entries(expect.figures || {})) {
    const value = got[key];
    let score = 0;
    let expected;
    if (want.match) {
      expected = want.match[0];
      score = typeof value === "string" && matches(want.match, value) ? 1 : 0;
    } else if (want.amount !== undefined) {
      expected = `${want.amount} ${want.currency}`;
      if (value && near(value.amount, want.amount, want.tolerance ?? 0.01)) score = String(value.currency).toUpperCase() === want.currency ? 1 : 0.5;
    } else if (want.any) {
      expected = want.any.join(" or ");
      score = want.any.some((option) => near(value, option, want.tolerance)) ? 1 : 0;
    } else {
      expected = want.value;
      score = near(value, want.value, want.tolerance) ? 1 : (want.partial || []).some((option) => near(value, option)) ? 0.5 : 0;
    }
    checks.push(check(key, score, expected, value));
  }
  for (const absent of expect.figures_absent || []) {
    const value = got[absent.key];
    const present = value !== undefined && value !== null && value !== 0;
    checks.push(check(`${absent.key} left out`, present ? 0 : 1, "not stated", value, absent.why));
  }
  let score = mean(checks.map((c) => c.score));
  let traps = 0;
  for (const trap of expect.figures_forbidden || []) {
    const value = figureAt(got, trap.key);
    if (near(value, trap.value, 0.005)) {
      traps += 1;
      checks.push(check(`Trap: ${trap.why}`, 0, `not ${trap.value}`, value));
    }
  }
  if (score != null) score *= 0.5 ** traps;
  const known = new Set([...Object.keys(expect.figures || {}), ...(expect.figures_optional || []), ...(expect.figures_absent || []).map((a) => a.key)]);
  const extra = Object.keys(got).filter((key) => !known.has(key));
  return { score, checks, ...(extra.length ? { notes: [`Also recorded, not checked: ${extra.map((key) => `${key} ${show(got[key])}`).join(", ")}`] } : {}) };
}

function classification(expect, result) {
  const details = result.details || {};
  const checks = [];
  for (const [key, accepted] of Object.entries(expect.details || {})) {
    let values;
    if (key === "products") values = list(details.products).map((p) => (typeof p === "string" ? p : p?.product)).filter(Boolean);
    else if (key.startsWith("route.")) values = list(details.route?.[key.slice(6)]);
    else values = list(details[key]);
    let score = 0;
    if (key === "agencies") {
      score = values.some((value) => accepted.some((token) => String(value).toLowerCase() === token.toLowerCase() || String(value).toLowerCase().includes(token.toLowerCase()))) ? 1 : 0;
    } else if (values.length) {
      const right = values.filter((value) => accepted.includes(value)).length;
      score = right === 0 ? 0 : key === "products" && right < values.length ? 0.5 : 1;
    }
    checks.push(check(key.replace("_", " "), score, accepted.join(" or "), values.join(", ")));
  }
  return { score: mean(checks.map((c) => c.score)), checks };
}

function corroboration(expect, result, raw) {
  const spec = expect.sources;
  if (!spec) return null;
  const evidence = new Map();
  for (const item of raw.evidence || []) {
    evidence.set(normalizeURL(item.url), item.text);
    if (item.final_url) evidence.set(normalizeURL(item.final_url), item.text);
  }
  const known = new Set((spec.known || []).map((domain) => outletOf(domain)));
  const need = spec.markers_min || 2;
  const outlets = new Map();
  const checks = [];
  let off = 0;
  for (const source of result.sources || []) {
    const outlet = outletOf(source.url);
    const text = evidence.get(normalizeURL(source.url));
    const found = text ? (spec.markers || []).filter((marker) => text.toLowerCase().includes(marker.toLowerCase())).length : null;
    let verdict;
    if (OWN.test(outlet)) verdict = "own";
    else if (found != null && found >= need) verdict = "same";
    else if (known.has(outlet) && !spec.strict) verdict = "same";
    else if (found === 0) verdict = "off";
    else verdict = "unknown";
    if (verdict === "same" && !outlets.has(outlet)) outlets.set(outlet, source.url);
    if (verdict === "off") off += 1;
    const say = { same: "about this event", off: "none of the event's marks found in the page", unknown: "could not be confirmed as this event", own: "the tracker's own site" }[verdict];
    checks.push(check(source.publisher || outlet, verdict === "same" ? 1 : 0, "a report of this event", `${outlet}: ${say}`));
  }
  const independent = outlets.size;
  let score = clamp(independent / spec.expect_independent) * 0.75 ** off;
  if ((raw.own_site || []).length) score = 0;
  checks.unshift(check("Independent outlets on this event", clamp(independent / spec.expect_independent), `${spec.expect_independent} or more`, independent));
  return { score, checks };
}

const OWN = /(^|\.)cannabisfreedom\.(fyi|org)$/;

function photos(expect, result, raw) {
  const spec = expect.media;
  if (!spec) return null;
  const media = result.media || [];
  if (spec.none) {
    return { score: media.length ? 0 : 1, checks: [check("No picture of this event exists on the pages", media.length ? 0 : 1, "no photos kept", media.length ? media.map((m) => m.media_url).join(", ") : "no photos kept")] };
  }
  const live = new Map((raw.media_checks || []).map((item) => [item.media_url, item.ok]));
  const hit = (patterns, url) => list(patterns).some((pattern) => url.toLowerCase().includes(pattern.toLowerCase()) || safeDecode(url).toLowerCase().includes(pattern.toLowerCase()));
  const checks = [];
  let value = 0;
  let penalty = 0;
  for (const item of media) {
    const url = String(item.media_url || "");
    if (!url) {
      penalty += 0.25;
      checks.push(check("Photo without an address", 0, "a direct media_url", "none"));
    } else if (hit(spec.reject, url)) {
      penalty += 0.5;
      checks.push(check("Stand-in picture kept", 0, "left out", url));
    } else if (live.get(url) === false) {
      penalty += 0.25;
      checks.push(check("Photo address does not open as a picture", 0, "an image or video", url));
    } else if (hit(spec.expect, url)) {
      value += 1;
      checks.push(check("Known photo of the event", 1, "linked", url));
    } else {
      value += 0.6;
      checks.push(check("Another picture (opens; not one of the known photos)", 0.6, "a photo of the event", url, item.caption ? String(item.caption).slice(0, 160) : ""));
    }
  }
  if (!media.length) checks.push(check("Photos of the event", 0, `${spec.min} or more`, "none linked"));
  return { score: clamp(clamp(value / spec.min) - penalty), checks };
}

function safeDecode(url) {
  try {
    return decodeURIComponent(url);
  } catch {
    return url;
  }
}

function text(expect, result, report) {
  const body = `${result.title || ""}\n${result.summary || ""}\n${report.body}`;
  const questions = [...list(report.front.open_questions), ...list(result.uncertainties)].join("\n");
  const checks = [];
  for (const item of expect.mentions || []) checks.push(check(`Says ${item.say}`, matches(item.any, body) ? 1 : 0, "in the text", matches(item.any, body) ? "yes" : "missing"));
  for (const item of expect.must_not_say || []) checks.push(check(`Does not say ${item.say}`, matches(item.any, body) ? 0 : 1, "not in the text", matches(item.any, body) ? "it does" : "correct"));
  for (const item of expect.open_questions || []) checks.push(check(`Open question: ${item.about}`, matches(item.any, questions) ? 1 : 0, "listed as open", matches(item.any, questions) ? "yes" : "missing"));
  const title = String(result.title || "");
  checks.push(check("Title of 90 characters or fewer", title && title.length <= 90 ? 1 : 0, "≤ 90", title.length));
  return { score: mean(checks.map((c) => c.score)), checks };
}

function grounding(raw, report) {
  const v = raw.validation;
  if (!v || !v.facts) return null;
  const ratio = v.confirmed / v.facts;
  const dropped = (v.data_left_out || []).length;
  const checks = [
    check("Sentences whose quotation was found in the source", ratio, `${v.facts} of ${v.facts}`, `${v.confirmed} of ${v.facts}`),
    check("Figures and details kept after the quotation check", 1 - Math.min(1, dropped / 4), "all", dropped ? `${dropped} dropped: ${v.data_left_out.join(", ")}` : "all"),
  ];
  if (report.front.status) checks.push({ ...check("Status given by the service", report.front.status === "verified" ? 1 : 0.5, "verified", report.front.status), info: true });
  return { score: 0.75 * ratio + 0.25 * (1 - Math.min(1, dropped / 4)), checks };
}

function usage(raw) {
  const sum = (key) => (raw.runs || []).reduce((total, run) => total + (run[key] || 0), 0);
  return {
    seconds: raw.seconds ?? null,
    research_seconds: sum("seconds") || null,
    steps: raw.steps ?? null,
    searches: (raw.searches || []).length,
    pages_opened: (raw.fetches || []).filter((fetch) => fetch.ok).length,
    runs: (raw.runs || []).length,
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    reasoning_tokens: sum("reasoning_tokens"),
    cache_read_tokens: sum("cache_read_tokens"),
    cost_usd: sum("cost_usd"),
  };
}

export function scoreCase(item, raw) {
  const expect = item.expect;
  const outcome = finalOutcome(raw);
  const result = raw.result || {};
  const report = parseReport(raw.draft_markdown);
  const target = raw.report_slug || result.existing_report || "";
  const out = {
    status: raw.status,
    outcome,
    model_outcome: result.outcome || "",
    report_slug: raw.report_slug || "",
    existing_report: result.existing_report || "",
    decision_title: result.decision_title || "",
    explanation: String(raw.explanation || result.explanation || "").slice(0, 2000),
    model_explanation: String(result.explanation || "").slice(0, 2000),
    flags: [],
    usage: usage(raw),
    searches: (raw.searches || []).slice(0, 30),
  };
  if ((raw.own_site || []).length) out.flags.push(`Opened the tracker's own site, where the answer is: ${raw.own_site.join(", ")}`);
  if ((raw.own_site_seen || []).length) out.flags.push(`A web search returned the tracker's own pages (it was told to ignore them): ${raw.own_site_seen.join(", ")}`);

  // The live tracker has the report this case hides. An answer that names that report did not come
  // from the benchmark's copy of the tracker but from the live site, so it measures nothing.
  const hidden = item.setup?.hide || [];
  // (a new report that happens to choose the hidden report's name is an ordinary new report)
  if (hidden.includes(result.existing_report) || (outcome !== "new_event" && hidden.includes(raw.report_slug))) {
    out.verdict = "spoiled";
    out.score = null;
    out.decision = { score: 0, expected: Object.keys(expect.outcome).join(" or "), got: "named the hidden report", note: `It answered with ${result.existing_report || raw.report_slug}, the report this case hides, which it can only know from the live tracker site. Not counted.` };
    return out;
  }

  if (outcome === "error" || outcome === "source_unavailable") {
    out.verdict = outcome === "error" ? "error" : "skipped";
    out.score = outcome === "error" ? 0 : null;
    out.decision = { score: 0, expected: Object.keys(expect.outcome).join(" or "), got: outcome === "error" ? "did not finish" : "page could not be opened", note: raw.failure || raw.error || raw.explanation || "The run did not finish." };
    return out;
  }

  let credit = expect.outcome[outcome] ?? 0;
  const wanted = Object.entries(expect.outcome).filter(([, value]) => value === 1).map(([key]) => key).join(" or ");
  let note = "";
  if (expect.existing_report && credit > 0 && ["duplicate", "additional_source", "existing_case"].includes(outcome) && target !== expect.existing_report) {
    credit = 0;
    note = `matched to the wrong report (${target || "none"}), not ${expect.existing_report}`;
  }
  if (outcome === "failed") note = raw.failure || raw.explanation || "the answer did not pass the service's checks";
  out.decision = { score: credit, expected: wanted + (expect.existing_report ? ` → ${expect.existing_report}` : ""), got: (outcome === "failed" ? "no usable answer" : outcome.replace(/_/g, " ")) + (target && outcome !== "new_event" ? ` → ${target}` : ""), ...(note ? { note } : {}) };

  const drafted = ["new_event", "existing_case"].includes(outcome);
  if (item.family === "new-event") {
    out.report = {
      title: result.title || "",
      summary: result.summary || "",
      date: result.incident_date || "",
      country: result.country || "",
      type: result.type || "",
      also: list(result.also),
      place: result.place || "",
      coordinates: result.coordinates || null,
      figures: result.figures || {},
      details: result.details || {},
      tags: result.tags || [],
      sources: (result.sources || []).map((s) => ({ url: s.url, title: s.title, publisher: s.publisher, date: s.date || "", language: s.language || "" })),
      media: (result.media || []).map((m) => ({ kind: m.kind, url: m.url, media_url: m.media_url || "", caption: m.caption || "" })),
      open_questions: list(report.front.open_questions).length ? list(report.front.open_questions) : list(result.uncertainties),
      body: report.body,
      words: report.body ? report.body.split(/\s+/).length : 0,
    };
    const dimensions = {};
    if (credit > 0 && drafted) {
      dimensions.facts = facts(expect, result);
      dimensions.figures = figures(expect, result);
      dimensions.classification = classification(expect, result);
      dimensions.corroboration = corroboration(expect, result, raw);
      dimensions.photos = photos(expect, result, raw);
      dimensions.text = text(expect, result, report);
      dimensions.grounding = grounding(raw, report);
    } else {
      // no report where one was due: every part of it is missing
      for (const key of Object.keys(WEIGHTS)) {
        const applies = key === "corroboration" ? expect.sources : key === "photos" ? expect.media : key === "classification" ? expect.details : true;
        if (applies) dimensions[key] = { score: 0, checks: [] };
      }
    }
    let total = 0;
    let weight = 0;
    out.dimensions = {};
    for (const [key, value] of Object.entries(dimensions)) {
      if (!value || value.score == null) continue;
      out.dimensions[key] = { ...value, score: clamp(value.score), weight: WEIGHTS[key] };
      total += WEIGHTS[key] * clamp(value.score);
      weight += WEIGHTS[key];
    }
    out.score = Math.round((credit * (weight ? total / weight : 0)) * 1000) / 10;
  } else {
    out.score = Math.round(credit * 1000) / 10;
    if (drafted && raw.draft_markdown) out.report = { title: result.title || "", summary: result.summary || "", body: report.body, sources: (result.sources || []).map((s) => ({ url: s.url, title: s.title, publisher: s.publisher })) };
  }
  out.verdict = out.score >= 85 ? "pass" : out.score >= 50 ? "partial" : "fail";
  return out;
}

const round = (value) => (value == null ? null : Math.round(value * 10) / 10);
const median = (values) => {
  const sorted = values.filter((value) => typeof value === "number").sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// cases: [{ id, family, attempts: [scoreCase output] }]
export function summarize(cases) {
  const scored = (attempt) => attempt.score != null;
  for (const item of cases) item.score = round(mean(item.attempts.filter(scored).map((attempt) => attempt.score)));
  const counted = cases.filter((item) => item.score != null);
  const attempts = cases.flatMap((item) => item.attempts);
  const families = {};
  for (const family of ["new-event", "known-event", "out-of-scope"]) {
    const group = counted.filter((item) => item.family === family);
    if (group.length) families[family] = { score: round(mean(group.map((item) => item.score))), cases: group.length };
  }
  const capabilities = {};
  const newEvents = counted.filter((item) => item.family === "new-event");
  if (newEvents.length) {
    capabilities.recognised = { score: round(100 * mean(newEvents.map((item) => mean(item.attempts.filter(scored).map((a) => a.decision.score))))), cases: newEvents.length };
    for (const key of Object.keys(WEIGHTS)) {
      const group = newEvents.filter((item) => item.attempts.some((a) => a.dimensions?.[key]));
      if (!group.length) continue;
      capabilities[key] = { score: round(100 * mean(group.map((item) => mean(item.attempts.filter((a) => a.dimensions?.[key]).map((a) => a.dimensions[key].score))))), cases: group.length };
    }
  }
  const count = (verdict) => attempts.filter((attempt) => attempt.verdict === verdict).length;
  const maxAttempts = Math.max(0, ...cases.map((item) => item.attempts.length));
  const perAttempt = [];
  for (let index = 0; index < maxAttempts; index += 1) {
    const values = cases.map((item) => item.attempts[index]).filter((attempt) => attempt && scored(attempt)).map((attempt) => attempt.score);
    if (values.length) perAttempt.push(round(mean(values)));
  }
  const total = (key) => attempts.reduce((sum, attempt) => sum + (attempt.usage?.[key] || 0), 0);
  return {
    score: round(mean(counted.map((item) => item.score))),
    attempt_scores: perAttempt,
    cases: cases.length,
    attempts: attempts.length,
    verdicts: { pass: count("pass"), partial: count("partial"), fail: count("fail"), error: count("error"), skipped: count("skipped"), spoiled: count("spoiled") },
    families,
    capabilities,
    usage: {
      minutes_per_case: round(median(attempts.map((a) => a.usage?.seconds)) / 60 || null),
      steps_per_case: median(attempts.map((a) => a.usage?.steps)),
      input_tokens: total("input_tokens"),
      output_tokens: total("output_tokens"),
      reasoning_tokens: total("reasoning_tokens"),
      cache_read_tokens: total("cache_read_tokens"),
      cost_usd: Math.round(total("cost_usd") * 10000) / 10000,
    },
  };
}

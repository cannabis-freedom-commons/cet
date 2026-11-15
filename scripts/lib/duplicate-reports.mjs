// Advisory candidate generation. Scores are review priorities, never merge decisions.
const STOP = new Set(`a an and are as at by cannabis marijuana marihuana ganja hashish hash hemp drug drugs police of on in over for from to the with after during more than about nearly allegedly alleged seized seizes seize arrest arrests arrested held jailed jail sentenced sentence sentencing kg kilograms kilogram g grams gram tonne tonnes t lb pounds million worth plants plant destroys destroyed destroy found accused man men woman women raid raids raided smuggling smuggled smuggles trafficking trafficker traffickers possession prison years year months month officers case court operation caught following amid says say said`.split(' '));
export function sourceKey(value) {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    // These variants only nominate a pair. A reader must still confirm the same article/event.
    return decodeURI(url.host + url.pathname.replace(/\/amp\/?$/, '').replace(/\/$/, '') + url.search);
  } catch { return value; }
}
const tokens = value => new Set((String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(w => w.length > 1 && !STOP.has(w)));
const compatibleCountry = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
const equalFigures = (a, b) => Object.entries(a.figures ?? {}).filter(([k, v]) => typeof v === 'number' && v > 0 && v === b.figures?.[k] && !['arrested', 'charged', 'deaths'].includes(k)).map(([k]) => k);
function shingles(report) {
  const words = `${report.summary ?? ''} ${report.body ?? ''}`.toLowerCase().replace(/\[@[^\]]*\]/g, '').match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(words.slice(3).map((_, i) => words.slice(i, i + 4).join(' ')));
}

export function findDuplicateReportCandidates(reports) {
  const titleTokens = reports.map(r => tokens(r.title));
  const frequencies = new Map();
  for (const set of titleTokens) for (const token of set) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  const weight = token => Math.log(2 + reports.length / (frequencies.get(token) ?? 1));
  const similarity = (a, b) => {
    const shared = [...a].filter(w => b.has(w));
    const sum = set => [...set].reduce((n, w) => n + weight(w), 0);
    return { shared, score: shared.reduce((n, w) => n + weight(w), 0) / Math.max(sum(a), sum(b), 1) };
  };
  const sources = reports.map(r => new Set((r.sources ?? []).filter(s => s.url).map(s => sourceKey(s.url))));
  const places = reports.map(r => tokens(r.place));
  const bodyShingles = reports.map(shingles);
  const names = reports.map(r => new Set([...`${r.title} ${r.summary ?? ''} ${r.body ?? ''}`.matchAll(/\b([A-Z][\p{L}’'-]{2,})\s+([A-Z][\p{L}’'-]{2,})\b/gu)].map(m => m[0])));
  const nameFrequency = new Map();
  for (const set of names) for (const name of set) nameFrequency.set(name, (nameFrequency.get(name) ?? 0) + 1);
  const candidates = [];
  for (let i = 0; i < reports.length; i++) for (let j = i + 1; j < reports.length; j++) {
    const a = reports[i], b = reports[j];
    const sharedSources = [...sources[i]].filter(url => sources[j].has(url));
    if (!compatibleCountry(a.country, b.country) && !sharedSources.length) continue;
    const days = Math.abs(Date.parse(a.date) - Date.parse(b.date)) / 86400000;
    const title = similarity(titleTokens[i], titleTokens[j]);
    const figures = equalFigures(a, b);
    const place = similarity(places[i], places[j]);
    const rareNames = [...names[i]].filter(n => names[j].has(n) && nameFrequency.get(n) <= 6);
    let overlap = 0;
    if (rareNames.length) overlap = [...bodyShingles[i]].filter(s => bodyShingles[j].has(s)).length / Math.max(1, Math.min(bodyShingles[i].size, bodyShingles[j].size));
    const nameInTitles = rareNames.some(n => a.title.includes(n) && b.title.includes(n));
    const sameSentence = a.figures?.prison && a.figures.prison === b.figures?.prison;
    const titleMatch = title.score >= 0.48 && title.shared.length >= 2;
    const nearbyMatch = days <= 8 && title.score >= 0.28 && (figures.length || place.score >= 0.65);
    const caseMatch = rareNames.length && (figures.length || nameInTitles || overlap >= 0.15 || (sameSentence && days <= 60));
    if (!sharedSources.length && !titleMatch && !nearbyMatch && !caseMatch) continue;
    let score = title.score * 50 + Math.min(sharedSources.length, 3) * 12 + (days <= 7 ? 6 : days <= 60 ? 2 : 0) + figures.length * 7;
    if (sharedSources.length && title.score < 0.2) score -= 25;
    if (caseMatch) score += Math.min(overlap * 30, 10);
    candidates.push({ a: a.file, b: b.file, titles: [a.title, b.title], countries: [a.country, b.country], dates: [a.date, b.date], days, score: +score.toFixed(1), titleSimilarity: +title.score.toFixed(2), sharedTitleTokens: title.shared, sharedSources, equalFigures: figures, ...(caseMatch ? { sharedNames: rareNames, bodyOverlap: +overlap.toFixed(2) } : {}) });
  }
  return candidates.sort((a, b) => b.score - a.score || a.a.localeCompare(b.a) || a.b.localeCompare(b.b));
}

// A candidate pair strict enough to stop a new report until it is checked: the same country, at
// most three days apart, no conflicting quantity (both give kilograms, plants, hectares or a value
// and they differ by more than a fifth: two seizures), and a nearly identical title, a shared
// source with the same figure or a similar title, the same large quantity (50 kg, 1,000 plants;
// accounts round, so within 2%), two equal figures, or shared rare names with an equal figure
// (two names: any equal figure).
// Only meaningful figures count (1 kg, 100 plants, five people): 10 g, one vehicle or one convict
// recur across unrelated cases (review of November 2026). Returns the reason, or "".
const LARGE = { kg_seized: 50, kg_destroyed: 50, plants_destroyed: 1000, plants_seized: 1000, hectares: 5 };
const MEANINGFUL = { kg_seized: 1, kg_destroyed: 1, plants_destroyed: 100, plants_seized: 100, hectares: 1, arrested: 5, convicted: 5, sentenced: 5, deaths: 1 };
const QUANTITIES = ['kg_seized', 'kg_destroyed', 'plants_destroyed', 'plants_seized', 'hectares'];
const near = (x, y) => x === y || (Math.max(x, y) >= 50 && Math.abs(x - y) / Math.max(x, y) <= 0.02);
const amount = (f, k) => (k === 'value' ? f.value?.amount : f[k]);
export function likelyDuplicate(pair, a, b) {
  if (!compatibleCountry(a.country ?? '', b.country ?? '') || pair.days > 3) return '';
  const fa = a.figures ?? {}, fb = b.figures ?? {};
  for (const k of [...QUANTITIES, 'value']) {
    const x = amount(fa, k), y = amount(fb, k);
    if (typeof x === 'number' && typeof y === 'number' && x > 0 && y > 0 && Math.abs(x - y) / Math.max(x, y) > 0.2) return '';
  }
  const same = Object.keys(MEANINGFUL).filter(k => typeof fa[k] === 'number' && typeof fb[k] === 'number' && fa[k] >= MEANINGFUL[k] && near(fa[k], fb[k]));
  const large = same.filter(k => fa[k] >= (LARGE[k] ?? Infinity));
  if (pair.titleSimilarity >= 0.75) return 'nearly the same title';
  if (pair.sharedSources?.length && (same.length || pair.titleSimilarity >= 0.6)) return 'a shared source and the same figures or title';
  if (large.length) return `the same ${large.join(', ')}`;
  if (same.length >= 2) return `the same ${same.join(', ')}`;
  if (pair.sharedNames?.length && same.length) return `the same names (${pair.sharedNames.slice(0, 3).join(', ')}) and ${same.join(', ')}`;
  // two people or places named in both and any equal figure, however small: one court case
  const anyEqual = Object.keys(fa).filter(k => typeof fa[k] === 'number' && fa[k] > 0 && fa[k] === fb[k]);
  if ((pair.sharedNames?.length ?? 0) >= 2 && anyEqual.length) return `the same names (${pair.sharedNames.slice(0, 3).join(', ')}) and ${anyEqual.join(', ')}`;
  if (same.includes('arrested') && pair.titleSimilarity >= 0.4 && pair.days <= 1) return 'the same arrest count and a similar title';
  return '';
}

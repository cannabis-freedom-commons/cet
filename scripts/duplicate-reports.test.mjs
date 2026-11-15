import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceKey, findDuplicateReportCandidates, likelyDuplicate } from './lib/duplicate-reports.mjs';
const report = (file, values = {}) => ({ file, country: 'gb', date: '2026-11-01', title: 'Cannabis seizure', sources: [], ...values });
test('source variants nominate the same article without dropping meaningful query parameters', () => {
  assert.equal(sourceKey('http://www.example.org/news/case/amp/?utm_source=rss#top'), sourceKey('https://example.org/news/case/'));
  assert.notEqual(sourceKey('https://example.org/article?id=1'), sourceKey('https://example.org/article?id=2'));
});
test('a shared roundup remains a candidate with its evidence; candidates do not merge or mutate reports', () => {
  const input = [report('a', { title: 'Four held at a warehouse', sources: [{ url: 'https://news.example/roundup' }] }), report('b', { title: 'Garden uprooted at a different town', sources: [{ url: 'https://news.example/roundup' }] })];
  const before = structuredClone(input), pairs = findDuplicateReportCandidates(input);
  assert.deepEqual(input, before);
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0].sharedSources, ['news.example/roundup']);
});
test('case names connect differently worded court stages many years apart', () => {
  const pairs = findDuplicateReportCandidates([
    report('arrest', { date: '2001-01-01', title: 'Eleanor Sample arrested with cannabis', summary: 'Eleanor Sample was arrested at the border.' }),
    report('appeal', { date: '2026-01-01', title: 'Court frees Eleanor Sample on appeal', summary: 'Eleanor Sample won her appeal.' }),
  ]);
  assert.equal(pairs.length, 1);
  assert.ok(pairs[0].sharedNames.includes('Eleanor Sample'));
  assert.ok(pairs[0].days > 8000);
});
test('a national report can match its state report, while unrelated countries do not match by a number alone', () => {
  const a = report('national', { country: 'us', title: 'Somerset warehouse: 931 plants seized', figures: { plants_destroyed: 931 } });
  const b = report('state', { ...a, file: 'state', country: 'us/ca' });
  const c = report('other', { ...a, file: 'other', country: 'ca' });
  assert.deepEqual(findDuplicateReportCandidates([a, b, c]).map(p => [p.a, p.b]), [['national', 'state']]);
});
test('empty or generic titles and common small arrest counts are not sufficient evidence', () => {
  const a = report('a', { title: 'Cannabis seized', figures: { arrested: 1 } });
  const b = report('b', { title: 'Cannabis seized', figures: { arrested: 1 } });
  assert.deepEqual(findDuplicateReportCandidates([a, b]), []);
});

test('a strict duplicate stops a new report only on strong evidence', () => {
  const pair = (extra = {}) => ({ days: 0, titleSimilarity: 0.3, sharedSources: [], ...extra });
  const report = (country, figures) => ({ country, figures });
  // the same large seizure, rounded differently by two accounts
  assert.match(likelyDuplicate(pair(), report('fr', { kg_seized: 5790, arrested: 3 }), report('fr', { kg_seized: 5750, arrested: 3 })), /kg_seized/);
  // a shared roundup source but different quantities: two seizures
  assert.equal(likelyDuplicate(pair({ sharedSources: ['x'] }), report('kg', { kg_seized: 3400 }), report('kg', { kg_seized: 2500 })), '');
  // a nearly identical headline with another quantity is another arrest
  assert.equal(likelyDuplicate(pair({ titleSimilarity: 0.8 }), report('in', { kg_seized: 0.9 }), report('in', { kg_seized: 0.6 })), '');
  // small round figures recur across unrelated cases
  assert.equal(likelyDuplicate(pair({ sharedNames: ['Manikganj Sadar'] }), report('bd', { kg_seized: 0.01 }), report('bd', { kg_seized: 0.01 })), '');
  // two defendants named in both and the same quantity: one court case
  assert.match(likelyDuplicate(pair({ sharedNames: ['Afendi Adam', 'Ridwan Ibrahim'] }), report('my', { kg_seized: 0.971 }), report('my', { kg_seized: 0.971 })), /names/);
  // other countries or a week apart never match
  assert.equal(likelyDuplicate(pair({ days: 7, titleSimilarity: 1 }), report('it', {}), report('it', {})), '');
});

# Research benchmark

How well does a model do the tracker's research? Before a new model is trusted with real
submissions, run it here: it gets the same real pages as every other model, does the whole job the
way production does, and comes out with a score and a case-by-case account of what it got wrong.

Results are on the site at `/benchmark/`.

```bash
npm run benchmark -- opencode@swancloud/muse-spark-1.3-contributor#xhigh
```

```bash
npm run benchmark:scores
```

## What is tested

A subject is always **harness + provider + model (+ effort)**. The same model behind another
provider, or driven by another harness, is a different subject and gets its own row.

| Written as | Harness | Provider | Model |
| --- | --- | --- | --- |
| `opencode@swancloud/muse-spark-1.3-contributor#xhigh` | OpenCode | swancloud | muse-spark-1.3-contributor, effort xhigh |
| `opencode@openrouter/inclusionai/ling-3.2-flash:free` | OpenCode | openrouter | inclusionai/ling-3.2-flash:free |
| `muse@muse-spark-1.3#xhigh` | Muse | Muse itself | muse-spark-1.3, effort xhigh |

`opencode@` may be left out. The names are the ones `RESEARCH_AGENTS` takes; `opencode models` lists
what OpenCode can reach. The harness version is recorded with every run.

## How a run works

1. The tracker's own research service (`backend/`) is built from this checkout and started as a
   private copy: its own port and database, no news harvesting, no Nostr, no pushing.
2. It works against a copy of the repository in which each case's answer has been taken out. The
   instructions, skills and vocabularies are today's; the reports are those of one fixed commit
   (`reports_commit` in `protocol.json`), so every model sees the same coverage.
3. Each case's page is submitted like a link a reader sends. The service opens it, screens it, runs
   the model with the production tools (web search, page fetching, report lookup, result check),
   checks the quotations and builds the report.
4. What the service ends with is collected and scored against the case's answer.

The copy differs from production in one thing. The live tracker publishes the very reports the
cases hide, and web search finds them, so one paragraph is added to the agent's instructions in the
copy: the tracker's own site is never a source, and what the tracker has is only what its report
tools return (`OWN_SITE_NOTE` in `lib/snapshot.mjs`).

Only the **first research attempt** of a case counts. In production the service would try a failed
attempt again, up to eight times; here a model that returns no usable answer has failed that case.
A run that breaks for other reasons (the provider does not answer) is tried once more and otherwise
shown as "did not finish".

A full run is 41 research jobs: about an hour with a fast model at two at a time, and it uses the
provider's quota like 41 real submissions.

```bash
npm run benchmark -- muse@muse-spark-1.3#xhigh --repeat 3
```

```bash
npm run benchmark -- opencode@provider/model --cases out-of-scope,us-clifton-park-pounds
```

| Option | Meaning |
| --- | --- |
| `--repeat N` | Every case N times. Models vary from run to run; three repeats show by how much. |
| `--cases a,b` | Only these cases or kinds (`new-event`, `known-event`, `out-of-scope`). Such a run is kept apart from full runs. |
| `--concurrency N` | Cases researched at once (default 2). |
| `--label "text"` | A note shown with the run. |
| `--extend <run id>` | Run the cases a saved run lacks, with the same subject, and add them to it. For a run that was stopped, and after new cases were added. Unfinished and spoiled cases run again. |
| `--keep` | Keep the working files in `benchmark/.work/` (logs, database) for a closer look. |
| `--list` | List the cases. |

Every finished case is saved at once, so Ctrl-C, a crash or a power cut loses only the cases still
being researched; `--extend` picks the run up from there. A provider that stops answering ends
the run the same way: after three cases in a row on which the model never takes a step, the run
stops and names the `--extend` command to continue it. A model that does not answer the start
check ends the run at once, before any case.

```bash
npm run benchmark -- --extend 20261116-1145
```

## The cases

One YAML file per real page in `cases/`. Three kinds:

| Kind | Asked | Scored |
| --- | --- | --- |
| `new-event` | An event the tracker does not have (its report is hidden). Recognise it and write the report. Some have a **look-alike** left in the tracker: another event at the same place, on the same day or with the same weight, which this one must not be merged into. | No report, or merged into the look-alike: 0. Otherwise the report, part by part. |
| `known-event` | Another page on an event the tracker has: a reprint, a translation, a headline about the other drugs in the same raid, a later step in the case. Find the report and add to it. | 100 when attached to the right report or called its duplicate; 0 for a second report or the wrong one. |
| `out-of-scope` | Synthetic cannabinoids, a law change, statistics, cannabis only in passing. | 100 for the right decision, part credit for another rejection, 0 for a report. |

The parts of a report and their weights:

| Part | Weight | Checked |
| --- | --- | --- |
| Facts | 20 | Country, date of the event, kind of event, place on the map |
| Figures | 20 | Each figure the sources give; units converted; nothing recorded that was not stated |
| Classification | 10 | Product, case stage, setting, agencies, route |
| Corroboration | 15 | Independent outlets that report this event, among the sources kept |
| Photos | 10 | Photos of the event with an address that opens; no stand-in pictures |
| Text | 15 | The key points are said; what stays open is listed; the title fits |
| Grounding | 10 | The service's own quotation check: sentences confirmed, figures kept |

A part a case cannot test is left out for that case. A figure **trap** (pounds recorded as
kilograms, cocaine added to the cannabis weight) halves the figures score when walked into. The
overall score is the mean over all cases.

All scoring is fixed rules on recorded output (`lib/score.mjs`). No model judges another model, so
a run can be scored again at any time and two runs are always compared by the same rules.

### How the fuzzy parts are decided

- **Is a source about this event?** Yes when the page the service captured contains enough of the
  case's `markers` (a number, a place, a name), or when it is on a listed outlet. A page with none
  of the marks counts against the score. Cases about events that recur (`strict: true`) rely on
  the marks alone.
- **Is a photo a photo of the event?** The known ones are listed by a piece of their address. Any
  other picture that opens counts 0.6, because the scorer cannot look at it. When a run links a
  good photo the case does not know, look at it and add it to `expect.media.expect`.
- **The tracker's own site** holds the answers to the hidden cases. A run that opens it is flagged
  and gets no corroboration score for that case; one that only meets it in search results is
  flagged. An answer that names the hidden report itself ("duplicate of …") can only have come
  from the live site: that attempt is **spoiled** and left out of the score, like a skipped one.

## Reading a result

- Runs are compared only within one **set**: the same cases, run settings and scoring rules. The
  site shows the newest set as the table and keeps the rest under "Other runs".
- A few points between two rows mean little. With one run per case, a single slip moves the total
  by up to 2.4 points. Repeat before deciding.
- Most cases come from what `muse-spark-1.3-contributor` already handles in production, so it
  scores high. The benchmark shows clearly when a model is **worse** than that; it has less room
  to show that one is better. The look-alike and mixed-headline cases, taken from the duplicate
  reviews in `docs/`, are there to make room; more of that kind is the way to make more.
- Pages change and disappear. A case whose page no longer opens is shown as "skipped" and left out
  of the mean; replace it.

## After changing a case or a rule

```bash
npm run benchmark:scores -- --rescore
```

scores every saved run again from the service output kept in `results/raw/`. No model is called.
The set changes, so the re-scored runs stay comparable with each other.

## Adding a case

1. Pick a real page. For a new event, take a finished report with several sources and check its
   facts against the sources yourself: the answer must be right, not just what a model wrote.
   Good places to look for hard ones: pairs the duplicate reviews (`docs/DUPLICATE-REVIEW-*`) found
   to be different events, `node scripts/check-duplicate-reports.mjs --json`, and submissions that
   models in production got wrong.
2. Write `cases/<id>.yaml` (copy a similar one). `why` says what the case tests, in plain words; it
   is shown on the site. For a new event, `setup.hide` names the report (and any duplicate of it)
   to take out. For a later step in a known case, `setup.restore` puts the report back as it
   was at an earlier commit (`{path, commit}`), before that step was added.
3. Keep answers tolerant where honest sources differ (`also`, `any`, `tolerance_days`), and strict
   where a mistake is a mistake (`figures_forbidden`).
4. `npm test`, then run the case alone: `npm run benchmark -- <subject> --cases <id>`.
5. Add it to the saved runs you still want to compare: `npm run benchmark -- --extend <run id>`
   for each. Until then those runs are listed apart, as runs of only some cases.

To move the fixed coverage forward, set `reports_commit` in `protocol.json` to a newer commit of
`main` and check that every hidden report still exists. That starts a new set.

## Files

| Path | What |
| --- | --- |
| `run.mjs`, `score.mjs` | The two commands |
| `protocol.json` | Run settings: step limit, timeout, search, starting context, fixed reports commit |
| `cases/` | The cases and their answers |
| `lib/` | Snapshot, private service, collection, scoring |
| `results/` | One file per run (what the site shows) and `raw/` (the service's output, for re-scoring) |
| `site/` | The `/benchmark/` pages, added to the site by `site/integration.mjs` |
| `test/` | Tests of the cases and the scorer, part of `npm test` |
| `.work/` | Working files of runs; not committed |

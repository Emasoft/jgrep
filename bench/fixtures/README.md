# bench/fixtures — committed benchmark fixtures (WI-8)

These fixtures are **committed to the repository** so that every benchmark run is
reproducible: the same bytes are scored today, in CI, and in a year (issue #1, WI-8 —
"fixtures are committed so runs are reproducible"). They are the acceptance set for the
WI-8 accuracy harness (`bench/accuracy.ts`, `bench/code_selection.ts`) and for later
milestones (WI-2/3/5/9).

Fixtures are **read-only at run time**. Nothing under `bench/fixtures/` is ever written
by `src/` or by the bench scripts; results land in `bench/results/` only
(see implementation plan §1.7).

## Files

| File | Rows | Shape |
|---|---|---|
| `sms_spam.csv` | 200 (100 spam + 100 ham) | header `label,text` |
| `ag_news.csv` | 120 (30 per class, order: World, Sports, Business, Sci/Tech) | header `label,text` |
| `code_selection/cases.json` | 20 cases × 5 candidates | array of `{ id, description, expected, candidates, kind }` |

CSV fixtures load with the repo's own `parseCsv` (`src/rows.ts`): RFC-4180 quoting — a
field containing `"`, `,`, CR or LF is wrapped in double quotes and embedded `"` are
doubled; LF line endings; trailing newline. Both CSVs round-trip byte-exactly through
`parseCsv`.

## Provenance

### `sms_spam.csv` — UCI SMS Spam Collection

- Source: <https://archive.ics.uci.edu/dataset/228/sms+spam+collection>
  (zip: <https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip>),
  file `SMSSpamCollection` — 5,574 tab-separated records (`ham<TAB>text` / `spam<TAB>text`;
  4,827 ham, 747 spam).
- License: **free for research**, with citation. UCI Machine Learning Repository
  citation request:
  > Almeida, T.A., Gómez Hidalgo, J.M., Yamakami, A. "Contributions to the study of SMS
  > Spam Filtering: new collection and results". *DocEng'11* — ACM Symposium on Document
  > Engineering, 2011.
- Original labels (`ham`/`spam`) are preserved verbatim; text case and punctuation are
  untouched; texts are single-line (the source is one record per line).

### `ag_news.csv` — AG News (train split)

- Source: <https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/train.csv>
  — 120,000 headerless rows (`"class","title","description"`, class ∈ 1–4; 30,000 per class).
  AG News was introduced in:
  > Xiang Zhang, Junbo Zhao, Yann LeCun. "Character-level Convolutional Networks for Text
  > Classification". *NeurIPS 2015*.
- License: **academic use** (dataset assembled from AG's news corpus; use it for
  research/benchmarking, not for redistribution as a corpus).
- Class mapping: `1→World`, `2→Sports`, `3→Business`, `4→Sci/Tech`.
- Row text = `title + ". " + description` (single line; the source has one physical line
  per record). The source's literal `\` artifacts are kept as-is.

### `code_selection/cases.json` — hand-written cases

Written by hand for this repository (original code, no external copying), 20 cases ×
5 candidates each: 18 `typescript`, 2 `go`. In every case **exactly one** candidate
satisfies the `description` behaviorally (the `expected` one); the other 4 are near-miss
distractors of the same theme (e.g. fixed-delay retry vs exponential backoff,
`Promise.all` vs first-settled race, debounce vs throttle, FIFO vs LRU eviction,
write-to-target vs temp-then-rename). Descriptions are phrased as observable behavior so
answering them requires judging code semantics, not matching keywords. Themes covered
(2 cases each): async patterns, error handling, data transformation, security
(input validation/sanitization), resource cleanup, caching, parsing, rate limiting,
auth, file I/O. All candidate code is self-contained (no imports/package clauses) and
3–15 lines. The expected candidate sits at a different position per case (indices
2,2,0,0,3,2,0,1,0,2,0,3,0,2,0,1,0,2,0,1) to avoid position bias. Content is static —
nothing is generated at run time.

## Deterministic sampling rules

No randomness anywhere: sampling is "every k-th row within each class subsequence,
in stable source order" (a systematised stride sample that spreads across the whole
file). The source files are ordered inputs, so an identical script run anywhere
reproduces the committed bytes exactly (verified by the SHA256s below).

**`sms_spam.csv`** — 100 spam + 100 ham:

1. Read `SMSSpamCollection`, drop the trailing empty line; each physical line `i`
   (1-based) is one record `{ lineNo: i, label, text }` (split on the **first** TAB).
2. Per class, keep the subsequence in original file order.
   - spam: 747 records → `k_spam = floor(747 / 100) = 7`; take positions `0, 7, 14, …, 693`
     (i.e. `i * k` for `i = 0..99`).
   - ham: 4,827 records → `k_ham = floor(4827 / 100) = 48`; take positions `0, 48, …, 4752`.
3. Merge the two samples and emit rows **sorted by original line number** (spam and ham
   interleaved as they appear in the source file).

**`ag_news.csv`** — 30 per class, output grouped in the fixed order World, Sports,
Business, Sci/Tech:

1. Parse the train CSV (headerless, RFC-4180 quoted fields); each physical row `i`
   (1-based) keeps its position within its class subsequence.
2. Each class has 30,000 records → `k = floor(30000 / 30) = 1000`; take positions
   `0, 1000, 2000, …, 29000` (`i * k` for `i = 0..29`) within each class, in file order.
3. Emit all World rows first, then Sports, Business, Sci/Tech; text is
   `title + ". " + description`.

**Escaping (both CSVs):** same rule as the repo's `toCsv` — quote a field iff it
contains `"`, `,`, CR or LF; double the embedded quotes; LF terminators; trailing
newline. Labels never need quoting.

## Regenerating

```sh
# 1) fetch the sources
curl -L -o /tmp/smsspamcollection.zip https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip
unzip -o /tmp/smsspamcollection.zip -d /tmp/sms_raw          # -> /tmp/sms_raw/SMSSpamCollection
curl -L -o /tmp/ag_news_train.csv https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/train.csv

# 2) apply the sampling rules above (a ~60-line throwaway Bun/TS script; see
#    "Deterministic sampling rules" for the exact algorithm), then escape with the
#    repo's toCsv and write bench/fixtures/sms_spam.csv + bench/fixtures/ag_news.csv
```

The sampler is intentionally not committed (no new runtime files); the algorithm above
is its complete specification. If a download fails, regeneration aborts — partial or
empty fixtures must never be committed (plan Step 10).

`code_selection/cases.json` has no external source; it is maintained by hand.

## Integrity (SHA256)

```
418bbc30b86639e241b1d95c0db40de54f69b01f5561817e7e804f1d20439f60  sms_spam.csv
7365642741ff2a32f97a480e514b855eba745e282343ad385f2c2ea46970645d  ag_news.csv
7e3117cd90194614ff8241ac8fdb1724bf1512518e685e868489cebbcd4f35c4  code_selection/cases.json
```

Verify with `shasum -a 256 bench/fixtures/*.csv bench/fixtures/code_selection/cases.json`
(this README intentionally excludes its own hash). If a fixture's hash changes, the
sampling or the source changed — update this table and re-run the bench baseline.

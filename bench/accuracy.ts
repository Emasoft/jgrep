// bench/accuracy.ts — WI-8 accuracy harness: SMS spam-vs-ham + AG News 4-way
// precision/recall, ported from the sibling tool's accuracy.py idea on top of the
// existing rows machinery (scoreRows) and the WI-1 provider layer
// (resolveProvider/resolveApiKey). Zero new deps, Bun-only: `bun bench/accuracy.ts`.
//
// Hermetic behavior: with no key anywhere, resolveApiKey throws the standard
// missing-key enumeration error (exit 2) — no fake fallback provider. `--limit N`
// caps the rows per class so a smoke run costs pennies. Answers go into a
// THROWAWAY cache object that is never persisted: repeated runs always measure
// true accuracy, and nothing is ever written outside --out (default bench/results —
// never src/). The ground-truth `label` column never enters the request state.
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import path from "node:path";
import { readRows, scoreRows, type Answer, type Questions, type Row, type RowError } from "../src/rows";
import { resolveApiKey, resolvePricePerMtok, resolveProvider, type Backend, type Fetch } from "../src/providers";
import { JevProviderError } from "../src/errors";

// Ambient so the file typechecks without node types (same pattern as cli.ts);
// keep all process usage to this shape.
declare const process: {
  argv: string[];
  cwd(): string;
  env: Record<string, string | undefined>;
  exit(code: number): never;
  exitCode: number;
  stdout: { isTTY?: boolean; write(s: string): void };
  stderr: { isTTY?: boolean; write(s: string): void };
};

const VERSION = "0.4.0"; // mirrors src/cli.ts

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

// Script-relative paths: fixtures are read from ./fixtures next to this script and
// results default to ./results next to it, so the harness works from any cwd.
const HERE: string = (import.meta as { dir?: string }).dir ?? process.cwd();
export const FIXTURES_DIR = path.join(HERE, "fixtures");
const DEFAULT_OUT = path.join(HERE, "results");

const USAGE = `jgrep bench/accuracy.ts v${VERSION} — SMS + AG News precision/recall harness (WI-8)

usage: bun bench/accuracy.ts [options]

  --fixture <name>  sms | agnews | all (default all)
  --api <name>      provider: typesafe | openrouter | gateway
                    precedence: --api > $JEV_API > first key found (typesafe first)
  --model <id>      model id override (default: the provider's default)
  --limit <n>       first n rows per class — smoke mode, costs pennies (0 = all)
  --out <dir>       results directory (default bench/results, next to this script)
  --rate <req/s>    global request pacing (token bucket); 0 = unlimited
  --retries <n>     failed attempts tolerated per request-pack (default 4)
  --timeout <s>     per-pack deadline, retries included (default 15)
  --fail-fast       abort on the first fatal error instead of isolating it
  -h, --help        print this help

One noul question (SMS) or one choice question (AG News) is asked of every fixture
row through scoreRows(); answers are never cached (throwaway cache object), so
repeated runs measure true accuracy. Errored rows are excluded from the metric
denominators and reported with a kind breakdown. Results land in
<out>/<provider>-<fixture>-<UTC timestamp>.json.

exit status: 0 clean, 2 on error or when any row errored.

examples:
  bun bench/accuracy.ts --fixture sms --limit 2          # smoke: 4 rows, < $0.01
  bun bench/accuracy.ts --fixture all --rate 5
  OPENROUTER_API_KEY=sk-or-... bun bench/accuracy.ts --api openrouter`;

export interface BenchArgs {
  fixture: string; api: string; model: string; limit: number; out: string;
  rate: number; retries: number; timeout: number; failFast: boolean;
}

/** Same flag-parsing style as src/cli.ts: numerics validated here, the fixture enum
 *  too (a bench-local closed set — no typed provider error to defer to main). */
export function parse(argv: string[]): BenchArgs {
  const o: BenchArgs = { fixture: "all", api: "", model: "", limit: 0, out: "", rate: 0, retries: 4, timeout: 15, failFast: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--fixture") o.fixture = argv[++i] ?? "";
    else if (a === "--api") o.api = argv[++i] ?? "";
    else if (a === "--model") o.model = argv[++i] ?? "";
    else if (a === "--limit") o.limit = Number(argv[++i]);
    else if (a === "--out") o.out = argv[++i] ?? "";
    else if (a === "--rate") o.rate = Number(argv[++i]);
    else if (a === "--retries") o.retries = Number(argv[++i]);
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--fail-fast") o.failFast = true;
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown option ${a} (try --help)`);
    else rest.push(a);
  }
  if (![o.limit, o.rate, o.retries, o.timeout].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("numeric option expected");
  if (o.fixture !== "all" && o.fixture !== "sms" && o.fixture !== "agnews")
    throw new Error(`unknown fixture "${o.fixture}" (valid: sms, agnews, all — try --help)`);
  if (rest.length) throw new Error(`unexpected argument "${rest[0]}" (try --help)`);
  return o;
}

// ---- metrics (pure, exported for bench/accuracy.test.ts) -----------------------

export interface ClassMetrics { precision: number; recall: number; f1: number; support: number }
export interface Metrics {
  labels: string[];
  perClass: Record<string, ClassMetrics>;
  accuracy: number;
  macroF1: number;
  /** [actual][predicted] counts, same order as labels. */
  confusion: number[][];
  /** rows in the denominators (errored / unanswerable rows excluded). */
  scored: number;
}

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** Confusion matrix M[actual][predicted]; throws on unknown labels or length mismatch. */
export function confusionMatrix(pred: string[], truth: string[], labels: string[]): number[][] {
  if (pred.length !== truth.length)
    throw new Error(`confusionMatrix: pred (${pred.length}) and truth (${truth.length}) must have the same length`);
  const idx = new Map(labels.map((l, i) => [l, i]));
  const m = labels.map(() => labels.map(() => 0));
  for (let i = 0; i < truth.length; i++) {
    const t = idx.get(truth[i]);
    const p = idx.get(pred[i]);
    if (t === undefined || p === undefined)
      throw new Error(`confusionMatrix: unknown label "${t === undefined ? truth[i] : pred[i]}" (expected one of: ${labels.join(", ")})`);
    m[t][p]++;
  }
  return m;
}

/** Per-class precision/recall/F1 + accuracy + macro-F1 from a confusion matrix.
 *  Zero denominators degrade to 0 (never NaN). macro-F1 averages the UNROUNDED
 *  class F1s; stored values are rounded to 4 decimals for stable artifacts. */
export function precisionRecallF1(matrix: number[][], labels: string[]): Metrics {
  const perClass: Record<string, ClassMetrics> = {};
  let f1Sum = 0, correct = 0, total = 0;
  for (let i = 0; i < labels.length; i++) {
    const tp = matrix[i][i];
    const support = matrix[i].reduce((a, b) => a + b, 0);        // actual class i (row)
    const predictedAs = matrix.reduce((a, row) => a + row[i], 0); // predicted class i (column)
    const precision = predictedAs ? tp / predictedAs : 0;
    const recall = support ? tp / support : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[labels[i]] = { precision: r4(precision), recall: r4(recall), f1: r4(f1), support };
    f1Sum += f1; correct += tp; total += support;
  }
  return {
    labels: [...labels], perClass,
    accuracy: r4(total ? correct / total : 0),
    macroF1: r4(labels.length ? f1Sum / labels.length : 0),
    confusion: matrix.map((row) => [...row]),
    scored: total,
  };
}

/** SMS verdict from a RAW noul answer: p >= 0.5 is spam; no usable p -> null.
 *  Raw answers, not flatten(): flatten rounds to 2 decimals, which could flip
 *  exactly this 0.5 boundary. */
export function smsVerdict(a: Answer | undefined): boolean | null {
  const p = a?.type === "noul" ? a.noul : undefined;
  return typeof p === "number" && Number.isFinite(p) ? p >= 0.5 : null;
}

/** AG News prediction from a RAW choice answer: argmax over the per-criteria
 *  probabilities (first label wins ties); falls back to the provider's own
 *  `choice` when probabilities are absent; "" when nothing is usable. Raw
 *  answers, not flatten(): its 2-decimal rounding can manufacture argmax ties. */
export function argmaxChoice(a: Answer | undefined, criteria: string[]): string {
  if (!a || a.type !== "choice") return "";
  let best = "", bestP = -Infinity, any = false;
  for (const crit of criteria) {
    const p = a.probabilities?.[crit];
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    any = true;
    if (p > bestP) { bestP = p; best = crit; }
  }
  if (any) return best;
  return typeof a.choice === "string" && criteria.includes(a.choice) ? a.choice : "";
}

/** `2 timeout, 1 rate_limited` — count desc, then kind asc (same order as cli.ts). */
export function errorBreakdown(errors: { kind: string }[]): string {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([kind, n]) => `${n} ${kind}`).join(", ");
}

/** UTC YYYYMMDDTHHMMSSZ for result filenames. */
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// ---- fixtures ------------------------------------------------------------------
// buildRowsRequest() prefixes every question with `Look only at the row with id
// "rN".` itself and injects `id: "rN"` into the state rows, so the specs below
// carry only the bare question text; the bench passes `{ text }` rows and the
// state ends up { id, text }-shaped — the label column never reaches the model.

const AG_LABELS = ["World", "Sports", "Business", "Sci/Tech"];

// OpenRouter alpha surface (verified 2026-09): choice criteria must be a record keyed by label, not an array (HTTP 400 "expected record, received array"). Keys stay the exact labels so argmaxChoice/confusion metrics are unaffected.
const AG_CRITERIA: Record<string, string> = {
  World: "world news",
  Sports: "sports",
  Business: "business",
  "Sci/Tech": "science and tech",
};

export interface FixtureSpec {
  key: "sms" | "agnews";
  file: string;       // under bench/fixtures/
  title: string;      // report heading
  labels: string[];   // class labels, matrix order
  questions: Questions;
  /** predicted label, or "" when the answer is unusable (row excluded from metrics) */
  predict: (a: Record<string, Answer> | undefined) => string;
}

export const FIXTURES: Record<"sms" | "agnews", FixtureSpec> = {
  sms: {
    key: "sms",
    file: "sms_spam.csv",
    title: "SMS spam vs ham",
    labels: ["spam", "ham"],
    questions: { spam: { type: "noul", instructions: "Is this text message spam (unwanted advertising or fraud)? Answer yes for spam, no for legitimate ham." } },
    predict: (a) => { const v = smsVerdict(a?.spam); return v == null ? "" : v ? "spam" : "ham"; },
  },
  agnews: {
    key: "agnews",
    file: "ag_news.csv",
    title: "AG News (4-way)",
    labels: AG_LABELS,
    questions: { category: { type: "choice", instructions: "Which category does this news headline belong to?", criteria: AG_CRITERIA } },
    predict: (a) => argmaxChoice(a?.category, AG_LABELS),
  },
};

/** First `limit` rows per class (0 = all), in fixture order. */
export function sliceByClass(rows: Row[], labels: string[], limit: number): { row: Row; label: string }[] {
  const taken = new Map<string, number>();
  const out: { row: Row; label: string }[] = [];
  for (const row of rows) {
    if (!labels.includes(row.label)) throw new Error(`fixture row with unknown label "${row.label}" (expected one of: ${labels.join(", ")})`);
    const n = taken.get(row.label) ?? 0;
    if (limit > 0 && n >= limit) continue;
    taken.set(row.label, n + 1);
    out.push({ row, label: row.label });
  }
  return out;
}

// ---- harness -------------------------------------------------------------------

export interface BenchOptions {
  backend: Backend;
  apiKey: string;        // explicit — main resolves it via resolveApiKey; tests pass a dummy
  model: string;
  limit?: number;        // first N rows per class (0/undefined = all)
  batch?: number;        // default 16
  concurrency?: number;  // default 4
  ratePerSec?: number;
  maxRetries?: number;
  timeoutSec?: number;
  failFast?: boolean;
  pricePerMtok?: number; // default resolvePricePerMtok()
  fetchImpl?: Fetch;     // DI seam (repo fake-fetch pattern; never set by main)
  onProgress?: (done: number, total: number) => void;
}

/** The bench-results JSON artifact (bench/results/<provider>-<fixture>-<ts>.json). */
export interface FixtureResult {
  fixture: string; provider: string; model: string; n: number; metrics: Metrics;
  tokens: number; requests: number; cached: number; cost: number;
  durationSec: number; startedAt: string;
}

/** Score one fixture: slice per class, ask every row, compute the metrics. Errored
 *  and unanswerable rows are excluded from the denominators and returned alongside.
 *  The scoreRows cache is a throwaway object — bench answers are NEVER persisted. */
export async function scoreFixture(spec: FixtureSpec, rows: Row[], o: BenchOptions): Promise<{ result: FixtureResult; errors: RowError[] }> {
  const selected = sliceByClass(rows, spec.labels, o.limit ?? 0);
  if (!selected.length) throw new Error(`fixture "${spec.key}" produced no rows`);
  const benchRows: Row[] = selected.map((s) => ({ text: s.row.text })); // label stays out of the state
  const truth = selected.map((s) => s.label);
  const startedAt = new Date();
  const t0 = Date.now();
  const r = await scoreRows(benchRows, spec.questions, {
    backend: o.backend, apiKey: o.apiKey, model: o.model,
    batch: o.batch ?? 16, concurrency: o.concurrency ?? 4,
    cache: {}, // throwaway — never persisted, repeated runs measure true accuracy
    ratePerSec: o.ratePerSec, maxRetries: o.maxRetries, timeoutSec: o.timeoutSec, failFast: o.failFast,
    fetchImpl: o.fetchImpl, onProgress: o.onProgress,
  });
  const durationSec = (Date.now() - t0) / 1000;
  const pred = r.answers.map((a) => spec.predict(a));
  const scoredPred: string[] = [], scoredTruth: string[] = [];
  for (let i = 0; i < pred.length; i++) {
    if (!pred[i]) continue; // errored or no usable answer: excluded from every denominator
    scoredPred.push(pred[i]);
    scoredTruth.push(truth[i]);
  }
  const metrics = precisionRecallF1(confusionMatrix(scoredPred, scoredTruth, spec.labels), spec.labels);
  const cost = r.cost ?? (r.tokens * (o.pricePerMtok ?? resolvePricePerMtok())) / 1e6;
  return {
    result: {
      fixture: spec.key, provider: o.backend.name, model: o.model, n: selected.length, metrics,
      tokens: r.tokens, requests: r.requests, cached: r.cached, cost, durationSec,
      startedAt: startedAt.toISOString(),
    },
    errors: r.errors,
  };
}

// ---- output --------------------------------------------------------------------

function printReport(spec: FixtureSpec, r: FixtureResult, errors: RowError[]): void {
  console.log(`## ${spec.title} — ${r.provider} · ${r.model}`);
  console.log("");
  console.log("| class | precision | recall | f1 | support |");
  console.log("|---|---:|---:|---:|---:|");
  for (const label of r.metrics.labels) {
    const m = r.metrics.perClass[label];
    console.log(`| ${label} | ${m.precision.toFixed(2)} | ${m.recall.toFixed(2)} | ${m.f1.toFixed(2)} | ${m.support} |`);
  }
  console.log("");
  console.log(`accuracy ${r.metrics.accuracy.toFixed(2)} · macro-F1 ${r.metrics.macroF1.toFixed(2)}`);
  const summary = `${r.provider} ${r.model} · n ${r.n} (${r.metrics.scored} scored, ${r.cached} cached) · ${r.requests} requests · ${r.tokens} tokens · $${r.cost.toFixed(4)} · ${r.durationSec.toFixed(1)}s`;
  console.error(c("90", summary));
  if (errors.length) {
    console.error(c("31", `${errors.length} of ${r.n} rows errored (${errorBreakdown(errors)}) — excluded from the metrics`));
    for (const e of errors.slice(0, 5)) console.error(c("31", `  ${e.kind}: row ${e.row} ${e.message.slice(0, 120)}`));
    if (errors.length > 5) console.error(c("31", `  … and ${errors.length - 5} more`));
  }
  const silent = r.n - r.metrics.scored - errors.length;
  if (silent > 0) console.error(c("33", `${silent} more rows returned no usable answer — also excluded from the metrics`));
}

export function writeResult(outDir: string, base: string, r: FixtureResult): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${base}-${utcStamp(new Date())}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
  return file;
}

// ---- entrypoint ----------------------------------------------------------------

async function main() {
  const o = parse(process.argv.slice(2));
  // Provider resolution before anything else (§1.4 precedence): unknown --api, a
  // gateway without JEV_GATEWAY_URL, or a missing key throws the typed
  // JevProviderError straight to the catch (exit 2, hint under the message).
  const backend = resolveProvider(o.api || undefined);
  const apiKey = resolveApiKey(backend);
  const model = o.model || backend.model;
  const pricePerMtok = resolvePricePerMtok();
  const specs = o.fixture === "all" ? [FIXTURES.sms, FIXTURES.agnews] : [FIXTURES[o.fixture as "sms" | "agnews"]];
  const outDir = o.out || DEFAULT_OUT;
  let totalErrors = 0;
  for (const spec of specs) {
    const { rows } = readRows(path.join(FIXTURES_DIR, spec.file));
    const t0 = Date.now();
    const { result, errors } = await scoreFixture(spec, rows, {
      backend, apiKey, model, limit: o.limit, ratePerSec: o.rate || undefined,
      maxRetries: o.retries, timeoutSec: o.timeout, failFast: o.failFast, pricePerMtok,
      onProgress: (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); },
    });
    if (process.stderr.isTTY) process.stderr.write(`\r\x1b[K`); // clear the progress line
    printReport(spec, result, errors);
    const file = writeResult(outDir, `${backend.name}-${spec.key}`, result);
    console.error(c("90", `wrote ${file} in ${((Date.now() - t0) / 1000).toFixed(1)}s`));
    totalErrors += errors.length;
  }
  // Bench semantics mirror the CLI: a partial failure must be visible, not silent.
  if (totalErrors > 0) process.exitCode = 2;
}

if (!process.env.JGREP_NO_MAIN) main().catch((e: unknown) => {
  if (e instanceof JevProviderError) {
    console.error(c("31", `${e.kind}: ${e.message}`));
    if (e.hint) console.error(c("90", `  ${e.hint}`));
  } else {
    console.error(c("31", e instanceof Error ? e.message : String(e)));
  }
  process.exit(2);
});

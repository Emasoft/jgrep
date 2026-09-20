// bench/code_selection.ts — WI-8 top-1 code-selection accuracy: for each committed
// case (a behavior description + 5 near-miss candidate snippets) ONE request asks a
// single constant noul question of all candidate rows ("Does this code implement:
// <description>?"), and the highest-probability candidate is the prediction. Port of
// the sibling tool's code_selection.py idea, on top of the same rows machinery
// (scoreRows) and provider layer as bench/accuracy.ts (Step 11 — its conventions are
// copied verbatim: flag parsing, provider resolution, error rendering, results
// artifact, ambient shims). Zero new deps, Bun-only: `bun bench/code_selection.ts`.
//
// Hermetic behavior: with no key anywhere, resolveApiKey throws the standard
// missing-key enumeration error (exit 2) — no fake fallback provider. `--limit N`
// runs only the first N cases so a smoke run costs pennies (2 cases = 2 requests,
// well under $0.01). Answers go into a THROWAWAY cache object that is never
// persisted: repeated runs always measure true accuracy, and nothing is ever written
// outside --out (default bench/results — never src/). The state rows are
// { id, name, code } only — nothing marks which candidate is the expected one.
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import path from "node:path";
import { scoreRows, type Answer, type Questions, type Row } from "../src/rows";
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

/** Minimal Bun.file surface (no bun-types in this zero-dep repo); only .json() is used. */
declare const Bun: { file(path: string): { json(): Promise<unknown> } };

const VERSION = "0.4.0"; // mirrors src/cli.ts

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

// Script-relative paths: the fixture is read from ./fixtures next to this script and
// results default to ./results next to it, so the harness works from any cwd.
const HERE: string = (import.meta as { dir?: string }).dir ?? process.cwd();
export const CASES_FILE = path.join(HERE, "fixtures", "code_selection", "cases.json");
const DEFAULT_OUT = path.join(HERE, "results");

const USAGE = `jgrep bench/code_selection.ts v${VERSION} — top-1 code-selection accuracy (WI-8)

usage: bun bench/code_selection.ts [options]

  --limit <n>       first n cases — smoke mode, costs pennies (0 = all 20)
  --cases <n>       alias for --limit
  --api <name>      provider: typesafe | openrouter | gateway
                    precedence: --api > $JEV_API > first key found (typesafe first)
  --model <id>      model id override (default: the provider's default)
  --out <dir>       results directory (default bench/results, next to this script)
  --rate <req/s>    request pacing (token bucket); cases run sequentially, one
                    request each, so this rarely binds; 0 = unlimited
  --retries <n>     failed attempts tolerated per request-pack (default 4)
  --timeout <s>     per-pack deadline, retries included (default 15)
  --fail-fast       abort on the first fatal error instead of isolating it
  -h, --help        print this help

Each case asks one constant noul question of all 5 candidate rows ("Does this code
implement: <description>?"); the candidate with the highest answer probability wins
(argmax), and top-1 accuracy = correct / scored. Errored cases are excluded from the
denominator and reported with a kind breakdown. Answers are never cached (throwaway
cache object), so repeated runs measure true accuracy. Results land in
<out>/<provider>-code_selection-<UTC timestamp>.json.

exit status: 0 clean, 2 on error or when any case errored.

examples:
  bun bench/code_selection.ts --limit 2              # smoke: 2 cases, < $0.01
  bun bench/code_selection.ts --rate 5
  OPENROUTER_API_KEY=sk-or-... bun bench/code_selection.ts --api openrouter`;

export interface BenchArgs {
  limit: number; api: string; model: string; out: string;
  rate: number; retries: number; timeout: number; failFast: boolean;
}

/** Same flag-parsing style as src/cli.ts and bench/accuracy.ts: numerics validated
 *  here; --limit is the accuracy.ts name and --cases is the code_selection alias
 *  (last occurrence wins). */
export function parse(argv: string[]): BenchArgs {
  const o: BenchArgs = { limit: 0, api: "", model: "", out: "", rate: 0, retries: 4, timeout: 15, failFast: false };
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--limit" || a === "--cases") o.limit = Number(argv[++i]);
    else if (a === "--api") o.api = argv[++i] ?? "";
    else if (a === "--model") o.model = argv[++i] ?? "";
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
  if (rest.length) throw new Error(`unexpected argument "${rest[0]}" (try --help)`);
  return o;
}

// ---- small helpers (verbatim copies from bench/accuracy.ts) ---------------------
// Copied, not imported: accuracy.ts auto-runs its main() at module load unless
// JGREP_NO_MAIN is already set, and ESM import hoisting cannot set it first from a
// static import — importing it here would launch the accuracy bench by accident.

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

const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** First 60 chars of a description for the report table (markdown pipes escaped). */
function trunc60(s: string): string {
  const t = s.length <= 60 ? s : `${s.slice(0, 59)}…`;
  return t.replace(/\|/g, "\\|");
}

// ---- cases ----------------------------------------------------------------------

export interface CaseCandidate { name: string; code: string }

/** One code-selection case: which of the candidate snippets implements the described behavior. */
export interface CaseInput { id: string; description: string; expected: string; candidates: CaseCandidate[] }

/** A candidate needs a string name and a string code (runtime check: the JSON is untyped). */
const isCandidate = (x: unknown): x is CaseCandidate =>
  !!x && typeof (x as CaseCandidate).name === "string" && typeof (x as CaseCandidate).code === "string";

/** Shape-validate the raw cases.json: an array of well-formed, unambiguous cases.
 *  `expected` must name one of the candidates — otherwise the case could never be
 *  scored correct, which is a fixture bug worth failing on. */
export function validateCases(raw: unknown): CaseInput[] {
  if (!Array.isArray(raw)) throw new Error("code_selection fixture: expected an array of cases");
  return raw.map((entry, i) => {
    const k = entry as Partial<CaseInput> | null;
    if (!k || typeof k.id !== "string" || typeof k.description !== "string" || typeof k.expected !== "string"
      || !Array.isArray(k.candidates) || !k.candidates.every(isCandidate))
      throw new Error(`code_selection case[${i}] needs { id, description, expected, candidates: [{ name, code }] }`);
    if (!k.candidates.length) throw new Error(`code_selection case "${k.id}" has no candidates`);
    const names = new Set<string>();
    for (const x of k.candidates) {
      if (names.has(x.name)) throw new Error(`code_selection case "${k.id}": duplicate candidate name "${x.name}"`);
      names.add(x.name);
    }
    if (!names.has(k.expected)) throw new Error(`code_selection case "${k.id}": expected "${k.expected}" is not one of the candidate names`);
    return { id: k.id, description: k.description, expected: k.expected, candidates: k.candidates.map((x) => ({ name: x.name, code: x.code })) };
  });
}

/** The committed 20-case fixture, read via Bun.file (absolute script-relative path). */
export async function loadCases(file: string): Promise<CaseInput[]> {
  return validateCases(await Bun.file(file).json());
}

/** The ONE question asked of every candidate row of a case. It is identical for all
 *  rows of the case, so the per-row answer probabilities p(name) are comparable and
 *  argmax picks the best-matching candidate. The description is embedded per case —
 *  that makes each case's question distinct (unavoidable; the cache is throwaway). */
export function matchQuestions(description: string): Questions {
  return {
    match: {
      type: "noul",
      instructions: `Does this code implement: ${description}? Answer yes only if the code fully implements the described behavior.`,
    },
  };
}

export interface Verdict { predicted: string; p: number | null; margin: number | null }

/** Top-1 verdict for one case from its RAW scoreRows answers (index-aligned with the
 *  candidates): argmax over the usable `match` noul probabilities. An exact tie keeps
 *  the FIRST candidate (deterministic) and reports margin 0 to flag it. Unusable
 *  answers (errored row -> undefined, type != noul, non-finite p) are skipped; with
 *  none usable the prediction is "" and with fewer than two usable answers the margin
 *  is null (undefined, not 0). Raw answers, not flatten(): its 2-decimal rounding
 *  could manufacture argmax ties. */
export function selectVerdict(answers: (Record<string, Answer> | undefined)[], candidates: { name: string }[]): Verdict {
  const ps = candidates.map((_, i) => {
    const a = answers[i]?.match;
    return a?.type === "noul" && typeof a.noul === "number" && Number.isFinite(a.noul) ? a.noul : null;
  });
  let best = -1, bestP = -Infinity, second = -Infinity, usable = 0;
  ps.forEach((p, i) => {
    if (p === null) return;
    usable++;
    if (p > bestP) { second = bestP; bestP = p; best = i; }
    else if (p > second) second = p;
  });
  if (best < 0) return { predicted: "", p: null, margin: null };
  return { predicted: candidates[best].name, p: bestP, margin: usable >= 2 ? bestP - second : null };
}

// ---- harness --------------------------------------------------------------------

export interface CaseOptions {
  backend: Backend;
  apiKey: string;        // explicit — main resolves it via resolveApiKey; tests pass a dummy
  model: string;
  ratePerSec?: number;
  maxRetries?: number;
  timeoutSec?: number;
  failFast?: boolean;
  pricePerMtok?: number; // default resolvePricePerMtok()
  fetchImpl?: Fetch;     // DI seam (repo fake-fetch pattern; never set by main)
  onProgress?: (done: number, total: number) => void;
}

export interface CaseError { case: string; kind: string; message: string }

/** One perCase artifact entry; errored / no-answer cases keep predicted "" and null p. */
export interface PerCase { id: string; expected: string; predicted: string; p: number | null; margin: number | null; ok: boolean }

/** The bench-results JSON artifact (bench/results/<provider>-code_selection-<ts>.json). */
export interface SelectionResult {
  fixture: "code_selection"; provider: string; model: string;
  n: number;              // cases attempted (errored ones included)
  correct: number;        // predicted === expected among the scored cases
  accuracy: number;       // correct / scored; errored + no-answer cases excluded
  errored: CaseError[];   // one entry per case with any errored candidate row
  perCase: PerCase[];
  tokens: number; requests: number; cached: number; cost: number;
  durationSec: number; startedAt: string;
}

/** Score cases sequentially — one scoreRows request per case (batch = candidate count
 *  fits a single request-pack; 5 candidates x 1 question is far under the 64-question
 *  request cap), throwaway cache, no cross-case parallelism: deterministic and cheap.
 *  A case with any errored candidate row is "errored": excluded from the accuracy
 *  denominator and reported with its kind. A case whose answers all came back
 *  unusable (no finite p anywhere) is likewise excluded, counted as no-answer. */
export async function scoreCases(cases: CaseInput[], o: CaseOptions): Promise<SelectionResult> {
  const startedAt = new Date();
  const t0 = Date.now();
  const price = o.pricePerMtok ?? resolvePricePerMtok();
  const perCase: PerCase[] = [];
  const errored: CaseError[] = [];
  let correct = 0, scored = 0, tokens = 0, requests = 0, cached = 0, cost = 0, done = 0;
  for (const kase of cases) {
    const rows: Row[] = kase.candidates.map((k) => ({ name: k.name, code: k.code }));
    const r = await scoreRows(rows, matchQuestions(kase.description), {
      backend: o.backend, apiKey: o.apiKey, model: o.model,
      batch: kase.candidates.length, // one pack = one request for the whole case
      concurrency: 1,                // single pack per case — nothing to parallelize
      cache: {}, // throwaway — never persisted, repeated runs measure true accuracy
      ratePerSec: o.ratePerSec, maxRetries: o.maxRetries, timeoutSec: o.timeoutSec, failFast: o.failFast,
      fetchImpl: o.fetchImpl,
    });
    tokens += r.tokens;
    requests += r.requests;
    cached += r.cached;
    cost += r.cost ?? (r.tokens * price) / 1e6;
    if (r.errors.length) {
      // One pack per case: every errored row shares the pack's error, so the first is the case's.
      const e = r.errors[0];
      errored.push({ case: kase.id, kind: e.kind, message: e.message });
      perCase.push({ id: kase.id, expected: kase.expected, predicted: "", p: null, margin: null, ok: false });
    } else {
      const v = selectVerdict(r.answers, kase.candidates);
      if (v.predicted === "") {
        perCase.push({ id: kase.id, expected: kase.expected, predicted: "", p: null, margin: null, ok: false });
      } else {
        scored++;
        if (v.predicted === kase.expected) correct++;
        perCase.push({
          id: kase.id, expected: kase.expected, predicted: v.predicted,
          p: r4(v.p as number), margin: v.margin === null ? null : r4(v.margin),
          ok: v.predicted === kase.expected,
        });
      }
    }
    o.onProgress?.(++done, cases.length);
  }
  return {
    fixture: "code_selection", provider: o.backend.name, model: o.model,
    n: cases.length, correct, accuracy: r4(scored ? correct / scored : 0),
    errored, perCase, tokens, requests, cached, cost,
    durationSec: (Date.now() - t0) / 1000, startedAt: startedAt.toISOString(),
  };
}

// ---- output ---------------------------------------------------------------------

function printReport(r: SelectionResult, cases: CaseInput[]): void {
  const descriptions = new Map(cases.map((k) => [k.id, k.description]));
  const erroredIds = new Set(r.errored.map((e) => e.case));
  console.log(`## Code selection (top-1) — ${r.provider} · ${r.model}`);
  console.log("");
  console.log("| case | description | expected | predicted | p | ok |");
  console.log("|---|---|---|---|---:|---|");
  for (const pc of r.perCase) {
    const p = pc.p === null ? "—" : pc.p.toFixed(2);
    const predicted = pc.predicted || "—";
    const ok = erroredIds.has(pc.id) ? "err" : pc.predicted === "" ? "n/a" : pc.ok ? "yes" : "no";
    console.log(`| ${pc.id} | ${trunc60(descriptions.get(pc.id) ?? "")} | ${pc.expected} | ${predicted} | ${p} | ${ok} |`);
  }
  console.log("");
  const noAnswer = r.n - r.errored.length - r.perCase.filter((pc) => pc.p !== null).length;
  const parts = [`accuracy ${r.accuracy.toFixed(2)} (${r.correct}/${r.n - r.errored.length - noAnswer})`];
  if (r.errored.length) parts.push(`${r.errored.length} errored (${errorBreakdown(r.errored)})`);
  console.error(c("90", parts.join(" · ")));
  if (r.errored.length) {
    for (const e of r.errored.slice(0, 5)) console.error(c("31", `  ${e.kind}: case ${e.case} ${e.message.slice(0, 120)}`));
    if (r.errored.length > 5) console.error(c("31", `  … and ${r.errored.length - 5} more`));
  }
  if (noAnswer > 0) console.error(c("33", `${noAnswer} more cases returned no usable answer — also excluded from the denominator`));
  const summary = `${r.provider} ${r.model} · n ${r.n} (${r.correct}/${r.n - r.errored.length - noAnswer} correct, ${r.cached} cached) · ${r.requests} requests · ${r.tokens} tokens · $${r.cost.toFixed(4)} · ${r.durationSec.toFixed(1)}s`;
  console.error(c("90", summary));
}

/** Same conventions as bench/accuracy.ts's writeResult (mirrored, not imported: the
 *  artifact shape differs and a static import would run accuracy.ts's auto-main). */
export function writeResult(outDir: string, base: string, r: SelectionResult): string {
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${base}-${utcStamp(new Date())}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2) + "\n");
  return file;
}

// ---- entrypoint -----------------------------------------------------------------

async function main() {
  const o = parse(process.argv.slice(2));
  // Provider resolution before anything else (§1.4 precedence): unknown --api, a
  // gateway without JEV_GATEWAY_URL, or a missing key throws the typed
  // JevProviderError straight to the catch (exit 2, hint under the message).
  const backend = resolveProvider(o.api || undefined);
  const apiKey = resolveApiKey(backend);
  const model = o.model || backend.model;
  const pricePerMtok = resolvePricePerMtok();
  const allCases = await loadCases(CASES_FILE);
  const cases = o.limit > 0 ? allCases.slice(0, o.limit) : allCases;
  if (!cases.length) throw new Error(`fixture "code_selection" produced no cases`);
  const outDir = o.out || DEFAULT_OUT;
  const t0 = Date.now();
  const result = await scoreCases(cases, {
    backend, apiKey, model, pricePerMtok,
    ratePerSec: o.rate || undefined, maxRetries: o.retries, timeoutSec: o.timeout, failFast: o.failFast,
    onProgress: (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} cases`); },
  });
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[K`); // clear the progress line
  printReport(result, cases);
  const file = writeResult(outDir, `${backend.name}-code_selection`, result);
  console.error(c("90", `wrote ${file} in ${((Date.now() - t0) / 1000).toFixed(1)}s`));
  // Bench semantics mirror the CLI and accuracy.ts: a partial failure must be visible, not silent.
  if (result.errored.length > 0) process.exitCode = 2;
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

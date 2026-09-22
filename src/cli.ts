#!/usr/bin/env node
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; only createHash is used
import { createHash } from "node:crypto";
import { chunkPaths, diffChunks, estimateRun, gitDiff, jgrep, jgrepFuncs, loadCache, parseTagCategories, saveCache, type Hit, type Kind } from "./jgrep";
import { readRows, loadQuestions, scoreRows, flattenAnswers, toCsv } from "./rows";
import { resolveApiKey, resolvePricePerMtok, resolveProvider, verifyApiKey, type Backend } from "./providers";
import { JevProviderError } from "./errors";

// Ambient so the file typechecks without node types (same pattern as providers.ts);
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

const VERSION = "0.7.0";
// Exported so src/skill.test.ts can pin skills/jgrep/SKILL.md's embedded help
// block to this exact text (the template already embeds the rendered VERSION).
export const USAGE = `jgrep ${VERSION} — semantic grep powered by Jev (TypeSafe)

usage: jgrep init                       interactive setup (provider, key, agent skills)
       jgrep [options] "<description>" [path ...]
       jgrep [options] --diff [ref] "<description>"
       jgrep [options] --rows <file.csv|.jsonl> "<description>"
       jgrep [options] --rows <file> --questions <q.json> [--out scored.csv]

  -t, --threshold <p>   print chunks with probability >= p (default 0.7)
  -C, --show            print the matching chunk body under each hit
  -a, --all             print every chunk with its probability, best first
      --group/--votes <n>/--verify   grouped verdicts, N-vote medians, strict re-ask
      --estimate/--budget <usd>/--sarif/--envelopes   cost dry run, budget stop, SARIF, envelopes
      --funcs           two-phase navigation: shortlist files by function signatures, then search only those
      --tag <list>      classify hits: one choice question per hit; the winning category prints as [tag]
      --json            machine-readable output: hits as a JSON array
                        (v0.3.0-compatible: [{file,start,end,p,text}]; rows: flattened objects)
      --json-errors     with --json: a JSON object instead — code mode
                        {hits:[...], errors:[{file,start,end,kind,message}]};
                        rows mode {answers:[...], errors:[{row,kind,message}]}
      --diff [ref]      grep git diff hunks instead of files
                        (working tree by default, or against <ref>; --staged = staged only)
      --rows <file>     grep rows of a CSV / JSONL file instead of code
      --questions <f>   with --rows: JSON of Jev questions (noul/choice/score)
                        asked of every row; prints the table with answer columns
      --out <file>      with --questions: write the CSV here instead of stdout
                        (with --json: the JSON output goes to the file)
  -b, --batch <n>       chunks per request (default 16)
  -c, --concurrency <n> parallel requests (default 16)
      --api <name>      provider: typesafe | openrouter | gateway
                        precedence: --api > $JEV_API > first key found (typesafe first)
      --model <id>      model id override (default: the provider's default; or $JEV_MODEL)
      --timeout <s>     per-batch deadline, retries included (default 15)
      --request-timeout <s>  per-attempt HTTP timeout (default 30)
      --retries <n>     failed attempts tolerated per batch (default 4)
      --rate <req/s>    global request pacing (token bucket); 0 = unlimited
      --fail-fast       abort on the first fatal error instead of isolating it
      --no-probe/--no-cache   skip the openrouter startup probe; ignore and do not write ~/.cache/jgrep
  -v, --version         print version

exit status: 0 when something matched, 1 when nothing did, 2 on error or when any
chunk errored (partial failure: hits and errors are both reported; every failed
chunk carries a typed kind — timeout, rate_limited, insufficient_credits, ... — with a hint).
CI lint:    ! jgrep --diff origin/main "adds an endpoint without an auth check"

examples:
  jgrep "catches an error and silently ignores it" src/
  jgrep --estimate "swallows errors" src/
  jgrep --rows creators.csv "beauty is the main content of this account"
  jgrep --rows creators.csv --questions beauty.json --out scored.csv
  jgrep -C "reads user input without validating it" app/
  jgrep --diff --staged "changes billing logic without touching tests"
  OPENROUTER_API_KEY=sk-or-... jgrep --api openrouter "swallows errors" src/`;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export function parse(argv: string[]) {
  const o = {
    threshold: 0.7, batch: 16, concurrency: 16, all: false, show: false, group: false, votes: 1, verify: false, json: false, jsonErrors: false, cache: true,
    estimate: false, sarif: false, envelopes: false, funcs: false, budget: null as number | null,
    diff: null as string[] | null, rows: "", questions: "", out: "", tag: "",
    api: "", model: "", timeout: 15, requestTimeout: 30, retries: 4, rate: 0, failFast: false, noProbe: false,
  };
  const rest: string[] = [];
  const positionalsAfter = (i: number) => argv.slice(i + 1).filter((x) => !x.startsWith("-")).length;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-t" || a === "--threshold") o.threshold = Number(argv[++i]);
    else if (a === "-b" || a === "--batch") o.batch = Number(argv[++i]);
    else if (a === "-c" || a === "--concurrency") o.concurrency = Number(argv[++i]);
    else if (a === "-a" || a === "--all") o.all = true;
    else if (a === "-C" || a === "--show") o.show = true;
    else if (a === "--group") o.group = true;
    else if (a === "--votes") o.votes = Number(argv[++i]);
    else if (a === "--verify") o.verify = true;
    else if (a === "--envelopes") o.envelopes = true;
    else if (a === "--funcs") o.funcs = true;
    else if (a === "--tag") o.tag = argv[++i] ?? ""; // comma-separated categories; validated below
    else if (a === "--estimate") o.estimate = true;
    else if (a === "--json") o.json = true;
    else if (a === "--json-errors") { o.jsonErrors = true; o.json = true; } // implies --json
    else if (a === "--sarif") o.sarif = true; // machine-readable SARIF 2.1.0 (its own shape, not --json's)
    else if (a === "--budget") o.budget = Number(argv[++i]);
    else if (a === "--no-cache") o.cache = false;
    else if (a === "--api") o.api = argv[++i] ?? "";
    else if (a === "--model") o.model = argv[++i] ?? "";
    else if (a === "--timeout") o.timeout = Number(argv[++i]);
    else if (a === "--request-timeout") o.requestTimeout = Number(argv[++i]);
    else if (a === "--retries") o.retries = Number(argv[++i]);
    else if (a === "--rate") o.rate = Number(argv[++i]);
    else if (a === "--fail-fast") o.failFast = true;
    else if (a === "--no-probe") o.noProbe = true;
    else if (a === "--staged") (o.diff ??= []).push("--staged");
    else if (a === "--rows") o.rows = argv[++i] ?? "";
    else if (a === "--questions") o.questions = argv[++i] ?? "";
    else if (a === "--out") o.out = argv[++i] ?? "";
    else if (a === "--diff") {
      o.diff ??= [];
      // `--diff <ref>` when a ref follows and the question is still available elsewhere
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && (rest.length > 0 || positionalsAfter(i + 1) > 0)) o.diff.push(argv[++i]);
    }
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else if (a === "-V" || a === "-v" || a === "--version") { console.log(VERSION); process.exit(0); }
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown option ${a} (try --help)`);
    else rest.push(a);
  }
  if (![o.threshold, o.batch, o.concurrency, o.timeout, o.requestTimeout, o.retries, o.rate].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("numeric option expected");
  // batch < 1 spins the batching loop forever (+= 0) and a fraction overlaps batches;
  // 0 stays legal for timeout/rate/retries, but never for batch.
  if (!Number.isInteger(o.batch) || o.batch < 1) throw new Error("batch must be a positive integer");
  // --votes: 1..5 — every extra vote is another question per chunk, and past 5 the
  // re-asks stop adding signal (rejected before anything is sent or cached).
  if (!Number.isInteger(o.votes) || o.votes < 1 || o.votes > 5)
    throw new Error("votes must be an integer between 1 and 5");
  // --tag (WI-4): at least 2 categories — a choice over a single criterion is not a
  // classification. Categories are trimmed/empties-dropped; the raw string passes
  // through to jgrep(), which re-parses it the same way.
  if (o.tag !== "" && parseTagCategories(o.tag).length < 2)
    throw new Error(`--tag needs at least 2 comma-separated categories (got ${parseTagCategories(o.tag).length})`);
  // --budget (WI-7): dollars; 0 stays legal (stop once the first batch has spent
  // anything), negative/non-finite gets the generic numeric error like every flag.
  if (o.budget !== null && !(Number.isFinite(o.budget) && o.budget >= 0))
    throw new Error("numeric option expected");
  return { ...o, question: rest[0], paths: rest.slice(1) };
}

/** Resolved provider + reliability options handed to BOTH jgrep() and scoreRows(). */
interface Wiring {
  backend: Backend;
  apiKey?: string;  // resolved by the openrouter startup probe; otherwise lazy inside the run
  model?: string;   // --model > $JEV_MODEL > the backend's default (applied in jgrep/scoreRows)
  timeoutSec: number;
  requestTimeoutSec: number;
  maxRetries: number;
  ratePerSec?: number;
  failFast: boolean;
  pricePerMtok: number; // $/Mtok for the cost estimate — resolved (and validated) up front
  budget?: number;      // --budget > $JEV_BUDGET > undefined (unlimited); jgrep() meters it per batch
}

/** ` · 4 errored (3 timeout, 1 rate_limited)` — kind counts ordered by count desc, then kind asc. */
function erroredSuffix(errors: { kind: string }[]): string {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([kind, n]) => `${n} ${kind}`);
  return ` · ${errors.length} errored (${parts.join(", ")})`;
}

/** Up to 5 example error lines under the summary, then `… and N more` (stderr, red).
 *  A hint rides under its line as a second grey indented line when the provider
 *  error carried one (so partial-failure runs are as actionable as fatal throws). */
function printExamples(lines: { line: string; hint?: string }[]) {
  for (const { line, hint } of lines.slice(0, 5)) {
    console.error(c("31", line));
    if (hint) console.error(c("90", `    ${hint}`));
  }
  if (lines.length > 5) console.error(c("31", `  … and ${lines.length - 5} more`));
}

// ---- --sarif (WI-7) --------------------------------------------------------------
/** SARIF 2.1.0 rendering of a run: one rule per description hash, one result per hit
 *  (message = the description, location = file uri + the chunk's start line). The shape
 *  GitHub code scanning and every SARIF consumer ingest; printed instead of text when
 *  --sarif is set (works with --diff and plain runs alike). */
export function toSarif(question: string, hits: Hit[]) {
  const ruleId = `jgrep-${createHash("sha1").update(question).digest("hex").slice(0, 12)}`;
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [{
      tool: { driver: { name: "jgrep", rules: [{ id: ruleId, shortDescription: { text: question } }] } },
      results: hits.map((h) => ({
        ruleId,
        message: { text: question },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: h.file },
            region: { startLine: h.start },
          },
        }],
      })),
    }],
  };
}

// ---- --budget (WI-7) ---------------------------------------------------------------
/** $JEV_BUDGET: the default run budget in dollars (an explicit --budget flag wins).
 *  Invalid values are fatal before anything can be spent — same up-front philosophy
 *  as JEV_PRICE_PER_MTOK. Unset/empty means unlimited. */
export function resolveBudgetEnv(env: Record<string, string | undefined>): number | undefined {
  const raw = env.JEV_BUDGET?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0)
    throw new JevProviderError("bad_request", `JEV_BUDGET must be a non-negative number (got "${raw}")`, {
      provider: "generic", retryable: false, hint: "JEV_BUDGET is dollars, e.g. 0.05",
    });
  return n;
}

// ---- --estimate (WI-7) ---------------------------------------------------------------
/** Chunk-only dry run: runs ONLY the chunker — no provider, no key, no probe, no
 *  network, no cache — and prints a per-file chunk table plus the documented token/
 *  cost model (~270 tokens of request overhead + ~300 per chunk, priced at $/Mtok).
 *  Provider-independent (--api/--model/keys are irrelevant), so it runs BEFORE any
 *  provider resolution. Exit 0. */
function estimateMain(o: ReturnType<typeof parse>) {
  const pricePerMtok = resolvePricePerMtok();
  const chunks = o.diff ? diffChunks(gitDiff(o.diff)) : chunkPaths(o.paths.length ? o.paths : ["."]);
  const perFile = new Map<string, number>();
  for (const ch of chunks) perFile.set(ch.file, (perFile.get(ch.file) ?? 0) + 1);
  const files = [...perFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const width = Math.max(...files.map(([f]) => f.length), "file".length);
  console.log(`${"file".padEnd(width)}  chunks`);
  for (const [file, n] of files) console.log(`${file.padEnd(width)}  ${n}`);
  console.log(`${"total".padEnd(width)}  ${chunks.length}`);
  const est = estimateRun(chunks.length, o.batch, pricePerMtok);
  console.log(`estimated: ${est.chunks} chunks, ~${est.tokens} tokens, ~$${est.cost.toFixed(4)}`);
}

async function main() {
  if (process.argv[2] === "init") { const { init } = await import("./init"); return init(); }
  const o = parse(process.argv.slice(2));
  // --estimate (WI-7) is provider-independent: it runs before resolveProvider so an
  // irrelevant --api can neither fail the dry run nor trigger the startup probe.
  if (o.estimate) return estimateMain(o);
  // Provider resolution before anything else: unknown --api, or gateway without
  // JEV_GATEWAY_URL, throws JevProviderError straight to the catch (exit 2).
  const backend = resolveProvider(o.api || undefined);
  // Resolve (and validate) the price up front, BOTH modes: an invalid
  // JEV_PRICE_PER_MTOK must be fatal before the run can bill anything, not at
  // summary time when the tokens have already been spent.
  const pricePerMtok = resolvePricePerMtok();
  // Startup probe — openrouter only (plan §1.6 deviation 3): the alpha decisions
  // surface is the one that may move, so it gets one cheap ping before the run;
  // --no-probe skips it. typesafe/gateway surfaces are stable and skip the probe.
  let apiKey: string | undefined;
  if (backend.name === "openrouter" && !o.noProbe) {
    apiKey = resolveApiKey(backend); // resolved once here, shared with the run below
    const probe = await verifyApiKey(backend, apiKey);
    if (!probe.ok)
      throw new JevProviderError("model_unavailable", `OpenRouter probe failed (HTTP ${probe.status})`, {
        provider: "openrouter", retryable: false,
        hint: "the alpha decisions surface may have changed — pin a version with --model (e.g. ~typesafe/jev-1.13), skip with --no-probe, or switch with --api typesafe",
      });
  }
  const wiring: Wiring = {
    backend, apiKey,
    model: o.model || process.env.JEV_MODEL || undefined,
    timeoutSec: o.timeout, requestTimeoutSec: o.requestTimeout, maxRetries: o.retries,
    ratePerSec: o.rate || undefined, failFast: o.failFast, pricePerMtok,
    budget: o.budget ?? resolveBudgetEnv(process.env), // --budget (WI-7): flag > $JEV_BUDGET > unlimited
  };
  if (o.rows) return rowsMain(o, wiring);
  if (!o.question) { console.error(USAGE); process.exit(2); }

  const t0 = Date.now();
  const kind: Kind = o.diff ? "diff" : "code";
  // --funcs (WI-5) builds its own chunks inside jgrepFuncs (pass-1 signature chunks,
  // then pass-2 normal chunks of the shortlist) — the eager chunking below is skipped.
  // Applies to code search only: --diff keeps judging hunks (funcs ignored there).
  const chunks = o.funcs && !o.diff ? null : (o.diff ? diffChunks(gitDiff(o.diff)) : chunkPaths(o.paths.length ? o.paths : ["."]));
  if (chunks !== null && !chunks.length) { console.error(o.diff ? "empty diff" : "no text files found"); process.exit(1); }
  const cache = o.cache ? loadCache() : {};
  try {
    const onProgress = (d: number, n: number) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); };
    const r = chunks !== null
      ? await jgrep(o.question, chunks, { ...o, kind, cache, ...wiring, onProgress })
      : await jgrepFuncs(o.question, o.paths.length ? o.paths : ["."], { ...o, kind, cache, ...wiring, onProgress });
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

    const rows: Hit[] = o.all ? [...r.all].sort((a, b) => b.p - a.p) : r.hits;
    if (o.sarif) {
      // --sarif (WI-7): machine-readable SARIF 2.1.0 instead of text — one rule per
      // description hash, one result per hit at its chunk's start line. True hits only
      // (the --all tail below the threshold is not a finding), --diff or plain runs.
      console.log(JSON.stringify(toSarif(o.question ?? "", r.hits), null, 2));
    } else if (o.json) {
      // Backward-compatible (the upstream v0.3.0 contract): --json is the bare hit
      // array, byte-for-byte the old shape. Errored chunks never enter it (they
      // never enter all/hits) and surface via the stderr summary + exit 2;
      // --json-errors opts into the object so chunk errors sit next to the hits.
      // --group opts into an object too: groups[] rides next to the hits (with
      // --json-errors also the errors — key order hits, groups, errors keeps the
      // documented shape prefix-stable).
      // --tag (WI-4): tag/tag_p ride on hit objects ONLY when --tag was passed AND the
      // hit actually carries a tag (a failed tag batch leaves the bare v0.3.0 shape —
      // byte-identical output, same as the no-tag contract the v0.3.0 consumers pin).
      const hits = rows.map((h) => ({
        file: h.file, start: h.start, end: h.end, p: h.p, text: h.text,
        ...(o.tag && h.tag !== undefined ? { tag: h.tag, ...(h.tag_p !== undefined ? { tag_p: h.tag_p } : {}) } : {}),
      }));
      const payload = o.jsonErrors || o.group
        ? {
            hits,
            ...(r.groups !== undefined ? { groups: r.groups } : {}),
            ...(o.jsonErrors ? { errors: r.errors.map((e) => ({ file: e.file, start: e.start, end: e.end, kind: e.kind, message: e.message, ...(e.hint !== undefined ? { hint: e.hint } : {}) })) } : {}),
          }
        : hits;
      console.log(JSON.stringify(payload, null, 2));
    } else if (o.group && r.groups) {
      // --group text rendering: one block per signature (p desc), sites indented
      // under the header — the siblings are the same code at other sites, so the
      // representative range is the one to open first.
      for (const g of r.groups) {
        const pcol = g.p >= o.threshold ? "32" : "90";
        console.log(`${c("90", g.sig.slice(0, 7))} ${c("36", `×${g.count}`)}  ${c(pcol, `p=${g.p.toFixed(2)}`)}`);
        for (const s of g.sites)
          console.log(`    ${c("35", s.file)}${c("36", ":")}${c("32", `${s.start}-${s.end}`)}`);
      }
    } else {
      for (const h of rows) {
        const head = h.text.split("\n").find((l) => l.trim() && !l.startsWith("@@"))?.trim().slice(0, 90) ?? "";
        const pcol = h.p >= o.threshold ? "32" : "90";
        // --tag (WI-4): the winning category prints right after the p column.
        const tagcol = h.tag !== undefined ? c("33", ` [${h.tag}]`) : "";
        console.log(`${c("35", h.file)}${c("36", ":")}${c("32", `${h.start}-${h.end}`)}  ${c(pcol, `p=${h.p.toFixed(2)}`)}${tagcol}  ${head}`);
        if (o.show) console.log(h.text.split("\n").map((l) => "    " + l).join("\n") + "\n");
      }
    }
    const cost = r.cost ?? (r.tokens * wiring.pricePerMtok) / 1e6;
    // --budget (WI-7): when the meter tripped, the summary names the stop and the limit
    // (the per-chunk budget_exhausted errors already carry the "raise --budget" hint).
    const budgetStopped = r.errors.some((e) => e.kind === "budget_exhausted");
    const summary = `${r.hits.length} hits / ${r.chunks} chunks (${r.cached} cached) · ${r.tokens} tokens · $${cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`
      + (budgetStopped ? ` · stopped by --budget at $${cost.toFixed(4)} (limit $${wiring.budget})` : "");
    console.error(c("90", r.errors.length ? summary + erroredSuffix(r.errors) : summary));
    printExamples(r.errors.map((e) => ({ line: `  ${e.kind}: ${e.file}:${e.start}-${e.end} ${e.message.slice(0, 120)}`, hint: e.hint })));
    // grep semantics when clean; 2 when any chunk errored (partial failure).
    process.exitCode = r.errors.length > 0 ? 2 : (r.hits.length > 0 ? 0 : 1);
  } finally {
    // Cache save on success, partial failure, breaker abort AND a --fail-fast throw
    // (§1.7); --no-cache still skips (o.cache false leaves `cache` a throwaway object).
    if (o.cache) saveCache(cache);
  }
}

async function rowsMain(o: ReturnType<typeof parse>, wiring: Wiring) {
  if (!o.questions && !o.question) { console.error(USAGE); process.exit(2); }
  const t0 = Date.now();
  const { columns, rows } = readRows(o.rows);
  if (!rows.length) { console.error("no rows"); process.exit(1); }
  const questions = loadQuestions(o.questions || o.question);
  const cache = o.cache ? loadCache() : {};
  try {
    const r = await scoreRows(rows, questions, {
      ...o, cache, ...wiring,
      onProgress: (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); },
    });
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");

    const flat = flattenAnswers(r); // dense: errored rows are null, never holes
    let hits = rows.length;
    // --out truthfulness: `wrote` only when a file actually landed (a --json --out run
    // used to print `wrote <out>` while the JSON only ever reached stdout).
    let wrote = false;
    const writeOut = (text: string) => { if (o.out) { fs.writeFileSync(o.out, text); wrote = true; } else console.log(text); };
    const jsonErrors = r.errors.map((e) => ({ row: e.row, kind: e.kind, message: e.message, ...(e.hint !== undefined ? { hint: e.hint } : {}) }));
    // Rows output shape: unlike code mode (byte-identical to the upstream v0.3.0 bare
    // array), rows --json is a flattened answer array — position-aligned, an errored
    // row is a null entry, never a hole (honest and position-stable); --json-errors
    // opts into the object with the row errors alongside.
    const payload = o.jsonErrors
      ? { answers: flat, errors: jsonErrors }
      : flat;
    if (o.questions) {
      const qCols = [...new Set(flat.flatMap((f) => Object.keys(f ?? {})))];
      const table = rows.map((row, i) => ({ ...row, ...(flat[i] ?? {}) }));
      if (o.json) writeOut(JSON.stringify(payload, null, 2));
      else if (o.out) { fs.writeFileSync(o.out, toCsv([...columns, ...qCols], table)); wrote = true; }
      else process.stdout.write(toCsv([...columns, ...qCols], table));
    } else {
      // single description: grep-style hits, like the code mode
      const scored = rows
        .map((row, i) => ({ row, i, p: Number(flat[i]?.match ?? NaN) }))
        .filter((s) => Number.isFinite(s.p)); // errored rows carry no usable match: skipped, never a TypeError
      const shown = o.all ? [...scored].sort((a, b) => b.p - a.p) : scored.filter((s) => s.p >= o.threshold);
      hits = scored.filter((s) => s.p >= o.threshold).length;
      if (o.json) writeOut(JSON.stringify(payload, null, 2));
      else if (o.out) {
        // --out without --json used to be a silent no-op here: write a CSV of the
        // SHOWN hits — `row` is the source row number (1-based + header = s.i + 2),
        // then p and the flattened answer columns for those rows.
        const cols = [...new Set(shown.flatMap((s) => Object.keys(flat[s.i] ?? {})))];
        writeOut(toCsv(["row", "p", ...cols], shown.map((s) => ({ row: s.i + 2, p: s.p, ...(flat[s.i] ?? {}) }))));
      }
      if (!o.json || o.out) for (const s of shown) { // with --json --out the JSON went to the file; stdout keeps the pretty hits
        const preview = Object.values(s.row).filter(Boolean).join(" | ").slice(0, 90);
        const pcol = s.p >= o.threshold ? "32" : "90";
        console.log(`${c("35", o.rows)}${c("36", ":")}${c("32", String(s.i + 2))}  ${c(pcol, `p=${s.p.toFixed(2)}`)}  ${preview}`);
      }
    }
    const cost = r.cost ?? (r.tokens * wiring.pricePerMtok) / 1e6;
    const summary = `${o.questions ? Object.keys(questions).length + " questions x " : hits + " hits / "}${rows.length} rows (${r.cached} cached) · ${r.requests} requests · ${r.tokens} tokens · $${cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    console.error(c("90", r.errors.length ? summary + erroredSuffix(r.errors) : summary));
    printExamples(r.errors.map((e) => ({ line: `  ${e.kind}: row ${e.row} ${e.message.slice(0, 120)}`, hint: e.hint })));
    if (wrote) console.error(c("90", `wrote ${o.out}`));
    // grep semantics when clean; 2 when any row errored (partial failure) — same rule as code mode.
    process.exitCode = r.errors.length > 0 ? 2 : (o.questions || hits ? 0 : 1);
  } finally {
    // Same rule as code mode: save on success, partial failure, breaker abort and
    // --fail-fast throw; --no-cache still skips.
    if (o.cache) saveCache(cache);
  }
}

if (!process.env.JGREP_NO_MAIN) main().catch((e) => {
  if (e instanceof JevProviderError) {
    console.error(c("31", `${e.kind}: ${e.message}`));
    if (e.hint) console.error(c("90", `  ${e.hint}`));
  } else {
    console.error(c("31", e.message));
  }
  process.exit(2);
});

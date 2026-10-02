#!/usr/bin/env node
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; only createHash is used
import { createHash } from "node:crypto";
import { chunkPaths, diffChunks, estimateLine, estimateTokens, gitDiff, jgrep, jgrepFuncs, loadCache, parseTagCategories, saveCache, type Estimate, type Hit, type Kind } from "./jgrep";
import { readRows, loadQuestions, scoreRows, flattenAnswers, toCsv } from "./rows";
import { loadTests, selectTests } from "./tests";
import { resolvePricePerMtok, resolveProvider, type Backend } from "./providers";
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
// Grouped by purpose (search, input, output, modes, provider, env, reliability, cost),
// then exit status, examples and use cases. Every flag parse() accepts and every env
// var the code reads appears here; the examples run as written from the repo root.
export const USAGE = `jgrep ${VERSION} — semantic grep powered by Jev

usage: jgrep init                       interactive setup (provider, key, agent skills)
       jgrep [options] "<description>" [path ...]
       jgrep [options] --diff [ref] "<description>"
       jgrep [options] --tests [ref] [--staged] [path ...]
       jgrep [options] --rows <file.csv|.jsonl> "<description>"
       jgrep [options] --rows <file> --questions <q.json> [--out scored.csv]

Describe the code in English; jgrep asks Jev one yes/no question per chunk and
prints the chunks that match as file:line ranges with a probability p.
Key: export OPENROUTER_API_KEY or TYPESAFE_API_KEY (or JEV_GATEWAY_API_KEY) in your
shell profile; jgrep detects it. No env var? \`jgrep init\` stores a key file instead.

search
  -t, --threshold <p>   print chunks with p >= this (default 0.7; 0.5 with --tests)
  -a, --all             print every chunk with its probability, best first
  -C, --show            print the matching chunk body under each hit
      --diff [ref]      judge git diff hunks instead of files (working tree, or vs <ref>)
      --staged          with --diff / --tests: staged changes only

input and chunking
  paths default to "."; files come from git ls-files (else a walk, max 5000 files);
  binaries and files over 1 MB are skipped; code splits into 5-60 line chunks,
  Markdown at its headings, and every diff hunk is one chunk
  -b, --batch <n>       chunks per request (default 16)
      --no-cache        ignore and do not write ~/.cache/jgrep

output
      --json            hits as a JSON array [{file,start,end,p,text}] (v0.3.0 shape);
                        --rows: flattened answer objects, null for an errored row
      --json-errors     implies --json and prints an object instead: code mode
                        {hits, errors:[{file,start,end,kind,message}]},
                        rows mode {answers, errors:[{row,kind,message}]}
      --sarif           SARIF 2.1.0 instead of text: one rule per description, one
                        result per hit (GitHub code scanning)
      --out <file>      with --rows: write the CSV (or, with --json, the JSON) here

modes
      --funcs           two passes: shortlist files by their function signatures,
                        then search only those (code search; ignored with --diff)
      --group           print one group per near-identical signature with its sites
                        (each family is judged once; --json adds "groups")
      --votes <n>       ask every chunk n times (1-5); the median probability wins
      --verify          re-ask every hit strictly; it stands at p >= 0.6 x threshold
      --envelopes       append each chunk's numbers to its text (steadier counting)
      --tag <a,b,...>   classify each hit into one of 2+ categories, printed as [tag]
      --tests [ref]     print the test files a diff plausibly affects (by name, by
                        import, then by Jev); pipe the list into your test runner
      --rows <file>     judge the rows of a CSV / JSONL file instead of code
      --questions <f>   with --rows: JSON of Jev questions (noul/choice/score) asked
                        of every row; prints the table with one column per question
  --group, --votes, --verify, --envelopes and --tag apply to code and --diff search

provider and keys
      --api <name>      typesafe | openrouter | gateway; precedence: --api > $JEV_API
                        > the first provider with a key (typesafe, openrouter, gateway),
                        so an OpenRouter key alone selects OpenRouter automatically
      --model <id>      model id (default: the provider's; env JEV_MODEL, JGREP_MODEL)
  key lookup per provider: env var > ~/.config/jgrep/<provider>.key (jgrep init)
  > ~/.config/jgrep/env > ./.env of the project

environment
  TYPESAFE_API_KEY      TypeSafe key
  OPENROUTER_API_KEY    OpenRouter key
  JEV_GATEWAY_URL       gateway: full System One endpoint, https:// or a loopback
                        http:// server that needs no key (alias JGREP_ENDPOINT;
                        read from the process env only, never from ./.env)
  JEV_GATEWAY_API_KEY   gateway key
  JEV_API               default provider (--api wins)
  JEV_MODEL             default model id (alias JGREP_MODEL; --model wins)
  JEV_BUDGET            default --budget in dollars (the flag wins)
  JEV_PRICE_PER_MTOK    dollars per million input tokens for --estimate, --budget and
                        the cost line when the provider reports none (default 0.042)
  NO_COLOR              plain output (also plain when stdout is not a terminal)

reliability
      --timeout <s>     per-batch deadline, retries included (default 15)
      --request-timeout <s>  per-attempt HTTP timeout (default 30)
      --retries <n>     failed attempts tolerated per batch (default 4)
  -c, --concurrency <n> parallel requests (default 16)
      --rate <req/s>    global request pacing (token bucket); 0 = unlimited
      --fail-fast       abort on the first fatal error instead of isolating it

cost (no cap unless you set one)
      --estimate        dry run: requests, input tokens and cost; sends nothing and
                        needs no key (with --funcs it prices the plain search)
      --budget <usd>    hard spend cap: each request reserves its estimated cost and
                        is not sent when it does not fit (search, --verify, --tag,
                        --funcs, --rows; not --tests); 0 sends nothing

  -h, --help            print this help
  -v, -V, --version     print version

exit status: 0 when something matched, 1 when nothing did, 2 on error or when any
chunk errored (partial failure: hits and errors are both reported; every failed
chunk carries a typed kind — timeout, rate_limited, budget_exhausted, ... — with
an actionable hint on stderr). --estimate exits 0. In CI test for 1, never use !:
  jgrep --diff origin/main "adds an endpoint without an auth check"; [ $? -eq 1 ]

examples:
  jgrep "catches an error and silently ignores it" src/
  jgrep -C -t 0.9 "builds an SQL string by concatenation" .
  jgrep -a -t 0 "retries failed HTTP requests" src/ | head
  jgrep --funcs "parses command-line arguments" src/
  jgrep --diff --staged "leaves debug output such as console.log"
  jgrep --diff origin/main --sarif "adds an endpoint without an auth check"
  jgrep --tag "real bug,best-effort cleanup" "swallows an exception" src/
  jgrep --json "spawns a child process" src/ | jq -r '.[].file'
  bun test $(jgrep --tests origin/main)
  jgrep --rows examples/creators.csv "beauty is the main content of this account"
  jgrep --rows examples/creators.csv --questions examples/beauty.json --out scored.csv
  jgrep --estimate "swallows errors" src/
  jgrep --budget 0.05 "swallows errors" .
  jgrep --api openrouter "swallows errors" src/

use cases:
  find where X happens in an unfamiliar repo
      jgrep -C "validates the webhook signature" .
  triage a big diff or PR: rank the hunks, then label them
      jgrep --diff origin/main --tag "bug,refactor" "changes error handling"
  pick the tests to run in CI
      jgrep --tests origin/main | xargs bun test
  classify CSV / JSONL rows with typed questions
      jgrep --rows data.csv --questions q.json --out scored.csv
  cap spending: price the run first, then set a hard cap
      jgrep --estimate "<rule>" src/ && jgrep --budget 0.02 "<rule>" src/
  SARIF for code scanning in CI
      jgrep --diff origin/main --sarif "<rule>" > jgrep.sarif
  a local or Ollama System One server, no key, no code leaves the machine
      JEV_GATEWAY_URL=http://localhost:11434/v1/systemone \\
        jgrep --api gateway --model <name> "<rule>" src/`;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);

export function parse(argv: string[]) {
  const o = {
    threshold: 0.7, batch: 16, concurrency: 16, all: false, show: false, group: false, votes: 1, verify: false, json: false, jsonErrors: false, cache: true,
    estimate: false, sarif: false, envelopes: false, funcs: false, budget: null as number | null,
    diff: null as string[] | null, rows: "", questions: "", out: "", tests: false, tag: "",
    api: "", model: "", timeout: 15, requestTimeout: 30, retries: 4, rate: 0, failFast: false,
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
    else if (a === "--staged") (o.diff ??= []).push("--staged");
    else if (a === "--rows") o.rows = argv[++i] ?? "";
    else if (a === "--questions") o.questions = argv[++i] ?? "";
    else if (a === "--out") o.out = argv[++i] ?? "";
    else if (a === "--tests") {
      o.tests = true; o.diff ??= [];
      const next = argv[i + 1];
      if (next && !next.startsWith("-") && !fs.existsSync(next)) o.diff.push(argv[++i]); // a ref, not a path
    }
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
  // Per-option numeric validation (review): a zero deadline is meaningless, so the
  // two timeouts must be positive; concurrency and retries count requests/attempts,
  // so they must be whole (>= 1 and >= 0); rate 0 = unlimited and the threshold keep
  // the plain finite/non-negative rule. batch keeps its own check below.
  if (![o.threshold, o.rate].every((n) => Number.isFinite(n) && n >= 0))
    throw new Error("numeric option expected");
  if (!Number.isFinite(o.timeout) || o.timeout <= 0) throw new Error("timeout must be a positive number");
  if (!Number.isFinite(o.requestTimeout) || o.requestTimeout <= 0) throw new Error("request-timeout must be a positive number");
  if (!Number.isInteger(o.concurrency) || o.concurrency < 1) throw new Error("concurrency must be a positive integer");
  if (!Number.isInteger(o.retries) || o.retries < 0) throw new Error("retries must be a non-negative integer");
  // batch < 1 spins the batching loop forever (+= 0) and a fraction overlaps batches.
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
  // --budget (WI-7): dollars; 0 stays legal (nothing is sent: every request's
  // reservation exceeds it), negative/non-finite gets the generic numeric error.
  if (o.budget !== null && !(Number.isFinite(o.budget) && o.budget >= 0))
    throw new Error("numeric option expected");
  return { ...o, question: rest[0], paths: rest.slice(1) };
}

/** Resolved provider + reliability options handed to BOTH jgrep() and scoreRows(). */
interface Wiring {
  backend: Backend;
  model?: string;   // --model > $JEV_MODEL > $JGREP_MODEL > the backend's default (applied in jgrep/scoreRows)
  timeoutSec: number;
  requestTimeoutSec: number;
  maxRetries: number;
  ratePerSec?: number;
  failFast: boolean;
  pricePerMtok: number; // $/Mtok for the cost estimate — resolved (and validated) up front
  estimate?: Estimate;  // --estimate: dry-run sink; the run counts requests instead of sending them
  budget?: number;      // --budget > $JEV_BUDGET > undefined (no cap); metered per batch when set
}

/** --estimate: ONE dry-run implementation for every mode (code, --diff, --rows, --tests).
 *  The run goes through the normal request builders into the Estimate sink, so it counts
 *  exactly the requests a real run would send (cached chunks free). Text output: PR #2's
 *  per-file chunk table (code/diff modes) plus the `estimated:` line; --json prints the
 *  upstream #14 object instead. Exit 0. Returns false on a real run. */
function reportEstimate(w: Wiring, json: boolean): boolean {
  if (!w.estimate) return false;
  const tokens = estimateTokens(w.estimate);
  if (json) console.log(JSON.stringify({ requests: w.estimate.requests, tokens, usd: (tokens * w.pricePerMtok) / 1e6, estimate: true }));
  else {
    const files = Object.entries(w.estimate.files ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (files.length) {
      const width = Math.max(...files.map(([f]) => f.length), "file".length);
      console.log(`${"file".padEnd(width)}  chunks`);
      for (const [file, n] of files) console.log(`${file.padEnd(width)}  ${n}`);
      console.log(`${"total".padEnd(width)}  ${files.reduce((s, [, n]) => s + n, 0)}`);
    }
    console.log(estimateLine(w.estimate, w.pricePerMtok));
  }
  process.exitCode = 0;
  return true;
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

async function main() {
  if (process.argv[2] === "init") { const { init } = await import("./init"); return init(); }
  const o = parse(process.argv.slice(2));
  // Provider resolution before anything else: unknown --api, or gateway without
  // JEV_GATEWAY_URL, throws JevProviderError straight to the catch (exit 2).
  const backend = resolveProvider(o.api || undefined);
  // Resolve (and validate) the price up front, BOTH modes: an invalid
  // JEV_PRICE_PER_MTOK must be fatal before the run can bill anything, not at
  // summary time when the tokens have already been spent.
  const pricePerMtok = resolvePricePerMtok();
  // No startup probe (upstream design): OpenRouter is on its stable /api/v1/systemone path,
  // and the first batch's error goes through the typed classifier (401 invalid key, 402
  // credits, retries for transients) — a separate billed ping only misreported those.
  const wiring: Wiring = {
    backend,
    // JGREP_MODEL is upstream's name for the same override (#19); JEV_MODEL wins when both are set.
    model: o.model || process.env.JEV_MODEL || process.env.JGREP_MODEL || undefined,
    timeoutSec: o.timeout, requestTimeoutSec: o.requestTimeout, maxRetries: o.retries,
    ratePerSec: o.rate || undefined, failFast: o.failFast, pricePerMtok,
    estimate: o.estimate ? { requests: 0, chars: 0, files: {} } : undefined,
    budget: o.budget ?? resolveBudgetEnv(process.env), // --budget (WI-7): flag > $JEV_BUDGET > unlimited
  };
  if (o.tests) return testsMain(o, wiring);
  if (o.rows) return rowsMain(o, wiring);
  if (!o.question) { console.error(USAGE); process.exit(2); }

  const t0 = Date.now();
  const kind: Kind = o.diff ? "diff" : "code";
  // --funcs (WI-5) builds its own chunks inside jgrepFuncs (pass-1 signature chunks,
  // then pass-2 normal chunks of the shortlist) — the eager chunking below is skipped.
  // Applies to code search only: --diff keeps judging hunks (funcs ignored there).
  // --estimate prices the plain search even with --funcs: pass 2 depends on pass-1
  // answers a dry run never gets (a known overestimate, listed in the CHANGELOG).
  const chunks = o.funcs && !o.diff && !o.estimate ? null : (o.diff ? diffChunks(gitDiff(o.diff)) : chunkPaths(o.paths.length ? o.paths : ["."]));
  if (chunks !== null && !chunks.length) { console.error(o.diff ? "empty diff" : "no text files found"); process.exit(1); }
  const cache = o.cache ? loadCache() : {};
  try {
    const onProgress = (d: number, n: number) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); };
    const r = chunks !== null
      ? await jgrep(o.question, chunks, { ...o, kind, cache, ...wiring, onProgress })
      : await jgrepFuncs(o.question, o.paths.length ? o.paths : ["."], { ...o, kind, cache, ...wiring, onProgress });
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    if (reportEstimate(wiring, o.json)) return;

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

/** Upstream's --tests mode, wired through the fork's provider plumbing: backend,
 *  model, timeouts, pacing and the price come from the shared Wiring (resolved in
 *  main()), the API key stays lazy inside selectTests (scoreRows pattern). Errors are
 *  isolated per batch like the other modes (upstream's pool-based selectTests). */
async function testsMain(o: ReturnType<typeof parse>, wiring: Wiring) {
  const t0 = Date.now();
  const diff = gitDiff(o.diff ?? []);
  if (!diff.trim()) { console.error("empty diff"); process.exit(1); }
  const paths = [o.question, ...o.paths].filter((p): p is string => !!p);
  const tests = loadTests(paths.length ? paths : ["."]);
  if (!tests.length) { console.error("no test files found"); process.exit(1); }
  const threshold = o.threshold === 0.7 ? 0.5 : o.threshold; // recall matters more here
  const cache = o.cache ? loadCache() : {};
  try {
    const r = await selectTests(diff, tests, {
      ...o, threshold, cache, ...wiring,
      onProgress: (d, n) => { if (process.stderr.isTTY) process.stderr.write(`\r${d}/${n} requests`); },
    });
    if (process.stderr.isTTY) process.stderr.write("\r\x1b[K");
    if (reportEstimate(wiring, o.json)) return;
    const rows = o.all ? [...r.all].sort((a, b) => b.p - a.p) : r.selected;
    if (o.json) console.log(JSON.stringify(rows, null, 2));
    else for (const s of rows) console.log(o.all || process.stdout.isTTY ? `${s.file}${c("90", `  p=${s.p.toFixed(2)} ${s.reason}`)}` : s.file);
    const cost = r.cost ?? (r.tokens * wiring.pricePerMtok) / 1e6;
    const byCode = r.all.filter((s) => s.reason === "direct" || s.reason === "import" || s.reason === "package").length;
    const summary = `${r.selected.length} of ${tests.length} tests selected (${byCode} by name/import, ${r.cached} cached) · ${r.requests} requests · ${r.tokens} tokens · $${cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`;
    console.error(c("90", r.errors.length ? summary + erroredSuffix(r.errors) : summary));
    printExamples(r.errors.map((e) => ({ line: `  ${e.kind}: ${e.file} ${e.message.slice(0, 120)}`, hint: e.hint })));
    // grep semantics when clean; 2 when any batch errored (partial failure) — same rule as code mode.
    process.exitCode = r.errors.length > 0 ? 2 : (r.selected.length ? 0 : 1);
  } finally {
    // Same rule as code mode: save on success, partial failure and a --fail-fast throw.
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
    if (reportEstimate(wiring, o.json)) return;

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
    const budgetStopped = r.errors.some((e) => e.kind === "budget_exhausted"); // same suffix as code mode
    const summary = `${o.questions ? Object.keys(questions).length + " questions x " : hits + " hits / "}${rows.length} rows (${r.cached} cached) · ${r.requests} requests · ${r.tokens} tokens · $${cost.toFixed(4)} · ${((Date.now() - t0) / 1000).toFixed(1)}s`
      + (budgetStopped ? ` · stopped by --budget at $${cost.toFixed(4)} (limit $${wiring.budget})` : "");
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

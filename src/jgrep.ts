// jgrep core: split files (or git diff hunks) into chunks, ask Jev one yes/no
// question per chunk with many chunks per request, return probabilities.
// No index, no embeddings, no dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { BACKENDS, DEFAULT_PRICE_PER_MTOK, postSystemOne, resolveApiKey, RateLimiter, type Backend, type Fetch, type PostOpts } from "./providers";
import { runPool, type PoolResult } from "./pool";
import { isFatalError, JevProviderError, type JevErrorKind } from "./errors";
import { detectLanguage, signatureChunk } from "./funcs";

// DI seam for fetch (moved to providers.ts; re-exported so existing imports keep working)
export type { Fetch };

export interface Chunk { file: string; start: number; end: number; text: string; context?: string }
/** A hit may carry a --tag (WI-4) verdict: the winning category name and its probability. */
export interface Hit extends Chunk { p: number; tag?: string; tag_p?: number }
export type Kind = "code" | "diff";

// ---- chunking ---------------------------------------------------------------
// Language-agnostic heuristic: a column-0 line starts a new block. Swap in
// tree-sitter per language when this misfires on real code.
export function chunk(file: string, text: string, opts = { minLines: 5, maxLines: 60 }): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  let start = 0;
  const flush = (end: number) => {
    const t = lines.slice(start, end).join("\n");
    if (t.trim()) out.push({ file, start: start + 1, end, text: t });
    start = end;
  };
  for (let i = 1; i < lines.length; i++) {
    const len = i - start;
    const boundary = /^[^\s})\]]/.test(lines[i]) && !/^(else|catch|finally|\.)/.test(lines[i]);
    if (len >= opts.maxLines || (boundary && len >= opts.minLines)) flush(i);
  }
  flush(lines.length);
  return out;
}

const MD_EXTENSIONS = new Set([".md", ".markdown", ".mdx", ".mkd", ".mdown"]);

/** True for markdown files, which get heading-aware chunking instead of column-0 splits. */
export function isMarkdownPath(file: string): boolean {
  return MD_EXTENSIONS.has(path.extname(file).toLowerCase());
}

/** Heading boundary: 1-6 `#`s followed by whitespace or end of line (`#`, `## Topic`). */
const isMdHeading = (line: string) => /^#{1,6}(\s|$)/.test(line);
/** Fence delimiter per the chunker's heuristic: ``` anywhere in leading whitespace. */
const isMdFence = (line: string) => /^\s*```/.test(line);

/**
 * Markdown-aware chunking: a `---`/`---` frontmatter block becomes its own first
 * chunk, then every ATX heading (`#`..`######`) starts a section spanning through
 * the line before the next heading (any level) or EOF. Each section chunk carries
 * `context` — the heading trail joined by " > " (e.g. "jgrep > Help") — so the
 * question can name the sub-section. Sections are semantic units: small ones are
 * kept whole (no minLines merging). Sections longer than maxLines split at blank
 * lines OUTSIDE fenced code blocks; a fence that outgrows maxLines is never broken
 * (that piece exceeds maxLines instead). Ranges are 1-based inclusive, like chunk().
 */
export function chunkMarkdown(file: string, text: string, opts = { minLines: 5, maxLines: 60 }): Chunk[] {
  const lines = text.split("\n");
  const maxLines = opts.maxLines ?? 60; // minLines unused: headings are semantic units, never merged away
  const out: Chunk[] = [];
  const push = (start: number, end: number, context?: string) => {
    const t = lines.slice(start, end + 1).join("\n");
    if (!t.trim()) return; // skip completely-whitespace regions only
    out.push(context === undefined ? { file, start: start + 1, end: end + 1, text: t } : { file, start: start + 1, end: end + 1, text: t, context });
  };
  // Oversized region: cut greedily at the last blank line outside fences; a hard
  // cut at the maxLines boundary is the fallback when no blank line is available.
  const splitAndPush = (start: number, end: number, context?: string) => {
    let pieceStart = start;
    let inFence = false; // regions always begin outside a fence (sections start at headings)
    while (pieceStart <= end) {
      if (end - pieceStart + 1 <= maxLines) { push(pieceStart, end, context); break; }
      let cut = -1;
      let lastBlank = -1;
      for (let i = pieceStart; i <= end; i++) {
        const l = lines[i];
        if (!inFence && !l.trim()) lastBlank = i;
        if (isMdFence(l)) inFence = !inFence;
        if (i - pieceStart + 1 >= maxLines && !inFence) { cut = lastBlank >= pieceStart ? lastBlank : i; break; }
      }
      if (cut === -1) { push(pieceStart, end, context); break; } // fence ran past maxLines: exceed rather than break it
      push(pieceStart, cut, context);
      pieceStart = cut + 1;
      inFence = false; // cuts only happen outside fences, so the next piece starts fence-free
    }
  };
  let i = 0;
  // Frontmatter: file opens with exactly `---` and a later line closes it.
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) { push(0, close); i = close + 1; }
  }
  // Sections: one pass, tracking the heading stack for the context trail.
  const stack: { level: number; title: string }[] = [];
  let regionStart = i;       // start of the not-yet-chunked region (preamble or current section)
  let sectionStart = -1;     // heading line of the current section; -1 = still in the preamble
  let context: string | undefined;
  let inFence = false;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!inFence && isMdHeading(l)) {
      if (sectionStart === -1) push(regionStart, i - 1); // preamble before the first heading
      else splitAndPush(regionStart, i - 1, context);
      const level = /^#{1,6}/.exec(l)![0].length;
      while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, title: l.replace(/^#{1,6}\s*/, "").trim() });
      context = stack.map((s) => s.title).join(" > ");
      regionStart = i;
      sectionStart = i;
    } else if (isMdFence(l)) {
      inFence = !inFence;
    }
  }
  if (sectionStart === -1) push(regionStart, lines.length - 1);
  else splitAndPush(regionStart, lines.length - 1, context);
  return out;
}

/** Hunks of `git diff <args>` as chunks; text keeps the +/- markers. */
export function diffChunks(diff: string): Chunk[] {
  const out: Chunk[] = [];
  let file = "";
  let cur: Chunk | null = null;
  const push = () => { if (cur && cur.text.trim()) out.push(cur); cur = null; };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) { push(); file = line.slice(4).replace(/^b\//, ""); continue; }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m) {
      push();
      const start = Number(m[1]), count = m[2] === undefined ? 1 : Number(m[2]);
      if (file === "/dev/null") continue;
      cur = { file, start, end: Math.max(start, start + count - 1), text: "" };
      continue;
    }
    if (line.startsWith("diff --git")) { push(); continue; }
    if (cur) cur.text += (cur.text ? "\n" : "") + line;
  }
  push();
  return out;
}

export function gitDiff(args: string[], cwd = process.cwd()): string {
  return execFileSync("git", ["diff", "--no-color", "--unified=3", ...args], { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
}

// ---- files ------------------------------------------------------------------
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "vendor"]);

export function listFiles(paths: string[]): string[] {
  const files = new Set<string>();
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new Error(`no such path: ${p}`);
    if (fs.statSync(p).isFile()) { files.add(p); continue; }
    try {
      execFileSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split("\0").filter(Boolean).forEach((f) => files.add(f));
    } catch {
      walk(p, files);
    }
  }
  return [...files].filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }).sort();
}

const MAX_WALK_FILES = 5000;
function walk(root: string, out: Set<string>, dir = root) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    if (out.size > MAX_WALK_FILES) {
      const shown = path.resolve(root) === process.cwd() ? "the current directory" : root;
      throw new Error(`${shown} is not a git repo and has more than ${MAX_WALK_FILES} files.\n` +
        `Run jgrep inside a project, or pass its path:  jgrep "..." ~/Documents/<project>`);
    }
    const p = path.join(dir, e.name);
    e.isDirectory() ? walk(root, out, p) : out.add(p);
  }
}

export function readText(file: string): string | null {
  const st = fs.statSync(file);
  if (st.size > 1_000_000) return null;
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString("utf8");
}

export function chunkPaths(paths: string[]): Chunk[] {
  const chunks: Chunk[] = [];
  for (const file of listFiles(paths)) {
    const text = readText(file);
    if (text !== null) chunks.push(...(isMarkdownPath(file) ? chunkMarkdown(file, text) : chunk(file, text)));
  }
  return chunks;
}

// ---- Jev --------------------------------------------------------------------
export function buildRequest(question: string, chunks: Chunk[], kind: Kind = "code", model = "jev-latest", votes = 1, envelopes = false) {
  const state = { chunks: chunks.map((c, i) => ({ id: `c${i}`, file: c.file, lines: `${c.start}-${c.end}`, [kind]: envelopes ? c.text + numberEnvelope(c.text) : c.text })) };
  const what = kind === "diff"
    ? "Does that diff hunk (lines starting with + were added, - removed) match this description"
    : "Does that code match this description";
  const n = Math.max(1, Math.floor(votes)); // --votes (WI-2): N questions per chunk
  const questions: Record<string, unknown> = {};
  chunks.forEach((c, i) => {
    // Markdown chunks carry their heading trail so the question can name the sub-section.
    const ctx = c.context ? `[Section context: ${c.context}] ` : "";
    for (let v = 0; v < n; v++) {
      // votes=1 keeps the byte-identical `c{i}` id; N > 1 names each vote `c{i}#v{v}`
      // (the chunk id inside the instruction stays `c{i}` — the state has one chunk entry).
      questions[n > 1 ? `c${i}#v${v}` : `c${i}`] = { type: "noul", instructions: `Look only at the chunk with id "c${i}". ${ctx}${what}: ${question}` };
    }
  });
  return { model, state, questions };
}

// ---- --envelopes (WI-9) --------------------------------------------------------
/** Cap on the numbers spelled out per chunk: the envelope is a hint for the judge,
 *  not a transcript — past ~20 digits it stops helping and starts costing tokens. */
export const ENVELOPE_MAX_NUMBERS = 20;
const NUMBER_RE = /-?\d+(?:\.\d+)?/g;

/**
 * WI-9 numeric envelope: Jev's documented weakness is counting ("at most 3 retry
 * sites?") — the chunk arrives as prose and the digits get miscounted. With
 * --envelopes the first <=20 numbers of the chunk text are spelled out as a
 * machine-readable suffix ("\n[numbers: 42, 7]"). The suffix is appended INSIDE
 * buildRequest — the request carries it, but cache keys hash the whitespace-
 * NORMALIZED chunk text (WI-6), so envelope and non-envelope runs share one cache
 * (a chunk judged once is never paid for twice either way). Off by default; chunks
 * without numbers get no suffix.
 */
export function numberEnvelope(text: string): string {
  const nums = text.match(NUMBER_RE);
  if (!nums || nums.length === 0) return "";
  return `\n[numbers: ${nums.slice(0, ENVELOPE_MAX_NUMBERS).join(", ")}]`;
}

// ---- cache ------------------------------------------------------------------
// One JSON file for now; move to sqlite if it grows past a few MB.
const CACHE_FILE = path.join(os.homedir(), ".cache", "jgrep", "cache.json");
export type Cache = Record<string, any>;

/** WI-6 size cap: at most this many entries survive a save; the OLDEST-inserted
 *  keys are evicted first, so the newest judgments always survive. */
export const CACHE_MAX_ENTRIES = 10_000;

/** Pure eviction seam (WI-6): drops entries from the FRONT of the insertion order
 *  until `c` fits `cap`. Object.keys of a JSON-parsed cache IS insertion order (a
 *  40-char sha1 hex key is never an integer-like array index), so the front of that
 *  order is the oldest generation. Mutates and returns `c`. Exported so the cap and
 *  oldest-first rule are testable without driving 10k entries through the disk. */
export function evict(c: Cache, cap: number = CACHE_MAX_ENTRIES): Cache {
  const overflow = Object.keys(c).length - cap;
  if (overflow <= 0) return c;
  for (const k of Object.keys(c).slice(0, overflow)) delete c[k];
  return c;
}

/**
 * Whitespace-normalized chunk identity for the persistent cache key (WI-6): lines
 * trimmed, blank lines dropped, re-joined — the same rule as chunkSignature, kept a
 * SEPARATE function because the two serve different masters. chunkSignature only
 * dedups identical chunks WITHIN one run; this one decides what a cached judgment
 * costs: whitespace-only reformatting (re-indentation, trailing spaces, blank-line
 * churn) must not re-bill, while any change in actual content still hashes
 * differently and re-bills. Rows mode normalizes the judged row through this too.
 */
export function normalizeForCache(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
}

/** Disk format v1 (WI-6): `{"v":1,"entries":{…},"order":["key",…]}` with `order` =
 *  insertion order (front = oldest). Returns the FLAT entry map either way, so every
 *  consumer keeps treating the cache as Record<key, p>. A legacy flat object (no
 *  envelope) loads unchanged and is re-persisted in the envelope on the next save —
 *  entries kept, order taken as Object.keys. No migration code: entries keyed on the
 *  pre-normalization raw chunk text simply miss once and re-bill (README cache note). */
export function loadCache(file: string = CACHE_FILE): Cache {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    if (parsed.entries && typeof parsed.entries === "object" && !Array.isArray(parsed.entries))
      return parsed.entries as Cache;
    return parsed as Cache;
  } catch { return {}; }
}

/** Best-effort persist (WI-6): evict past CACHE_MAX_ENTRIES, then write
 *  `${file}.tmp-<pid>` in the SAME directory and fs.renameSync it over the target —
 *  a same-directory rename is atomic, so concurrent jgrep processes never observe a
 *  half-written cache and the worst case is a lost save, never a corrupted file.
 *  Any failure skips the save silently (as before) and removes the tmp file
 *  best-effort. The `file` parameter is a test seam; production callers rely on the
 *  default CACHE_FILE. */
export function saveCache(c: Cache, file: string = CACHE_FILE) {
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    evict(c);
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries: c, order: Object.keys(c) }));
    fs.renameSync(tmp, file);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* cache is best-effort */ }
  }
}
// Normalized signature: whitespace-insensitive chunk identity. Chunks sharing
// a signature are near-identical boilerplate — judge one, siblings inherit.
export function chunkSignature(text: string): string {
	return text.split("\n").map(l => l.trim()).filter(l => l.length > 0).join("\n");
}

// Intra-run signature key (WI-3): sha1 over (kind, question, normalized text).
// Deliberately NOT the persistent cache key below — the signature only dedups
// identical chunks WITHIN a single run.
const sigKey = (kind: Kind, q: string, c: Chunk) =>
  createHash("sha1").update(`${kind}\0${q}\0${chunkSignature(c.text)}`).digest("hex");

// Persistent cache key (WI-6): sha1 over (model, kind, question, NORMALIZED chunk
// text [, context]) — normalizeForCache(c.text), not the raw bytes, so whitespace-
// only reformatting of a file never re-bills while any content change does. Old
// raw-text keys simply miss and re-bill once (no migration code; README note).
// Markdown chunks fold their context trail into the key; chunks without context
// keep the exact pre-markdown key shape (no trailing \0). The #v{i} (votes) and
// #verify suffixes compose AFTER this normalized base — suffix logic unchanged.
const key = (model: string, kind: Kind, q: string, c: Chunk) =>
  createHash("sha1")
    .update(c.context ? `${model}\0${kind}\0${q}\0${normalizeForCache(c.text)}\0${c.context}` : `${model}\0${kind}\0${q}\0${normalizeForCache(c.text)}`)
    .digest("hex");

// ---- votes & verify (WI-2) ----------------------------------------------------
/** Median of N probabilities; an even count averages the two middle values. */
export function median(ps: number[]): number {
  const s = [...ps].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** --verify: the pass-2 question is this strict prefix + the original instruction. */
export const VERIFY_PREFIX = "Verify strictly — answer only if clearly matching: ";
/** --verify hysteresis (documented): a hit stands when its re-ask p >= threshold * VERIFY_GATE. */
export const VERIFY_GATE = 0.6;

// ---- --tag (WI-4) ---------------------------------------------------------------
/** Cap on hits per --tag request: tagging annotates results that are already paid
 *  for, so even a raised --batch never packs more than a default main-pass batch
 *  into one annotation request. */
export const TAG_BATCH_MAX = 16;

/** --tag (WI-4) categories: split on commas, trimmed, empties dropped. The CLI
 *  rejects lists with fewer than 2 categories (a one-way choice is not a category);
 *  the core tolerates any non-empty list so library callers set their own floor. */
export function parseTagCategories(tag: string): string[] {
  return tag.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * --tag (WI-4) request: the standing hits as state (batch-local ids `h0..hN`, the
 * same convention as the main pass's `c0..cN`) plus ONE `choice` question per hit
 * whose criteria are the user's categories keyed `t0..tN`. The winning criterion's
 * NAME (the category string) becomes `Hit.tag`, its probability `Hit.tag_p`.
 */
export function buildTagRequest(hits: Hit[], tags: string[], kind: Kind = "code", model = "jev-latest") {
  const criteria: Record<string, string> = {};
  tags.forEach((t, i) => { criteria[`t${i}`] = t; });
  const state = { chunks: hits.map((h, j) => ({ id: `h${j}`, file: h.file, lines: `${h.start}-${h.end}`, [kind]: h.text })) };
  const questions: Record<string, unknown> = {};
  hits.forEach((_, j) => {
    questions[`h${j}`] = {
      type: "choice",
      instructions: `Which category best fits the code in chunk h${j}? Choose exactly one.`,
      criteria,
    };
  });
  return { model, state, questions };
}

// ---- --estimate (WI-7) ---------------------------------------------------------
/** The documented token model behind `--estimate` (mirrors the README Cost section's
 *  math, which lands $0.010–$0.012 on the 896-chunk reference repo): ~270 tokens of
 *  fixed overhead per REQUEST (system framing + the answers schema) plus ~300 tokens
 *  per CHUNK (chunk body + its question instructions) — one full 16-chunk batch ≈
 *  270 + 16 × 300 ≈ 5,070 input tokens. Cost is tokens × the $/Mtok price
 *  (JEV_PRICE_PER_MTOK, default $0.042); output is free. Provider-independent. */
export const ESTIMATE_REQUEST_OVERHEAD_TOKENS = 270;
export const ESTIMATE_TOKENS_PER_CHUNK = 300;

export interface Estimate { chunks: number; requests: number; tokens: number; cost: number }

/** Token/cost estimate for a run of `chunkCount` chunks batched `batch` per request,
 *  priced at `pricePerMtok` $/Mtok. Pure math — the chunker's caller feeds the count. */
export function estimateRun(chunkCount: number, batch: number, pricePerMtok: number): Estimate {
  const perBatch = Math.max(1, Math.floor(batch) || 1);
  const requests = Math.ceil(chunkCount / perBatch);
  const tokens = requests * ESTIMATE_REQUEST_OVERHEAD_TOKENS + chunkCount * ESTIMATE_TOKENS_PER_CHUNK;
  return { chunks: chunkCount, requests, tokens, cost: (tokens * pricePerMtok) / 1e6 };
}

// ---- core -------------------------------------------------------------------
// Retry/deadline defaults live in ONE place (here); jgrep()/scoreRows() resolve
// them once per run and the pool workers only read the resolved values.
export const DEFAULT_TIMEOUT_SEC = 15;         // per-batch deadline INCLUDING retries (§1.6.1)
export const DEFAULT_REQUEST_TIMEOUT_SEC = 30; // per attempt
export const DEFAULT_MAX_RETRIES = 4;          // => 5 total attempts

export interface Options {
  threshold: number; batch: number; concurrency: number; apiKey?: string; kind?: Kind;
  backend?: Backend; model?: string;
  timeoutSec?: number;         // per-batch deadline, retries included
  requestTimeoutSec?: number;  // per attempt
  maxRetries?: number;         // failed attempts tolerated before the final error
  ratePerSec?: number;         // token-bucket pacing across all requests; 0/undefined = unlimited
  failFast?: boolean;          // rethrow the first fatal error instead of isolating it
  group?: boolean;             // --group: fill result.groups[] (the intra-run signature dedup is always on)
  votes?: number;              // --votes: judge every chunk N times (1-5); the MEDIAN probability wins
  verify?: boolean;            // --verify: strict re-ask of every hit; the hit stands only at p >= threshold * 0.6
  tag?: string;                // --tag (WI-4): comma-separated categories; one choice question per standing hit, the winner rides on Hit.tag
  funcs?: boolean;             // --funcs (WI-5): two-phase navigation — shortlist files by signature chunks, then search only those
  envelopes?: boolean;         // --envelopes (WI-9): append each chunk's numbers ("[numbers: 42, 7]") to the judged text
  budget?: number;             // --budget (WI-7): once metered cost exceeds this many dollars, un-run chunks error budget_exhausted
  pricePerMtok?: number;       // $/Mtok for the --budget meter when the provider reports no cost (default DEFAULT_PRICE_PER_MTOK)
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}
export interface ChunkError { file: string; start: number; end: number; kind: JevErrorKind; message: string; hint?: string }
/** One signature cluster (WI-3 --group): hits sharing a whitespace-normalized signature.
 *  `p` is the group's best probability, `sites` are the hit sites in hit (file) order and
 *  `representative` is the first hit's chunk body. */
export interface Group { sig: string; p: number; count: number; sites: { file: string; start: number; end: number }[]; representative: string }
export interface Result { hits: Hit[]; all: Hit[]; chunks: number; tokens: number; cached: number; errors: ChunkError[]; cost?: number; groups?: Group[] }

/** What one batch worker hands back; runPool results are completion-ordered, so the
 *  batch index rides along and `all` is re-associated after the pool settles. A
 *  partial 200 (the provider answered some chunks but not others) is NOT a hit:
 *  unanswered chunk indices come back in `malformed` and the caller records them as
 *  malformed_response ChunkErrors — otherwise they would surface as p:NaN entries. */
interface BatchOutcome { index: number; entries: { chunkIndex: number; p: number }[]; malformed: number[] }

/** What one --verify batch worker hands back (same shape idea as BatchOutcome). */
interface VerifyOutcome { index: number; got: { hit: Hit; p: number }[]; missing: Hit[] }

/** What one --tag batch worker hands back (same shape idea as VerifyOutcome): the
 *  hits this batch successfully categorized. Unlisted hits of the batch stay untagged. */
interface TagOutcome { index: number; got: { hit: Hit; tag: string; p: number }[] }

/** Appended to an invalid_api_key hint when at least one batch succeeded earlier in the
 *  SAME run (plan §1.5): a 401/403 then means the key expired/was revoked, not that the
 *  user handed over the wrong provider's key. */
export const KEY_WORKED_EARLIER_HINT = "the key worked earlier this run — it may have been expired or revoked";

export async function jgrep(question: string, chunks: Chunk[], o: Options): Promise<Result> {
  const kind = o.kind ?? "code";
  const backend = o.backend ?? BACKENDS.typesafe; // the core never picks a provider from env — cli.ts resolves in Step 7
  const model = o.model ?? backend.model;
  const cache = o.cache ?? {};
  const f = o.fetchImpl ?? fetch;
  // Lazy key resolution: explicit apiKey wins; otherwise resolved once at the first
  // request, so a fully-cached run (or a test passing apiKey) never touches the filesystem.
  let apiKey = o.apiKey;
  const apiKeyOf = (): string => { apiKey ??= resolveApiKey(backend); return apiKey; };
  const all: (Hit | undefined)[] = new Array(chunks.length); // errored chunks stay unset
  // Signature clustering (WI-3): chunks sharing a whitespace-normalized signature are
  // near-identical boilerplate — the FIRST cache-missing chunk of a signature (the head)
  // enters the batch todo, siblings inherit the head's verdict once the pool settles.
  // The persistent cache is keyed on the whitespace-normalized chunk text (WI-6);
  // `cached` counts only genuinely cache-served chunks — an inheriting sibling is
  // deduped, not cached.
  const heads = new Map<string, number>();        // signature key -> head chunk index
  const siblingsOf = new Map<string, number[]>(); // signature key -> chunk indices that inherit the verdict
  let cached = 0;
  // --votes (WI-2): parse() validates 1..5; library callers get clamped. N > 1 moves
  // reads/writes to per-vote cache keys `${key}#v{i}` (every vote cached individually, so
  // a re-run replays the same median for free) and the verdict to the MEDIAN of the N
  // answers. votes=1 keeps the byte-exact legacy single-question request and plain keys.
  const votes = Math.max(1, Math.min(5, Math.floor(o.votes ?? 1)));
  const envelopes = o.envelopes ?? false; // --envelopes (WI-9): judged text gains "[numbers: …]"
  const keyOf = (ci: number): string => key(model, kind, question, chunks[ci]);
  const qid = (j: number, v: number): string => (votes > 1 ? `c${j}#v${v}` : `c${j}`);
  chunks.forEach((c, i) => {
    const k = keyOf(i);
    if (votes > 1) {
      const ps: number[] = [];
      let complete = true;
      for (let v = 0; v < votes; v++) {
        const p = cache[`${k}#v${v}`];
        if (typeof p === "number" && Number.isFinite(p)) ps.push(p);
        else { complete = false; break; }
      }
      if (complete) { all[i] = { ...c, p: median(ps) }; cached++; return; }
    } else {
      const hit = cache[k];
      if (hit !== undefined) { all[i] = { ...c, p: hit }; cached++; return; }
    }
    const sk = sigKey(kind, question, c);
    if (heads.has(sk)) siblingsOf.get(sk)!.push(i);
    else { heads.set(sk, i); siblingsOf.set(sk, []); }
  });
  const todo: number[] = [...heads.values()];
  // Defensive normalization: a 0/fractional batch would spin the loop forever (+= 0)
  // or overlap batches. parse() rejects those; library callers get clamped instead.
  const batch = Math.max(1, Math.floor(o.batch));
  const batches: number[][] = [];
  for (let i = 0; i < todo.length; i += batch) batches.push(todo.slice(i, i + batch));
  // One resolution of the retry/deadline options for the whole run (the worker only reads these).
  const timeoutMs = (o.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
  const post: PostOpts = {
    fetchImpl: f,
    requestTimeoutMs: (o.requestTimeoutSec ?? DEFAULT_REQUEST_TIMEOUT_SEC) * 1000,
    maxRetries: o.maxRetries ?? DEFAULT_MAX_RETRIES,
    limiter: o.ratePerSec && o.ratePerSec > 0 ? new RateLimiter(o.ratePerSec, Math.max(1, o.concurrency)) : undefined,
  };
  let tokens = 0;
  let cost: number | undefined; // stays undefined unless a provider reports a cost
  // --budget (WI-7): the meter mirrors the CLI summary line — the provider-reported
  // cost when one arrived, else tokens × $/Mtok. Checked at each worker's ENTRY, i.e.
  // AFTER the previous batch's spend was recorded: in-flight batches finish (their
  // hits and cache entries are kept), later ones refuse to start for free.
  const price = o.pricePerMtok ?? DEFAULT_PRICE_PER_MTOK;
  const meteredCost = (): number => (cost !== undefined ? cost : (tokens * price) / 1e6);
  const budgetStop = (): boolean => o.budget !== undefined && meteredCost() > o.budget;
  const budgetError = (): JevProviderError =>
    new JevProviderError(
      "budget_exhausted",
      `budget exhausted: $${meteredCost().toFixed(4)} spent of the $${o.budget} --budget`,
      { provider: backend.name, retryable: false, hint: "raise --budget" },
    );
  // Run-level success flag (plan §1.5): drives the invalid_api_key expired-vs-wrong-key
  // hint. Tracked HERE (not PoolResult) because failFast throws the pool result away.
  let hadSuccess = false;
  const worker = async (b: number[], index: number): Promise<BatchOutcome> => {
    // --budget (WI-7): refuse to start a batch once the meter exceeds the budget — no
    // request, no spend. budget_exhausted is non-retryable but deliberately NOT fatal
    // (see errors.ts FATAL_KINDS): the breaker never trips on it, so every remaining
    // batch reports the same stop instead of the run becoming circuit_breaker_open.
    if (budgetStop()) throw budgetError();
    const res = await postSystemOne(buildRequest(question, b.map((i) => chunks[i]), kind, model, votes, envelopes), backend, apiKeyOf(), {
      ...post,
      deadlineMs: Date.now() + timeoutMs, // per-batch deadline, retries included (§1.6.1)
    });
    tokens += res.usage?.input_tokens ?? 0;
    if (res.cost !== undefined) cost = (cost ?? 0) + res.cost;
    // Finite p-values go straight into the in-memory cache object: cli.ts persists it in a
    // finally (Step 7), so answers paid for survive even when other batches fail. A chunk
    // the provider did not answer (missing or non-finite p on a 200) is skipped here and
    // reported as malformed_response — never a p:NaN entry in all/hits.
    const entries: { chunkIndex: number; p: number }[] = [];
    const malformed: number[] = [];
    b.forEach((ci, j) => {
      // --votes: the verdict needs ALL N votes finite (returned ones are still cached as
      // they arrive); an incomplete set is malformed_response — never a partial median.
      const ps: number[] = [];
      let complete = true;
      for (let v = 0; v < votes; v++) {
        const p = res.answers[qid(j, v)]?.noul;
        if (Number.isFinite(p)) {
          ps.push(p);
          if (votes > 1) cache[`${keyOf(ci)}#v${v}`] = p;
        } else complete = false;
      }
      if (!complete) { malformed.push(ci); return; }
      const p = votes > 1 ? median(ps) : ps[0];
      if (votes === 1) cache[keyOf(ci)] = p;
      entries.push({ chunkIndex: ci, p });
    });
    hadSuccess = true; // this batch's request succeeded — set before returning (plan §1.5)
    return { index, entries, malformed };
  };
  let pool: PoolResult<BatchOutcome>;
  try {
    pool = await runPool(batches, {
      concurrency: o.concurrency,
      failFast: o.failFast,
      onProgress: o.onProgress ? (done, total) => o.onProgress!(done, total) : undefined,
    }, worker);
  } catch (e) {
    // failFast: runPool rethrows the first fatal error and PoolResult.hadSuccess is lost
    // with it, so the run-level flag above is the only remaining evidence that the key
    // worked earlier this run. Amend the hint; otherwise rethrow untouched.
    if (e instanceof JevProviderError && isFatalError(e) && e.kind === "invalid_api_key" && hadSuccess)
      e.hint = [e.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    throw e;
  }
  for (const r of pool.results) for (const e of r.entries) all[e.chunkIndex] = { ...chunks[e.chunkIndex], p: e.p };
  // Not failFast: recorded 401/403s get the same expired-vs-wrong-key distinction. One
  // clean place — mutate the JevProviderError's hint in pool.errors BEFORE mapping onto
  // chunks, so the amended hint is what ChunkError carries down to the CLI.
  if (pool.hadSuccess) {
    for (const e of pool.errors) {
      if (e.error.kind === "invalid_api_key") e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    }
  }
  // Chunk-index -> ChunkError (insertion-ordered exactly like the old flatMap/push
  // chain), so signature siblings below can look up and inherit their head's error.
  const errByChunk = new Map<number, ChunkError>();
  for (const e of pool.errors)
    for (const ci of batches[e.index])
      errByChunk.set(ci, {
        file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end,
        kind: e.error.kind, message: e.error.message,
        // The provider error's actionable hint rides along (cli.ts prints it under the
        // error line and --json-errors includes it) — incl. the KEY_WORKED_EARLIER_HINT
        // amended above.
        ...(e.error.hint !== undefined ? { hint: e.error.hint } : {}),
      });
  // A 200 that answered only some chunks of a batch: the unanswered chunks are
  // recorded per chunk here (the batch itself succeeded, so the pool saw no error).
  for (const r of pool.results)
    for (const ci of r.malformed)
      errByChunk.set(ci, { file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: "malformed_response", message: "provider returned no usable answer for this chunk" });
  if (pool.aborted) {
    // Batches that were dispatched all reported (success or their own error); whatever
    // was never attempted is reported as a breaker error. No cache entries, no hits.
    const settled = new Set<number>(pool.results.map((r) => r.index).concat(pool.errors.map((e) => e.index)));
    for (let bi = 0; bi < batches.length; bi++) {
      if (settled.has(bi)) continue;
      for (const ci of batches[bi]) {
        errByChunk.set(ci, { file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: "circuit_breaker_open", message: "not attempted: provider failing consistently (circuit breaker open)" });
      }
    }
  }
  const errors: ChunkError[] = [...errByChunk.values()];
  // Signature siblings (WI-3): inherit the head's verdict — or, when the head ended up
  // with no answer, the head's error mapped onto the sibling's own site (no silent
  // vanish; every batch settles as a result, an error, or a breaker skip, so a verdict-
  // less head always carries an error to inherit). Each inheriting sibling still writes
  // its OWN plain-text cache entry, so a later run serves it without re-judging. (With
  // --votes the sibling's per-vote values are unknown — only the median is — so the
  // entry lands under the legacy key: a votes=1 re-run serves it; a votes>1 re-run
  // re-judges rather than fabricate votes.)
  for (const [sk, sibs] of siblingsOf) {
    if (!sibs.length) continue;
    const headIdx = heads.get(sk)!;
    const verdict = all[headIdx];
    if (verdict !== undefined) {
      for (const si of sibs) {
        cache[key(model, kind, question, chunks[si])] = verdict.p;
        all[si] = { ...chunks[si], p: verdict.p };
      }
    } else {
      const headErr = errByChunk.get(headIdx);
      if (headErr !== undefined)
        for (const si of sibs)
          errors.push({ ...headErr, file: chunks[si].file, start: chunks[si].start, end: chunks[si].end });
    }
  }
  let hits: Hit[] = [];
  const ordered: Hit[] = [];
  for (const h of all) if (h) { ordered.push(h); if (h.p >= o.threshold) hits.push(h); }
  // --verify (WI-2): every hit is re-asked ONCE with a strict instruction (the prefix +
  // the original question, one question per chunk — the median already happened); the
  // hit stands only when the re-ask p >= threshold * 0.6 (documented hysteresis: a
  // strict rephrase naturally scores lower, so the gate is deliberately forgiving).
  // Dropped hits leave `hits` but stay in `all` with their main-pass p. Verification
  // verdicts cache under `${chunkKey}#verify`, so a re-run pays nothing for either pass.
  if (o.verify && hits.length > 0) {
    const gate = o.threshold * VERIFY_GATE;
    const verdictOf = new Map<Hit, number>(); // hit -> pass-2 p; an ABSENT verdict failed -> fail open
    const pending: { hit: Hit; cacheKey: string }[] = [];
    for (const h of hits) {
      const ck = `${key(model, kind, question, h)}#verify`;
      const v = cache[ck];
      if (typeof v === "number" && Number.isFinite(v)) verdictOf.set(h, v);
      else pending.push({ hit: h, cacheKey: ck });
    }
    if (pending.length > 0) {
      const vBatches: (typeof pending)[] = [];
      for (let i = 0; i < pending.length; i += batch) vBatches.push(pending.slice(i, i + batch));
      const vWorker = async (bp: typeof pending, index: number): Promise<VerifyOutcome> => {
        if (budgetStop()) throw budgetError(); // --budget meters the verify pass too
        const req = buildRequest(question, bp.map(({ hit }) => hit), kind, model, 1, envelopes);
        for (const id of Object.keys(req.questions))
          req.questions[id] = { type: "noul", instructions: VERIFY_PREFIX + (req.questions[id] as { instructions: string }).instructions };
        const res = await postSystemOne(req, backend, apiKeyOf(), { ...post, deadlineMs: Date.now() + timeoutMs });
        tokens += res.usage?.input_tokens ?? 0;
        if (res.cost !== undefined) cost = (cost ?? 0) + res.cost;
        const got: { hit: Hit; p: number }[] = [];
        const missing: Hit[] = [];
        bp.forEach(({ hit, cacheKey }, j) => {
          const p = res.answers[`c${j}`]?.noul;
          if (Number.isFinite(p)) { cache[cacheKey] = p; got.push({ hit, p }); }
          else missing.push(hit);
        });
        return { index, got, missing };
      };
      let vPool: PoolResult<VerifyOutcome>;
      try {
        // No onProgress: the main pass already drove the CLI's d/N counter; the verify
        // pass is a short second sweep.
        vPool = await runPool(vBatches, { concurrency: o.concurrency, failFast: o.failFast }, vWorker);
      } catch (e) {
        // failFast: the main pass succeeded (there were hits), so the key worked earlier.
        if (e instanceof JevProviderError && isFatalError(e) && e.kind === "invalid_api_key")
          e.hint = [e.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
        throw e;
      }
      for (const r of vPool.results) for (const g of r.got) verdictOf.set(g.hit, g.p);
      for (const e of vPool.errors) {
        if (e.error.kind === "invalid_api_key")
          e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
        for (const { hit } of vBatches[e.index])
          errors.push({
            file: hit.file, start: hit.start, end: hit.end,
            kind: e.error.kind, message: e.error.message,
            ...(e.error.hint !== undefined ? { hint: e.error.hint } : {}),
          });
      }
      // A 200 with no usable verification answer: FAIL-OPEN (the main-pass hit stands)
      // and reported, so the user can see verification could not finish for that chunk.
      for (const r of vPool.results)
        for (const hit of r.missing)
          errors.push({ file: hit.file, start: hit.start, end: hit.end, kind: "malformed_response", message: "provider returned no usable verification answer — the main-pass hit stands" });
    }
    // The hysteresis gate: a hit with no verify verdict (request failed, fail-open) falls
    // back to its main-pass p — which cleared `threshold`, so it stands.
    hits = hits.filter((h) => (verdictOf.get(h) ?? h.p) >= gate);
  }
  // --tag (WI-4): one `choice` question per STANDING hit, run AFTER --verify filtering
  // so a tag only lands on hits that survived the hysteresis gate. The categories become
  // criteria `t0..tN`; the chosen criterion's name rides on the hit as `tag` with its
  // probability as `tag_p` (the Hit objects are shared with `all`, so --all/--json see
  // them too). Batched <=TAG_BATCH_MAX hits per request through the same pool +
  // postSystemOne machinery as the verify pass (same retries, pacing, deadlines, lazy
  // key resolution); its tokens/cost meter the same way.
  // ERROR POLICY (deliberate, differs from the verify pass): the tag pass NEVER throws
  // and NEVER records errors[] — a failed tag batch (retries exhausted, breaker open,
  // --budget stopped) simply leaves those hits untagged and the search result stands.
  // Tags annotate results that already cleared the threshold; surfacing them as chunk
  // errors would turn an answered search into an exit-2 run, and --fail-fast governs
  // the search, not this annotation pass.
  if (o.tag && hits.length > 0) {
    const tags = parseTagCategories(o.tag);
    if (tags.length > 0) {
      const criteria: Record<string, string> = {};
      tags.forEach((t, i) => { criteria[`t${i}`] = t; });
      // <=16 hits per request even when --batch was raised (TAG_BATCH_MAX above).
      const tagBatch = Math.max(1, Math.min(TAG_BATCH_MAX, batch));
      const tBatches: Hit[][] = [];
      for (let i = 0; i < hits.length; i += tagBatch) tBatches.push(hits.slice(i, i + tagBatch));
      const tWorker = async (bh: Hit[], index: number): Promise<TagOutcome> => {
        if (budgetStop()) return { index, got: [] }; // --budget exhausted: no tags, no error (policy above)
        const res = await postSystemOne(buildTagRequest(bh, tags, kind, model), backend, apiKeyOf(), {
          ...post,
          deadlineMs: Date.now() + timeoutMs, // per-batch deadline, retries included (§1.6.1)
        });
        tokens += res.usage?.input_tokens ?? 0;
        if (res.cost !== undefined) cost = (cost ?? 0) + res.cost;
        const got: { hit: Hit; tag: string; p: number }[] = [];
        bh.forEach((hit, j) => {
          // A choice answer names its criterion by KEY (`t0`) with `probabilities`
          // keyed the same way; a provider that echoes the category NAME instead maps
          // just the same. An unusable answer leaves that hit untagged (policy above).
          const a = res.answers[`h${j}`];
          const choice = typeof a?.choice === "string" && a.choice ? a.choice : undefined;
          const name = choice === undefined ? undefined : criteria[choice] ?? choice;
          const p = a?.probabilities?.[choice ?? ""] ?? a?.probabilities?.[name ?? ""];
          if (name !== undefined && tags.includes(name) && typeof p === "number" && Number.isFinite(p))
            got.push({ hit, tag: name, p });
        });
        return { index, got };
      };
      // failFast is deliberately NOT honored here (error policy above): every failure
      // lands in tPool.errors and is dropped — hits stay untagged, nothing is recorded.
      const tPool = await runPool(tBatches, { concurrency: o.concurrency }, tWorker);
      for (const r of tPool.results) for (const g of r.got) { g.hit.tag = g.tag; g.hit.tag_p = g.p; }
    }
  }
  // --group (WI-3): one Group per signature present in the hits, sorted p desc (stable
  // for ties: first-site order). Sites keep hit (file) order; representative is the
  // first hit's chunk body. Sites judged this run share the head's p; cache-served
  // members can carry an older p, so the group reports the best one.
  let groups: Group[] | undefined;
  if (o.group) {
    const bySig = new Map<string, Group>();
    for (const h of hits) {
      const sk = sigKey(kind, question, h);
      const g = bySig.get(sk);
      if (g) {
        g.count++;
        g.sites.push({ file: h.file, start: h.start, end: h.end });
        if (h.p > g.p) g.p = h.p;
      } else
        bySig.set(sk, { sig: sk, p: h.p, count: 1, sites: [{ file: h.file, start: h.start, end: h.end }], representative: h.text });
    }
    groups = [...bySig.values()].sort((a, b) => b.p - a.p);
  }
  return { hits, all: ordered, chunks: chunks.length, tokens, cached, errors, ...(cost !== undefined ? { cost } : {}), ...(groups !== undefined ? { groups } : {}) };
}

// ---- --funcs (WI-5): two-phase function navigation ----------------------------
/**
 * Two-phase navigation over `paths`. Pass 1 judges ONE SIGNATURE chunk per
 * supported source file (funcs.signatureChunk: regex-extracted function/method/
 * class lines, tree-sitter deferred) exactly like any chunk — a handful of chunks
 * for a whole tree. The files whose signature chunk reaches `threshold` become the
 * shortlist; pass 2 is the NORMAL chunk search run only on those files, so the
 * search cost is proportional to the shortlist instead of the whole tree.
 *
 * Files in unsupported languages (funcs.detectLanguage → null) and supported files
 * with no extractable signatures are SKIPPED entirely — pass 1 cannot shortlist
 * what it never saw (documented). The returned Result is pass 2's (real-code
 * file:line hits); when nothing is shortlisted, pass 1's Result comes back with
 * 0 hits. Pass-1 chunk errors stay pass-1-internal (they only shrink the
 * shortlist); a fatal throw (fail-fast, dead key) propagates as usual. Both passes
 * share one cache object — a signature chunk and a code chunk never collide (the
 * judged text differs), so a re-run replays either pass for free.
 */
export async function jgrepFuncs(question: string, paths: string[], o: Options): Promise<Result> {
  const sigChunks: Chunk[] = [];
  for (const file of listFiles(paths)) {
    const lang = detectLanguage(file);
    if (!lang) continue; // unsupported language: excluded from --funcs search (documented)
    const text = readText(file);
    if (text === null) continue; // binary or >1MB: the same skip chunkPaths applies
    const sc = signatureChunk(file, text, lang);
    if (sc) sigChunks.push(sc);
  }
  // Pass 1 never tags (--tag stripped): its hits are only a shortlist — never printed
  // — so tagging them would be a wasted request. Pass 2 tags the real hits.
  const pass1 = await jgrep(question, sigChunks, { ...o, tag: undefined });
  const shortlist = [...new Set(pass1.hits.map((h) => h.file))];
  if (shortlist.length === 0) return pass1;
  return jgrep(question, chunkPaths(shortlist), o);
}

// ---- config -----------------------------------------------------------------
// Key resolution/verification/storage moved to providers.ts (WI-1): resolveApiKey,
// verifyApiKey and the legacy ~/.config/jgrep/env writer live there now.
// Agent-skill installation moved to init.ts: the vercel `skills` universal installer
// (`installToAgentsDir` there is the fallback) replaced the old per-harness copy.

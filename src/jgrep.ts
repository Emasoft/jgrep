// jgrep core: split files (or git diff hunks) into chunks, ask Jev one yes/no
// question per chunk with many chunks per request, return probabilities.
// No index, no embeddings, no dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { BACKENDS, postSystemOne, resolveApiKey, RateLimiter, type Backend, type Fetch, type PostOpts } from "./providers";
import { runPool, type PoolResult } from "./pool";
import { isFatalError, JevProviderError, type JevErrorKind } from "./errors";

// DI seam for fetch (moved to providers.ts; re-exported so existing imports keep working)
export type { Fetch };

export interface Chunk { file: string; start: number; end: number; text: string; context?: string }
export interface Hit extends Chunk { p: number }
export type Kind = "code" | "diff";

// ---- chunking ---------------------------------------------------------------
// ponytail: language-agnostic heuristic (column-0 line starts a new block).
// Swap in tree-sitter per language when this misfires on real code.
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
export function buildRequest(question: string, chunks: Chunk[], kind: Kind = "code", model = "jev-latest") {
  const state = { chunks: chunks.map((c, i) => ({ id: `c${i}`, file: c.file, lines: `${c.start}-${c.end}`, [kind]: c.text })) };
  const what = kind === "diff"
    ? "Does that diff hunk (lines starting with + were added, - removed) match this description"
    : "Does that code match this description";
  const questions: Record<string, unknown> = {};
  chunks.forEach((c, i) => {
    // Markdown chunks carry their heading trail so the question can name the sub-section.
    const ctx = c.context ? `[Section context: ${c.context}] ` : "";
    questions[`c${i}`] = { type: "noul", instructions: `Look only at the chunk with id "c${i}". ${ctx}${what}: ${question}` };
  });
  return { model, state, questions };
}

// ---- cache ------------------------------------------------------------------
// ponytail: one JSON file; move to sqlite if it passes a few MB.
const CACHE_FILE = path.join(os.homedir(), ".cache", "jgrep", "cache.json");
export type Cache = Record<string, any>;
export function loadCache(): Cache {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}
export function saveCache(c: Cache) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(c));
  } catch { /* cache is best-effort */ }
}
// Markdown chunks fold their context trail into the key; chunks without context
// keep the exact pre-markdown key string (no trailing \0), so old cache entries stay valid.
const key = (model: string, kind: Kind, q: string, c: Chunk) =>
  createHash("sha1")
    .update(c.context ? `${model}\0${kind}\0${q}\0${c.text}\0${c.context}` : `${model}\0${kind}\0${q}\0${c.text}`)
    .digest("hex");

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
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}
export interface ChunkError { file: string; start: number; end: number; kind: JevErrorKind; message: string }
export interface Result { hits: Hit[]; all: Hit[]; chunks: number; tokens: number; cached: number; errors: ChunkError[]; cost?: number }

/** What one batch worker hands back; runPool results are completion-ordered, so the
 *  batch index rides along and `all` is re-associated after the pool settles. */
interface BatchOutcome { index: number; entries: { chunkIndex: number; p: number }[] }

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
  const todo: number[] = [];
  chunks.forEach((c, i) => {
    const hit = cache[key(model, kind, question, c)];
    if (hit !== undefined) all[i] = { ...c, p: hit }; else todo.push(i);
  });
  const cached = chunks.length - todo.length;
  const batches: number[][] = [];
  for (let i = 0; i < todo.length; i += o.batch) batches.push(todo.slice(i, i + o.batch));
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
  // Run-level success flag (plan §1.5): drives the invalid_api_key expired-vs-wrong-key
  // hint. Tracked HERE (not PoolResult) because failFast throws the pool result away.
  let hadSuccess = false;
  const worker = async (b: number[], index: number): Promise<BatchOutcome> => {
    const res = await postSystemOne(buildRequest(question, b.map((i) => chunks[i]), kind, model), backend, apiKeyOf(), {
      ...post,
      deadlineMs: Date.now() + timeoutMs, // per-batch deadline, retries included (§1.6.1)
    });
    tokens += res.usage?.input_tokens ?? 0;
    if (res.cost !== undefined) cost = (cost ?? 0) + res.cost;
    // Finite p-values go straight into the in-memory cache object: cli.ts persists it in a
    // finally (Step 7), so answers paid for survive even when other batches fail.
    const entries = b.map((ci, j) => {
      const p = res.answers[`c${j}`]?.noul ?? NaN;
      if (Number.isFinite(p)) cache[key(model, kind, question, chunks[ci])] = p;
      return { chunkIndex: ci, p };
    });
    hadSuccess = true; // this batch's request succeeded — set before returning (plan §1.5)
    return { index, entries };
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
  // chunks (ChunkError carries only kind+message; the hint stays on the provider error
  // that pool-level consumers see).
  if (pool.hadSuccess) {
    for (const e of pool.errors) {
      if (e.error.kind === "invalid_api_key") e.error.hint = [e.error.hint, KEY_WORKED_EARLIER_HINT].filter(Boolean).join(" ");
    }
  }
  const errors: ChunkError[] = pool.errors.flatMap((e) =>
    batches[e.index].map((ci) => ({ file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: e.error.kind, message: e.error.message })));
  if (pool.aborted) {
    // Batches that were dispatched all reported (success or their own error); whatever
    // was never attempted is reported as a breaker error. No cache entries, no hits.
    const settled = new Set<number>(pool.results.map((r) => r.index).concat(pool.errors.map((e) => e.index)));
    for (let bi = 0; bi < batches.length; bi++) {
      if (settled.has(bi)) continue;
      for (const ci of batches[bi]) {
        errors.push({ file: chunks[ci].file, start: chunks[ci].start, end: chunks[ci].end, kind: "circuit_breaker_open", message: "not attempted: provider failing consistently (circuit breaker open)" });
      }
    }
  }
  const hits: Hit[] = [];
  const ordered: Hit[] = [];
  for (const h of all) if (h) { ordered.push(h); if (h.p >= o.threshold) hits.push(h); }
  return { hits, all: ordered, chunks: chunks.length, tokens, cached, errors, ...(cost !== undefined ? { cost } : {}) };
}

// ---- config -----------------------------------------------------------------
// Key resolution/verification/storage moved to providers.ts (WI-1): resolveApiKey,
// verifyApiKey and the legacy ~/.config/jgrep/env writer live there now.

/** Copy the bundled SKILL.md into each agent's skills dir that exists. Returns the dirs written. */
export function installSkills(skillSrc: string, home = os.homedir(), agents = ["claude", "codex"]): string[] {
  const out: string[] = [];
  for (const a of agents) {
    const base = path.join(home, `.${a}`);
    if (!fs.existsSync(base)) continue;
    const dir = path.join(base, "skills", "jgrep");
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(skillSrc, path.join(dir, "SKILL.md"));
    out.push(dir);
  }
  return out;
}

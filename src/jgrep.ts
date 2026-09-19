// jgrep core: split files (or git diff hunks) into chunks, ask Jev one yes/no
// question per chunk with many chunks per request, return probabilities.
// No index, no embeddings, no dependencies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const MODEL = "jev-latest";
export const USD_PER_M_INPUT = 0.042;

export interface Chunk { file: string; start: number; end: number; text: string }
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
    if (text !== null) chunks.push(...chunk(file, text));
  }
  return chunks;
}

// ---- Jev --------------------------------------------------------------------
export function buildRequest(question: string, chunks: Chunk[], kind: Kind = "code") {
  const state = { chunks: chunks.map((c, i) => ({ id: `c${i}`, file: c.file, lines: `${c.start}-${c.end}`, [kind]: c.text })) };
  const what = kind === "diff"
    ? "Does that diff hunk (lines starting with + were added, - removed) match this description"
    : "Does that code match this description";
  const questions: Record<string, unknown> = {};
  chunks.forEach((_, i) => {
    questions[`c${i}`] = { type: "noul", instructions: `Look only at the chunk with id "c${i}". ${what}: ${question}` };
  });
  return { model: MODEL, state, questions };
}

export type Fetch = typeof fetch;

/** POST one System One request with retries on 429/5xx. */
export async function postSystemOne(body: unknown, apiKey: string, f: Fetch = fetch): Promise<{ answers: Record<string, any>; usage?: { input_tokens: number } }> {
  const json = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    const res = await f(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: json,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return (await res.json()) as any;
    if ((res.status === 429 || res.status >= 500) && attempt < 3) { await new Promise((r) => setTimeout(r, 500 * 2 ** attempt)); continue; }
    if (res.status === 401) throw new Error("TypeSafe API rejected the key (401). Check TYPESAFE_API_KEY.");
    throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

async function ask(question: string, chunks: Chunk[], kind: Kind, apiKey: string, f: Fetch): Promise<{ ps: number[]; tokens: number }> {
  const json = await postSystemOne(buildRequest(question, chunks, kind), apiKey, f);
  return { ps: chunks.map((_, i) => json.answers[`c${i}`]?.noul ?? NaN), tokens: json.usage?.input_tokens ?? 0 };
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
const key = (q: string, kind: Kind, c: Chunk) => createHash("sha1").update(`${MODEL}\0${kind}\0${q}\0${c.text}`).digest("hex");

// ---- core -------------------------------------------------------------------
export interface Options {
  threshold: number; batch: number; concurrency: number; apiKey: string; kind?: Kind;
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}
export interface Result { hits: Hit[]; all: Hit[]; chunks: number; tokens: number; cached: number }

export async function jgrep(question: string, chunks: Chunk[], o: Options): Promise<Result> {
  const kind = o.kind ?? "code";
  const cache = o.cache ?? {};
  const f = o.fetchImpl ?? fetch;
  const all: Hit[] = new Array(chunks.length);
  const todo: number[] = [];
  chunks.forEach((c, i) => {
    const hit = cache[key(question, kind, c)];
    if (hit !== undefined) all[i] = { ...c, p: hit }; else todo.push(i);
  });
  const cached = chunks.length - todo.length;
  const batches: number[][] = [];
  for (let i = 0; i < todo.length; i += o.batch) batches.push(todo.slice(i, i + o.batch));
  let tokens = 0, done = 0, next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const { ps, tokens: t } = await ask(question, b.map((i) => chunks[i]), kind, o.apiKey, f);
      tokens += t;
      b.forEach((ci, j) => {
        all[ci] = { ...chunks[ci], p: ps[j] };
        if (Number.isFinite(ps[j])) cache[key(question, kind, chunks[ci])] = ps[j];
      });
      o.onProgress?.(++done, batches.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, batches.length) }, worker));
  const hits = all.filter((h) => h.p >= o.threshold);
  return { hits, all, chunks: chunks.length, tokens, cached };
}

// ---- config -----------------------------------------------------------------
export const CONFIG_FILE = path.join(os.homedir(), ".config", "jgrep", "env");

export function resolveApiKey(env = process.env): string {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim();
  for (const file of [path.join(process.cwd(), ".env"), CONFIG_FILE]) {
    try {
      const m = fs.readFileSync(file, "utf8").match(/^\s*(?:export\s+)?TYPESAFE_API_KEY\s*=\s*["']?([^"'\r\n#]+)/m);
      if (m) return m[1].trim();
    } catch { /* next */ }
  }
  throw new Error("No TypeSafe API key. Run `jgrep init` (or export TYPESAFE_API_KEY).");
}

/** Cheapest possible request; true when the key is accepted. */
export async function verifyApiKey(apiKey: string, f: typeof fetch = fetch): Promise<{ ok: boolean; status: number; model?: string }> {
  const res = await f(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, state: "ping", questions: { ok: { type: "noul", instructions: "Is the state the word ping?" } } }),
    signal: AbortSignal.timeout(15_000),
  });
  const model = res.ok ? ((await res.json()) as { model?: string }).model : undefined;
  return { ok: res.ok, status: res.status, model };
}

export function saveApiKey(apiKey: string): string {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `TYPESAFE_API_KEY=${apiKey}\n`, { mode: 0o600 });
  return CONFIG_FILE;
}

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

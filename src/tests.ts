// jgrep --tests: predictive test selection. Given a diff, ask Jev one Noul per
// test file ("would this change plausibly affect this test?") and print the
// tests worth running first. Tests that map to a changed file by name are
// selected in code without asking.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { MODEL, postSystemOne, listFiles, type Cache, type Fetch } from "./jgrep";

export interface TestFile { file: string; signature: string }
export interface Selected { file: string; p: number; reason: "direct" | "import" | "jev" | "cached" }

// ponytail: patterns cover js/ts, python, go, ruby, rust, java, elixir; add flags when a stack is missing.
export const TEST_FILE_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|(\.|_)(test|spec)\.[cm]?[jt]sx?$|(^|\/)test_[^/]*\.py$|_test\.(py|go|rb|exs)$|_spec\.rb$|(^|\/)[^/]*Tests?\.(java|kt|swift|cs)$|(^|\/)tests\.rs$/;

export function findTestFiles(files: string[]): string[] {
  return files.filter((f) => TEST_FILE_RE.test(f));
}

/** Imports plus test/describe names: enough for Jev to know what the file exercises, ~5% of its tokens. */
export function signature(file: string, text = fs.readFileSync(file, "utf8")): string {
  const keep = /^\s*(import |from .+ import |const .+ = require\(|require\(|use |using |package |describe\(|it\(|test\(|it\.each|test\.each|def test_|async def test_|func Test|fn test_|#\[test\]|@Test|class .*Test|context\(|scenario\(|feature\()/;
  const lines = text.split("\n").filter((l) => keep.test(l)).map((l) => l.trim().slice(0, 160));
  return lines.slice(0, 60).join("\n");
}

const stem = (f: string) => path.basename(f).replace(/\.(test|spec)\.[cm]?[jt]sx?$|_(test|spec)\.(py|go|rb|exs)$|^test_|\.[^.]+$/g, "").toLowerCase();

/** Tests whose name mirrors a changed source file (foo.ts -> foo.test.ts, foo.py -> test_foo.py). */
export function directMatches(changedFiles: string[], tests: string[]): Set<string> {
  const changedStems = new Set(changedFiles.filter((f) => !TEST_FILE_RE.test(f)).map(stem));
  const changedTests = new Set(changedFiles.filter((f) => TEST_FILE_RE.test(f)));
  return new Set(tests.filter((t) => changedTests.has(t) || changedStems.has(stem(t))));
}

export function changedFilesOf(diff: string): string[] {
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]);
}

const NOISE_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|Cargo\.lock|go\.sum|poetry\.lock|Gemfile\.lock)$|\.(md|mdx|txt|svg|png|jpe?g|gif|ico|lock|snap)$|(^|\/)(dist|build|node_modules|vendor)\//;

/** Keep only what Jev needs from a diff: source files only, changed lines only, a per-file cap so one
 *  large file cannot starve the others, and the full changed-file list up front. */
export function compactDiff(diff: string, maxChars = 8000, perFile = 2000): string {
  const files: { name: string; lines: string[] }[] = [];
  let cur: { name: string; lines: string[] } | null = null;
  for (const l of diff.split("\n")) {
    const m = /^\+\+\+ b\/(.+)$/.exec(l);
    if (m) { cur = NOISE_RE.test(m[1]) ? null : { name: m[1], lines: [] }; if (cur) files.push(cur); continue; }
    if (cur && /^(@@ |[+-][^+-])/.test(l)) cur.lines.push(l);
  }
  const header = "changed files:\n" + files.map((f) => "  " + f.name).join("\n") + "\n\n";
  const budget = Math.max(1000, maxChars - header.length);
  const per = Math.min(perFile, Math.floor(budget / Math.max(1, files.length)));
  let body = "";
  for (const f of files) {
    let chunk = `+++ ${f.name}\n` + f.lines.join("\n");
    if (chunk.length > per) chunk = chunk.slice(0, per) + "\n... (truncated)";
    body += chunk + "\n";
  }
  return (header + body).trim();
}

/** Tests whose import lines reference a changed source file (by path segment or stem): selected in code, no Jev. */
export function importMatches(changedFiles: string[], tests: TestFile[]): Set<string> {
  const changedStems = new Set(changedFiles.filter((f) => !TEST_FILE_RE.test(f) && !NOISE_RE.test(f)).map(stem));
  const out = new Set<string>();
  for (const t of tests) {
    for (const m of t.signature.matchAll(/(?:from|require\(|import)\s*["']([^"']+)["']/g)) {
      const target = m[1];
      if (target.startsWith(".") || target.startsWith("/") || target.includes("/src/")) {
        const base = target.split("/").pop()?.replace(/\.(js|ts|mjs|cjs|jsx|tsx|py|go|rb|rs)$/, "") ?? "";
        if (base && changedStems.has(base.toLowerCase())) { out.add(t.file); break; }
      }
    }
  }
  return out;
}

export interface SelectOptions {
  threshold: number; batch: number; concurrency: number; apiKey: string;
  fetchImpl?: Fetch; cache?: Cache; onProgress?: (done: number, total: number) => void;
}

export async function selectTests(diff: string, tests: TestFile[], o: SelectOptions): Promise<{ selected: Selected[]; all: Selected[]; tokens: number; requests: number; cached: number }> {
  const f = o.fetchImpl ?? fetch;
  const cache = o.cache ?? {};
  const compact = compactDiff(diff);
  const changed = changedFilesOf(diff);
  const direct = directMatches(changed, tests.map((t) => t.file));
  const viaImport = importMatches(changed, tests);
  const diffHash = createHash("sha1").update(compact).digest("hex");
  const key = (t: TestFile) => createHash("sha1").update(`${MODEL}\0tests\0${diffHash}\0${t.file}\0${t.signature}`).digest("hex");

  const all: Selected[] = new Array(tests.length);
  const todo: number[] = [];
  tests.forEach((t, i) => {
    if (direct.has(t.file)) all[i] = { file: t.file, p: 1, reason: "direct" };
    else if (viaImport.has(t.file)) all[i] = { file: t.file, p: 1, reason: "import" };
    else if (typeof cache[key(t)] === "number") all[i] = { file: t.file, p: cache[key(t)], reason: "cached" };
    else todo.push(i);
  });
  const batches: number[][] = [];
  for (let i = 0; i < todo.length; i += o.batch) batches.push(todo.slice(i, i + o.batch));
  let tokens = 0, done = 0, next = 0;
  const worker = async () => {
    while (next < batches.length) {
      const b = batches[next++];
      const state = { diff: compact, tests: b.map((i, j) => ({ id: `t${j}`, file: tests[i].file, signature: tests[i].signature })) };
      const questions: Record<string, unknown> = {};
      b.forEach((_, j) => {
        questions[`t${j}`] = { type: "noul", instructions: `Look only at the test file with id "t${j}". Given the diff, is this test plausibly affected by the change: it imports or exercises a changed module or function, or asserts behaviour the diff alters? Unrelated tests should be no.` };
      });
      const res = await postSystemOne({ model: MODEL, state, questions }, o.apiKey, f);
      tokens += res.usage?.input_tokens ?? 0;
      b.forEach((i, j) => {
        const p = res.answers[`t${j}`]?.noul;
        all[i] = { file: tests[i].file, p: typeof p === "number" ? p : NaN, reason: "jev" };
        if (typeof p === "number") cache[key(tests[i])] = p;
      });
      o.onProgress?.(++done, batches.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency, batches.length) }, worker));
  const selected = all.filter((s) => s.p >= o.threshold).sort((a, b) => b.p - a.p);
  const byCode = all.filter((s) => s.reason === "direct" || s.reason === "import").length;
  return { selected, all, tokens, requests: batches.length, cached: tests.length - byCode - todo.length };
}

export function loadTests(paths: string[] = ["."]): TestFile[] {
  return findTestFiles(listFiles(paths)).map((file) => ({ file, signature: signature(file) }));
}

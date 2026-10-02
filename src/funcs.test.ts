// --funcs (WI-5) tests: regex signature extraction per language (funcs.ts) and the
// two-phase jgrepFuncs flow (jgrep.ts). The two-phase integration runs against real
// temp files with the repo's fake-fetch DI pattern (explicit apiKey, so the lazy key
// resolver never touches the filesystem); the fetch captures every request body so
// the tests can assert WHICH files were signature-judged in pass 1 and which files'
// chunks were searched in pass 2 — the cost property ("1 request per ~16 signature
// files") is asserted on the captured call list.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import {
  detectLanguage, extractSignatures, signatureChunk,
  MAX_SIGNATURES, SIGNATURE_CHUNK_MAX_CHARS, type Signature,
} from "./funcs";
import type { Fetch } from "./providers";
import { jgrepFuncs } from "./jgrep";

// ---- detectLanguage: the extension map ----------------------------------------

test("detectLanguage: every supported extension maps to its language", () => {
  const cases: [string, string][] = [
    ["a.ts", "typescript"], ["a.tsx", "typescript"],
    ["a.js", "javascript"], ["a.jsx", "javascript"], ["a.mjs", "javascript"], ["a.cjs", "javascript"],
    ["a.py", "python"], ["a.go", "go"], ["a.rs", "rust"], ["a.java", "java"], ["a.kt", "kotlin"],
    ["a.swift", "swift"], ["a.rb", "ruby"], ["a.php", "php"], ["a.cs", "csharp"],
    ["a.c", "c"], ["a.h", "c"], ["a.cpp", "cpp"], ["a.cc", "cpp"], ["a.hpp", "cpp"],
    ["a.sh", "bash"], ["a.bash", "bash"],
    ["/deep/nested/dir/a.TS", "typescript"], // case-insensitive extension
  ];
  for (const [file, lang] of cases) expect(detectLanguage(file)).toBe(lang);
});

test("detectLanguage: unsupported and extension-less files are null (skipped in --funcs mode)", () => {
  for (const file of ["a.md", "a.markdown", "a.json", "a.yaml", "a.csv", "a.txt", "Makefile", ".gitignore", "noext"])
    expect(detectLanguage(file)).toBeNull();
});

// ---- extractSignatures: per-language fixtures (embedded, real-shaped) ----------

const TS_FIXTURE = `import { readText } from "./io";

export function retryWithBackoff(op: () => Promise<void>, tries: number): Promise<void> {
  return op();
}

function helper() {
  return 1;
}

const viaArrow = async (n: number) => n * 2;

const typed: Handler = (req) => req.ok;

export class BackoffStore {
  private n = 0;
}
`;

test("extractSignatures: typescript — function, arrow-const, typed arrow-const and class, 1-based lines", () => {
  const sigs = extractSignatures(TS_FIXTURE, "typescript");
  expect(sigs.map((s) => s.line)).toEqual([3, 7, 11, 13, 15]);
  expect(sigs[0].text).toBe("export function retryWithBackoff(op: () => Promise<void>, tries: number): Promise<void> {");
  expect(sigs[1].text).toBe("function helper() {");
  expect(sigs[2].text).toBe("const viaArrow = async (n: number) => n * 2;");
  expect(sigs[3].text).toBe("const typed: Handler = (req) => req.ok;");
  expect(sigs[4].text).toBe("export class BackoffStore {");
  // javascript shares the typescript patterns
  expect(extractSignatures(TS_FIXTURE, "javascript").map((s) => s.line)).toEqual([3, 7, 11, 13, 15]);
});

const GO_FIXTURE = `package retry

import "time"

// Retry runs op until it succeeds.
func Retry(op func() error, tries int) error {
	return backoff(op, tries)
}

func (s *Store) Get(key string) (string, bool) {
	return "", false
}
`;

test("extractSignatures: go — top-level funcs and receiver methods", () => {
  const sigs = extractSignatures(GO_FIXTURE, "go");
  expect(sigs.map((s) => s.line)).toEqual([6, 10]);
  expect(sigs[0].text).toBe("func Retry(op func() error, tries int) error {");
  expect(sigs[1].text).toBe("func (s *Store) Get(key string) (string, bool) {");
});

const PY_FIXTURE = `import time

class Backoff:
    def __init__(self, base=1.0):
        self.base = base

    async def wait(self, attempt: int) -> float:
        return self.base * (2 ** attempt)

def retry(op, tries=3):
    return _retry(op, tries)
`;

test("extractSignatures: python — class, methods (indented) and async defs", () => {
  const sigs = extractSignatures(PY_FIXTURE, "python");
  expect(sigs.map((s) => s.line)).toEqual([3, 4, 7, 10]);
  expect(sigs[2].text).toBe("async def wait(self, attempt: int) -> float:");
  expect(sigs[3].text).toBe("def retry(op, tries=3):");
});

test("extractSignatures: rust — fn, pub fn, pub(crate) async fn", () => {
  const rs = `struct Backoff;

impl Backoff {
    pub fn wait(&self, attempt: u32) -> u64 {
        attempt as u64
    }
}

pub(crate) async fn retry<F>(op: F) {
    todo!()
}
`;
  expect(extractSignatures(rs, "rust").map((s) => s.line)).toEqual([4, 9]);
});

test("extractSignatures: java — visibility+name+( methods and class; plain fields are NOT signatures", () => {
  const java = `package app;

public class Retrier {
    public static <T> T retry(Callable<T> op, int tries) throws Exception {
        return null;
    }

    private int attempts;
}
`;
  const sigs = extractSignatures(java, "java");
  expect(sigs.map((s) => s.line)).toEqual([3, 4]);
  expect(sigs[1].text).toContain("public static <T> T retry(");
  // csharp shares the java patterns
  expect(extractSignatures(java, "csharp").map((s) => s.line)).toEqual([3, 4]);
});

test("extractSignatures: ruby — def, def self.x and class", () => {
  const rb = `class Fetcher
  def initialize(base)
    @base = base
  end

  def self.retry(op, tries = 3)
    op.call
  end
end
`;
  expect(extractSignatures(rb, "ruby").map((s) => s.line)).toEqual([1, 2, 6]);
});

test("extractSignatures: bash — `function x()` and `x() {` forms", () => {
  const sh = `#!/usr/bin/env bash
set -euo pipefail

function cleanup() {
  rm -rf "$TMP"
}

retry() {
  for i in 1 2 3; do "$@" && return 0; done
  return 1
}
`;
  expect(extractSignatures(sh, "bash").map((s) => s.line)).toEqual([4, 8]);
});

test("extractSignatures: c — definitions kept, `;`-terminated prototypes dropped", () => {
  const c = `#include <stdio.h>

static int backoff_ms(int attempt) {
    return attempt * 100;
}

int forward_decl(int x);
`;
  expect(extractSignatures(c, "c").map((s) => s.line)).toEqual([3]);
});

test("extractSignatures: cpp — namespace-qualified definitions", () => {
  const cpp = `#include <string>

std::string Store::get(const std::string& key) const {
    return key;
}
`;
  expect(extractSignatures(cpp, "cpp").map((s) => s.line)).toEqual([3]);
});

test("extractSignatures: unknown language extracts nothing; prose-only files extract nothing", () => {
  expect(extractSignatures(TS_FIXTURE, "cobol")).toEqual([]);
  expect(extractSignatures("just prose\nno code here\n", "typescript")).toEqual([]);
});

test("extractSignatures: capped at MAX_SIGNATURES with a [truncated: N more] marker (line 0)", () => {
  const py = Array.from({ length: 250 }, (_, i) => `def f${i}():`).join("\n");
  const sigs = extractSignatures(py, "python");
  expect(sigs).toHaveLength(MAX_SIGNATURES + 1); // 200 real + 1 marker
  expect(sigs[MAX_SIGNATURES - 1]).toEqual({ line: 200, text: "def f199():" });
  const marker: Signature = sigs[MAX_SIGNATURES];
  expect(marker.line).toBe(0);
  expect(marker.text).toBe("[truncated: 50 more signatures]");
});

// ---- signatureChunk: the pass-1 chunk ------------------------------------------

test("signatureChunk: one chunk per file, L-prefixed lines, start/end span the signatures", () => {
  const sc = signatureChunk("src/retry.go", GO_FIXTURE, "go");
  expect(sc).not.toBeNull();
  expect(sc!.file).toBe("src/retry.go");
  expect(sc!.start).toBe(6);
  expect(sc!.end).toBe(10);
  expect(sc!.text).toBe("L6: func Retry(op func() error, tries int) error {\nL10: func (s *Store) Get(key string) (string, bool) {");
});

test("signatureChunk: a truncation marker renders bare (no L prefix), start/end stay real lines", () => {
  const py = Array.from({ length: 250 }, (_, i) => `def f${i}():`).join("\n");
  const sc = signatureChunk("big.py", py, "python")!;
  expect(sc.start).toBe(1);
  expect(sc.end).toBe(200);
  expect(sc.text.split("\n")).toHaveLength(MAX_SIGNATURES + 1);
  expect(sc.text.endsWith("[truncated: 50 more signatures]")).toBe(true);
  expect(sc.text).not.toContain("L0:");
});

test("signatureChunk: bodies over SIGNATURE_CHUNK_MAX_CHARS are cut at a line boundary with a note", () => {
  const long = Array.from({ length: 120 }, (_, i) => `export function fn${i}(${"a".repeat(90)}: string) {`).join("\n");
  const sc = signatureChunk("wide.ts", long, "typescript")!;
  expect(long.length).toBeGreaterThan(SIGNATURE_CHUNK_MAX_CHARS);
  expect(sc.text.length).toBeLessThanOrEqual(SIGNATURE_CHUNK_MAX_CHARS + "[note: signature chunk truncated at 8000 chars]".length + 1);
  expect(sc.text.endsWith("[note: signature chunk truncated at 8000 chars]")).toBe(true);
  expect(sc.start).toBe(1);
  expect(sc.end).toBeGreaterThan(1); // end reflects the LAST INCLUDED signature, not the file
  // every shown line is intact (no mid-line cut)
  for (const l of sc.text.split("\n")) expect(l === "" || l.startsWith("L") || l.startsWith("[note:")).toBe(true);
});

test("signatureChunk: a file with no extractable signatures gets no chunk (skipped in pass 1)", () => {
  expect(signatureChunk("imports.ts", `import a from "a";\nimport b from "b";\n`, "typescript")).toBeNull();
});

// ---- jgrepFuncs: the two-phase flow (fake fetch, real temp files) ----------------

interface Call { state: { chunks: { id: string; file: string; code: string }[] } }

/** Fake Jev: signature chunks (L-prefixed) match "retryWithBackoff"; code chunks of
 *  the retry implementation match "backoff". Captures every parsed request body. */
const funcsFetch = () => {
  const calls: Call[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body: Call = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) {
      const isSig = /(^|\n)L\d+:/.test(c.code);
      const hit = isSig ? c.code.includes("retryWithBackoff") : c.code.includes("backoff");
      answers[c.id] = { type: "noul", noul: hit ? 0.95 : 0.05 };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 50 } }), { status: 200 });
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};

const writeTree = (dir: string) => {
  fs.writeFileSync(path.join(dir, "retry.ts"),
    `export function retryWithBackoff(op: () => Promise<void>, tries: number) {\n  // sleeps with exponential backoff between attempts\n  return attempt(op, tries);\n}\n\nfunction attempt(op: () => Promise<void>, tries: number) {\n  if (tries === 0) throw new Error("exhausted");\n  return op().catch(() => attempt(op, tries - 1));\n}\n`);
  fs.writeFileSync(path.join(dir, "parse.ts"),
    `export function parseCSV(text: string) {\n  return text.split("\\n");\n}\n`);
  fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n\nplain prose, never searched by --funcs\n");
  fs.writeFileSync(path.join(dir, "data.csv"), "col\nrow\n"); // unsupported extension
};

const opts = (fetchImpl: Fetch) => ({
  threshold: 0.7, batch: 16, concurrency: 4, apiKey: "k", fetchImpl, cache: {} as Record<string, number>,
});

test("jgrepFuncs: two-phase — pass 1 shortlists exactly the signature match; pass 2 searches ONLY its chunks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-funcs-"));
  try {
    writeTree(dir);
    const { calls, fetchImpl } = funcsFetch();
    const files = ["retry.ts", "parse.ts", "notes.md", "data.csv"].map((f) => path.join(dir, f));
    const r = await jgrepFuncs("retries a failing operation with backoff", files, opts(fetchImpl));

    // Pass 1: ONE request; only the two SUPPORTED files are in it (notes.md and
    // data.csv have no language → excluded from --funcs search, documented), and
    // every chunk is a signature chunk. listFiles sorts, so parse.ts leads.
    expect(calls.length).toBe(2); // 1 signature request + 1 pass-2 request
    const sigReq = calls[0];
    expect(sigReq.state.chunks.map((c) => c.file)).toEqual([path.join(dir, "parse.ts"), path.join(dir, "retry.ts")]);
    for (const c of sigReq.state.chunks) expect(c.code).toMatch(/(^|\n)L\d+:/);

    // Pass 2: the shortlist is exactly retry.ts — its real chunks, nobody else's.
    const p2 = calls[1];
    expect(p2.state.chunks.length).toBeGreaterThan(0);
    for (const c of p2.state.chunks) expect(c.file).toBe(path.join(dir, "retry.ts"));
    expect(p2.state.chunks.some((c) => c.code.includes("backoff"))).toBe(true);
    for (const f of ["parse.ts", "notes.md", "data.csv"])
      expect(p2.state.chunks.some((c) => c.file === path.join(dir, f))).toBe(false);

    // Result shape unchanged: hits are pass-2 real-code hits (file:line of the code).
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].file).toBe(path.join(dir, "retry.ts"));
    expect(r.hits[0].start).toBe(1);
    expect(r.hits[0].text).toContain("retryWithBackoff");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jgrepFuncs: cost property — a 3-file set is ONE signature request (batched) + the shortlist's chunk requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-funcscost-"));
  try {
    // three supported files, distinct signatures; only a.ts's matches the description
    fs.writeFileSync(path.join(dir, "a.ts"), `export function retryWithBackoff(op: () => Promise<void>) {\n  // exponential backoff\n  return op();\n}\n`);
    fs.writeFileSync(path.join(dir, "b.ts"), `export function parseCSV(text: string) {\n  return text.split("\\n");\n}\n`);
    fs.writeFileSync(path.join(dir, "c.go"), `package x\n\nfunc RenderHTML(w io.Writer) error {\n\treturn nil\n}\n`);
    const { calls, fetchImpl } = funcsFetch();
    const r = await jgrepFuncs("retries a failing operation with backoff", ["a.ts", "b.ts", "c.go"].map((f) => path.join(dir, f)), opts(fetchImpl));

    // 16-chunk batching: all 3 signature chunks travel in ONE request
    expect(calls[0].state.chunks).toHaveLength(3);
    expect(calls[0].state.chunks.map((c) => c.file)).toEqual([path.join(dir, "a.ts"), path.join(dir, "b.ts"), path.join(dir, "c.go")]);
    // total = 1 signature request + 1 shortlisted (a.ts) chunk request
    expect(calls).toHaveLength(2);
    expect(calls[1].state.chunks.every((c) => c.file === path.join(dir, "a.ts"))).toBe(true);
    expect(r.hits.map((h) => h.file)).toEqual([path.join(dir, "a.ts")]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jgrepFuncs: nothing shortlisted → no pass-2 request, pass-1 Result with 0 hits", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-funcs0-"));
  try {
    writeTree(dir);
    const calls: Call[] = [];
    const fetchImpl = (async (_url: unknown, init: { body: string }) => {
      const body: Call = JSON.parse(init.body);
      calls.push(body);
      const answers: Record<string, unknown> = {};
      for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: 0.01 };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 50 } }), { status: 200 });
    }) as unknown as Fetch;
    const r = await jgrepFuncs("something no signature mentions", ["retry.ts", "parse.ts"].map((f) => path.join(dir, f)), opts(fetchImpl));
    expect(calls).toHaveLength(1); // signature pass only — nothing else was searched
    expect(r.hits).toEqual([]);
    expect(r.chunks).toBe(2); // the two signature chunks were the whole cost
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("jgrepFuncs: signature pass batches 16 files per request — 20 files = 2 signature requests + pass 2", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-funcsbatch-"));
  try {
    const names = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    for (const name of names)
      fs.writeFileSync(path.join(dir, name),
        name === "f0.ts"
          ? `export function retryWithBackoff(op: () => Promise<void>) {\n  // exponential backoff\n  return op();\n}\n`
          : `export function fn${name}() {\n  return 1;\n}\n`);
    const { calls, fetchImpl } = funcsFetch();
    const r = await jgrepFuncs("retries a failing operation with backoff", names.map((n) => path.join(dir, n)), opts(fetchImpl));
    // 20 signature chunks at the default batch of 16: two signature requests…
    expect(calls[0].state.chunks).toHaveLength(16);
    expect(calls[1].state.chunks).toHaveLength(4);
    for (const c of [...calls[0].state.chunks, ...calls[1].state.chunks]) expect(c.code).toMatch(/(^|\n)L\d+:/);
    // …then exactly one pass-2 request, for the single shortlisted file
    expect(calls).toHaveLength(3);
    expect(calls[2].state.chunks.every((c) => c.file === path.join(dir, "f0.ts"))).toBe(true);
    expect(r.hits.map((h) => h.file)).toEqual([path.join(dir, "f0.ts")]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

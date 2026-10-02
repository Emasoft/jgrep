// Context fit — USER 2026-10-02: "content must never be truncated to fit Jev's context;
// oversized content is split into context-sized chunks instead." Every line of the input
// must reach the provider, and no request may exceed the context budget.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import type { Fetch } from "./providers";
import { chunkPaths, diffChunks, jgrep, MAX_CHUNK_BYTES, MAX_REQUEST_BYTES, type Chunk } from "./jgrep";
import { scoreRows } from "./rows";
import { compactDiff, selectTests } from "./tests";

const bytes = (s: string) => new TextEncoder().encode(s).length;

/** Answers every question (noul 0.9, choice t0) and records each request body. */
const recorder = () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    bodies.push(init.body);
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      const q = body.questions[id];
      answers[id] = q.type === "choice" ? { type: "choice", choice: "t0", probabilities: { t0: 0.9, t1: 0.1 } } : { type: "noul", noul: 0.9 };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 } }), { status: 200 });
  }) as unknown as Fetch;
  return { bodies, fetchImpl };
};
/** Every chunk/diff text the provider saw, across all requests. */
const sentTexts = (bodies: string[], field = "code") =>
  bodies.flatMap((b) => (JSON.parse(b).state.chunks ?? []).map((c: Record<string, string>) => c[field]));
const opts = (fetchImpl: Fetch, extra: object = {}) => ({ threshold: 0.7, batch: 16, concurrency: 4, apiKey: "k", fetchImpl, cache: {}, ...extra });

test("a 5000-line function handed over as ONE chunk is split; every line reaches the provider; no request over budget", async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `  total += step(${i}); // line ${i}`);
  const c: Chunk = { file: "big.ts", start: 1, end: 5000, text: lines.join("\n") };
  const { bodies, fetchImpl } = recorder();
  const r = await jgrep("q", [c], opts(fetchImpl));
  const sent = sentTexts(bodies).join("\n");
  for (const l of lines) expect(sent.includes(l)).toBe(true); // before: one ~170 KB chunk, far over the context
  for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  for (const t of sentTexts(bodies)) expect(bytes(t)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
  expect(r.chunks).toBeGreaterThan(1);
  expect(Math.min(...r.all.map((h) => h.start))).toBe(1);
  expect(Math.max(...r.all.map((h) => h.end))).toBe(5000); // piece ranges map back onto the file
});

test("a huge fenced block in Markdown (kept whole by the chunker) is split before sending; nothing is lost", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-fence-"));
  try {
    const body = Array.from({ length: 5000 }, (_, i) => `echo step-${i}`);
    fs.writeFileSync(path.join(dir, "doc.md"), ["# Guide", "", "```sh", ...body, "```", ""].join("\n"));
    const chunks = chunkPaths([dir]);
    const { bodies, fetchImpl } = recorder();
    await jgrep("q", chunks, opts(fetchImpl));
    const sent = sentTexts(bodies).join("\n");
    for (const l of body) expect(sent.includes(l)).toBe(true);
    for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
    expect(bodies.every((b) => JSON.parse(b).state.chunks.every((c: { id: string }) => c.id)));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("one giant line (minified code) is split by characters with overlap; the pieces rebuild the whole line", async () => {
  const line = Array.from({ length: 20_000 }, (_, i) => `f${i}()`).join(";"); // ~150 KB, no newline
  const { bodies, fetchImpl } = recorder();
  await jgrep("q", [{ file: "min.js", start: 7, end: 7, text: line }], opts(fetchImpl));
  const pieces = sentTexts(bodies);
  expect(pieces.length).toBeGreaterThan(1);
  for (const p of pieces) expect(bytes(p)).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
  // overlapping pieces cover the line end to end, in order
  let pos = 0;
  for (const p of pieces) { const at = line.indexOf(p, Math.max(0, pos - p.length)); expect(at).toBeGreaterThanOrEqual(0); expect(at).toBeLessThanOrEqual(pos); pos = at + p.length; }
  expect(pos).toBe(line.length);
});

test("a huge diff hunk is split with new-side line ranges that skip removed lines", async () => {
  const added = Array.from({ length: 3000 }, (_, i) => `+const added${i} = ${i}; // padding to make it big`);
  const diff = `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -10,2 +10,3001 @@\n-removed line\n context\n${added.join("\n")}\n`;
  const [hunk] = diffChunks(diff);
  const { bodies, fetchImpl } = recorder();
  const r = await jgrep("q", [hunk], { ...opts(fetchImpl), kind: "diff" as const });
  for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(MAX_REQUEST_BYTES); // before: one ~170 KB request
  const sent = sentTexts(bodies, "diff").join("\n");
  for (const l of added) expect(sent.includes(l)).toBe(true);
  expect(Math.min(...r.all.map((h) => h.start))).toBe(10);
  expect(Math.max(...r.all.map((h) => h.end))).toBe(10 + 3000); // 1 context + 3000 added lines on the new side
});

test("--verify and --tag batches are packed under the request budget too", async () => {
  const chunks: Chunk[] = Array.from({ length: 16 }, (_, i) => ({ file: `f${i}.ts`, start: 1, end: 100, text: Array.from({ length: 100 }, (_, j) => `x${i}_${j} = compute(${j}); // padding padding`).join("\n") }));
  const { bodies, fetchImpl } = recorder();
  const r = await jgrep("q", chunks, opts(fetchImpl, { verify: true, tag: "bug,style" }));
  expect(r.hits).toHaveLength(16);
  for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(MAX_REQUEST_BYTES); // before: 16 x ~5 KB in one verify/tag request
  expect(r.hits.every((h) => h.tag === "bug")).toBe(true);
});

test("--rows: a pack whose rows exceed the budget is split into smaller packs; every row is answered", async () => {
  const rows = Array.from({ length: 16 }, (_, i) => ({ id: String(i), bio: `creator ${i} `.repeat(400) })); // ~5 KB per row
  const { bodies, fetchImpl } = recorder();
  const r = await scoreRows(rows, { match: { type: "noul", instructions: "beauty" } }, { batch: 16, concurrency: 2, apiKey: "k", fetchImpl, cache: {} });
  expect(bodies.length).toBeGreaterThan(1); // before: all 16 rows in one ~80 KB request
  for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  expect(r.answers.every((a) => a !== null)).toBe(true);
  expect(r.errors).toEqual([]);
});

test("--rows: ONE row over the context is judged in parts; noul = best part, choice = the best non-default label", async () => {
  const bio = Array.from({ length: 3000 }, (_, i) => `post ${i}: travel diary entry`).join("\n") + "\nfinal post: BEAUTY tutorial";
  const rows = [{ name: "big", bio }];
  const bodies: string[] = [];
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    bodies.push(init.body);
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const [id] of Object.entries(body.questions)) {
      const r = body.state.rows[Number(/^r(\d+)\./.exec(id)![1])];
      const hit = r.bio.includes("BEAUTY");
      answers[id] = id.endsWith(".match") ? { type: "noul", noul: hit ? 0.95 : 0.1 }
        : { type: "choice", choice: hit ? "beauty" : "travel", probabilities: hit ? { beauty: 0.9, travel: 0.1 } : { beauty: 0.3, travel: 0.6 } };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 } }), { status: 200 });
  }) as unknown as Fetch;
  const q = { match: { type: "noul" as const, instructions: "beauty content" }, topic: { type: "choice" as const, instructions: "main topic", criteria: { beauty: "beauty", travel: "travel" } } };
  const r = await scoreRows(rows, q, { batch: 16, concurrency: 1, apiKey: "k", fetchImpl, cache: {} });
  expect(bodies.length).toBeGreaterThan(1); // before: one ~100 KB request
  for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  const sent = bodies.map((b) => JSON.parse(b).state.rows.map((x: { bio: string }) => x.bio).join("\n")).join("\n");
  for (const l of bio.split("\n")) expect(sent.includes(l)).toBe(true); // nothing truncated
  expect(r.answers[0]!.match.noul).toBe(0.95);   // best part, not the first and not an average
  expect(r.answers[0]!.topic.choice).toBe("beauty"); // travel is the default (last criterion): the beauty part is the only vote
});

test("combineParts choice (USER: \"Best real evidence wins\"): one relevant part beats many confident default parts", async () => {
  const { combineParts } = await import("./rows");
  const qs = { q: { type: "choice" as const, instructions: "kind", criteria: { bug: "a real bug", filler: "nothing relevant" } } }; // default = last = filler
  const filler = { q: { type: "choice", choice: "filler", probabilities: { bug: 0.01, filler: 0.99 }, confidence: 0.99 } };
  const parts = [filler, filler, { q: { type: "choice", choice: "bug", probabilities: { bug: 0.6, filler: 0.4 } } }, filler];
  expect(combineParts(parts, qs).q).toEqual({ type: "choice", choice: "bug", probabilities: { bug: 0.6, filler: 0.4 } });
  // among voting parts the highest top label wins, reported with its part
  const votes = [{ q: { type: "choice", choice: "bug", probabilities: { bug: 0.7, style: 0.2, filler: 0.1 } } }, { q: { type: "choice", choice: "style", probabilities: { bug: 0.1, style: 0.8, filler: 0.1 } } }];
  const q3 = { q: { type: "choice" as const, instructions: "kind", criteria: { bug: "b", style: "s", filler: "f" } } };
  expect(combineParts(votes, q3).q.choice).toBe("style");
});

test("combineParts choice: when no part votes, the row gets the default label at its best score", async () => {
  const { combineParts } = await import("./rows");
  const qs = { q: { type: "choice" as const, instructions: "kind", criteria: { bug: "b", filler: "f" } } };
  const parts = [
    { q: { type: "choice", choice: "filler", probabilities: { bug: 0.3, filler: 0.7 } } },
    { q: { type: "choice", choice: "filler", probabilities: { bug: 0.1, filler: 0.9 } } },
  ];
  expect(combineParts(parts, qs).q).toEqual({ type: "choice", choice: "filler", probabilities: { bug: 0.1, filler: 0.9 } });
  // --default names another catch-all: now "bug" parts are the non-voting ones
  const flipped = [
    { q: { type: "choice", choice: "bug", probabilities: { bug: 0.95, filler: 0.05 } } },
    { q: { type: "choice", choice: "filler", probabilities: { bug: 0.45, filler: 0.55 } } },
  ];
  expect(combineParts(flipped, qs, "bug").q.choice).toBe("filler");
  expect(combineParts(flipped, qs).q.choice).toBe("bug");
  // single part unchanged; noul and score stay the max over the parts
  expect(combineParts([flipped[1]], qs, "filler")).toBe(flipped[1]);
  expect(combineParts([{ a: { type: "noul", noul: 0.2 } }, { a: { type: "noul", noul: 0.7 } }]).a.noul).toBe(0.7);
  expect(combineParts([{ s: { type: "score", score: 0.9 } }, { s: { type: "score", score: 0.4 } }]).s.score).toBe(0.9);
});

test("--tests: a big diff is never truncated — it is split into parts, and a test's p is its best part", async () => {
  const fileA = Array.from({ length: 2000 }, (_, i) => `+export const a${i} = ${i}; // filler line`).join("\n");
  const diff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2000 @@\n${fileA}\ndiff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n+export const NEEDLE = 1;\n`;
  expect(compactDiff(diff)).not.toContain("(truncated)"); // before: capped at 8000 chars / 2000 per file
  const bodies: string[] = [];
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    bodies.push(init.body);
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const t of body.state.tests) answers[t.id] = { type: "noul", noul: body.state.diff.includes("NEEDLE") ? 0.9 : 0.1 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 } }), { status: 200 });
  }) as unknown as Fetch;
  const tests = [{ file: "spec/x.test.ts", signature: 'describe("x")' }];
  const r = await selectTests(diff, tests, { threshold: 0.5, batch: 16, concurrency: 2, apiKey: "k", fetchImpl, cache: {} });
  const sentDiff = bodies.map((b) => JSON.parse(b).state.diff).join("\n");
  for (const l of fileA.split("\n")) expect(sentDiff.includes(l)).toBe(true); // every changed line reached the provider
  for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  expect(r.selected.map((s) => s.file)).toEqual(["spec/x.test.ts"]); // NEEDLE was in a later part: max over parts
  expect(r.selected[0].p).toBe(0.9);
});

test("--tests: a big suite's signature is never clipped — it is judged in parts and the best part decides", async () => {
  const { signature } = await import("./tests");
  const src = [`import { other } from "./other";`, ...Array.from({ length: 400 }, (_, i) => `it("case number ${i} does a perfectly ordinary thing", () => {});`), `it("handles the NEEDLE path", () => {});`].join("\n");
  const sig = signature("spec/big.test.ts", src);
  expect(sig.split("\n")).toHaveLength(402); // before: clipped to the first 60 lines, NEEDLE gone
  expect(sig).toContain("NEEDLE");
  const bodies: string[] = [];
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    bodies.push(init.body);
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const t of body.state.tests) answers[t.id] = { type: "noul", noul: t.signature.includes("NEEDLE") ? 0.8 : 0.2 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 } }), { status: 200 });
  }) as unknown as Fetch;
  const diff = "diff --git a/src/w.ts b/src/w.ts\n--- a/src/w.ts\n+++ b/src/w.ts\n@@ -1 +1 @@\n+export const w = 1;\n";
  const r = await selectTests(diff, [{ file: "spec/big.test.ts", signature: sig }], { threshold: 0.5, batch: 16, concurrency: 1, apiKey: "k", fetchImpl, cache: {} });
  const sentSigs = bodies.flatMap((b) => JSON.parse(b).state.tests.map((t: { signature: string }) => t.signature)).join("\n");
  for (const l of sig.split("\n")) expect(sentSigs.includes(l)).toBe(true);
  for (const b of bodies) expect(bytes(b)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
  expect(r.selected).toHaveLength(1);
  expect(r.selected[0].p).toBe(0.8); // the best part's verdict, not the first part's 0.2
});

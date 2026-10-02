// WI-3 signature clustering + --group: chunks sharing a whitespace-normalized
// signature are judged ONCE (the head enters the batch todo), siblings inherit the
// head's verdict — or, on failure, the head's error (no silent vanish). Same
// fake-fetch DI pattern as jgrep.test.ts; every run passes an explicit apiKey.
import { test, expect } from "bun:test";
import { chunkSignature, jgrep, type Chunk } from "./jgrep";

const mk = (file: string, start: number, end: number, text: string): Chunk => ({ file, start, end, text });

const opts = (over: Record<string, unknown> = {}) => ({ threshold: 0.7, batch: 4, concurrency: 2, apiKey: "k", ...over });

/** Always-200 fake: answers every chunk with `p`, capturing parsed request bodies. */
const okFetch = (p = 0.9) => {
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: p };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as any;
  return { calls, fetchImpl };
};

test("chunkSignature: trims lines and drops blanks — whitespace-insensitive identity", () => {
  expect(chunkSignature("  a \n\tb\n\nc\n")).toBe("a\nb\nc");
  expect(chunkSignature("a\nb\nc")).toBe(chunkSignature("  a \n\tb\n\nc\n"));
});

test("clustering: two signature-identical chunks send exactly ONE question for the pair", async () => {
  const cs = [
    mk("a.ts", 1, 3, "export function alpha() {\n  return 1;\n}\n"),
    mk("b.ts", 40, 42, "export function alpha() {\n\treturn 1;\n}\n"), // tab indent: same signature, different raw text
  ];
  const { calls, fetchImpl } = okFetch();
  const cache: Record<string, number> = {};
  const r = await jgrep("returns 1", cs, { ...opts(), fetchImpl, cache });
  expect(calls).toHaveLength(1); // one request for the pair...
  expect(Object.keys(calls[0].questions)).toEqual(["c0"]); // ...carrying exactly one question (the head)
  expect(calls[0].state.chunks).toHaveLength(1); // the sibling never enters a batch
  expect(r.chunks).toBe(2);
  expect(r.cached).toBe(0); // intra-run dedup is not the cache
  expect(r.hits.map((h) => h.file).sort()).toEqual(["a.ts", "b.ts"]); // both sites present
  expect(new Set(r.hits.map((h) => h.p))).toEqual(new Set([0.9])); // the sibling inherits the head's p
  // WI-6: cache keys are whitespace-normalized, so a signature-identical sibling's
  // write lands on the SAME entry as the head's — one key, both variants served.
  expect(Object.keys(cache)).toHaveLength(1);
  const r2 = await jgrep("returns 1", cs, { ...opts(), fetchImpl, cache });
  expect(calls).toHaveLength(1); // the re-run replays the shared entry — 0 new requests
  expect(r2.cached).toBe(2);
  expect(Object.keys(cache)).toHaveLength(1); // no new keys either
});

test("clustering: two different chunks are two questions (no false clustering)", async () => {
  const cs = [
    mk("a.ts", 1, 3, "export function alpha() {\n  return 1;\n}\n"),
    mk("b.ts", 9, 11, "export function beta() {\n  return 2;\n}\n"),
  ];
  const { calls, fetchImpl } = okFetch();
  const r = await jgrep("returns", cs, { ...opts({ batch: 1 }), fetchImpl, cache: {} });
  expect(calls).toHaveLength(2); // one request per chunk — nothing was merged
  expect(Object.keys(calls[0].questions)).toEqual(["c0"]);
  expect(Object.keys(calls[1].questions)).toEqual(["c0"]);
  expect(r.hits).toHaveLength(2);
});

test("clustering: whitespace variants (indent, trailing spaces, blank lines) share one signature", async () => {
  const cs = [
    mk("a.ts", 1, 3, "export function gamma() {\n  return 3;\n}\n"),
    mk("b.ts", 7, 10, "  export function gamma() {  \n\treturn 3;\n\n}\n"),
    mk("c.ts", 20, 24, "export function gamma() {\n\n\n  return 3;\n\n\n}\n"),
  ];
  const { calls, fetchImpl } = okFetch(0.8);
  const r = await jgrep("returns 3", cs, { ...opts(), fetchImpl, cache: {} });
  expect(calls).toHaveLength(1); // judged once
  expect(Object.keys(calls[0].questions)).toEqual(["c0"]);
  expect(r.hits.map((h) => h.file).sort()).toEqual(["a.ts", "b.ts", "c.ts"]); // all three sites
  expect(new Set(r.hits.map((h) => h.p))).toEqual(new Set([0.8])); // equal inherited p
});

test("clustering: a failed head batch maps its error onto ALL signature siblings", async () => {
  const cs = [
    mk("a.ts", 1, 3, "export function delta() {\n  return 4;\n}\n"),
    mk("b.ts", 5, 7, "export function delta() {\n  return 4;\n}\n"),
    mk("c.ts", 9, 11, "export function delta() {\n  return 4;\n}\n"),
  ];
  let sent = 0;
  const fetchImpl = (async () => { sent++; throw new Error("connection reset"); }) as any;
  const r = await jgrep("returns 4", cs, { ...opts({ maxRetries: 0 }), fetchImpl, cache: {} });
  expect(sent).toBe(1); // only the head batch was sent
  expect(r.errors).toHaveLength(3); // head + both siblings — no silent vanish
  expect(r.errors.map((e) => e.file).sort()).toEqual(["a.ts", "b.ts", "c.ts"]); // on their OWN sites
  expect(new Set(r.errors.map((e) => e.kind))).toEqual(new Set(["server_unreachable"]));
  expect(new Set(r.errors.map((e) => e.message)).size).toBe(1); // the head's message rides onto the siblings
  expect(r.hits).toEqual([]);
});

test("--group: groups[] built from hits, sorted p desc, count >= 2, representative present", async () => {
  const cs = [
    mk("a.ts", 1, 3, "export function alpha() {\n  return 1;\n}\n"),
    mk("b.ts", 8, 10, "export function alpha() {\n return 1;\n}\n"), // same signature as a.ts
    mk("c.ts", 20, 22, "export function beta() {\n  return 2;\n}\n"),
    mk("d.ts", 30, 32, "export function beta() {\n  return 2;\n}\n"),
  ];
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: c.code.includes("alpha") ? 0.9 : 0.6 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as any;
  const r = await jgrep("returns a number", cs, { ...opts({ threshold: 0.5, group: true }), fetchImpl, cache: {} });
  expect(r.hits).toHaveLength(4);
  expect(r.groups).toHaveLength(2);
  const [top, low] = r.groups!;
  expect(top.p).toBe(0.9); // p desc: the 0.9 cluster first
  expect(top.count).toBe(2);
  expect(top.sites).toEqual([
    { file: "a.ts", start: 1, end: 3 },
    { file: "b.ts", start: 8, end: 10 },
  ]);
  expect(top.representative).toContain("alpha");
  expect(low.p).toBe(0.6);
  expect(low.count).toBe(2);
  expect(top.sig).not.toBe(low.sig);
  expect(top.sig).toMatch(/^[0-9a-f]{40}$/); // sha1 hex — the CLI prints sig.slice(0, 7)

  const r2 = await jgrep("returns a number", cs, { ...opts({ threshold: 0.5 }), fetchImpl, cache: {} });
  expect(r2.groups).toBeUndefined(); // without --group the result shape is untouched
});

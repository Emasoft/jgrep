// WI-2 --votes / --verify: N questions per chunk with the MEDIAN as the verdict and
// per-vote cache keys (`${key}#v{i}`), the strict verify pass with its documented
// hysteresis gate (threshold * 0.6), and the two composing (votes first, verify on the
// median). Same fake-fetch DI pattern as jgrep.test.ts / group.test.ts; every run
// passes an explicit apiKey.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { chunk, jgrep, VERIFY_PREFIX, VERIFY_GATE, type Chunk } from "./jgrep";

const src = `import a from "a";
import b from "b";

export function one() {
  try { save() } catch (e) {}
}

export function two() {
  try { save() } catch (e) { log(e); throw e }
}
`;

const mk = (file: string, start: number, end: number, text: string): Chunk => ({ file, start, end, text });

/** Vote answers keyed by question id (`c0#v0`, ...); the verify pass (strict prefix) answers `strictP`. */
const voteFetch = (probs: number[], strictP: number) => {
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const ids = Object.keys(body.questions);
    const strict = Object.values<any>(body.questions).some((q) => q.instructions.startsWith(VERIFY_PREFIX));
    const answers: Record<string, unknown> = {};
    if (strict) for (const id of ids) answers[id] = { type: "noul", noul: strictP };
    else for (const id of ids) answers[id] = { type: "noul", noul: probs[Number(id.slice(id.indexOf("#v") + 2))] };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
  }) as any;
  return { calls, fetchImpl };
};

const opts = (over: Record<string, unknown> = {}) => ({ threshold: 0.7, batch: 2, concurrency: 4, apiKey: "k", ...over });

test("votes=3: three questions per chunk, the MEDIAN wins, per-vote cache keys #v0..#v2", async () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 }); // 3 chunks
  const probs = [0.9, 0.5, 0.8]; // median 0.8 — NOT the mean (0.733) and not max/min
  const { calls, fetchImpl } = voteFetch(probs, 0);
  const cache: Record<string, number> = {};
  const r = await jgrep("swallows errors", cs, { ...opts({ votes: 3 }), fetchImpl, cache });
  // N questions per chunk, appended to the batch request as c{j}#v{i}
  expect(Object.keys(calls[0].questions)).toEqual(["c0#v0", "c0#v1", "c0#v2", "c1#v0", "c1#v1", "c1#v2"]);
  expect(calls[0].state.chunks).toHaveLength(2); // the state still has ONE entry per chunk
  expect(r.all.map((h) => h.p)).toEqual([0.8, 0.8, 0.8]); // median of [0.9, 0.5, 0.8]
  expect(r.hits.map((h) => h.start)).toEqual([1, 4, 8]); // every chunk: median 0.8 >= 0.7
  // per-vote cache keys: 3 per chunk carrying the RAW vote values (not the median)
  const keys = Object.keys(cache);
  expect(keys).toHaveLength(9);
  for (const v of [0, 1, 2]) expect(keys.filter((k) => k.endsWith(`#v${v}`))).toHaveLength(3);
  expect(new Set(keys.map((k) => k.replace(/#v\d$/, "")))).toHaveLength(3); // three distinct chunk keys
  expect(Object.values(cache).sort((a, b) => a - b)).toEqual([0.5, 0.5, 0.5, 0.8, 0.8, 0.8, 0.9, 0.9, 0.9]);
  // re-run: all three votes served from cache, same median for free
  const r2 = await jgrep("swallows errors", cs, { ...opts({ votes: 3 }), fetchImpl, cache });
  expect(calls.length).toBe(2); // no new requests
  expect(r2.cached).toBe(3);
  expect(r2.all.map((h) => h.p)).toEqual([0.8, 0.8, 0.8]);
});

test("votes: signature siblings inherit the head's MEDIAN (one head judged)", async () => {
  const text = "export function alpha() {\n  return 1;\n}\n";
  const cs = [mk("a.ts", 1, 3, text), mk("b.ts", 9, 11, text)];
  const { calls, fetchImpl } = voteFetch([0.9, 0.5, 0.8], 0);
  const r = await jgrep("returns 1", cs, { ...opts({ votes: 3 }), fetchImpl, cache: {} });
  expect(calls).toHaveLength(1); // the head only
  expect(Object.keys(calls[0].questions)).toEqual(["c0#v0", "c0#v1", "c0#v2"]);
  expect(r.all.map((h) => h.p)).toEqual([0.8, 0.8]); // the sibling inherits the median
});

test("votes default (1): the legacy single-question request and bare cache keys are untouched", async () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 });
  const { calls, fetchImpl } = voteFetch([0.95], 0);
  const cache: Record<string, number> = {};
  const r = await jgrep("swallows errors", cs, { ...opts(), fetchImpl, cache });
  expect(Object.keys(calls[0].questions)).toEqual(["c0", "c1"]);
  expect(Object.keys(cache).every((k) => !k.includes("#"))).toBe(true); // bare keys, no #v suffix
  expect(r.cached).toBe(0);
});

test("verify above hysteresis: pass-2 p >= threshold * 0.6 — the hit stands", async () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 }).slice(1, 2); // the 0.95 chunk
  const { calls, fetchImpl } = voteFetch([0.95], 0.5); // 0.5 >= 0.7 * 0.6 = 0.42
  const cache: Record<string, number> = {};
  const r = await jgrep("swallows errors", cs, { ...opts({ verify: true }), fetchImpl, cache });
  expect(calls).toHaveLength(2); // main batch + verify batch
  expect(r.hits.map((h) => h.start)).toEqual([4]);
  expect(r.all.map((h) => h.p)).toEqual([0.95]); // `all` keeps the MAIN-pass p
  expect(r.errors).toEqual([]);
  // pass-2 instruction: the strict prefix + the original question
  expect(calls[1].questions.c0.instructions).toBe(
    `${VERIFY_PREFIX}Look only at the chunk with id "c0". Does that code match this description: swallows errors`);
  expect(Object.keys(calls[1].questions)).toEqual(["c0"]); // one question per chunk, no votes in pass 2
  // the verify verdict cached under `#verify`
  expect(Object.keys(cache).filter((k) => k.endsWith("#verify"))).toHaveLength(1);
  // re-run: main pass served by the main keys, pass 2 by the #verify key — no new requests
  const r2 = await jgrep("swallows errors", cs, { ...opts({ verify: true }), fetchImpl, cache });
  expect(calls).toHaveLength(2);
  expect(r2.hits.map((h) => h.start)).toEqual([4]);
});

test("verify below hysteresis: pass-2 p < threshold * 0.6 — the hit drops out of `hits`, stays in `all`", async () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 }).slice(1, 2);
  const { calls, fetchImpl } = voteFetch([0.95], 0.3); // 0.3 < 0.42
  const r = await jgrep("swallows errors", cs, { ...opts({ verify: true }), fetchImpl, cache: {} });
  expect(r.hits).toEqual([]); // dropped
  expect(r.all.map((h) => h.p)).toEqual([0.95]); // but still reported with its main-pass p
});

test("verify gate is exactly threshold * 0.6 (documented hysteresis)", () => {
  expect(VERIFY_GATE).toBe(0.6);
});

test("votes + verify compose: votes judge first, the verify pass asks ONE strict question on the median", async () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 }).slice(1, 2);
  const { calls, fetchImpl } = voteFetch([0.9, 0.5, 0.8], 0.5); // median 0.8 -> hit; verify 0.5 >= 0.42 -> stands
  const r = await jgrep("swallows errors", cs, { ...opts({ votes: 3, verify: true }), fetchImpl, cache: {} });
  expect(calls).toHaveLength(2);
  expect(Object.keys(calls[0].questions)).toEqual(["c0#v0", "c0#v1", "c0#v2"]); // votes first
  expect(Object.keys(calls[1].questions)).toEqual(["c0"]); // verify on the median: one question
  expect(calls[1].questions.c0.instructions.startsWith(VERIFY_PREFIX)).toBe(true);
  expect(r.hits.map((h) => h.start)).toEqual([4]);
});

test("votes + verify compose (drop): a median hit whose strict re-ask sinks below the gate is dropped", async () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 }).slice(1, 2);
  const { fetchImpl } = voteFetch([0.9, 0.5, 0.8], 0.3); // median 0.8 -> hit; verify 0.3 < 0.42 -> dropped
  const r = await jgrep("swallows errors", cs, { ...opts({ votes: 3, verify: true }), fetchImpl, cache: {} });
  expect(r.hits).toEqual([]);
  expect(r.all.map((h) => h.p)).toEqual([0.8]); // the median stays in `all`
});

test("verify fail-open: a failed verification request keeps the hit and reports the chunk error", async () => {
  const cs = chunk("f.ts", src, { minLines: 3, maxLines: 60 }).slice(1, 2);
  let n = 0;
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    if (n++ === 0) {
      const answers = { c0: { type: "noul", noul: 0.95 } };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
    }
    throw new Error("connection reset"); // the verify batch dies
  }) as any;
  const r = await jgrep("swallows errors", cs, { ...opts({ verify: true, maxRetries: 0 }), fetchImpl, cache: {} });
  expect(r.hits.map((h) => h.start)).toEqual([4]); // the hit stands (fail-open)
  expect(r.errors).toHaveLength(1);
  expect(r.errors[0].kind).toBe("server_unreachable");
});

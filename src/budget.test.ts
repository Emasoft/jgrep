// --budget hard cap via reservation (B1/B4, USER decision 2026-10-02: "Hard cap via
// reservation" and "make the cap opt-in. by default no cap should be enabled.").
// The fake provider bills exactly what --estimate predicts for each request body
// (input_tokens = estimateTokens of the body), so "never exceeds the budget" is an exact
// assertion: every batch that starts has reserved its own cost first.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { type Fetch } from "./providers";
import { estimateTokens, jgrep, type Chunk } from "./jgrep";
import { scoreRows } from "./rows";
import { selectTests } from "./tests";

const PRICE = 1000; // $/Mtok: one ~300-token request ≈ $0.3, so the budget math is readable

/** Provider fake: answers every chunk / verify / tag question, bills the estimator's own
 *  token count for the body, and stays in flight a few ms so concurrent workers overlap. */
const billingFetch = (opts: { tokens?: (body: string) => number } = {}) => {
  const st = { requests: 0, spent: 0, inFlight: 0, maxInFlight: 0 };
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    st.requests++; st.inFlight++; st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
    const body = JSON.parse(init.body);
    const tokens = opts.tokens ? opts.tokens(init.body) : estimateTokens({ requests: 1, chars: init.body.length });
    st.spent += (tokens * PRICE) / 1e6;
    await new Promise((r) => setTimeout(r, 5));
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) {
      const q = body.questions[id];
      answers[id] = q.type === "choice" ? { type: "choice", choice: "t0", probabilities: { t0: 0.9, t1: 0.1 } } : { type: "noul", noul: 0.9 };
    }
    st.inFlight--;
    return new Response(JSON.stringify({ answers, usage: { input_tokens: tokens } }), { status: 200 });
  }) as unknown as Fetch;
  return { st, fetchImpl };
};

const nChunks = (n: number): Chunk[] =>
  Array.from({ length: n }, (_, i) => ({ file: `f${i}.ts`, start: 1, end: 2, text: `const value${i} = compute(${i});` }));

/** Cost of one single-chunk request for chunk i, priced like the meter does. */
const oneRequestCost = async (): Promise<number> => {
  const { st, fetchImpl } = billingFetch();
  await jgrep("q", nChunks(1), { threshold: 0.7, batch: 1, concurrency: 1, apiKey: "k", fetchImpl, cache: {}, pricePerMtok: PRICE });
  return st.spent;
};

test("B1 --budget: 16 concurrent workers never spend past the budget (reservation before send)", async () => {
  const c1 = await oneRequestCost();
  const budget = c1 * 3.5; // room for 3 requests
  const { st, fetchImpl } = billingFetch();
  const r = await jgrep("q", nChunks(64), { threshold: 0.7, batch: 1, concurrency: 16, budget, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.spent).toBeLessThanOrEqual(budget + 1e-12);
  expect(st.requests).toBe(3);
  const stops = r.errors.filter((e) => e.kind === "budget_exhausted");
  expect(stops).toHaveLength(64 - 3);
  expect(r.errors).toHaveLength(64 - 3); // nothing else failed
  expect(r.hits).toHaveLength(3);
});

test("B1 --budget: the --verify pass reserves against the same meter (main + verify stay under the budget)", async () => {
  const c1 = await oneRequestCost();
  const budget = c1 * 10.5; // 8 main-pass requests + ~2 verify requests (verify bodies are a bit larger)
  const { st, fetchImpl } = billingFetch();
  const r = await jgrep("q", nChunks(8), { threshold: 0.7, batch: 1, concurrency: 8, verify: true, budget, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.spent).toBeLessThanOrEqual(budget + 1e-12);
  expect(st.requests).toBeGreaterThan(8); // the main pass ran in full and some verification did
  expect(st.requests).toBeLessThan(16);   // ...but not all 8 verify batches
  expect(r.errors.every((e) => e.kind === "budget_exhausted")).toBe(true);
  expect(r.hits).toHaveLength(8); // unverified hits fail open
});

test("B1 --budget: the --tag pass reserves too and never errors the run", async () => {
  const c1 = await oneRequestCost();
  const budget = c1 * 8.2; // the 8 main-pass requests fit; a tag request does not
  const { st, fetchImpl } = billingFetch();
  const r = await jgrep("q", nChunks(8), { threshold: 0.7, batch: 1, concurrency: 8, tag: "bug,style", budget, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.spent).toBeLessThanOrEqual(budget + 1e-12);
  expect(st.requests).toBe(8);
  expect(r.errors).toEqual([]); // tag policy: a stopped tag batch leaves hits untagged
  expect(r.hits.every((h) => h.tag === undefined)).toBe(true);
});

test("B1 --budget: the provider-reported cost replaces the reservation (a pricier batch stops the next one)", async () => {
  // Reported cost is 3x the estimate: after 1 request the meter holds 3x, so with a 3.5x
  // budget a second reservation (1x) no longer fits at concurrency 1.
  const c1 = await oneRequestCost();
  const st = { requests: 0 };
  const fetchImpl = (async (_u: unknown, init: { body: string }) => {
    st.requests++;
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 1 }, cost: c1 * 3 }), { status: 200 });
  }) as unknown as Fetch;
  const r = await jgrep("q", nChunks(4), { threshold: 0.7, batch: 1, concurrency: 1, budget: c1 * 3.5, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.requests).toBe(1);
  expect(r.errors.filter((e) => e.kind === "budget_exhausted")).toHaveLength(3);
});

test("B1 no budget: no cap at all — every batch runs at full concurrency, never budget_exhausted", async () => {
  const { st, fetchImpl } = billingFetch({ tokens: () => 1_000_000_000 }); // absurd spend per request
  const r = await jgrep("q", nChunks(64), { threshold: 0.7, batch: 1, concurrency: 16, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.requests).toBe(64);
  expect(st.maxInFlight).toBe(16);
  expect(r.errors).toEqual([]);
  expect(r.hits).toHaveLength(64);
});

// ---- B4: --rows honours --budget with the same reservation ----------------------

const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `creator ${i}`, bio: `posts about topic ${i}` }));
const Q = { match: { type: "noul" as const, instructions: "beauty is the main content" } };

test("B4 --rows --budget: packs reserve before sending; spend stays under the budget", async () => {
  const one = billingFetch();
  await scoreRows(rowsOf(1), Q, { batch: 1, concurrency: 1, apiKey: "k", fetchImpl: one.fetchImpl, cache: {} });
  const budget = one.st.spent * 3.5; // room for 3 one-row packs
  const { st, fetchImpl } = billingFetch();
  const r = await scoreRows(rowsOf(40), Q, { batch: 1, concurrency: 8, budget, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.spent).toBeLessThanOrEqual(budget + 1e-12);
  expect(st.requests).toBe(3);
  expect(r.requests).toBe(3); // the summary's request count excludes packs the budget never sent
  expect(r.errors).toHaveLength(37);
  expect(r.errors.every((e) => e.kind === "budget_exhausted" && e.hint === "raise --budget")).toBe(true);
});

test("B4 --rows without a budget: no cap — every pack runs", async () => {
  const { st, fetchImpl } = billingFetch({ tokens: () => 1_000_000_000 });
  const r = await scoreRows(rowsOf(40), Q, { batch: 1, concurrency: 8, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.requests).toBe(40);
  expect(r.errors).toEqual([]);
});

// ---- --tests honours --budget with the same reservation (audit MAJOR) ------------

const DIFF = "diff --git a/src/widget.ts b/src/widget.ts\n--- a/src/widget.ts\n+++ b/src/widget.ts\n@@ -1 +1 @@\n-old\n+new\n";
const testFiles = (n: number) => Array.from({ length: n }, (_, i) => ({ file: `spec/case${i}.test.ts`, signature: `describe("case ${i}")` }));

test("--tests --budget: test packs reserve before sending; spend stays under the budget", async () => {
  const one = billingFetch();
  await selectTests(DIFF, testFiles(1), { threshold: 0.5, batch: 1, concurrency: 1, apiKey: "k", fetchImpl: one.fetchImpl, cache: {} });
  expect(one.st.requests).toBe(1);
  const budget = one.st.spent * 3.5; // room for 3 one-test packs
  const { st, fetchImpl } = billingFetch();
  const r = await selectTests(DIFF, testFiles(40), { threshold: 0.5, batch: 1, concurrency: 8, budget, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.spent).toBeLessThanOrEqual(budget + 1e-12);
  expect(st.requests).toBe(3);
  expect(r.requests).toBe(3); // the summary's request count excludes packs the budget never sent
  expect(r.errors).toHaveLength(37);
  expect(r.errors.every((e) => e.kind === "budget_exhausted" && e.hint === "raise --budget")).toBe(true);
});

test("--tests without a budget: no cap — every pack runs", async () => {
  const { st, fetchImpl } = billingFetch({ tokens: () => 1_000_000_000 });
  const r = await selectTests(DIFF, testFiles(40), { threshold: 0.5, batch: 1, concurrency: 8, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.requests).toBe(40);
  expect(r.errors).toEqual([]);
});

// ---- billed-but-failed requests settle their reservation (audit MINOR) ----------

const failingFetch = (status: number, body: string) => {
  const st = { requests: 0 };
  const fetchImpl = (async () => { st.requests++; return new Response(body, { status }); }) as unknown as Fetch;
  return { st, fetchImpl };
};

test("--budget: a 200 with a malformed body (likely billed) is charged its reservation, so the cap still holds", async () => {
  const c1 = await oneRequestCost();
  const { st, fetchImpl } = failingFetch(200, "not json");
  const r = await jgrep("q", nChunks(10), { threshold: 0.7, batch: 1, concurrency: 1, maxRetries: 0, budget: c1 * 3.5, pricePerMtok: PRICE, apiKey: "k", fetchImpl, cache: {} });
  expect(st.requests).toBe(3); // before: spend stayed $0 on every failed request and all 10 were sent
  expect(r.errors.filter((e) => e.kind === "malformed_response")).toHaveLength(3);
  expect(r.errors.filter((e) => e.kind === "budget_exhausted")).toHaveLength(7);
});

test("--budget: a retried 5xx is charged its reservation; a 400 (never processed) is released", async () => {
  const c1 = await oneRequestCost();
  const five = failingFetch(503, "busy");
  // room for 2: the breaker (3 consecutive fatal 5xx) must not be what stops the run
  const r5 = await jgrep("q", nChunks(10), { threshold: 0.7, batch: 1, concurrency: 1, maxRetries: 0, budget: c1 * 2.5, pricePerMtok: PRICE, apiKey: "k", fetchImpl: five.fetchImpl, cache: {} });
  expect(five.st.requests).toBe(2);
  expect(r5.errors.filter((e) => e.kind === "budget_exhausted")).toHaveLength(8);
  const bad = failingFetch(400, "bad request");
  const r4 = await jgrep("q", nChunks(10), { threshold: 0.7, batch: 1, concurrency: 1, maxRetries: 0, budget: c1 * 3.5, pricePerMtok: PRICE, apiKey: "k", fetchImpl: bad.fetchImpl, cache: {} });
  expect(bad.st.requests).toBe(10);
  expect(r4.errors.every((e) => e.kind === "bad_request")).toBe(true);
});

// ---- run cost = per-request settled cost, same rule as the meter (PR #2 open item) ----

/** First request reports a provider cost, every later one reports only tokens. */
const intermittentFetch = (reported: number, tokens: number) => {
  let n = 0;
  return (async (_u: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const id of Object.keys(body.questions)) answers[id] = { type: "noul", noul: 0.9 };
    const first = n++ === 0;
    return new Response(JSON.stringify({ answers, usage: { input_tokens: tokens }, ...(first ? { cost: reported } : {}) }), { status: 200 });
  }) as unknown as Fetch;
};

test("run cost: a provider reporting cost only sometimes is not undercounted (jgrep, rows, tests)", async () => {
  const unreported = (10 * PRICE) / 1e6; // one token-priced request: 10 tokens at $1000/Mtok = $0.01
  const r = await jgrep("q", nChunks(3), { threshold: 0.7, batch: 1, concurrency: 1, pricePerMtok: PRICE, apiKey: "k", fetchImpl: intermittentFetch(0.5, 10), cache: {} });
  expect(r.cost).toBeCloseTo(0.5 + 2 * unreported, 12); // before: 0.5 — the two unreported requests were free
  const rows = await scoreRows(rowsOf(3), Q, { batch: 1, concurrency: 1, pricePerMtok: PRICE, apiKey: "k", fetchImpl: intermittentFetch(0.5, 10), cache: {} });
  expect(rows.cost).toBeCloseTo(0.5 + 2 * unreported, 12);
  const t = await selectTests(DIFF, testFiles(3), { threshold: 0.5, batch: 1, concurrency: 1, pricePerMtok: PRICE, apiKey: "k", fetchImpl: intermittentFetch(0.5, 10), cache: {} });
  expect(t.cost).toBeCloseTo(0.5 + 2 * unreported, 12);
});

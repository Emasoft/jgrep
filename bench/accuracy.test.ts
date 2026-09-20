// bench/accuracy.test.ts — pure metric-function tests (confusionMatrix,
// precisionRecallF1, argmaxChoice, smsVerdict + the small helpers) and fake-fetch
// end-to-end runs of scoreFixture(). No network, no key, no env: scoreFixture
// takes an explicit backend/apiKey/fetchImpl (the repo's DI pattern), so nothing
// here touches resolveProvider/resolveApiKey. The only filesystem reads are the
// committed fixture CSVs (label-coverage check).
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import path from "node:path";
import { readRows } from "../src/rows";
import { BACKENDS, type Fetch } from "../src/providers";

declare const process: { env: Record<string, string | undefined> };

process.env.JGREP_NO_MAIN = "1"; // before the dynamic import: accuracy.ts must not auto-run
const {
  FIXTURES, FIXTURES_DIR, argmaxChoice, confusionMatrix, errorBreakdown, parse,
  precisionRecallF1, scoreFixture, sliceByClass, smsVerdict, utcStamp,
} = await import("./accuracy");

// ---- confusionMatrix -----------------------------------------------------------

test("confusionMatrix counts [actual][predicted] and rejects bad input", () => {
  expect(confusionMatrix(["spam", "ham", "spam", "spam"], ["spam", "ham", "ham", "spam"], ["spam", "ham"]))
    .toEqual([[2, 0], [1, 1]]); // actual spam: 2 spam-pred + 0 ham-pred; actual ham: 1 spam-pred + 1 ham-pred
  expect(() => confusionMatrix(["x"], ["spam"], ["spam", "ham"])).toThrow(/unknown label "x"/);
  expect(() => confusionMatrix(["spam"], ["spam", "ham"], ["spam", "ham"])).toThrow(/same length/);
});

// ---- precisionRecallF1 ---------------------------------------------------------

test("precisionRecallF1: a perfect matrix gives 1 everywhere", () => {
  const m = precisionRecallF1([[2, 0], [0, 2]], ["spam", "ham"]);
  expect(m.perClass.spam).toEqual({ precision: 1, recall: 1, f1: 1, support: 2 });
  expect(m.perClass.ham).toEqual({ precision: 1, recall: 1, f1: 1, support: 2 });
  expect(m.accuracy).toBe(1);
  expect(m.macroF1).toBe(1);
  expect(m.scored).toBe(4);
  expect(m.confusion).toEqual([[2, 0], [0, 2]]);
});

test("precisionRecallF1: spam as positive, 2-decimal-independent rounding", () => {
  // actual spam: [1 spam-pred, 0 ham-pred]; actual ham: [1 spam-pred, 2 ham-pred]
  const m = precisionRecallF1([[1, 0], [1, 2]], ["spam", "ham"]);
  expect(m.perClass.spam).toEqual({ precision: 0.5, recall: 1, f1: 0.6667, support: 1 });
  expect(m.perClass.ham.precision).toBe(1);
  expect(m.perClass.ham.recall).toBe(0.6667);
  expect(m.perClass.ham.f1).toBe(0.8);
  expect(m.accuracy).toBe(0.75);
  expect(m.macroF1).toBe(0.7333); // mean of the UNROUNDED f1s: (2/3 + 0.8) / 2
  expect(m.scored).toBe(4);
});

test("precisionRecallF1: zero denominators degrade to 0, never NaN", () => {
  const m = precisionRecallF1([[0, 0], [2, 0]], ["a", "b"]);
  expect(m.perClass.a).toEqual({ precision: 0, recall: 0, f1: 0, support: 0 }); // class never seen
  expect(m.perClass.b).toEqual({ precision: 0, recall: 0, f1: 0, support: 2 }); // predicted, never actual
  expect(m.accuracy).toBe(0);
  expect(m.macroF1).toBe(0);
});

// ---- argmaxChoice --------------------------------------------------------------

test("argmaxChoice: argmax over per-criteria probabilities, first label wins ties", () => {
  const labels = FIXTURES.agnews.labels; // World, Sports, Business, Sci/Tech
  const ans = { type: "choice", choice: "Sports", probabilities: { World: 0.1, Sports: 0.8, Business: 0.05, "Sci/Tech": 0.05 } };
  expect(argmaxChoice(ans, labels)).toBe("Sports");
  expect(argmaxChoice({ type: "choice", choice: "World", probabilities: { World: 0.4, Sports: 0.4 } }, labels)).toBe("World");
  // no probabilities -> the provider's own choice, when it is a known criteria
  expect(argmaxChoice({ type: "choice", choice: "Business" }, labels)).toBe("Business");
  // probabilities without any usable criteria key, and a choice outside the criteria
  expect(argmaxChoice({ type: "choice", choice: "Politics", probabilities: {} }, labels)).toBe("");
  expect(argmaxChoice({ type: "choice", choice: "Politics" }, labels)).toBe("");
  expect(argmaxChoice({ type: "missing" }, labels)).toBe("");
  expect(argmaxChoice(undefined, labels)).toBe("");
});

// ---- smsVerdict ----------------------------------------------------------------

test("smsVerdict: p >= 0.5 is spam, sub-half is ham, unusable answers are null", () => {
  expect(smsVerdict({ type: "noul", noul: 0.5 })).toBe(true); // boundary: exactly 0.5 counts as spam
  expect(smsVerdict({ type: "noul", noul: 0.4999 })).toBe(false);
  expect(smsVerdict({ type: "noul", noul: 0 })).toBe(false);
  expect(smsVerdict({ type: "noul", noul: 1 })).toBe(true);
  expect(smsVerdict({ type: "noul" })).toBeNull(); // no p at all
  expect(smsVerdict({ type: "missing" })).toBeNull();
  expect(smsVerdict(undefined)).toBeNull(); // errored row: no answer object
});

// ---- helpers -------------------------------------------------------------------

test("errorBreakdown orders kinds by count desc then name asc", () => {
  const e = (kind: string) => ({ kind });
  expect(errorBreakdown([e("timeout"), e("rate_limited"), e("timeout")])).toBe("2 timeout, 1 rate_limited");
  expect(errorBreakdown([e("timeout"), e("bad_request")])).toBe("1 bad_request, 1 timeout");
  expect(errorBreakdown([])).toBe("");
});

test("utcStamp formats UTC YYYYMMDDTHHMMSSZ for result filenames", () => {
  expect(utcStamp(new Date("2026-02-05T06:07:08.900Z"))).toBe("20260205T060708Z");
  expect(utcStamp(new Date("2026-12-31T23:59:59Z"))).toBe("20261231T235959Z");
});

test("sliceByClass takes the first N rows per class in fixture order", () => {
  const rows = [
    { label: "spam", text: "s1" }, { label: "ham", text: "h1" }, { label: "spam", text: "s2" },
    { label: "spam", text: "s3" }, { label: "ham", text: "h2" },
  ];
  expect(sliceByClass(rows, ["spam", "ham"], 0).map((s) => s.row.text)).toEqual(["s1", "h1", "s2", "s3", "h2"]);
  expect(sliceByClass(rows, ["spam", "ham"], 1).map((s) => s.row.text)).toEqual(["s1", "h1"]);
  expect(sliceByClass(rows, ["spam", "ham"], 2).map((s) => s.row.text)).toEqual(["s1", "h1", "s2", "h2"]);
  expect(() => sliceByClass([{ label: "weird", text: "x" }], ["spam", "ham"], 0)).toThrow(/unknown label "weird"/);
});

test("parse: defaults, flags, numeric validation, fixture enum, stray positionals", () => {
  expect(parse([])).toMatchObject({ fixture: "all", api: "", model: "", limit: 0, out: "", rate: 0, retries: 4, timeout: 15, failFast: false });
  expect(parse(["--fixture", "sms", "--limit", "2", "--api", "openrouter", "--model", "~typesafe/jev-1.13",
    "--rate", "5", "--retries", "1", "--timeout", "30", "--fail-fast", "--out", "/tmp/r"]))
    .toMatchObject({ fixture: "sms", limit: 2, api: "openrouter", model: "~typesafe/jev-1.13",
      rate: 5, retries: 1, timeout: 30, failFast: true, out: "/tmp/r" });
  for (const flag of ["--limit", "--rate", "--retries", "--timeout"]) {
    expect(() => parse([flag, "abc"])).toThrow(/numeric option expected/);
    expect(() => parse([flag, "-1"])).toThrow(/numeric option expected/);
  }
  expect(() => parse(["--rate", "0", "--limit", "0", "--retries", "0", "--timeout", "0"])).not.toThrow(); // 0 is legal
  expect(() => parse(["--fixture", "spam"])).toThrow(/unknown fixture "spam"/);
  expect(() => parse(["--wat"])).toThrow(/unknown option --wat/);
  expect(() => parse(["stray"])).toThrow(/unexpected argument "stray"/);
});

// ---- committed fixtures (read-only integration) --------------------------------

test("committed fixtures: every label is known, text non-empty, per-class counts as documented", () => {
  const counts: Record<string, Record<string, number>> = {};
  for (const spec of Object.values(FIXTURES)) {
    const { rows } = readRows(path.join(FIXTURES_DIR, spec.file));
    expect(rows.length).toBeGreaterThan(0);
    counts[spec.key] = {};
    for (const row of rows) {
      expect(spec.labels).toContain(row.label);
      expect(row.text.length).toBeGreaterThan(0);
      counts[spec.key][row.label] = (counts[spec.key][row.label] ?? 0) + 1;
    }
  }
  expect(counts.sms).toEqual({ spam: 100, ham: 100 });
  expect(counts.agnews).toEqual({ World: 30, Sports: 30, Business: 30, "Sci/Tech": 30 });
});

// ---- scoreFixture end-to-end (fake fetch, the repo DI pattern) ------------------

test("scoreFixture end-to-end (fake fetch): SMS rows -> metrics + results JSON shape", async () => {
  const rows = [
    { label: "spam", text: "WIN a free prize now, text WIN to 87121" },
    { label: "ham", text: "pick up a burger on your way home" },
  ];
  const calls: any[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.spam`] = { type: "noul", noul: /WIN/.test(r.text) ? 0.9 : 0.1 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 7 } }), { status: 200 });
  }) as unknown as Fetch;
  const { result } = await scoreFixture(FIXTURES.sms, rows, {
    backend: BACKENDS.typesafe, apiKey: "k", model: "jev-latest", fetchImpl, pricePerMtok: 0.042,
  });

  // The Step-11 artifact shape, exactly these keys in this order.
  expect(Object.keys(result)).toEqual(["fixture", "provider", "model", "n", "metrics", "tokens", "requests", "cached", "cost", "durationSec", "startedAt"]);
  expect(result.fixture).toBe("sms");
  expect(result.provider).toBe("typesafe");
  expect(result.model).toBe("jev-latest");
  expect(result.n).toBe(2);
  expect(result.metrics.scored).toBe(2);
  expect(result.metrics.confusion).toEqual([[1, 0], [0, 1]]);
  expect(result.metrics.perClass.spam).toEqual({ precision: 1, recall: 1, f1: 1, support: 1 });
  expect(result.metrics.accuracy).toBe(1);
  expect(result.tokens).toBe(7); // one batched request for both rows
  expect(result.requests).toBe(1);
  expect(result.cached).toBe(0); // throwaway cache: nothing is ever counted as cached
  expect(result.cost).toBeCloseTo((7 * 0.042) / 1e6, 12); // tokens x price fallback
  expect(result.durationSec).toBeGreaterThanOrEqual(0);
  expect(Number.isNaN(new Date(result.startedAt).getTime())).toBe(false);

  // Existing rows conventions hold: one noul question per row, keyed rN.<name>,
  // with buildRowsRequest's "Look only at the row with id" prefix — and the
  // ground-truth label never leaks into the state the model sees.
  expect(Object.keys(calls[0].questions)).toEqual(["r0.spam", "r1.spam"]);
  expect((calls[0].questions["r0.spam"] as { instructions: string }).instructions).toContain(`Look only at the row with id "r0"`);
  expect(JSON.stringify(calls[0].state)).not.toContain("spam");
  expect(JSON.stringify(calls[0].state)).not.toContain("ham");
});

test("scoreFixture end-to-end (fake fetch): AG News argmax over choice probabilities", async () => {
  const rows = [
    { label: "World", text: "Venezuelans vote early in referendum" },
    { label: "Sports", text: "United clinch the title with a late goal" },
    { label: "Business", text: "Shares slide as inflation data lands" },
    { label: "Sci/Tech", text: "Fusion startup claims a net energy gain" },
  ];
  const picks = ["Sports", "Sports", "Business", "World"]; // by pack-local row id r0..r3
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) {
      const chosen = picks[Number(r.id.slice(1))];
      answers[`${r.id}.category`] = {
        type: "choice", choice: chosen,
        probabilities: Object.fromEntries(FIXTURES.agnews.labels.map((l) => [l, l === chosen ? 0.9 : 0.03])),
      };
    }
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 11 } }), { status: 200 });
  }) as unknown as Fetch;
  const { result } = await scoreFixture(FIXTURES.agnews, rows, {
    backend: BACKENDS.typesafe, apiKey: "k", model: "m", fetchImpl, pricePerMtok: 0.042,
  });

  expect(result.fixture).toBe("agnews");
  expect(result.n).toBe(4);
  expect(result.metrics.scored).toBe(4);
  expect(result.metrics.confusion).toEqual([[0, 1, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 0, 0]]);
  expect(result.metrics.perClass["Sci/Tech"]).toEqual({ precision: 0, recall: 0, f1: 0, support: 1 });
  expect(result.metrics.perClass.Sports).toEqual({ precision: 0.5, recall: 1, f1: 0.6667, support: 1 });
  expect(result.metrics.accuracy).toBe(0.5);
  expect(result.metrics.macroF1).toBe(0.4167);
  expect(result.requests).toBe(1);
  expect(result.tokens).toBe(11);
});

test("scoreFixture: errored rows are excluded from the denominators and reported", async () => {
  const rows = [
    { label: "spam", text: "s1" }, { label: "ham", text: "h1" }, { label: "spam", text: "s2" },
  ];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (body.state.rows.some((r: { text: string }) => r.text === "s2")) return new Response("boom", { status: 500 });
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.spam`] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 5 } }), { status: 200 });
  }) as unknown as Fetch;
  const { result, errors } = await scoreFixture(FIXTURES.sms, rows, {
    backend: BACKENDS.typesafe, apiKey: "k", model: "m", batch: 2, maxRetries: 0, fetchImpl, pricePerMtok: 0.042,
  });

  expect(errors.map((e) => e.row)).toEqual([2]); // the failed pack, rows stay isolated
  expect(errors[0].kind).toBe("server_unreachable");
  expect(errorBreakdown(errors)).toBe("1 server_unreachable");
  expect(result.n).toBe(3);
  expect(result.metrics.scored).toBe(2); // only the answered rows are in the denominators
  expect(result.metrics.confusion).toEqual([[1, 0], [1, 0]]); // row 1 (ham) predicted spam
  expect(result.metrics.perClass.ham.support).toBe(1);
});

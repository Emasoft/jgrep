// bench/code_selection.test.ts — pure helper tests (selectVerdict, matchQuestions,
// validateCases, parse) and fake-fetch end-to-end runs of scoreCases(). No network,
// no key, no env: scoreCases takes an explicit backend/apiKey/fetchImpl (the repo's
// DI pattern), so nothing here touches resolveProvider/resolveApiKey. The only
// filesystem read is the committed cases.json fixture (integrity check).
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { BACKENDS, type Fetch } from "../src/providers";

declare const process: { env: Record<string, string | undefined> };

process.env.JGREP_NO_MAIN = "1"; // before the dynamic import: code_selection.ts must not auto-run
const { CASES_FILE, loadCases, matchQuestions, parse, scoreCases, selectVerdict, validateCases } = await import(
  "./code_selection"
);

// ---- selectVerdict --------------------------------------------------------------

test("selectVerdict: argmax over candidate probabilities, margin = p_top - p_second", () => {
  const candidates = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const answers = [
    { match: { type: "noul", noul: 0.2 } },
    { match: { type: "noul", noul: 0.9 } },
    { match: { type: "noul", noul: 0.5 } },
  ];
  expect(selectVerdict(answers, candidates)).toEqual({ predicted: "b", p: 0.9, margin: 0.4 });
});

test("selectVerdict: an exact tie keeps the first candidate and flags it with margin 0", () => {
  const candidates = [{ name: "a" }, { name: "b" }, { name: "c" }];
  const answers = [
    { match: { type: "noul", noul: 0.7 } },
    { match: { type: "noul", noul: 0.7 } },
    { match: { type: "noul", noul: 0.1 } },
  ];
  expect(selectVerdict(answers, candidates)).toEqual({ predicted: "a", p: 0.7, margin: 0 });
});

test("selectVerdict: unusable answers are skipped; single usable has no margin; none usable is empty", () => {
  const candidates = [{ name: "a" }, { name: "b" }];
  // an errored row leaves no answer object at all; the other row still decides
  expect(selectVerdict([undefined, { match: { type: "noul", noul: 0.6 } }], candidates))
    .toEqual({ predicted: "b", p: 0.6, margin: null });
  // wrong question key and a missing-type answer are unusable
  expect(selectVerdict([{ other: { type: "noul", noul: 1 } }, { match: { type: "missing" } }], candidates))
    .toEqual({ predicted: "", p: null, margin: null });
  // a noul answer without a finite probability is unusable too
  expect(selectVerdict([{ match: { type: "noul" } }, { match: { type: "noul", noul: Number.NaN } }], candidates))
    .toEqual({ predicted: "", p: null, margin: null });
  expect(selectVerdict([], candidates)).toEqual({ predicted: "", p: null, margin: null });
});

// ---- matchQuestions -------------------------------------------------------------

test("matchQuestions: one constant noul question embedding the description", () => {
  const q = matchQuestions("Grows the wait geometrically.");
  expect(Object.keys(q)).toEqual(["match"]);
  expect(q.match.type).toBe("noul");
  expect(q.match.instructions).toBe(
    "Does this code implement: Grows the wait geometrically.? "
    + "Answer yes only if the code fully implements the described behavior.",
  );
});

// ---- validateCases --------------------------------------------------------------

test("validateCases rejects malformed fixtures with actionable messages", () => {
  expect(() => validateCases({})).toThrow(/expected an array of cases/);
  expect(() => validateCases([{ id: "x" }])).toThrow(/case\[0\] needs \{ id, description, expected, candidates/);
  expect(() => validateCases([{ id: "x", description: "d", expected: "e", candidates: [] }])).toThrow(/has no candidates/);
  expect(() => validateCases([{ id: "x", description: "d", expected: "e", candidates: [{ name: "e", code: "c" }, { name: "e", code: "c2" }] }]))
    .toThrow(/duplicate candidate name "e"/);
  expect(() => validateCases([{ id: "x", description: "d", expected: "missing", candidates: [{ name: "e", code: "c" }] }]))
    .toThrow(/expected "missing" is not one of the candidate names/);
  expect(validateCases([{ id: "x", description: "d", expected: "e", candidates: [{ name: "e", code: "c" }] }]))
    .toEqual([{ id: "x", description: "d", expected: "e", candidates: [{ name: "e", code: "c" }] }]);
});

// ---- parse ----------------------------------------------------------------------

test("parse: defaults, flags, --limit/--cases alias, numeric validation, stray positionals", () => {
  expect(parse([])).toMatchObject({ limit: 0, api: "", model: "", out: "", rate: 0, retries: 4, timeout: 15, failFast: false });
  expect(parse(["--limit", "3", "--api", "openrouter", "--model", "~typesafe/jev-1.13",
    "--rate", "5", "--retries", "1", "--timeout", "30", "--fail-fast", "--out", "/tmp/r"]))
    .toMatchObject({ limit: 3, api: "openrouter", model: "~typesafe/jev-1.13",
      rate: 5, retries: 1, timeout: 30, failFast: true, out: "/tmp/r" });
  expect(parse(["--cases", "2"]).limit).toBe(2);
  expect(parse(["--cases", "2", "--limit", "5"]).limit).toBe(5); // last occurrence wins
  for (const flag of ["--limit", "--cases", "--rate", "--retries", "--timeout"]) {
    expect(() => parse([flag, "abc"])).toThrow(/numeric option expected/);
    expect(() => parse([flag, "-1"])).toThrow(/numeric option expected/);
  }
  expect(() => parse(["--rate", "0", "--limit", "0", "--retries", "0", "--timeout", "0"])).not.toThrow(); // 0 is legal
  expect(() => parse(["--wat"])).toThrow(/unknown option --wat/);
  expect(() => parse(["stray"])).toThrow(/unexpected argument "stray"/);
});

// ---- scoreCases end-to-end (fake fetch, the repo DI pattern) --------------------

test("scoreCases end-to-end (fake fetch): argmax scoring + artifact shape", async () => {
  // One request per case; the high-probability token sits in the EXPECTED candidate's
  // code for c1/c2 and in a distractor for c3 (a deliberately wrong prediction).
  const cases = [
    { id: "c1", description: "grows the wait geometrically after each failure", expected: "backoff",
      candidates: [{ name: "backoff", code: "delay = delay * 2 // GROWTH" }, { name: "fixedDelay", code: "delay = 500 // FLAT" }] },
    { id: "c2", description: "resolves with the first task that settles", expected: "race",
      candidates: [{ name: "all", code: "Promise.all(tasks) // FLAT" }, { name: "race", code: "Promise.race(tasks) // GROWTH" }] },
    { id: "c3", description: "lowercases every character of the input", expected: "lower",
      candidates: [{ name: "lower", code: "s.toLowerCase() // FLAT" }, { name: "upper", code: "s.toUpperCase() // GROWTH" }] },
  ];
  const calls: any[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.match`] = { type: "noul", noul: /GROWTH/.test(r.code) ? 0.9 : 0.1 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 7 } }), { status: 200 });
  }) as unknown as Fetch;
  const result = await scoreCases(cases, {
    backend: BACKENDS.typesafe, apiKey: "k", model: "jev-latest", fetchImpl, pricePerMtok: 0.042,
  });

  // The Step-12 artifact shape, exactly these keys in this order.
  expect(Object.keys(result)).toEqual(["fixture", "provider", "model", "n", "correct", "accuracy", "errored", "perCase", "tokens", "requests", "cached", "cost", "durationSec", "startedAt"]);
  expect(result.fixture).toBe("code_selection");
  expect(result.provider).toBe("typesafe");
  expect(result.model).toBe("jev-latest");
  expect(result.n).toBe(3);
  expect(result.correct).toBe(2);
  expect(result.accuracy).toBe(0.6667); // r4(2/3) — the wrong c3 stays in the denominator
  expect(result.errored).toEqual([]);
  expect(result.perCase.map((pc: { id: string }) => pc.id)).toEqual(["c1", "c2", "c3"]);
  expect(Object.keys(result.perCase[0])).toEqual(["id", "expected", "predicted", "p", "margin", "ok"]);
  expect(result.perCase[0]).toEqual({ id: "c1", expected: "backoff", predicted: "backoff", p: 0.9, margin: 0.8, ok: true });
  expect(result.perCase[2]).toEqual({ id: "c3", expected: "lower", predicted: "upper", p: 0.9, margin: 0.8, ok: false });
  expect(result.requests).toBe(3); // one request per case
  expect(result.tokens).toBe(21); // one batched request per case, 7 tokens each
  expect(result.cached).toBe(0); // throwaway cache: nothing is ever counted as cached
  expect(result.cost).toBeCloseTo((21 * 0.042) / 1e6, 12); // tokens x price fallback
  expect(result.durationSec).toBeGreaterThanOrEqual(0);
  expect(Number.isNaN(new Date(result.startedAt).getTime())).toBe(false);

  // Existing rows conventions hold: one constant noul question per candidate row,
  // keyed rN.match with buildRowsRequest's "Look only at the row with id" prefix —
  // and the state rows are { id, name, code } only, nothing marks the expected one.
  expect(calls.length).toBe(3);
  expect(Object.keys(calls[0].questions)).toEqual(["r0.match", "r1.match"]);
  expect((calls[0].questions["r0.match"] as { instructions: string }).instructions).toContain(`Look only at the row with id "r0"`);
  expect((calls[0].questions["r0.match"] as { instructions: string }).instructions).toContain("grows the wait geometrically after each failure");
  expect(Object.keys(calls[0].state.rows[0])).toEqual(["id", "name", "code"]);
});

test("scoreCases: a case whose request fails is excluded from the denominator and reported", async () => {
  const cases = [
    { id: "good", description: "grows the wait geometrically", expected: "backoff",
      candidates: [{ name: "backoff", code: "delay = delay * 2 // GROWTH" }, { name: "fixed", code: "delay = 5 // FLAT" }] },
    { id: "bad", description: "detonates on purpose", expected: "boom",
      candidates: [{ name: "boom", code: "throw new Error('BOOM')" }, { name: "calm", code: "return 1 // FLAT" }] },
  ];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    if (JSON.stringify(body.state).includes("BOOM")) return new Response("nope", { status: 400 });
    const answers: Record<string, unknown> = {};
    for (const r of body.state.rows) answers[`${r.id}.match`] = { type: "noul", noul: /GROWTH/.test(r.code) ? 0.9 : 0.1 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 7 } }), { status: 200 });
  }) as unknown as Fetch;
  const result = await scoreCases(cases, {
    backend: BACKENDS.typesafe, apiKey: "k", model: "m", maxRetries: 0, fetchImpl, pricePerMtok: 0.042,
  });

  expect(result.errored.length).toBe(1);
  expect(result.errored[0].case).toBe("bad");
  expect(result.errored[0].kind).toBe("bad_request");
  expect(result.errored[0].message).toContain("typesafe 400");
  expect(result.n).toBe(2);
  expect(result.correct).toBe(1);
  expect(result.accuracy).toBe(1); // only the good case is in the denominator
  expect(result.perCase[0]).toEqual({ id: "good", expected: "backoff", predicted: "backoff", p: 0.9, margin: 0.8, ok: true });
  expect(result.perCase[1]).toEqual({ id: "bad", expected: "boom", predicted: "", p: null, margin: null, ok: false });
  expect(result.requests).toBe(2);
  expect(result.tokens).toBe(7); // the failed request contributes nothing
});

// ---- committed fixture (read-only integration) ----------------------------------

test("committed code_selection fixture: 20 cases x 5 unique candidates, expected among them", async () => {
  const cases = await loadCases(CASES_FILE);
  expect(cases.length).toBe(20);
  for (const kase of cases) {
    expect(kase.candidates.length).toBe(5);
    expect(new Set(kase.candidates.map((k) => k.name)).size).toBe(5);
    expect(kase.candidates.map((k) => k.name)).toContain(kase.expected);
    expect(kase.description.length).toBeGreaterThan(0);
    for (const k of kase.candidates) expect(k.code.length).toBeGreaterThan(0);
  }
  // The expected candidate sits at a different position per case (bench/fixtures/README.md).
  expect(cases.map((kase) => kase.candidates.findIndex((k) => k.name === kase.expected)))
    .toEqual([2, 2, 0, 0, 3, 2, 0, 1, 0, 2, 0, 3, 0, 2, 0, 1, 0, 2, 0, 1]);
});

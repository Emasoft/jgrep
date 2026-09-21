// OPT-IN live e2e against the real OpenRouter backend. This file NEVER runs in CI
// and never runs by accident locally: every test is double-gated on
//   JGREP_E2E_LIVE=1   (explicit opt-in env var)   AND   CI unset
// (GitHub Actions always sets CI, so no CI run can ever reach the network here).
// Without the flag bun reports these tests as skipped — silently, no network, no
// spend. With the flag the suite issues 4 OpenRouter calls: one behavioral code
// query, one rows classification, one key probe and one guaranteed-401 invalid-key
// call (free) — well under 10k input tokens in total, roughly $0.005 per full run.
// The key comes from the ambient OPENROUTER_API_KEY (resolveApiKey's first lookup);
// with the flag set but no key configured the suite skips with a one-line hint
// instead of failing.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { JevProviderError } from "./errors";
import { chunk, jgrep } from "./jgrep";
import { BACKENDS, resolveApiKey, verifyApiKey } from "./providers";
import { scoreRows, type Row } from "./rows";

declare const process: { env: Record<string, string | undefined> };

// ---- the gate: both halves are required; CI detection is a second lock, not the only one ----
const RUN_LIVE = process.env.JGREP_E2E_LIVE === "1" && process.env.CI === undefined;

// Forced backend — never auto-detected — with the ambient OpenRouter key.
const backend = BACKENDS.openrouter;
let apiKey = "";
let hasKey = false;
try {
  apiKey = resolveApiKey(backend);
  hasKey = true;
} catch {
  if (RUN_LIVE) console.log("e2e: no OpenRouter key — skipping live tests");
}

const skip = !RUN_LIVE || !hasKey;

// Deterministic 3-function fixture: chunk() splits it into 3 chunks (one per
// function), so the code query and the rows classification each cost exactly ONE
// request. Chunks are passed to jgrep() directly — no temp files, no filesystem.
const SAMPLE = `export function addNumbers(a: number, b: number): number {\n  return a + b;\n}\n\nexport function reverseString(s: string): string {\n  return [...s].reverse().join("");\n}\n\nexport function todayPizzaTopping(): string {\n  return "mushroom";\n}\n`;
const chunks = chunk("sample.ts", SAMPLE, { minLines: 3, maxLines: 10 });

/** Reject reason of a promise, or null when it resolved (repo pattern, http.test.ts). */
const errOf = async (p: Promise<unknown>): Promise<JevProviderError> => {
  try { await p; } catch (e) { return e as JevProviderError; }
  throw new Error("expected the promise to reject");
};

test.skipIf(skip)("live code mode: behavioral query hits addNumbers (1 request)", async () => {
  console.log(`e2e: code mode via ${backend.name} model=${backend.model}`);
  const r = await jgrep("returns the sum of two numbers", chunks, {
    backend, apiKey, model: backend.model, threshold: 0.5, timeoutSec: 30, batch: 4, concurrency: 2,
  });
  expect(r.errors).toHaveLength(0);
  expect(r.hits.length).toBeGreaterThanOrEqual(1);
  // `all` is index-aligned with the input chunks on a clean run: the addNumbers
  // chunk scored above threshold and every scored chunk got a finite p.
  const add = r.all.find((c) => c.text.includes("addNumbers"));
  expect(add).toBeDefined();
  expect(add!.p).toBeGreaterThanOrEqual(0.5);
  expect(r.all.every((h) => Number.isFinite(h.p))).toBe(true);
  expect(r.tokens).toBeGreaterThan(0);
  const best = r.hits.reduce((a, b) => (b.p > a.p ? b : a));
  expect(best.text.includes("addNumbers")).toBe(true);
  console.log(`e2e: p=${r.all.map((h) => h.p.toFixed(2)).join(",")} tokens=${r.tokens}`);
}, 30_000);

test.skipIf(skip)("live rows mode: pet-cat classification (1 request)", async () => {
  console.log(`e2e: rows mode via ${backend.name} model=${backend.model}`);
  const rows: Row[] = [
    { text: "I adopted a cat named Whiskers last year" },
    { text: "The quantum flux capacitor requires recalibration" },
    { text: "BUY NOW cheap meds online, best prices!!!" },
  ];
  const r = await scoreRows(rows, { cat: { type: "noul", instructions: "Is this text about a pet cat? Answer yes or no." } }, {
    backend, apiKey, model: backend.model, batch: 3, concurrency: 1, timeoutSec: 30,
  });
  expect(r.errors).toHaveLength(0);
  const p = r.answers.map((a) => a?.cat?.noul ?? NaN);
  expect(p[0]).toBeGreaterThanOrEqual(0.5);
  expect(p[2]).toBeLessThan(0.5);
  expect(p[2]).toBeLessThanOrEqual(p[0]); // soft assert: spam never outranks the cat text
  expect(r.tokens).toBeGreaterThan(0);
  console.log(`e2e: rows p=${p.map((n) => n.toFixed(2)).join(",")} tokens=${r.tokens}`);
}, 30_000);

test.skipIf(skip)("live invalid key: typed invalid_api_key 401, not retryable (free)", async () => {
  console.log(`e2e: invalid-key taxonomy via ${backend.name} (no spend expected)`);
  const e = await errOf(jgrep("anything", chunks, {
    backend, apiKey: "sk-or-invalid-e2e-" + Date.now(), threshold: 0.5, batch: 4, concurrency: 1, failFast: true, maxRetries: 1,
  }));
  expect(e instanceof JevProviderError).toBe(true);
  expect(e.kind).toBe("invalid_api_key");
  expect(e.status).toBe(401);
  expect(e.retryable).toBe(false);
  console.log("e2e: invalid key rejected before billing — tokens=0");
}, 30_000);

test.skipIf(skip)("live key probe: verifyApiKey reports ok + model", async () => {
  console.log(`e2e: key probe via ${backend.name}`);
  const probe = await verifyApiKey(backend, apiKey);
  expect(probe.ok).toBe(true);
  expect(typeof probe.model).toBe("string");
  expect((probe.model ?? "").length).toBeGreaterThan(0);
  console.log(`e2e: probe status=${probe.status} model=${probe.model}`);
}, 30_000);

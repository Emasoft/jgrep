// WI-7 + WI-9 roadmap features: --estimate (the per-file table of the unified dry run;
// the token model itself is tested in jgrep.test.ts), --budget (hard cap via reservation, kind budget_exhausted; the concurrency cases live in budget.test.ts), --sarif (SARIF 2.1.0
// output) and --envelopes (numeric envelopes inside buildRequest). Core behavior runs
// through jgrep()/buildRequest() with the repo's fake-fetch DI pattern (explicit apiKey
// everywhere, so the lazy key resolver never touches the filesystem); the CLI surface
// (parse flags, the estimate table, the budget stop summary, SARIF end-to-end) runs the
// real entrypoint against a localhost-only fake gateway — no network, no key files,
// --no-cache so ~/.cache/jgrep stays out of it.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import { DEFAULT_PRICE_PER_MTOK, type Fetch } from "./providers";
import {
  buildRequest, jgrep, numberEnvelope, ENVELOPE_MAX_NUMBERS,
  type Chunk,
} from "./jgrep";

process.env.JGREP_NO_MAIN = "1";
const { parse, toSarif, resolveBudgetEnv, USAGE } = await import("./cli");

declare const Bun: {
  serve(opts: { port?: number; fetch(req: Request): Response | Promise<Response> }): {
    port: number;
    stop(closeActiveConnections?: boolean): void;
  };
  spawn(cmd: string[], opts?: { env?: Record<string, string | undefined> }): {
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    exited: Promise<number>;
  };
  spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined> }): {
    exitCode: number | null;
    stdout: { toString(): string };
    stderr: { toString(): string };
  };
};

// ---- fakes -------------------------------------------------------------------

/** n synthetic chunks with distinct files (request chunk ids are batch-local: c0..cN). */
const nChunks = (n: number): Chunk[] =>
  Array.from({ length: n }, (_, i) => ({ file: `f${i}.ts`, start: 1, end: 2, text: `chunk ${i}` }));

/** Always-200 fake: answers every chunk p=0.9, capturing parsed request bodies. */
const okFetch = (usage = 10) => {
  const calls: Record<string, any>[] = [];
  const fetchImpl = (async (_url: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: usage } }), { status: 200 });
  }) as unknown as Fetch;
  return { calls, fetchImpl };
};

/** Async spawn: Bun.spawnSync blocks this process's event loop, which would deadlock
 *  the in-process fake gateway (cli.test.ts pattern). */
const spawn = async (args: string[], env: Record<string, string | undefined>) => {
  const proc = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
};

/** Jev System One fake answering every chunk p=0.9 with LARGE usage — one batch is
 *  already far past a $0.001 budget at the default price ($0.042/Mtok). */
const startBigUsageGateway = () =>
  Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body: { state: { chunks?: { id: string }[] } } = await req.json();
      const answers: Record<string, unknown> = {};
      for (const c of body.state.chunks ?? []) answers[c.id] = { type: "noul", noul: 0.9 };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 1_000_000 } }), { status: 200 });
    },
  });

const gatewayEnv = (port: number) => ({
  ...process.env, JGREP_NO_MAIN: "",
  JEV_GATEWAY_URL: `http://127.0.0.1:${port}/v1/systemone`, JEV_GATEWAY_API_KEY: "test-key",
  JEV_PRICE_PER_MTOK: "0.042", // pinned so the budget math is deterministic
});

// ---- --sarif: SARIF 2.1.0 shape --------------------------------------------------

test("toSarif: valid SARIF 2.1.0 — $schema, version, driver jgrep, one rule, results = hits", () => {
  const hits = [
    { file: "src/a.ts", start: 12, end: 20, text: "x", p: 0.95 },
    { file: "src/b.ts", start: 3, end: 9, text: "y", p: 0.8 },
  ];
  const s = toSarif("swallows errors", hits as any);
  expect(s.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
  expect(s.version).toBe("2.1.0");
  expect(s.runs).toHaveLength(1);
  expect(s.runs[0].tool.driver.name).toBe("jgrep");
  expect(s.runs[0].tool.driver.rules).toHaveLength(1); // one rule per description hash
  const rule = s.runs[0].tool.driver.rules[0];
  expect(rule.shortDescription.text).toBe("swallows errors");
  expect(s.runs[0].results).toHaveLength(hits.length);
  for (const [i, res] of s.runs[0].results.entries()) {
    expect(res.ruleId).toBe(rule.id);
    expect(res.message.text).toBe("swallows errors");
    expect(res.locations).toHaveLength(1);
    expect(res.locations[0].physicalLocation.artifactLocation.uri).toBe(hits[i].file);
    expect(res.locations[0].physicalLocation.region.startLine).toBe(hits[i].start);
  }
  // the rule id is a stable hash of the description
  expect((toSarif("swallows errors", []) as any).runs[0].tool.driver.rules[0].id).toBe(rule.id);
  expect((toSarif("other question", []) as any).runs[0].tool.driver.rules[0].id).not.toBe(rule.id);
});

// ---- --envelopes (WI-9) -----------------------------------------------------------

test("--envelopes: the judged chunk text carries [numbers: 42, 7]; default requests stay byte-identical", () => {
  const c: Chunk = { file: "f.ts", start: 1, end: 2, text: "const retries = 42;\nconst delay = 7;" };
  const on = buildRequest("q", [c], "code", "m", 1, true);
  expect(on.state.chunks[0].code).toBe(c.text + "\n[numbers: 42, 7]");
  const off = buildRequest("q", [c]);
  expect(off.state.chunks[0].code).toBe(c.text); // off by default: the request is untouched
  // the documented regex: negatives and decimals in, plus-signs out
  const d = buildRequest("q", [{ file: "f.ts", start: 1, end: 2, text: "x = -3.14, y = +5, z = 007" }], "code", "m", 1, true);
  expect(d.state.chunks[0].code).toContain("[numbers: -3.14, 5, 007]");
  // capped at the first 20 numbers
  const many = Array.from({ length: 30 }, (_, i) => String(i)).join(" ");
  expect(numberEnvelope(many).match(/\d+/g)).toHaveLength(ENVELOPE_MAX_NUMBERS);
  // a chunk without numbers gets no envelope
  expect(numberEnvelope("no digits here")).toBe("");
});

test("--envelopes: cache keys stay keyed on the RAW chunk text — an envelope re-run replays for free", async () => {
  const chunks = [{ file: "f.ts", start: 1, end: 1, text: "retry 42 times" }];
  const { calls, fetchImpl } = okFetch();
  const cache: Record<string, number> = {};
  await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, envelopes: true, apiKey: "k", fetchImpl, cache });
  expect(calls[0].state.chunks[0].code).toContain("[numbers: 42]");
  const r2 = await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, envelopes: true, apiKey: "k", fetchImpl, cache });
  expect(calls).toHaveLength(1); // served from cache despite the envelope run
  expect(r2.cached).toBe(1);
});

// ---- --budget (WI-7): the stop, at concurrency 1 --------------------------------------------

test("--budget: large usage stops after the first batch; remaining chunks error budget_exhausted; hits and cache kept", async () => {
  const { calls, fetchImpl } = okFetch(1_000_000); // $0.042 per batch at the default price
  const cache: Record<string, number> = {};
  const r = await jgrep("q", nChunks(6), { threshold: 0.7, batch: 2, concurrency: 1, budget: 0.001, apiKey: "k", fetchImpl, cache });
  expect(calls).toHaveLength(1); // 3 batches of 2 — only the first ran
  expect(r.hits.map((h) => h.file)).toEqual(["f0.ts", "f1.ts"]); // the completed batch's hits kept
  expect(r.chunks).toBe(6);
  const stops = r.errors.filter((e) => e.kind === "budget_exhausted");
  expect(stops.map((e) => e.file).sort()).toEqual(["f2.ts", "f3.ts", "f4.ts", "f5.ts"]); // exactly the un-run batches
  expect(stops.every((e) => e.hint === "raise --budget")).toBe(true);
  expect(stops[0].message).toContain("budget exhausted");
  expect(Object.keys(cache)).toHaveLength(2); // paid-for answers still cached
  expect(r.tokens).toBe(1_000_000);
});

test("--budget: a provider-reported cost meters the same way; an under-budget run stays clean", async () => {
  const fetchOf = (cost: number) => (async (_u: unknown, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const answers: Record<string, unknown> = {};
    for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: 0.9 };
    return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 }, cost }), { status: 200 });
  }) as unknown as Fetch;
  const chunks = nChunks(4);
  // $0.6 per batch: after batch 0 the meter ($0.6) exceeds the $0.5 budget
  const over = await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, budget: 0.5, apiKey: "k", fetchImpl: fetchOf(0.6), cache: {} });
  expect(over.hits).toHaveLength(2);
  expect(over.errors.filter((e) => e.kind === "budget_exhausted")).toHaveLength(2);
  // under the budget: a clean run, provider-reported cost passed through
  const under = await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, budget: 10, apiKey: "k", fetchImpl: fetchOf(0.6), cache: {} });
  expect(under.errors).toEqual([]);
  expect(under.hits).toHaveLength(4);
  expect(under.cost).toBeCloseTo(1.2, 12);
});

test("--budget: the meter honors pricePerMtok when the provider reports no cost", async () => {
  const { fetchImpl } = okFetch(1_000_000); // 1M billed tokens per batch, no reported cost
  const chunks = nChunks(4);
  // price 1 $/Mtok => $1 billed per batch: over a $0.5 budget after batch 0
  const r = await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, budget: 0.5, pricePerMtok: 1, apiKey: "k", fetchImpl, cache: {} });
  expect(r.hits).toHaveLength(2);
  expect(r.errors.filter((e) => e.kind === "budget_exhausted")).toHaveLength(2);
  // at $0.042/Mtok the same batches bill $0.042 each: all fit in $0.5
  const cheap = await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, budget: 0.5, pricePerMtok: 0.042, apiKey: "k", fetchImpl, cache: {} });
  expect(cheap.errors).toEqual([]);
});

test("budget_exhausted: non-retryable but never fatal — a long budget stop does not trip the circuit breaker", async () => {
  const { fetchImpl } = okFetch(1_000_000);
  const chunks = nChunks(40); // 20 batches; 19 of them must report the stop, not the breaker
  const r = await jgrep("q", chunks, { threshold: 0.7, batch: 2, concurrency: 1, budget: 0.001, apiKey: "k", fetchImpl, cache: {} });
  expect(r.errors.filter((e) => e.kind === "circuit_breaker_open")).toHaveLength(0);
  expect(r.errors.every((e) => e.kind === "budget_exhausted")).toBe(true);
  expect(r.errors).toHaveLength(38);
  expect(r.hits).toHaveLength(2);
});

// ---- CLI surface: parse flags + env override ----------------------------------------

test("cli parse: --estimate/--sarif/--envelopes are boolean flags; --budget takes dollars (0 legal)", () => {
  expect(parse(["q"])).toMatchObject({ estimate: false, sarif: false, envelopes: false, budget: null });
  expect(parse(["--estimate", "--sarif", "--envelopes", "q", "src/"])).toMatchObject({
    estimate: true, sarif: true, envelopes: true, question: "q", paths: ["src/"],
  });
  expect(parse(["--budget", "0.05", "q"])).toMatchObject({ budget: 0.05 });
  expect(parse(["--budget", "0", "q"]).budget).toBe(0); // legal: nothing is sent
  expect(() => parse(["--budget", "abc", "q"])).toThrow(/numeric option expected/);
  expect(() => parse(["--budget", "-1", "q"])).toThrow(/numeric option expected/);
});

test("resolveBudgetEnv: unset means unlimited; JEV_BUDGET overrides; invalid is fatal", () => {
  expect(resolveBudgetEnv({})).toBeUndefined();
  expect(resolveBudgetEnv({ JEV_BUDGET: "" })).toBeUndefined();
  expect(resolveBudgetEnv({ JEV_BUDGET: " 0.01 " })).toBe(0.01);
  expect(resolveBudgetEnv({ JEV_BUDGET: "0" })).toBe(0);
  expect(() => resolveBudgetEnv({ JEV_BUDGET: "abc" })).toThrow(/JEV_BUDGET must be a non-negative number/);
  expect(() => resolveBudgetEnv({ JEV_BUDGET: "-1" })).toThrow(/JEV_BUDGET must be a non-negative number/);
});

test("USAGE documents the new flags; --help prints them", () => {
  for (const flag of ["--estimate", "--budget <usd>", "--sarif", "--envelopes"]) expect(USAGE).toContain(flag);
  const p = Bun.spawnSync(["bun", "src/cli.ts", "--help"], { env: { ...process.env, JGREP_NO_MAIN: "" } });
  expect(p.exitCode).toBe(0);
  for (const flag of ["--estimate", "--budget", "--sarif", "--envelopes"]) expect(p.stdout.toString()).toContain(flag);
});

// ---- CLI end-to-end over the fake gateway --------------------------------------------

test("cli e2e: --sarif emits a valid SARIF 2.1.0 object whose results are the hits", async () => {
  const server = startBigUsageGateway();
  try {
    const p = await spawn(
      ["bun", "src/cli.ts", "--sarif", "--no-cache", "--api", "gateway", "swallows errors", "src/cli.ts"],
      gatewayEnv(server.port),
    );
    expect(p.exitCode).toBe(0);
    const sarif = JSON.parse(p.stdout);
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toContain("sarif-2.1.0");
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.name).toBe("jgrep");
    expect(sarif.runs[0].results.length).toBeGreaterThan(0);
    for (const res of sarif.runs[0].results) {
      expect(res.message.text).toBe("swallows errors");
      expect(typeof res.locations[0].physicalLocation.artifactLocation.uri).toBe("string");
      expect(typeof res.locations[0].physicalLocation.region.startLine).toBe("number");
    }
  } finally {
    server.stop(true);
  }
}, 20_000);

test("cli e2e: --budget stops the run — summary names the stop, un-run chunks error budget_exhausted, exit 2", async () => {
  const server = startBigUsageGateway();
  try {
    const p = await spawn(
      ["bun", "src/cli.ts", "--json", "--no-cache", "-c", "1", "--api", "gateway", "--budget", "0.001", "swallows errors", "src/cli.ts"],
      gatewayEnv(server.port),
    );
    expect(p.exitCode).toBe(2); // un-run chunks errored: partial-failure semantics
    const hits = JSON.parse(p.stdout);
    expect(hits.length).toBeGreaterThan(0); // the first batch's hits survived
    expect(hits.length).toBeLessThanOrEqual(16); // never more than one batch's worth
    const err = p.stderr;
    expect(err).toContain("budget_exhausted");
    expect(err).toContain("raise --budget");
    expect(err).toContain("stopped by --budget");
    expect(err).toContain("limit $0.001");
  } finally {
    server.stop(true);
  }
}, 20_000);

test("cli e2e: --envelopes reaches the request body ([numbers: …] in the judged chunk text)", async () => {
  let seen: string | undefined;
  const server = Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body: { state: { chunks: { id: string; code: string }[] } } = await req.json();
      seen = body.state.chunks[0]?.code;
      const answers: Record<string, unknown> = {};
      for (const c of body.state.chunks) answers[c.id] = { type: "noul", noul: 0.9 };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-env-"));
  try {
    fs.writeFileSync(path.join(dir, "n.ts"), "export const retries = 42;\nexport const delay = 7;\nexport const more = 1;\nexport const x = 2;\nexport const y = 3;\n");
    const p = await spawn(
      ["bun", "src/cli.ts", "--no-cache", "--envelopes", "--api", "gateway", "many retries", dir],
      gatewayEnv(server.port),
    );
    expect(p.exitCode).toBe(0);
    expect(seen).toContain("[numbers: 42, 7, 1, 2, 3]");
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

// ---- --estimate end-to-end: the dry run needs no key, no network, no cache ------------

test("cli e2e: --estimate prints the per-file table and the estimated line — exit 0, provider-independent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-est-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n");
    fs.writeFileSync(path.join(dir, "b.md"), "# T\n\ntext\n\n## U\n\nmore\n");
    fs.writeFileSync(path.join(dir, "skip.bin"), Buffer.from([0, 1, 2, 0])); // binary: never chunked
    const p = await spawn(["bun", "src/cli.ts", "--estimate", "--no-cache", "whatever", dir], { ...process.env, JGREP_NO_MAIN: "" });
    expect(p.exitCode).toBe(0);
    const out = p.stdout;
    expect(out).toContain(`${path.join(dir, "a.ts")}`);
    expect(out).toContain(`${path.join(dir, "b.md")}`);
    expect(out).not.toContain("skip.bin"); // binaries are skipped by the chunker
    const total = out.split("\n").find((l) => l.startsWith("total"));
    const n = Number(/(\d+)$/.exec(total!)![1]);
    expect(n).toBeGreaterThan(0);
    const line = out.split("\n").find((l) => l.startsWith("estimated:"));
    // the unified dry run: requests a real run would send (16 chunks per request here)
    expect(line).toMatch(/^estimated: \d+ requests, ~\d+ input tokens, ~\$[\d.]+ /);
    expect(Number(/^estimated: (\d+) requests/.exec(line!)![1])).toBe(Math.ceil(n / 16));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

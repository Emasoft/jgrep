// Step 7 CLI-surface tests: parse() flag types/defaults/numeric validation, the
// --api choice enumeration (validated in main() via resolveProvider), and hermetic
// end-to-end error rendering through the real entrypoint. The subprocess scenarios
// all fail during argument/provider resolution — before any cache IO or network
// call — so only stderr/exit-code are observed.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect } from "bun:test";
import { JevProviderError } from "./errors";

declare const process: { env: Record<string, string | undefined> };
declare const Bun: {
  spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined> }): {
    exitCode: number | null;
    stdout: { toString(): string };
    stderr: { toString(): string };
  };
  spawn(cmd: string[], opts?: {
    env?: Record<string, string | undefined>;
    stdout?: string;
    stderr?: string;
  }): { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number> };
  serve(opts: { port?: number; fetch(req: Request): Response | Promise<Response> }): {
    port: number;
    stop(closeActiveConnections?: boolean): void;
  };
};

process.env.JGREP_NO_MAIN = "1";
const { parse } = await import("./cli");
const { resolveProvider } = await import("./providers");

// ---- parse(): new flags --------------------------------------------------------

test("cli parse: new flags parse with correct types and defaults", () => {
  const o = parse(["q"]);
  expect(o).toMatchObject({ api: "", model: "", timeout: 15, requestTimeout: 30, retries: 4, rate: 0, failFast: false, noProbe: false });
  expect(typeof o.timeout).toBe("number");
  expect(typeof o.retries).toBe("number");
  expect(typeof o.failFast).toBe("boolean");
  expect(typeof o.noProbe).toBe("boolean");

  const o2 = parse(["--api", "openrouter", "--model", "~typesafe/jev-1.13", "--timeout", "30", "--request-timeout", "60", "--retries", "2", "--rate", "5", "--fail-fast", "--no-probe", "q", "src/"]);
  expect(o2).toMatchObject({
    api: "openrouter", model: "~typesafe/jev-1.13", timeout: 30, requestTimeout: 60,
    retries: 2, rate: 5, failFast: true, noProbe: true, question: "q", paths: ["src/"],
  });
});

test("cli parse: --api accepts any string; main()'s resolveProvider rejects unknown with all three choices", () => {
  const o = parse(["--api", "unknown", "q"]);
  expect(o.api).toBe("unknown"); // parse itself does not validate — main() does, for the typed error
  let caught: unknown;
  try { resolveProvider(o.api); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(JevProviderError);
  const err = caught as JevProviderError;
  expect(err.kind).toBe("bad_request");
  for (const choice of ["typesafe", "openrouter", "gateway"]) expect(err.message).toContain(choice);
});

test("cli parse: numeric validation covers the new numerics (timeout/request-timeout/retries/rate)", () => {
  for (const flag of ["--timeout", "--request-timeout", "--retries", "--rate"]) {
    expect(() => parse([flag, "abc", "q"])).toThrow(/numeric option expected/);
    expect(() => parse([flag, "-1", "q"])).toThrow(/numeric option expected/);
  }
  expect(() => parse(["--timeout", "0", "--rate", "0", "--retries", "0", "q"])).not.toThrow(); // 0 is legal (batch is not)
});

test("cli parse: --batch must be a positive integer — 0 would spin the batching loop, a fraction overlaps batches", () => {
  expect(() => parse(["-b", "0", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["--batch", "0", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["-b", "1.5", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["-b", "2.5", "q"])).toThrow(/batch must be a positive integer/);
  expect(() => parse(["-b", "abc", "q"])).toThrow(/numeric option expected/); // still the generic numeric check
  expect(() => parse(["-b", "-1", "q"])).toThrow(/numeric option expected/); // caught by the >= 0 check first
  expect(() => parse(["-b", "1", "q"])).not.toThrow();
  expect(() => parse(["-b", "16", "q"])).not.toThrow();
});

test("cli parse: old and new flags coexist (--diff positional heuristic untouched)", () => {
  const o = parse(["--diff", "--json", "--fail-fast", "--api", "openrouter", "--staged", "q"]);
  expect(o).toMatchObject({ json: true, failFast: true, api: "openrouter", diff: ["--staged"], question: "q" });
  const o2 = parse(["--diff", "origin/main", "--no-probe", "--rate", "10", "q", "src/"]);
  expect(o2).toMatchObject({ diff: ["origin/main"], noProbe: true, rate: 10, question: "q", paths: ["src/"] });
});

test("cli: JGREP_NO_MAIN import pattern still works (parse importable, main not auto-run)", () => {
  expect(typeof parse).toBe("function");
});

test("cli parse: --json-errors implies --json; --json alone keeps the array shape", () => {
  expect(parse(["q"])).toMatchObject({ json: false, jsonErrors: false });
  expect(parse(["--json", "q"])).toMatchObject({ json: true, jsonErrors: false });
  expect(parse(["--json-errors", "q"])).toMatchObject({ json: true, jsonErrors: true });
  expect(parse(["--json", "--json-errors", "q"])).toMatchObject({ json: true, jsonErrors: true });
  expect(parse(["--json-errors", "--diff", "--staged", "q"])).toMatchObject({ json: true, jsonErrors: true, diff: ["--staged"] });
});

// ---- main() via the real entrypoint: hermetic subprocess checks -----------------
// JGREP_NO_MAIN leaks into child env from this process (bun test shares one), so it
// is cleared explicitly; JEV_GATEWAY_URL too, so the gateway scenario is deterministic.

const run = (args: string[]) =>
  Bun.spawnSync(["bun", "src/cli.ts", ...args], {
    env: { ...process.env, JGREP_NO_MAIN: "", JEV_GATEWAY_URL: "" },
  });

test("cli main: --api unknown exits 2 with the typed error and the three choices", () => {
  const p = run(["--api", "unknown", "q"]);
  expect(p.exitCode).toBe(2);
  const err = p.stderr.toString();
  expect(err).toContain("bad_request: unknown provider");
  for (const choice of ["typesafe", "openrouter", "gateway"]) expect(err).toContain(choice);
  expect(err).toContain("use one of:"); // the grey hint line under the error
});

test("cli main: gateway without JEV_GATEWAY_URL exits 2 with its hint", () => {
  const p = run(["--api", "gateway", "q"]);
  expect(p.exitCode).toBe(2);
  const err = p.stderr.toString();
  expect(err).toContain("bad_request: gateway provider needs JEV_GATEWAY_URL");
  expect(err).toContain("--api typesafe");
});

test("cli main: a non-numeric numeric flag exits 2 with the plain untyped rendering", () => {
  const p = run(["--rate", "abc", "q"]);
  expect(p.exitCode).toBe(2);
  const err = p.stderr.toString();
  expect(err).toContain("numeric option expected");
  expect(err).not.toContain("bad_request:"); // plain Error keeps today's rendering (no kind prefix)
});

// ---- main() end-to-end over a local fake gateway: the --json output shapes -------
// The 0.4 contract: --json stays the v0.3.0 bare array (upstream requires it),
// --json-errors opts into the object. The shapes are proven through the REAL
// entrypoint: a localhost-only Bun.serve fake speaks the Jev System One protocol
// for chunks and rows, so no network and no key files are touched; --no-cache
// keeps ~/.cache/jgrep out of it.

const HIT_KEYS = ["end", "file", "p", "start", "text"]; // the exact v0.3.0 hit-object keys

/** Jev System One fake: answers every chunk and every row's `match` question with p=0.9. */
const startFakeGateway = () =>
  Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body: { state: { chunks?: { id: string }[]; rows?: { id: string }[] } } = await req.json();
      const answers: Record<string, unknown> = {};
      for (const c of body.state.chunks ?? []) answers[c.id] = { type: "noul", noul: 0.9 };
      for (const r of body.state.rows ?? []) answers[`${r.id}.match`] = { type: "noul", noul: 0.9 };
      return new Response(JSON.stringify({ answers, usage: { input_tokens: 10 } }), { status: 200 });
    },
  });

const gatewayEnv = (port: number) => ({
  ...process.env, JGREP_NO_MAIN: "",
  JEV_GATEWAY_URL: `http://127.0.0.1:${port}/v1/systemone`, JEV_GATEWAY_API_KEY: "test-key",
});

/** Async spawn: Bun.spawnSync BLOCKS this process's event loop, which would
 *  deadlock the in-process fake gateway (the child's requests would sit
 *  unaccepted until its batch deadline). Bun.spawn keeps the loop running. */
const spawn = async (args: string[], env: Record<string, string | undefined>) => {
  const proc = Bun.spawn(args, { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { exitCode: await proc.exited, stdout, stderr };
};

test("cli main code: --json emits the bare v0.3.0 hit array ({file,start,end,p,text}); --json-errors wraps it with errors", async () => {
  const server = startFakeGateway();
  try {
    const p = await spawn(
      ["bun", "src/cli.ts", "--json", "--no-cache", "--api", "gateway", "swallows errors", "src/cli.ts"],
      gatewayEnv(server.port),
    );
    expect(p.exitCode).toBe(0);
    const parsed = JSON.parse(p.stdout);
    expect(Array.isArray(parsed)).toBe(true); // v0.3.0 contract: bare array, NO wrapper, NO errors field
    expect(parsed.length).toBeGreaterThan(0);
    for (const h of parsed) expect(Object.keys(h).sort()).toEqual(HIT_KEYS);

    const p2 = await spawn(
      ["bun", "src/cli.ts", "--json-errors", "--no-cache", "--api", "gateway", "swallows errors", "src/cli.ts"],
      gatewayEnv(server.port),
    );
    expect(p2.exitCode).toBe(0);
    const obj = JSON.parse(p2.stdout);
    expect(Array.isArray(obj)).toBe(false); // opt-in object
    expect(Object.keys(obj).sort()).toEqual(["errors", "hits"]);
    for (const h of obj.hits) expect(Object.keys(h).sort()).toEqual(HIT_KEYS);
    expect(obj.errors).toEqual([]); // clean run: same hits, empty errors
  } finally {
    server.stop(true);
  }
}, 20_000);

test("cli main rows: --json emits the position-aligned flattened array; --json-errors wraps it; --out follows the flag", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = startFakeGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-json-"));
  try {
    const csv = path.join(dir, "rows.csv");
    fs.writeFileSync(csv, "handle\n@a\n@b\n");
    const run = (extra: string[]) =>
      spawn(["bun", "src/cli.ts", "--rows", csv, "beauty?", "--api", "gateway", "--no-cache", ...extra], gatewayEnv(server.port));

    const bare = await run(["--json"]);
    expect(bare.exitCode).toBe(0);
    expect(JSON.parse(bare.stdout)).toEqual([{ match: 0.9 }, { match: 0.9 }]); // bare array, position-aligned

    const obj = JSON.parse((await run(["--json-errors"])).stdout);
    expect(obj).toEqual({ answers: [{ match: 0.9 }, { match: 0.9 }], errors: [] }); // same array under `answers`

    const out = path.join(dir, "out.json");
    expect((await run(["--json", "--out", out])).exitCode).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual([{ match: 0.9 }, { match: 0.9 }]); // the FILE gets the array
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli main: errored chunks/rows never enter the --json array (empty array / null entries) and exit 2", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-err-"));
  try {
    // Unroutable loopback port: connection-refused is instant, every chunk/row errors.
    const dead = { ...process.env, JGREP_NO_MAIN: "", JEV_GATEWAY_URL: "http://127.0.0.1:1/v1/systemone", JEV_GATEWAY_API_KEY: "test-key" };
    const csv = path.join(dir, "rows.csv");
    fs.writeFileSync(csv, "handle\n@a\n@b\n");
    const p = await spawn(
      ["bun", "src/cli.ts", "--json", "--no-cache", "--api", "gateway", "--retries", "0", "--timeout", "1", "swallows errors", "src/cli.ts"],
      dead,
    );
    expect(p.exitCode).toBe(2); // partial failure surfaced via the exit code, not the payload
    expect(JSON.parse(p.stdout)).toEqual([]); // no hits: the bare array is just empty

    const p2 = await spawn(
      ["bun", "src/cli.ts", "--rows", csv, "beauty?", "--api", "gateway", "--retries", "0", "--timeout", "1", "--no-cache", "--json"],
      dead,
    );
    expect(p2.exitCode).toBe(2);
    expect(JSON.parse(p2.stdout)).toEqual([null, null]); // errored rows: null entries, position-stable
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli main rows single description: --out writes a CSV of the shown hits (no --json needed), stdout keeps the pretty output", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const server = startFakeGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-rowsout-"));
  try {
    const csv = path.join(dir, "rows.csv");
    fs.writeFileSync(csv, "handle\n@a\n@b\n@c\n");
    const out = path.join(dir, "bots.csv");
    // --all so `shown` covers every scored row (threshold-only would still be a CSV);
    // no --json: this is the branch that used to ignore --out entirely.
    const p = await spawn(
      ["bun", "src/cli.ts", "--rows", csv, "beauty?", "--api", "gateway", "--no-cache", "--all", "--out", out],
      gatewayEnv(server.port),
    );
    expect(p.exitCode).toBe(0);
    expect(p.stderr.toString()).toContain(`wrote ${out}`); // written for real, not just claimed
    // stdout keeps the pretty hits even though the file landed
    expect(p.stdout).toContain("@a");

    const text = fs.readFileSync(out, "utf8");
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("row,p,match"); // header: source row number, p, flattened answer columns
    expect(lines).toHaveLength(4); // header + 3 data lines (one per scored row)
    const body = lines.slice(1).map((l) => l.split(","));
    expect(body.every((cols) => cols.length === 3)).toBe(true);
    // `row` is the source row number: 1-based + the header line = s.i + 2
    expect(body.map((cols) => Number(cols[0]))).toEqual([2, 3, 4]);
    expect(body.every((cols) => Number(cols[1]) === 0.9 && Number(cols[2]) === 0.9)).toBe(true);
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

test("cli main: an invalid JEV_PRICE_PER_MTOK is fatal before any request is made (rows mode used to bill first)", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: async () => {
      requests++;
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-price-"));
  try {
    const csv = path.join(dir, "rows.csv");
    fs.writeFileSync(csv, "handle\n@a\n@b\n");
    const p = await spawn(
      ["bun", "src/cli.ts", "--rows", csv, "beauty?", "--api", "gateway", "--no-cache"],
      { ...gatewayEnv(server.port), JEV_PRICE_PER_MTOK: "abc" },
    );
    expect(p.exitCode).toBe(2);
    expect(p.stderr.toString()).toContain("JEV_PRICE_PER_MTOK must be a positive number");
    expect(requests).toBe(0); // died at startup: nothing was spent
  } finally {
    server.stop(true);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);

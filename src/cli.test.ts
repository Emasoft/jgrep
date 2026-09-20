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
  expect(() => parse(["--timeout", "0", "--rate", "0", "--retries", "0", "q"])).not.toThrow(); // 0 is legal
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

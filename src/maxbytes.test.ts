// File size policy — USER 2026-10-02: "remove the input limit, make it opt-in only if
// --max-bytes is used. otherwise both tools must read any file size. add an hard limit of
// 100MB just to prevent system hungs." Files of any size up to the 100 MB hard ceiling are
// read; --max-bytes N / JGREP_MAX_BYTES=N is an opt-in LOWER per-file limit; the ceiling
// cannot be raised (exit 1). Over-limit files are skipped and reported; binaries stay skipped.
// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect, spyOn } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
import { chunkPaths, HARD_MAX_BYTES } from "./jgrep";

declare const Bun: { spawnSync(cmd: string[], opts?: { env?: Record<string, string | undefined> }): { exitCode: number | null; stdout: { toString(): string }; stderr: { toString(): string } } };

/** dir with small.ts and a 1.5 MB big.ts (text, many lines). */
const fixture = () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-size-")));
  fs.writeFileSync(path.join(dir, "small.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "big.ts"), "export const filler = 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';\n".repeat(34_000)); // ~1.5 MB
  return dir;
};
const filesOf = (cs: { file: string }[]) => [...new Set(cs.map((c) => path.basename(c.file)))].sort();

test("no default per-file limit: a file over 1 MB is chunked and searched", () => {
  const dir = fixture();
  try {
    expect(fs.statSync(path.join(dir, "big.ts")).size).toBeGreaterThan(1_000_000);
    expect(filesOf(chunkPaths([dir]))).toEqual(["big.ts", "small.ts"]); // before: big.ts silently skipped (1 MB cap)
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("--max-bytes (opt-in): a file over the limit is skipped and reported", () => {
  const dir = fixture();
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(filesOf(chunkPaths([dir], { maxBytes: 1_000_000 }))).toEqual(["small.ts"]);
    expect(String(err.mock.calls[0]?.[0])).toMatch(/skipped 1 file.*over.*1000000 bytes.*big\.ts/);
  } finally { err.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("the 100 MB hard ceiling applies without any flag (sparse file: nothing is read)", () => {
  const dir = fixture();
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(HARD_MAX_BYTES).toBe(104_857_600);
    const huge = path.join(dir, "huge.ts");
    fs.writeFileSync(huge, "");
    fs.truncateSync(huge, HARD_MAX_BYTES + 1); // sparse: no disk, no read — skipped on size alone
    expect(filesOf(chunkPaths([dir]))).toEqual(["big.ts", "small.ts"]);
    expect(String(err.mock.calls[0]?.[0])).toContain("huge.ts");
  } finally { err.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("cli: --max-bytes / JGREP_MAX_BYTES apply; a value above the 100 MB ceiling exits 1", () => {
  const dir = fixture();
  try {
    const env = { ...process.env, JGREP_NO_MAIN: "", JGREP_MAX_BYTES: "" };
    const run = (args: string[], e = env) => Bun.spawnSync(["bun", "src/cli.ts", "--estimate", "--no-cache", ...args, "q", dir], { env: e });
    expect(run([]).stdout.toString()).toContain("big.ts");
    const capped = run(["--max-bytes", "1000000"]);
    expect(capped.exitCode).toBe(0);
    expect(capped.stdout.toString()).not.toContain("big.ts");
    expect(run([], { ...env, JGREP_MAX_BYTES: "1000000" }).stdout.toString()).not.toContain("big.ts");
    const over = run(["--max-bytes", String(HARD_MAX_BYTES + 1)]);
    expect(over.exitCode).toBe(1);
    expect(over.stderr.toString()).toContain("100 MB");
    expect(run([], { ...env, JGREP_MAX_BYTES: "200000000" }).exitCode).toBe(1);
    expect(run(["--max-bytes", "abc"]).exitCode).toBe(2); // not a byte count: a usage error like every other bad number
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}, 30_000);

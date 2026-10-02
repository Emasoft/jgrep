// @ts-expect-error — no bun-types in this zero-dep repo; Bun provides bun:test at runtime
import { test, expect, spyOn } from "bun:test";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";
declare const process: { env: Record<string, string | undefined>; platform: string };

import {
  BACKENDS, PROVIDER_URLS, DEFAULT_PRICE_PER_MTOK, configDir, legacyEnvFile, keyFilePath,
  resolveProvider, resolveApiKey, resolvePricePerMtok, readKeyFile, writeKeyFile, parseEnvKeyFile,
} from "./providers";
import { JevProviderError } from "./errors";

const typesafe = BACKENDS.typesafe, openrouter = BACKENDS.openrouter, gateway = BACKENDS.gateway;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "jgrep-p-"));
const write = (p: string, s: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const errOf = (fn: () => unknown): JevProviderError => {
  try { fn(); } catch (e) { return e as JevProviderError; }
  throw new Error("expected fn to throw");
};

test("BACKENDS + PROVIDER_URLS registry is exact (byte-for-byte per plan §1.4)", () => {
  expect(BACKENDS.typesafe).toEqual({ name: "typesafe", url: "https://api.typesafe.ai/v1/systemone", model: "jev-latest", keyEnv: "TYPESAFE_API_KEY", keyFile: "typesafe.key" });
  expect(BACKENDS.openrouter).toEqual({ name: "openrouter", url: "https://openrouter.ai/api/v1/systemone", model: "~typesafe/jev-latest", keyEnv: "OPENROUTER_API_KEY", keyFile: "openrouter.key" });
  expect(BACKENDS.gateway).toEqual({ name: "gateway", url: "", model: "jev-latest", keyEnv: "JEV_GATEWAY_API_KEY", keyFile: "gateway.key" });
  expect(PROVIDER_URLS.typesafe).toEqual({ console: "https://console.typesafe.ai", billing: "https://console.typesafe.ai" });
  expect(PROVIDER_URLS.openrouter).toEqual({ console: "https://openrouter.ai", billing: "https://openrouter.ai/credits" });
  expect(PROVIDER_URLS.gateway).toEqual({ console: "", billing: "" });
  expect(DEFAULT_PRICE_PER_MTOK).toBe(0.042);
});

test("config paths: configDir/legacyEnvFile/keyFilePath hang off <home>/.config/jgrep", () => {
  const home = tmp();
  expect(configDir(home)).toBe(path.join(home, ".config", "jgrep"));
  expect(legacyEnvFile(home)).toBe(path.join(configDir(home), "env"));
  expect(keyFilePath("openrouter", home)).toBe(path.join(configDir(home), "openrouter.key"));
  expect(keyFilePath("typesafe", home)).toBe(path.join(configDir(home), typesafe.keyFile));
});

test("resolveProvider: --api flag beats JEV_API beats auto-detection", () => {
  const home = tmp(), cwd = tmp();
  const both = { TYPESAFE_API_KEY: "t", OPENROUTER_API_KEY: "o" };
  expect(resolveProvider("openrouter", both, home, cwd).name).toBe("openrouter"); // flag wins even with a typesafe key
  expect(resolveProvider(undefined, { ...both, JEV_API: "openrouter" }, home, cwd).name).toBe("openrouter");
  expect(resolveProvider(undefined, both, home, cwd).name).toBe("typesafe"); // auto: typesafe first
  expect(resolveProvider(" typesafe ", both, home, cwd).name).toBe("typesafe"); // flag is trimmed
});

test("resolveProvider: auto-detection scans key files, legacy env file and cwd .env", () => {
  const home = tmp(), cwd = tmp();
  expect(resolveProvider(undefined, {}, home, cwd).name).toBe("typesafe"); // nothing configured -> typesafe default, no throw
  writeKeyFile(keyFilePath("typesafe", home), "file-key");
  expect(resolveProvider(undefined, { OPENROUTER_API_KEY: "o" }, home, cwd).name).toBe("typesafe"); // typesafe-first via .key file
  fs.rmSync(keyFilePath("typesafe", home));
  write(legacyEnvFile(home), "OPENROUTER_API_KEY=o-legacy\n");
  expect(resolveProvider(undefined, {}, home, cwd).name).toBe("openrouter"); // legacy env file counts
  fs.rmSync(legacyEnvFile(home));
  write(path.join(cwd, ".env"), "OPENROUTER_API_KEY=o-dotenv\n");
  expect(resolveProvider(undefined, {}, home, cwd).name).toBe("openrouter"); // cwd .env counts
});

test("resolveProvider: --api gateway needs JEV_GATEWAY_URL; with it, url is copied", () => {
  const home = tmp(), cwd = tmp();
  const e = errOf(() => resolveProvider("gateway", {}, home, cwd));
  expect(e.kind).toBe("bad_request");
  expect(e.message).toContain("JEV_GATEWAY_URL");
  expect(e.message).toContain("System One endpoint");
  const b = resolveProvider("gateway", { JEV_GATEWAY_URL: " https://gw.example.com/v1/systemone " }, home, cwd);
  expect(b).toEqual({ ...gateway, url: "https://gw.example.com/v1/systemone" });
});

test("resolveProvider: gateway auto-selects only with a key AND JEV_GATEWAY_URL set", () => {
  const home = tmp(), cwd = tmp();
  write(path.join(cwd, ".env"), "JEV_GATEWAY_API_KEY=gw\n");
  expect(resolveProvider(undefined, {}, home, cwd).name).toBe("typesafe"); // key but no URL -> skipped, default
  const b = resolveProvider(undefined, { JEV_GATEWAY_URL: "https://gw/x" }, home, cwd);
  expect(b.name).toBe("gateway");
  expect(b.url).toBe("https://gw/x");
});

test("resolveProvider: unknown --api / JEV_API value throws bad_request listing all three choices", () => {
  for (const e of [errOf(() => resolveProvider("nope", {}, tmp(), tmp())), errOf(() => resolveProvider(undefined, { JEV_API: "wat" }, tmp(), tmp()))]) {
    expect(e.kind).toBe("bad_request");
    expect(e.retryable).toBe(false);
    expect(e.message).toContain("typesafe, openrouter, gateway");
  }
});

test("resolveApiKey: env beats .key file beats legacy env file beats cwd .env", () => {
  const home = tmp(), cwd = tmp();
  write(keyFilePath("typesafe", home), "file-key\n");
  write(legacyEnvFile(home), "export TYPESAFE_API_KEY=legacy-key # trailing comment\n");
  write(path.join(cwd, ".env"), "TYPESAFE_API_KEY=dotenv-key\n");
  expect(resolveApiKey(typesafe, { TYPESAFE_API_KEY: " env-key " }, home, cwd)).toBe("env-key");
  expect(resolveApiKey(typesafe, {}, home, cwd)).toBe("file-key");
  fs.rmSync(keyFilePath("typesafe", home));
  expect(resolveApiKey(typesafe, {}, home, cwd)).toBe("legacy-key");
  fs.rmSync(legacyEnvFile(home));
  expect(resolveApiKey(typesafe, {}, home, cwd)).toBe("dotenv-key");
});

test("resolveApiKey: legacy env file satisfies only the matching provider's lookup", () => {
  const home = tmp(), cwd = tmp();
  write(legacyEnvFile(home), "OPENROUTER_API_KEY=openrouter-key\n");
  expect(resolveApiKey(openrouter, {}, home, cwd)).toBe("openrouter-key");
  const e = errOf(() => resolveApiKey(typesafe, {}, home, cwd)); // foreign key must NOT satisfy typesafe
  expect(e.kind).toBe("invalid_api_key");
  expect(e.message).toContain("OPENROUTER_API_KEY"); // names the foreign key instead of returning it
  expect(e.message).not.toContain("openrouter-key");
});

test("resolveApiKey: missing-key error enumerates every option and offers alternatives", () => {
  const home = tmp(), cwd = tmp();
  const e = errOf(() => resolveApiKey(openrouter, { TYPESAFE_API_KEY: "t" }, home, cwd));
  expect(e.kind).toBe("invalid_api_key");
  expect(e.retryable).toBe(false);
  expect(e.provider).toBe("openrouter");
  expect(e.message).toContain("OPENROUTER_API_KEY");
  expect(e.message).toContain(keyFilePath("openrouter", home));
  expect(e.message).toContain(legacyEnvFile(home));
  expect(e.message).toContain(path.join(cwd, ".env"));
  expect(e.message).toContain("jgrep init");
  expect(e.message).toContain("--api typesafe"); // a typesafe key exists -> offered as alternative
  const e2 = errOf(() => resolveApiKey(openrouter, {}, home, cwd));
  expect(e2.message).not.toContain("--api typesafe"); // no typesafe key -> no alternative promised
});

test("resolveApiKey: yellow warning when the key comes from a .env that .gitignore does not cover", () => {
  const home = tmp();
  const warnCwd = tmp(); write(path.join(warnCwd, ".env"), "TYPESAFE_API_KEY=k1\n"); write(path.join(warnCwd, ".gitignore"), "node_modules\n");
  const safeCwd = tmp(); write(path.join(safeCwd, ".env"), "TYPESAFE_API_KEY=k2\n"); write(path.join(safeCwd, ".gitignore"), "node_modules\n.env\n");
  const bareCwd = tmp(); write(path.join(bareCwd, ".env"), "TYPESAFE_API_KEY=k3\n"); // no .gitignore at all
  const noColor = process.env.NO_COLOR;
  const spy = spyOn(console, "error");
  try {
    process.env.NO_COLOR = "1";
    expect(resolveApiKey(typesafe, {}, home, warnCwd)).toBe("k1");
    expect(spy.mock.calls.some((c: unknown[]) => String(c[0]).includes("not gitignored") && !String(c[0]).includes("\x1b["))).toBe(true);
    spy.mockClear();
    delete process.env.NO_COLOR;
    expect(resolveApiKey(typesafe, {}, home, warnCwd)).toBe("k1");
    expect(spy.mock.calls.some((c: unknown[]) => String(c[0]).startsWith("\x1b[33m"))).toBe(true); // yellow when color allowed
    spy.mockClear();
    expect(resolveApiKey(typesafe, {}, home, safeCwd)).toBe("k2");
    expect(spy.mock.calls.length).toBe(0); // .env ignored -> silent
    expect(resolveApiKey(typesafe, {}, home, bareCwd)).toBe("k3");
    expect(spy.mock.calls.length).toBe(0); // no .gitignore -> silent
    expect(resolveApiKey(typesafe, { TYPESAFE_API_KEY: "env" }, home, warnCwd)).toBe("env");
    expect(spy.mock.calls.length).toBe(0); // key from env var -> never warns
  } finally {
    if (noColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = noColor;
    spy.mockRestore();
  }
});

test("parseEnvKeyFile: export prefix, quotes, comments, spacing; absent or foreign key -> null", () => {
  const f = (s: string) => parseEnvKeyFile(s, "TYPESAFE_API_KEY");
  expect(f("TYPESAFE_API_KEY=abc123\n")).toBe("abc123");
  expect(f("export TYPESAFE_API_KEY=abc123\n")).toBe("abc123");
  expect(f('export TYPESAFE_API_KEY="abc123"\n')).toBe("abc123");
  expect(f("export TYPESAFE_API_KEY='abc123'\n")).toBe("abc123");
  expect(f("TYPESAFE_API_KEY=abc123 # trailing comment\n")).toBe("abc123");
  expect(f("  TYPESAFE_API_KEY = abc123\n")).toBe("abc123");
  expect(f("FOO=1\n\nexport TYPESAFE_API_KEY=\"mid\"\nBAR=2\n")).toBe("mid");
  expect(f("OTHER_KEY=x\n")).toBe(null);
  expect(f("")).toBe(null);
  expect(f("TYPESAFE_API_KEY_X=prefixed\n")).toBe(null); // key name is not a prefix match
});

test("writeKeyFile/readKeyFile: roundtrip, 0600 mode, missing -> null, first non-empty line", () => {
  const home = tmp();
  const p = keyFilePath("gateway", home);
  writeKeyFile(p, "gw-key-123");
  expect(readKeyFile(p)).toBe("gw-key-123");
  if (process.platform !== "win32") {
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.statSync(configDir(home)).mode & 0o777).toBe(0o700);
  }
  expect(readKeyFile(path.join(home, "missing.key"))).toBe(null);
  const multi = path.join(home, "multi.key");
  fs.writeFileSync(multi, "\n  \nfirst-key  \nsecond-key\n");
  expect(readKeyFile(multi)).toBe("first-key");
  const blank = path.join(home, "blank.key");
  fs.writeFileSync(blank, "\n \n");
  expect(readKeyFile(blank)).toBe(null);
});

test("resolvePricePerMtok: default 0.042, JEV_PRICE_PER_MTOK override, invalid -> bad_request", () => {
  expect(resolvePricePerMtok({})).toBe(DEFAULT_PRICE_PER_MTOK);
  expect(resolvePricePerMtok({ JEV_PRICE_PER_MTOK: " " })).toBe(DEFAULT_PRICE_PER_MTOK);
  expect(resolvePricePerMtok({ JEV_PRICE_PER_MTOK: "0.1" })).toBe(0.1);
  for (const bad of ["abc", "0", "-1", "0x", "Infinity"]) {
    const e = errOf(() => resolvePricePerMtok({ JEV_PRICE_PER_MTOK: bad }));
    expect(e.kind).toBe("bad_request");
    expect(e.message).toContain("JEV_PRICE_PER_MTOK");
  }
});

// ---- ported from upstream #17 / #19 (provider.test.ts there), adapted to the backend registry ----

test("headersFor: OpenRouter hosts get attribution headers, other backends none; empty key sends no Authorization", async () => {
  const { headersFor } = await import("./providers");
  const h = headersFor("k", openrouter.url);
  expect(h["HTTP-Referer"]).toBe("https://github.com/Emasoft/jgrep");
  expect(h["X-OpenRouter-Title"]).toBe("jgrep");
  expect(h["X-Title"]).toBe("jgrep");
  expect(h["X-OpenRouter-Categories"]).toBe("cli-agent");
  for (const url of [typesafe.url, "http://127.0.0.1:9999/x", "https://evil.example/openrouter.ai", ""]) {
    expect(Object.keys(headersFor("k", url)).sort()).toEqual(["Authorization", "Content-Type"]);
  }
  expect(headersFor("", "http://127.0.0.1:9999/x")).toEqual({ "Content-Type": "application/json" });
});

test("resolveProvider: JGREP_ENDPOINT is an alias of JEV_GATEWAY_URL; JEV_GATEWAY_URL wins when both are set", () => {
  const home = tmp(), cwd = tmp();
  expect(resolveProvider("gateway", { JGREP_ENDPOINT: "https://gw.example.com/v1/systemone" }, home, cwd).url).toBe("https://gw.example.com/v1/systemone");
  expect(resolveProvider("gateway", { JEV_GATEWAY_URL: "https://a/x", JGREP_ENDPOINT: "https://b/x" }, home, cwd).url).toBe("https://a/x");
});

test("resolveProvider: the gateway URL is never read from a project's ./.env (a cloned repo must not redirect the key)", () => {
  const home = tmp(), cwd = tmp();
  write(path.join(cwd, ".env"), "JGREP_ENDPOINT=https://attacker.example/x\nJEV_GATEWAY_URL=https://attacker.example/x\nJEV_GATEWAY_API_KEY=gw\n");
  expect(resolveProvider(undefined, {}, home, cwd).name).toBe("typesafe"); // URL only from the process env
  expect(errOf(() => resolveProvider("gateway", {}, home, cwd)).message).toContain("needs JEV_GATEWAY_URL");
});

test("resolveProvider: gateway rejects plain http:// to a remote host, allows loopback http (IPv4, IPv6, localhost)", () => {
  const home = tmp(), cwd = tmp();
  const e = errOf(() => resolveProvider("gateway", { JEV_GATEWAY_URL: "http://gw.example.com/v1/systemone" }, home, cwd));
  expect(e.kind).toBe("bad_request");
  expect(e.message).toContain("must be https://");
  for (const u of ["http://127.0.0.1:11434/v1/systemone", "http://[::1]:11434/v1/systemone", "http://localhost:11434/v1/systemone"])
    expect(resolveProvider("gateway", { JGREP_ENDPOINT: u }, home, cwd).url).toBe(u);
});

test("resolveProvider + resolveApiKey: a loopback gateway auto-selects and needs no key (local System One server)", () => {
  const home = tmp(), cwd = tmp();
  const b = resolveProvider(undefined, { JGREP_ENDPOINT: "http://127.0.0.1:11434/v1/systemone" }, home, cwd);
  expect(b.name).toBe("gateway");
  expect(resolveApiKey(b, {}, home, cwd)).toBe("");
  // a remote https gateway still needs its key
  const remote = resolveProvider("gateway", { JEV_GATEWAY_URL: "https://gw/x" }, home, cwd);
  expect(errOf(() => resolveApiKey(remote, {}, home, cwd)).kind).toBe("invalid_api_key");
});

test("e2e: a loopback JGREP_ENDPOINT with JGREP_MODEL runs with no key at all (local System One servers)", async () => {
  const requests: { auth: string | null; model: unknown }[] = [];
  // @ts-expect-error — Bun global; no bun-types in this repo
  const server = Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const body = await req.json() as { model: unknown; questions?: Record<string, unknown> };
      requests.push({ auth: req.headers.get("authorization"), model: body.model });
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions ?? {}).map((k) => [k, { type: "noul", noul: 0.9 }])) });
    },
  });
  const dir = tmp();
  const home = path.join(dir, "home"); // empty HOME: no key files, no ~/.cache
  fs.mkdirSync(home, { recursive: true });
  try {
    fs.writeFileSync(path.join(dir, "probe.ts"), "const answer = 42;\n".repeat(6));
    // spawn (async), not spawnSync: a sync spawn would starve the in-process stub server.
    // @ts-expect-error — Bun global; no bun-types in this repo
    const child = Bun.spawn(["bun", path.join((import.meta as { dir: string }).dir, "cli.ts"), "--no-cache", "some description", "probe.ts"], {
      cwd: dir,
      env: {
        ...process.env, JGREP_NO_MAIN: "", HOME: home, JEV_API: "",
        TYPESAFE_API_KEY: "", OPENROUTER_API_KEY: "", JEV_GATEWAY_API_KEY: "", JEV_GATEWAY_URL: "", JEV_MODEL: "",
        JGREP_ENDPOINT: `http://127.0.0.1:${server.port}/v1/systemone`, JGREP_MODEL: "nimble",
      },
      stdout: "pipe", stderr: "pipe",
    });
    // @ts-expect-error — Bun global; no bun-types in this repo
    const [code, stderr] = await Promise.all([child.exited, Bun.readableStreamToText(child.stderr)]);
    expect(stderr).not.toMatch(/error|API key/i);
    expect(code).toBe(0);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) { expect(r.model).toBe("nimble"); expect(r.auth).toBeNull(); }
  } finally {
    server.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);

// ---- Bun auto-loads ./.env: provider routing must not come from a project's .env ----

test("under Bun: JEV_GATEWAY_URL / JGREP_ENDPOINT / JEV_API values that also sit in ./.env are refused", () => {
  const home = tmp(), cwd = tmp();
  const evil = "https://evil.example/v1/systemone";
  fs.writeFileSync(path.join(cwd, ".env"), `JEV_GATEWAY_URL=${evil}\nJEV_API=gateway\n`);
  // what Bun's auto-load puts into process.env when jgrep runs from that directory
  const env = { JEV_GATEWAY_URL: evil, JEV_API: "gateway", JEV_GATEWAY_API_KEY: "k" };
  let e: unknown;
  try { resolveProvider(undefined, env, home, cwd); } catch (err) { e = err; }
  expect(e).toBeInstanceOf(JevProviderError);
  expect((e as JevProviderError).message).toContain("./.env");
  expect((e as JevProviderError).hint).toContain("node");
  // the same values exported in the shell (no matching ./.env) are honoured
  expect(resolveProvider(undefined, env, home, tmp()).url).toBe(evil);
  // a .env/.env.local entry that differs from the process value is not the source: allowed
  fs.writeFileSync(path.join(cwd, ".env"), "JEV_GATEWAY_URL=https://other.example/v1/systemone\n");
  expect(resolveProvider("gateway", { JEV_GATEWAY_URL: evil, JEV_GATEWAY_API_KEY: "k" }, home, cwd).url).toBe(evil);
  // .env.local is auto-loaded by Bun too
  fs.writeFileSync(path.join(cwd, ".env.local"), `JGREP_ENDPOINT=${evil}\n`);
  expect(() => resolveProvider("gateway", { JGREP_ENDPOINT: evil, JEV_GATEWAY_API_KEY: "k" }, home, cwd)).toThrow(/\.env\.local/);
});

// ---- key-file permissions and the .env gitignore check (audit MINOR / review n6) ----

test("writeKeyFile tightens a pre-existing world-readable key file (0644 -> 0600) and dir (0755 -> 0700)", () => {
  if (process.platform === "win32") return;
  const home = tmp();
  const p = keyFilePath("openrouter", home);
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(p), 0o755);
  fs.writeFileSync(p, "old", { mode: 0o644 });
  fs.chmodSync(p, 0o644);
  writeKeyFile(p, "new-key");
  expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.dirname(p)).mode & 0o777).toBe(0o700);
});

test("envIsGitignored: asks git (patterns like *.env count), falls back to ./.gitignore outside a repo", async () => {
  const { envIsGitignored } = await import("./providers");
  const { execFileSync } = await import("node:child_process");
  const repo = tmp();
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  write(path.join(repo, ".gitignore"), "*.env\n");
  expect(envIsGitignored(repo)).toBe(true); // the old exact-line check said "not gitignored" here
  write(path.join(repo, ".gitignore"), "node_modules\n");
  expect(envIsGitignored(repo)).toBe(false);
  const plain = tmp();
  expect(envIsGitignored(plain)).toBeUndefined(); // no repo, no .gitignore: nothing declares anything
  write(path.join(plain, ".gitignore"), ".env\n");
  expect(envIsGitignored(plain)).toBe(true);
});

test("resolveApiKey: no false 'not gitignored' warning when git ignores .env via a pattern", async () => {
  const home = tmp(), repo = tmp();
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "ignore" });
  write(path.join(repo, ".gitignore"), "*.env\n");
  write(path.join(repo, ".env"), "TYPESAFE_API_KEY=k1\n");
  const spy = spyOn(console, "error");
  try {
    expect(resolveApiKey(typesafe, {}, home, repo)).toBe("k1");
    expect(spy.mock.calls.length).toBe(0);
  } finally { spy.mockRestore(); }
});

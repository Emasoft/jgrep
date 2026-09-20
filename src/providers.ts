// WI-1 provider registry + key resolution: backend table, `--api`/`JEV_API`/auto
// precedence, per-provider API-key lookup chain and key-file IO. HTTP engine
// (postSystemOne/verifyApiKey/RateLimiter) lands in the next step. No deps.
import { JevProviderError } from "./errors";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo; the surface used is trivial
import * as fs from "node:fs";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as os from "node:os";
// @ts-expect-error — no @types/node in this zero-dep Bun-only repo
import * as path from "node:path";

// Ambient so the file typechecks without node types; keep all process usage to this shape.
declare const process: { env: Record<string, string | undefined>; cwd(): string; platform: string };

/** process.env-shaped map; stand-in for NodeJS.ProcessEnv while the repo ships no node types. */
export type Env = Record<string, string | undefined>;

export interface Backend {
  name: "typesafe" | "openrouter" | "gateway";
  url: string;      // full System One endpoint ("" for gateway until resolved from env)
  model: string;    // default model id
  keyEnv: string;   // env var holding the API key
  keyFile: string;  // basename inside ~/.config/jgrep
}

export const BACKENDS: Record<Backend["name"], Backend> = {
  typesafe:   { name: "typesafe",   url: "https://api.typesafe.ai/v1/systemone",      model: "jev-latest",           keyEnv: "TYPESAFE_API_KEY",    keyFile: "typesafe.key" },
  openrouter: { name: "openrouter", url: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest", keyEnv: "OPENROUTER_API_KEY",  keyFile: "openrouter.key" },
  gateway:    { name: "gateway",    url: "",                                          model: "jev-latest",           keyEnv: "JEV_GATEWAY_API_KEY", keyFile: "gateway.key" },
};

const PROVIDER_ORDER: Backend["name"][] = ["typesafe", "openrouter", "gateway"];

// console/billing URLs per provider, shared by init.ts and CLI hints (WI-12)
export const PROVIDER_URLS: Record<Backend["name"], { console: string; billing: string }> = {
  typesafe:   { console: "https://console.typesafe.ai", billing: "https://console.typesafe.ai" },
  openrouter: { console: "https://openrouter.ai",          billing: "https://openrouter.ai/credits" },
  gateway:    { console: "",                               billing: "" },
};

// ---- price -------------------------------------------------------------------
export const DEFAULT_PRICE_PER_MTOK = 0.042;

/** $/Mtok for cost math: JEV_PRICE_PER_MTOK override; invalid (non-finite, <= 0) is fatal. */
export function resolvePricePerMtok(env: Env = process.env): number {
  const raw = env.JEV_PRICE_PER_MTOK?.trim();
  if (!raw) return DEFAULT_PRICE_PER_MTOK;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new JevProviderError("bad_request", `JEV_PRICE_PER_MTOK must be a positive number (got "${raw}")`, {
      provider: "generic", retryable: false, hint: "JEV_PRICE_PER_MTOK is dollars per million input tokens, e.g. 0.042",
    });
  }
  return n;
}

// ---- config paths ------------------------------------------------------------
export function configDir(homeDir: string = os.homedir()): string { return path.join(homeDir, ".config", "jgrep"); }
export function legacyEnvFile(homeDir: string = os.homedir()): string { return path.join(configDir(homeDir), "env"); }
export function keyFilePath(name: Backend["name"] | string, homeDir: string = os.homedir()): string {
  return path.join(configDir(homeDir), `${name}.key`);
}

// ---- key files & env-style parsing -------------------------------------------
/** Same hand-rolled parser as the old jgrep.ts resolver: tolerates an `export ` prefix,
 *  quotes, spacing and trailing # comments; first matching line wins. */
export function parseEnvKeyFile(text: string, keyEnv: string): string | null {
  const m = new RegExp(`^\\s*(?:export\\s+)?${keyEnv}\\s*=\\s*["']?([^"'\\r\\n#]+)`, "m").exec(text);
  return m ? m[1].trim() : null;
}

/** First non-empty trimmed line of the file; null when missing or unreadable. */
export function readKeyFile(p: string): string | null {
  let text: string;
  try { text = fs.readFileSync(p, "utf8"); } catch { return null; }
  for (const line of text.split(/\r?\n/)) { const t = line.trim(); if (t) return t; }
  return null;
}

/** mkdir -p (0700) + write (0600). chmod 600 is a no-op on Windows — say so. */
export function writeKeyFile(p: string, key: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  fs.writeFileSync(p, key, { mode: 0o600 });
  if (process.platform === "win32") console.error("warning: chmod 600 is a no-op on Windows — protect %USERPROFILE%\\.config\\jgrep manually");
}

function readTextOrNull(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

// ---- key resolution (§1.4 lookup order) ---------------------------------------
type KeyOrigin = "env" | "keyfile" | "legacy" | "dotenv";

/** Full per-provider chain: keyEnv env var > <name>.key file > legacy
 *  ~/.config/jgrep/env > cwd .env. Silent — callers decide about warnings/errors.
 *  The legacy file may hold any provider's key, but only the requested provider's
 *  entry satisfies the lookup: a foreign provider's key is never handed back. */
function findKey(b: Backend, env: Env, homeDir: string, cwd: string): { key: string; origin: KeyOrigin } | null {
  const fromEnv = env[b.keyEnv]?.trim();
  if (fromEnv) return { key: fromEnv, origin: "env" };
  const fromFile = readKeyFile(keyFilePath(b.name, homeDir));
  if (fromFile) return { key: fromFile, origin: "keyfile" };
  const legacy = readTextOrNull(legacyEnvFile(homeDir));
  if (legacy != null) { const k = parseEnvKeyFile(legacy, b.keyEnv); if (k) return { key: k, origin: "legacy" }; }
  const dotenv = readTextOrNull(path.join(cwd, ".env"));
  if (dotenv != null) { const k = parseEnvKeyFile(dotenv, b.keyEnv); if (k) return { key: k, origin: "dotenv" }; }
  return null;
}

/** A .gitignore line that covers ./.env (plain entry or inside a directory). */
const GITIGNORE_ENV_RE = /(^|\/|\.|^)\.env$/;

/** Key came from cwd .env: warn when a .gitignore exists but does not cover it. */
function warnIfEnvNotGitignored(keyEnv: string, cwd: string): void {
  let gitignore: string;
  try { gitignore = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8"); } catch { return; } // no .gitignore -> nothing declares coverage
  if (gitignore.split(/\r?\n/).some((l) => GITIGNORE_ENV_RE.test(l.trimEnd()))) return;
  const msg = `warning: ${keyEnv} loaded from ./.env which is not gitignored — your key may leak`;
  console.error(process.env.NO_COLOR ? msg : `\x1b[33m${msg}\x1b[0m`);
}

function missingKeyError(b: Backend, env: Env, homeDir: string, cwd: string): JevProviderError {
  const looked = [
    `env var ${b.keyEnv}`,
    keyFilePath(b.name, homeDir),
    `${legacyEnvFile(homeDir)} (legacy env file)`,
    `${path.join(cwd, ".env")} (this project)`,
  ].map((s, i) => `  ${i + 1}. ${s}`).join("\n");
  let msg = `No ${b.name} API key found. Looked in:\n${looked}\nRun \`jgrep init\` or export ${b.keyEnv}.`;
  const legacy = readTextOrNull(legacyEnvFile(homeDir));
  const foreign = legacy == null ? [] : Object.values(BACKENDS)
    .filter((o) => o.name !== b.name && parseEnvKeyFile(legacy, o.keyEnv)).map((o) => o.keyEnv);
  if (foreign.length) msg += `\n${legacyEnvFile(homeDir)} holds ${foreign.join(", ")} — that key belongs to another provider and is not reused here.`;
  const alts = PROVIDER_ORDER.filter((n) => n !== b.name)
    .filter((n) => n !== "gateway" || !!env.JEV_GATEWAY_URL?.trim())
    .filter((n) => findKey(BACKENDS[n], env, homeDir, cwd)); // quiet check, no recursion into error building
  if (alts.length) msg += `\nA key is available for ${alts.join(", ")} — run with \`--api ${alts[0]}\` instead.`;
  return new JevProviderError("invalid_api_key", msg, {
    provider: b.name, retryable: false,
    hint: alts.length ? `run \`jgrep init\`, export ${b.keyEnv}, or switch with \`--api ${alts[0]}\`` : `run \`jgrep init\` or export ${b.keyEnv}`,
  });
}

/** API key for `backend` (§1.4 order); warns when a cwd-.env key is not gitignored.
 *  Throws invalid_api_key whose message enumerates every option when nothing fits. */
export function resolveApiKey(backend: Backend, env: Env = process.env, homeDir: string = os.homedir(), cwd: string = process.cwd()): string {
  const found = findKey(backend, env, homeDir, cwd);
  if (found?.origin === "dotenv") warnIfEnvNotGitignored(backend.keyEnv, cwd);
  if (found) return found.key;
  throw missingKeyError(backend, env, homeDir, cwd);
}

// ---- provider resolution (§1.4 precedence) ------------------------------------
function withGatewayUrl(b: Backend, env: Env): Backend {
  if (b.name !== "gateway") return { ...b };
  const url = env.JEV_GATEWAY_URL?.trim();
  if (!url) {
    throw new JevProviderError(
      "bad_request",
      "gateway provider needs JEV_GATEWAY_URL: the env var must point at the full System One endpoint " +
        "(e.g. https://gw.example.com/v1/systemone)",
      { provider: "gateway", retryable: false, hint: "export JEV_GATEWAY_URL=<full System One endpoint>, or use --api typesafe" },
    );
  }
  return { ...b, url };
}

const isProvider = (v: string): v is Backend["name"] => v === "typesafe" || v === "openrouter" || v === "gateway";

/** `--api` flag > `JEV_API` env > first backend with a key (typesafe first). When
 *  nothing is configured, returns the typesafe default — the missing-key error is
 *  resolveApiKey's job so its message can enumerate every option. */
export function resolveProvider(name: string | undefined, env: Env = process.env, homeDir: string = os.homedir(), cwd: string = process.cwd()): Backend {
  for (const requested of [name?.trim(), env.JEV_API?.trim()]) {
    if (!requested) continue;
    if (!isProvider(requested)) {
      throw new JevProviderError("bad_request", `unknown provider "${requested}" (valid: ${PROVIDER_ORDER.join(", ")})`, {
        provider: requested, retryable: false, hint: `use one of: ${PROVIDER_ORDER.join(", ")}`,
      });
    }
    return withGatewayUrl(BACKENDS[requested], env);
  }
  for (const n of PROVIDER_ORDER) {
    if (n === "gateway" && !env.JEV_GATEWAY_URL?.trim()) continue; // gateway only counts when its URL is set
    if (findKey(BACKENDS[n], env, homeDir, cwd)) return withGatewayUrl(BACKENDS[n], env);
  }
  return { ...BACKENDS.typesafe };
}

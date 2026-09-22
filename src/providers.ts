// WI-1 provider registry + key resolution: backend table, `--api`/`JEV_API`/auto
// precedence, per-provider API-key lookup chain and key-file IO — plus the WI-11
// HTTP engine (RateLimiter, postSystemOne, verifyApiKey). No deps.
import {
  classifyStatus, classifyTransport, jitteredDelayMs, parseRetryAfter, JevProviderError,
  RETRY_AFTER_MAX_MS, type JevErrorKind,
} from "./errors";
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
const GITIGNORE_ENV_RE = /((^|\/|\.)\.env$)/;

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

// ---- HTTP engine (WI-11) ------------------------------------------------------
// Replaces jgrep.ts's postSystemOne/verifyApiKey: per-attempt abort timeouts, a
// batch deadline that includes retries, Retry-After-aware full-jitter backoff,
// token-bucket pacing and typed errors from errors.ts. `Fetch` is re-declared
// here — providers.ts must not import jgrep.ts (circular); Step 4 rewires callers.

/** Ambient monotonic clock — the token bucket must not jump when the wall clock is adjusted. */
declare const performance: { now(): number };
const monotonicMs = (): number => performance.now();

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** DI seam for fetch — same shape as the export that still lives in jgrep.ts (until Step 4). */
export type Fetch = typeof fetch;

/** Rejection for a waiter whose batch deadline lapsed before or while it waited for a
 *  pacing token: the request never started, so no token is spent. kind "timeout" stays
 *  transient-class (no breaker trip) but retryable false — a retry cannot beat the clock.
 *  The limiter is provider-agnostic; the caller names its backend via acquire opts. */
const limiterTimeoutError = (provider?: string): JevProviderError =>
  new JevProviderError(
    "timeout",
    "the provider deadline exceeded while waiting for a rate-limit token (the batch deadline includes retries)",
    { provider: provider ?? "the provider", retryable: false, hint: "lower --batch or --concurrency — the deadline includes all retries" },
  );

/** A queued acquirer: resolved with a token, or rejected once its deadline lapses. */
interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
  deadlineMono?: number; // absolute monotonic ms — undefined waits forever
  provider?: string;     // backend name for the timeout rejection, when the caller knows it
}

/** Classic token bucket: `burst` tokens up front, refilled lazily at `ratePerSec`/s from a
 *  monotonic clock (no intervals). `acquire()` resolves immediately while a token is free;
 *  otherwise the waiter joins a FIFO queue and a single setTimeout is armed for the queue
 *  head's wait time. A waiter may carry a monotonic `deadlineMono`: one that has already
 *  passed rejects before waiting, and one that lapses while queued is evicted at the next
 *  refill or acquire — rejected WITHOUT consuming a token, so capacity goes to the next
 *  live waiter. ratePerSec <= 0 or non-finite means unlimited. The read-then-write
 *  sections below are await-free — on a single-threaded loop that IS the lock (§1.7). */
export class RateLimiter {
  private readonly rate: number;
  private readonly capacity: number;
  private tokens: number;
  private lastMs: number;
  private queue: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(ratePerSec: number, burst: number) {
    this.rate = ratePerSec;
    this.capacity = Math.max(1, burst);
    this.tokens = this.capacity;
    this.lastMs = monotonicMs();
  }

  private refill(): void {
    const t = monotonicMs();
    if (this.rate > 0 && Number.isFinite(this.rate)) {
      this.tokens = Math.min(this.capacity, this.tokens + ((t - this.lastMs) / 1000) * this.rate);
    }
    this.lastMs = t;
  }

  /** ms until the queue head can be granted a token (0 when one is free now). */
  private headWaitMs(): number {
    return Math.max(0, ((1 - this.tokens) / this.rate) * 1000);
  }

  /** True when the waiter carries a deadline the monotonic clock has already passed. */
  private expired(w: Waiter): boolean {
    return w.deadlineMono !== undefined && w.deadlineMono - monotonicMs() <= 0;
  }

  /** Reject and drop every queued waiter whose deadline has lapsed — no token is
   *  consumed, so the next refill goes to a live waiter (queue hygiene on arrival). */
  private evictExpired(): void {
    if (this.queue.length === 0) return;
    const live: Waiter[] = [];
    for (const w of this.queue) {
      if (this.expired(w)) w.reject(limiterTimeoutError(w.provider));
      else live.push(w);
    }
    this.queue = live;
  }

  private pump(): void {
    this.timer = null;
    this.refill();
    this.evictExpired(); // deadline hygiene for the whole queue, independent of tokens
    while (this.queue.length > 0 && this.tokens >= 1) {
      const w = this.queue.shift()!;
      if (this.expired(w)) { w.reject(limiterTimeoutError(w.provider)); continue; } // sub-ms race guard: a corpse never takes a token
      this.tokens -= 1;
      w.resolve();
    }
    if (this.queue.length > 0) this.timer = setTimeout(() => this.pump(), this.headWaitMs());
  }

  /** One pacing token. `opts.deadlineMono` (absolute monotonic ms) bounds the WAIT: an
   *  already-passed deadline rejects immediately, and a waiter whose deadline lapses
   *  while queued is evicted at the next refill or acquire — both without consuming
   *  a token. `opts.provider` names the backend for the timeout rejection. The caller
   *  keeps its own pre-attempt deadline check as the backstop. */
  acquire(opts?: { deadlineMono?: number; provider?: string }): Promise<void> {
    if (!(this.rate > 0) || !Number.isFinite(this.rate)) return Promise.resolve(); // unlimited
    this.refill();
    this.evictExpired(); // corpses leave here too, not only at refill time
    if (opts?.deadlineMono !== undefined && opts.deadlineMono - monotonicMs() <= 0) {
      return Promise.reject(limiterTimeoutError(opts?.provider)); // pre-wait: dead on arrival, no token
    }
    if (this.queue.length === 0 && this.tokens >= 1) { // never leapfrog queued waiters
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ resolve, reject, deadlineMono: opts?.deadlineMono, provider: opts?.provider });
      if (this.timer === null) this.timer = setTimeout(() => this.pump(), this.headWaitMs());
    });
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const VERIFY_TIMEOUT_MS = 15_000;
const SNIPPET_MAX = 300;

export interface PostOpts {
  fetchImpl?: Fetch;                     // DI seam (same as the old jgrep.ts option)
  requestTimeoutMs?: number;             // per attempt, default 30_000
  deadlineMs?: number;                   // absolute epoch ms — batch deadline INCLUDING all retries (compared on the monotonic clock internally)
  maxRetries?: number;                   // default 4 (=> 5 total attempts)
  sleep?: (ms: number) => Promise<void>; // DI for tests
  limiter?: RateLimiter;                 // shared token bucket
}

const headersFor = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
  "X-Title": "jevgrep", // OpenRouter app attribution; the other backends ignore it
});

const detailOf = (err: unknown): string => {
  if (err != null && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; name?: unknown };
    if (typeof e.message === "string" && e.message) return e.message;
    if (typeof e.code === "string" && e.code) return e.code;
    if (typeof e.name === "string" && e.name) return e.name;
  }
  return String(err);
};

/** First finite number among the provider cost fields, if any. */
const firstNumeric = (...vals: unknown[]): number | undefined => {
  for (const v of vals) if (typeof v === "number" && Number.isFinite(v)) return v;
  return undefined;
};

/** Actionable hint per error kind (plan §1.5); bad_request's depends on the snippet. */
function hintFor(kind: JevErrorKind, backend: Backend, snippet: string): string | undefined {
  switch (kind) {
    case "insufficient_credits": {
      // A self-hosted gateway has no billing page to point at — say so plainly.
      const billing = PROVIDER_URLS[backend.name].billing;
      return billing
        ? `top up credits at ${billing} or switch with --api typesafe if a TypeSafe key exists`
        : "insufficient credits on the gateway provider";
    }
    case "invalid_api_key":
      return `use a ${backend.name} key — check ${backend.keyEnv} or ${keyFilePath(backend.name)}, or run \`jgrep init\``;
    case "model_unavailable":
      return "pin an explicit version with --model (e.g. typesafe/jev-1.13) or switch with --api typesafe";
    case "bad_request":
      return snippet ? "request-shape problem — the snippet above is the provider's response body" : undefined;
    case "rate_limited":
      return "the provider is throttling — pace requests with --rate REQ/SEC";
    case "timeout":
      return "the provider did not answer within the request timeout — raise --request-timeout or --timeout";
    case "server_unreachable":
      return "check the network or the provider's status page";
    case "malformed_response":
      return "the API surface may have changed — pin the version with --model or report this";
    default:
      return undefined; // tls_error carries the certificate message verbatim; circuit_breaker_open never starts here
  }
}

/** Hints for transport failures: TLS carries the certificate message verbatim, timeouts name the flag. */
function transportHint(kind: JevErrorKind, err: unknown): string {
  if (kind === "tls_error") {
    const m = err != null && typeof err === "object" ? (err as { message?: unknown }).message : undefined;
    return typeof m === "string" && m ? m : "TLS/certificate problem — inspect the certificate chain";
  }
  if (kind === "timeout") return "the provider did not answer within the request timeout";
  return "check the network or the provider's status page";
}

function statusMessage(kind: JevErrorKind, backend: Backend, status: number, snippet: string): string {
  const base = snippet ? `${backend.name} ${status}: ${snippet}` : `${backend.name} ${status}`;
  // The env var belongs in the message itself — it is the first thing to check on 401/403.
  return kind === "invalid_api_key" ? `${base} — is ${backend.keyEnv} a ${backend.name} key?` : base;
}

function malformedResponseError(backend: Backend, snippet: string): JevProviderError {
  return new JevProviderError(
    "malformed_response",
    `${backend.name} 200 with unexpected body: ${snippet || "(empty body)"}`,
    { provider: backend.name, status: 200, retryable: false, hint: hintFor("malformed_response", backend, "") },
  );
}

/** POST one System One request with per-attempt timeouts, a batch deadline that
 *  includes retries, Retry-After-aware backoff and typed errors (WI-11). The
 *  caller owns `body` (including `body.model`) — it is never mutated here. */
export async function postSystemOne(
  body: unknown,
  backend: Backend,
  apiKey: string,
  opts: PostOpts = {},
): Promise<{ answers: Record<string, any>; usage?: { input_tokens: number }; cost?: number; model?: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const json = JSON.stringify(body);
  // The epoch deadline is converted to a MONOTONIC deadline once, at entry: the wall
  // clock can jump (NTP, manual adjust) but performance.now() cannot — same clock the
  // token bucket runs on. Identical behavior on a normal clock.
  const deadline = opts.deadlineMs === undefined ? undefined : monotonicMs() + (opts.deadlineMs - Date.now());

  for (let attempt = 0; ; attempt++) {
    // Pacing before EVERY attempt, retries included (§1.7). The monotonic deadline rides
    // along: the limiter rejects a waiter whose deadline lapses while queued — without
    // consuming a token — and the pre-attempt check below stays as the backstop.
    await opts.limiter?.acquire(deadline !== undefined ? { deadlineMono: deadline, provider: backend.name } : undefined);

    if (deadline !== undefined && deadline - monotonicMs() <= 0) {
      throw new JevProviderError(
        "timeout",
        `${backend.name} deadline exceeded before attempt ${attempt + 1} (the batch deadline includes retries)`,
        { provider: backend.name, retryable: false, hint: "raise --timeout or --request-timeout (seconds)" },
      );
    }

    const perAttemptMs = deadline === undefined
      ? requestTimeoutMs
      : Math.min(requestTimeoutMs, deadline - monotonicMs());
    const signal = AbortSignal.timeout(perAttemptMs);

    // What failed THIS attempt (a retryable status or a retryable transport error).
    let retryStatus: number | undefined;
    let retryKind: JevErrorKind = "server_unreachable";
    let retryDetail = "";
    let retryCause: unknown;
    let retryAfterRaw: string | null = null;

    try {
      const res = await fetchImpl(backend.url, {
        method: "POST",
        headers: headersFor(apiKey),
        body: json,
        signal,
      });
      if (!res.ok) {
        // Read the body BEFORE classifying so a retry never needs it a second time.
        const snippet = (await res.text()).slice(0, SNIPPET_MAX);
        const cls = classifyStatus(res.status, snippet);
        if (!cls.retryable) {
          throw new JevProviderError(cls.kind, statusMessage(cls.kind, backend, res.status, snippet), {
            provider: backend.name, status: res.status, retryable: false, hint: hintFor(cls.kind, backend, snippet),
          });
        }
        retryStatus = res.status;
        retryKind = cls.kind;
        retryDetail = snippet;
        retryAfterRaw = res.headers.get("retry-after");
      } else {
        // Success path: body read + JSON parse INSIDE the abort window (the old code left
        // res.json() outside it). text+parse rather than res.json() so a non-JSON 200 is
        // malformed_response instead of a misclassified transport error.
        const text = await res.text();
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { throw malformedResponseError(backend, text.slice(0, SNIPPET_MAX)); }
        if (parsed === null || typeof parsed !== "object"
          || (parsed as Record<string, unknown>).answers === null
          || typeof (parsed as Record<string, unknown>).answers !== "object") {
          throw malformedResponseError(backend, text.slice(0, SNIPPET_MAX));
        }
        const p = parsed as Record<string, any>;
        const usage = p.usage !== null && typeof p.usage === "object" ? (p.usage as { input_tokens: number }) : undefined;
        return {
          answers: p.answers as Record<string, any>,
          usage,
          cost: firstNumeric(p.cost, p.usage?.cost, p.cost_usd),
          model: typeof p.model === "string" ? p.model : undefined,
        };
      }
    } catch (err) {
      if (err instanceof JevProviderError) throw err; // fatal status / malformed body: pass through untouched
      const cls = classifyTransport(err);
      if (!cls.retryable) {
        throw new JevProviderError(cls.kind, `${backend.name} ${cls.kind}: ${detailOf(err)}`, {
          provider: backend.name, retryable: false, cause: err, hint: transportHint(cls.kind, err),
        });
      }
      retryKind = cls.kind;
      retryDetail = detailOf(err);
      retryCause = err;
    }

    if (attempt >= maxRetries) { // retries exhausted: final classification, still transient-class
      const label = retryStatus !== undefined ? String(retryStatus) : retryKind;
      throw new JevProviderError(
        retryKind,
        `${backend.name} ${label} after ${attempt + 1} attempts: ${retryDetail}`.trimEnd(),
        {
          provider: backend.name, status: retryStatus, retryable: true, cause: retryCause,
          hint: hintFor(retryKind, backend, retryDetail),
        },
      );
    }

    const delay = jitteredDelayMs(attempt); // full jitter, base 500ms, cap 30s
    const retryAfterMs = parseRetryAfter(retryAfterRaw); // transport errors have no header -> null
    let wait = Math.min(Math.max(delay, retryAfterMs ?? 0), RETRY_AFTER_MAX_MS);
    if (deadline !== undefined) wait = Math.max(0, Math.min(wait, deadline - monotonicMs()));
    await sleep(wait);
  }
}

/** Cheap backend-parameterized probe (init + the openrouter startup check): same ping
 *  payload as the old jgrep.ts version, 15s timeout, NO retries, never throws —
 *  transport failures come back as { ok: false, status: 0 }. */
export async function verifyApiKey(
  backend: Backend,
  apiKey: string,
  fetchImpl?: Fetch,
): Promise<{ ok: boolean; status: number; model?: string }> {
  const f = fetchImpl ?? fetch;
  try {
    const res = await f(backend.url, {
      method: "POST",
      headers: headersFor(apiKey),
      body: JSON.stringify({
        model: backend.model,
        state: "ping",
        questions: { ok: { type: "noul", instructions: "Is the state the word ping?" } },
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    let model: string | undefined;
    if (res.ok) {
      try {
        const parsed = (await res.json()) as { model?: unknown };
        if (parsed !== null && typeof parsed === "object" && typeof parsed.model === "string") model = parsed.model;
      } catch { /* 200 with a non-JSON body: the probe still succeeded */ }
    }
    return { ok: res.ok, status: res.status, model };
  } catch {
    return { ok: false, status: 0 };
  }
}

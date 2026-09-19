# Implementation Plan — jgrep v0.4.0 (Issue #1: WI-11 + WI-12 + WI-1 + WI-8)

Source of truth: **Emasoft/jgrep issue #1** ("Proposal: OpenRouter support + closing the gaps vs the line-based jgrep"). This plan implements the issue's own first milestone:

> `v0.4.0`: **WI-11** (timeouts/backoff/retry) + **WI-12** (error taxonomy, circuit breaker, partial-failure isolation) + **WI-1** (multi-provider layer) + **WI-8** (accuracy benchmark harness) — "a robust provider layer comes first — nothing else matters if requests fail opaquely".

WI-2/3/4/5/6/7/9/10/13 are **out of scope** here (deferred roadmap at the end).

---

## 1. Architecture & Patterns

### 1.1 Current state (verified in repo, HEAD `e91569b`, 779 LOC in `src/`)

| File | LOC | Relevant anchors |
|---|---|---|
| `src/jgrep.ts` | 249 | `ENDPOINT`/`MODEL`/`USD_PER_M_INPUT` consts (**lines 10–12**); `chunk()` 19–37; `diffChunks()` 40–60; `buildRequest()` 116–126 (`model: MODEL` at 125); `postSystemOne()` **130–145** (retry `429 \|\| >=500`, 4 total attempts, `500 * 2**attempt` ms, `AbortSignal.timeout(30_000)` at 138, **no network-error retry**, ignores `Retry-After`); cache 152–165 (`CACHE_FILE` = `~/.cache/jgrep/cache.json`, key at **165** = sha1 of `` `${MODEL}\0${kind}\0${q}\0${c.text}` ``); worker pool `jgrep()` 168–203 (`Promise.all` over shared-counter workers, **one rejection kills the whole run**, cache saved only by CLI on success); `resolveApiKey()` **208–217** (env `TYPESAFE_API_KEY` → cwd `.env` → `~/.config/jgrep/env`); `verifyApiKey()` 219–229 (init-only probe); `saveApiKey()` 231–235; `installSkills()` 238–249 |
| `src/cli.ts` | 149 | `VERSION = "0.3.0"` (**line 6**, duplicated from package.json); `parse()` 44–74; `main()` 76–107 (loads cache 85, `saveCache` 90 on success only, summary line 105 on stderr); rows rendering 109–147; single catch at 149 → red message + exit 2 |
| `src/rows.ts` | 127 | **line 6: `import { MODEL, postSystemOne } from "./jgrep"`**; `MAX_QUESTIONS_PER_REQUEST = 64` (61); `buildRowsRequest` 60–72 (`model: MODEL` at 71); rows cache key **74**; `scoreRows` 81–108 (same kill-the-run `Promise.all` pool) |
| `src/init.ts` | 112 | Interactive wizard; `CONSOLE_URL` (12); verify loop uses `verifyApiKey` (49 spinner text hardcodes api.typesafe.ai); stores key via `saveApiKey` |
| `src/jgrep.test.ts` | 142 | bun:test, 9 tests, colocated; **fake-fetch DI pattern**: `fetchImpl` option + `calls[]` capture array + answers keyed by chunk id from the parsed request body; `process.env.JGREP_NO_MAIN = "1"` before `await import("./cli")` |
| Toolchain | — | Bun-only build/test (`bun build src/cli.ts --target=node`, `bun test src/`); **zero runtime deps** (keep it that way); no tsconfig; `package.json` name `jevgrep` bin `jgrep`, version 0.3.0; CI: `ci.yml` (test+build+`--help` smoke), `publish.yml` (npm OIDC trusted publishing, tag==version check) |

### 1.2 Target module layout

```
src/errors.ts      NEW  JevProviderError, error kinds, status/transport classification,
                        Retry-After parsing, full-jitter delay calc (pure, testable)
src/providers.ts   NEW  Backend registry (typesafe/openrouter/gateway), resolveProvider,
                        resolveApiKey + key-file IO (incl. legacy ~/.config/jgrep/env),
                        RateLimiter (token bucket), postSystemOne (retry engine),
                        verifyApiKey(backend), price/cost helpers
src/pool.ts        NEW  runPool(): shared worker pool with partial-failure isolation,
                        circuit breaker (3 consecutive fatals), --fail-fast
src/jgrep.ts       EDIT becomes orchestration: chunking, diff, buildRequest(model),
                        cache (key uses backend.model), batch deadline wiring, Result{...,errors,cost}
src/rows.ts        EDIT same rewiring; rows key uses model; pool isolation
src/cli.ts         EDIT new flags, provider resolution + openrouter startup probe,
                        errors[] in --json, summary with error breakdown, exit codes, cache in finally
src/init.ts        EDIT per-provider key setup
bench/             NEW  fixtures + accuracy.ts + code_selection.ts + results/
.github/workflows/bench.yml  NEW  workflow_dispatch benchmark run
```

### 1.3 Data models

```ts
// providers.ts
export interface Backend {
  name: "typesafe" | "openrouter" | "gateway";
  url: string;      // full System One endpoint
  model: string;    // default model id
  keyEnv: string;   // env var holding the API key
  keyFile: string;  // basename in ~/.config/jgrep, e.g. "openrouter.key"
}
export const BACKENDS: Record<Backend["name"], Backend> = {
  typesafe:   { name: "typesafe",   url: "https://api.typesafe.ai/v1/systemone",    model: "jev-latest",           keyEnv: "TYPESAFE_API_KEY",     keyFile: "typesafe.key" },
  openrouter: { name: "openrouter", url: "https://openrouter.ai/api/alpha/decisions", model: "~typesafe/jev-latest", keyEnv: "OPENROUTER_API_KEY",  keyFile: "openrouter.key" },
  gateway:    { name: "gateway",    url: "", /* from JEV_GATEWAY_URL */             model: "jev-latest",           keyEnv: "JEV_GATEWAY_API_KEY", keyFile: "gateway.key" },
};

// errors.ts
export type JevErrorKind =
  | "insufficient_credits" | "invalid_api_key" | "model_unavailable" | "rate_limited"
  | "bad_request" | "malformed_response" | "server_unreachable" | "tls_error"
  | "timeout" | "circuit_breaker_open";
export class JevProviderError extends Error {
  kind: JevErrorKind; provider: string; status?: number;
  retryable: boolean; hint?: string; cause?: unknown;
}

// jgrep.ts
export interface ChunkError { file: string; start: number; end: number; kind: JevErrorKind; message: string; }
export interface Result {
  hits: Hit[]; all: Hit[]; chunks: number; tokens: number; cached: number;
  errors: ChunkError[];          // NEW
  cost?: number;                 // NEW: provider-reported cost when available
}
```

### 1.4 Provider / env / flag tables (verbatim from issue #1)

**Backend resolution precedence:** `--api` flag > `JEV_API` env > first backend with a key available (**typesafe first**, matching the sibling tool). Missing key → **fatal error enumerating every option**.

| Backend | URL | Default model | Key env | Key file |
|---|---|---|---|---|
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `jev-latest` | `TYPESAFE_API_KEY` | `~/.config/jgrep/typesafe.key` |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `~typesafe/jev-latest` | `OPENROUTER_API_KEY` | `~/.config/jgrep/openrouter.key` |
| `gateway` | `JEV_GATEWAY_URL` (full System One endpoint) | `jev-latest` (override `--model`/`JEV_MODEL`) | `JEV_GATEWAY_API_KEY` | `~/.config/jgrep/gateway.key` |

**Key lookup order (per provider):** keyEnv env var → `~/.config/jgrep/<name>.key` (raw, chmod 600) → `~/.config/jgrep/env` (**legacy file, keeps existing installs working**; parse any of the three key names, existing regex semantics from `jgrep.ts:210-214`) → cwd `.env` (existing behavior; **warn to stderr when a `.env` containing keys is not covered by `.gitignore`**).

**New env vars:** `JEV_API`, `JEV_MODEL`, `JEV_PRICE_PER_MTOK` (default `0.042`, replaces hardcoded `USD_PER_M_INPUT`), `JEV_GATEWAY_URL`, `JEV_GATEWAY_API_KEY`.

**New CLI flags:** `--api {typesafe,openrouter,gateway}` · `--model ID` · `--timeout SECONDS` (per-batch deadline **including retries**, default **15**, per issue) · `--request-timeout SECONDS` (per attempt, default **30**) · `--retries N` (default **4** → 5 total attempts) · `--rate REQ/SEC` (token-bucket global pacing, default 0 = unlimited) · `--fail-fast` (abort on first fatal = today's behavior) · `--no-probe` (skip the OpenRouter startup probe).

### 1.5 Error mapping (WI-12 taxonomy)

| Condition | kind | retryable | hint (actionable) |
|---|---|---|---|
| 402 | `insufficient_credits` | no | billing URL + "switch with `--api typesafe` if a TypeSafe key exists" |
| 401 / 403 | `invalid_api_key` | no | names provider + key env/file; distinguishes "worked earlier this run" (expired/revoked) vs "never worked" via run-level `hadSuccess` |
| 404, or body matching `/model not found|no endpoints found/i` | `model_unavailable` | no | pin explicit version (`--model typesafe/jev-1.13`); offer fallback `--api typesafe` |
| 429 | `rate_limited` | **yes** | carries Retry-After |
| 400 / 405 / 422 | `bad_request` | no | request-shape problem; include bounded body snippet |
| 200 with unexpected body shape | `malformed_response` | no | bounded body snippet; "API surface may have changed — pin the version or report" |
| DNS / ECONNREFUSED / ECONNRESET / ETIMEDOUT / EAI_AGAIN / AbortError(timeout) | `server_unreachable` (AbortError→`timeout`) | **yes** | check network/status page |
| TLS certificate errors (`ERR_TLS_CERT_ALTNAME_INVALID`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, `CERT_HAS_EXPIRED`, or message contains certificate/TLS/SSL) | `tls_error` | **no** | certificate message verbatim |
| per-batch deadline exhausted | `timeout` | no | suggest `--timeout`/`--request-timeout` |
| breaker tripped | `circuit_breaker_open` | no | "provider failing consistently" |

**Retryable statuses:** {408, 429, 500, 502, 503, 504, 529} **plus** the retryable transport failures above. **Non-retryable statuses:** {400, 401, 402, 403, 404, 405, 422} + `tls_error`.

**Backoff:** `delay = rand(0, min(cap, base * 2^attempt))`, base 500 ms, cap 30 s; when `Retry-After` present wait `max(jittered, retryAfterMs)`, capped at 5 min.

**Circuit breaker:** K = 3 **consecutive** fatal-kind batch failures (credits/key/model/unreachable/tls) aborts the run early; any successful batch resets the counter; unprocessed chunks reported as `circuit_breaker_open` errors. `rate_limited`/`timeout` batch failures do **not** count toward the breaker.

**Partial-failure isolation:** a failed batch marks only its chunks `errored`; the run continues; successful answers are still written to the cache (cache save moved into `finally` in `cli.ts`); `--json` gains `errors[]`; summary appends `· M errored (3 timeout, 1 rate_limited)`; **exit code 2 if any chunk errored**, otherwise grep semantics (0/1). Fatal-kind failures that exhaust retries still terminate with exit 2 unless `--fail-fast` (which aborts on the *first* fatal, restoring today's behavior).

### 1.6 Decisions & documented deviations (do not silently change)

1. **Per-chunk deadline adapted to batching.** The issue's `--timeout 15` is defined per chunk in the sibling tool; here one request judges up to 16 chunks, so the deadline is enforced **per batch** (all retries included). When it expires, every chunk in the batch is recorded as `timeout` and the worker moves on. Per-attempt signal = `min(--request-timeout, remaining deadline)`.
2. **`--json` becomes an object** `{ hits: [...], errors: [...] }` (a bare array cannot "gain" `errors[]`). Documented as a breaking change in the README (pre-1.0, acceptable). Rows mode `--json` becomes `{ answers: [...], errors: [...] }` symmetrically.
3. **Startup probe only for `openrouter` by default** (the issue flags the `alpha` surface as the risk): one cheap `verifyApiKey` ping before the run; `--no-probe` skips it; probe failure is fatal with the pin-version / `--api typesafe` hint. typesafe/gateway skip the probe (stable/known surfaces). Rationale: a probe on every run for every provider would add latency for no protection.
4. **Cache keys use `backend.model`** (not a global `MODEL` const): sha1 of `` `${model}\0${kind}\0${q}\0${c.text}` ``. typesafe and gateway both default to `jev-latest` and intentionally share cache entries (same underlying model); openrouter's `~typesafe/jev-latest` keys differ.
5. **Key storage is backward compatible:** existing `~/.config/jgrep/env` (written by today's `jgrep init`) keeps working; new init writes per-provider `<name>.key` files. `chmod 600` is a no-op on Windows → warn (per issue amendment).
6. **Env naming follows the issue exactly** (`JEV_*`), even though the repo also has `JGREP_NO_MAIN`; `JGREP_NO_MAIN` is a test-only guard and stays as is.
7. **No new runtime dependencies.** Tree-sitter (WI-5/13), sqlite (WI-6) are later milestones; benchmarks reuse the existing `scoreRows` machinery.

### 1.7 Concurrency & I/O safety notes (for coders)

- The shared-counter worker pattern (`const b = batches[next++]` — read+increment with no `await` between) must be preserved in `pool.ts`: JS is single-threaded, this is the atomicity guarantee. Do not introduce `await` between read and increment.
- `RateLimiter.acquire()` must be awaited **before** the fetch, never while holding other locks (there are none — single-threaded event loop; the bucket is just counters + a timer chain).
- Cache stays in-memory during the run and is written **once** at the end in a `try/finally` (success, partial failure, breaker abort, and `--fail-fast` throw all save). No whole-file rewrite per batch (write amplification).
- Bench fixtures are committed and read-only at run time; results are written under `bench/results/` only by bench scripts/workflow, never by `src/`.

---

## 2. Step-by-Step Implementation Strategy

Each step = exactly one `coder` subagent invocation. Steps are dependency-ordered; do not parallelize across steps that touch the same file.

### Phase A — Foundations: taxonomy + registry

- [ ] **Step 1: Create `src/errors.ts` + `src/errors.test.ts`** (WI-12 classification core)
  - *Context*: Everything downstream (retry engine, pool, CLI hints) needs typed, classifiable errors. Pure functions → fully unit-testable with no fetch.
  - *Instruction*: Implement exactly per §1.3/§1.5: `JevErrorKind` union; `JevProviderError extends Error` with `kind/provider/status/retryable/hint/cause`; `RETRYABLE_STATUSES`/`NON_RETRYABLE_STATUSES` sets; `classifyStatus(status, bodySnippet)` → `{kind, retryable}` (402→credits, 401/403→key, 404 or `/model not found|no endpoints found/i`→model_unavailable, 429→rate_limited, 400/405/422→bad_request, else→`bad_request` non-retryable with body snippet in message); `classifyTransport(err)` → `{kind, retryable}` (detect `AbortError`/`TimeoutError` name or `signal` reason → `timeout` retryable; TLS codes/messages → `tls_error` non-retryable; `ECONNRESET/ETIMEDOUT/ECONNREFUSED/EAI_AGAIN/EPIPE` codes → `server_unreachable` retryable; unknown transport → `server_unreachable` retryable); `parseRetryAfter(value: string|null): number|null` (delta-seconds **and** HTTP-date, capped at 300_000 ms); `jitteredDelayMs(attempt, base=500, cap=30000, rand=Math.random)` (full jitter: `rand() * min(cap, base*2**attempt)`). Tests: full status matrix, each transport code, HTTP-date parsing, jitter bounds (`0 <= d <= min(cap, base*2**attempt)` for 200 samples).

- [ ] **Step 2: Create `src/providers.ts` (registry + key resolution only) + `src/providers.test.ts`** (WI-1 part 1)
  - *Context*: Registry must exist before the HTTP engine consumes it. Key resolution must keep existing installs working.
  - *Instruction*: `Backend` interface + `BACKENDS` exactly per §1.3/§1.4 (gateway `url: ""` until `JEV_GATEWAY_URL` is read at resolve time). `resolveProvider(name?: string, env = process.env): Backend` — precedence `--api` argument > `JEV_API` > first backend with a resolvable key, typesafe first; unknown name → throw `JevProviderError` kind `bad_request` with hint listing valid choices; gateway without `JEV_GATEWAY_URL` → fatal with hint. `resolveApiKey(backend, env = process.env): string` — lookup order per §1.4; reuse the existing hand-rolled `KEY=value` regex parser (tolerates `export ` prefix, quotes, trailing `#` comments — copy from `jgrep.ts:210-214`); when the key comes from cwd `.env` and `.gitignore` exists without a `.env` entry, emit a one-line yellow warning to stderr. Key-file IO: `readKeyFile(p)`, `writeKeyFile(p, key)` (mkdir 0o700, write 0o600; on `process.platform === "win32"` print a warning that chmod 600 is a no-op). `DEFAULT_PRICE_PER_MTOK = 0.042` + `resolvePricePerMtok(env)` (JEV_PRICE_PER_MTOK override, invalid → fatal). Missing key → `JevProviderError` kind `invalid_api_key`, message **enumerating every option** (env var, `~/.config/jgrep/<name>.key`, `jgrep init`). Tests: registry values exact; precedence matrix (flag > env > auto, typesafe-first when both keys set); legacy `~/.config/jgrep/env` still resolves typesafe keys; `.key` file preferred over legacy file; missing-key error text lists all options; price override.

### Phase B — HTTP engine (WI-11)

- [ ] **Step 3: Add HTTP engine to `src/providers.ts`: `RateLimiter`, `postSystemOne`, `verifyApiKey` + `src/http.test.ts`** (WI-11 + WI-1 part 2)
  - *Context*: Replaces `jgrep.ts:130-145` and `jgrep.ts:219-229`. This is the heart of v0.4.0.
  - *Instruction*: Signatures:
    ```ts
    export interface PostOpts {
      fetchImpl?: Fetch;            // DI seam (same as today's Fetch = typeof fetch, jgrep.ts:128)
      requestTimeoutMs?: number;    // per attempt, default 30_000
      deadlineMs?: number;          // absolute epoch ms — batch deadline INCLUDING retries
      maxRetries?: number;          // default 4 (=> 5 total attempts)
      sleep?: (ms: number) => Promise<void>;  // DI for tests
      limiter?: RateLimiter;        // shared token bucket
    }
    export async function postSystemOne(body: unknown, backend: Backend, apiKey: string, opts: PostOpts = {}):
      Promise<{ answers: Record<string, any>; usage?: { input_tokens: number }; cost?: number; model?: string }>
    export async function verifyApiKey(backend: Backend, apiKey: string, fetchImpl?: Fetch): Promise<{ ok: boolean; status: number; model?: string }>
    ```
    Behavior: headers `Authorization: Bearer <key>`, `Content-Type: application/json`, **`X-Title: jevgrep`** (all backends; OpenRouter convention); URL/model from `backend` (model override comes from the caller putting it in `body.model`); `await limiter?.acquire()` before each attempt; per-attempt signal = `AbortSignal.timeout(min(requestTimeoutMs, deadlineMs - Date.now()))` — if `<= 0` throw `JevProviderError` kind `timeout` immediately; **wrap the fetch AND the success-path `res.json()` in try/catch** (today `res.json()` at `jgrep.ts:140` sits outside the signal): transport errors → `classifyTransport`, retry when retryable; status path → `classifyStatus`, retry when retryable; on retry compute `delay = max(jitteredDelayMs(...), parseRetryAfter(res.headers.get("retry-after")) ?? 0)` (transport errors have no header) then `await sleep(min(delay, remaining deadline))`; retries exhausted → throw `JevProviderError` (final classification, message includes attempt count); `200` with body that fails to parse or lacks `answers` object → `malformed_response` with a bounded (300-char) snippet. Cost extraction (OpenRouter returns cost in the response): first numeric found among `resp.cost`, `resp.usage?.cost`, `resp.cost_usd`; else `undefined` (caller falls back to tokens × price). `RateLimiter`: `class RateLimiter { constructor(ratePerSec: number, burst: number); acquire(): Promise<void> }` — classic token bucket, timer-chain refill, no per-request sleeps. `verifyApiKey` becomes backend-parameterized (same ping payload as `jgrep.ts:221-225`, 15 s timeout, no retries). Tests (fake-fetch pattern: `fetchImpl` DI + `calls[]` capture, `sleep` recorded fake): timeout-then-success retried exactly once; 429 with `Retry-After: 2` → recorded sleep ≥ 2000 ms; permanent 400 → zero retries and kind `bad_request`; 402 → `insufficient_credits` with billing hint; jitter bounds asserted from recorded sleeps; malformed 200 → `malformed_response`; `X-Title` header asserted; per-backend URL asserted (openrouter vs typesafe); cost extraction asserted; deadline expiry → kind `timeout` with zero further attempts.

- [ ] **Step 4: Rewire `src/jgrep.ts` and `src/rows.ts` onto `providers.ts`** (WI-1 part 3)
  - *Context*: Remove the single-provider hardcodes; keep default behavior byte-identical when only `TYPESAFE_API_KEY` is set.
  - *Instruction*: In `jgrep.ts`: delete `ENDPOINT`/`MODEL`/`USD_PER_M_INPUT` (10–12), `postSystemOne` (130–145), `resolveApiKey` (208–217), `verifyApiKey` (219–229), `saveApiKey` (231–235) — all now live in `providers.ts` (`writeKeyFile` replaces `saveApiKey`; keep `installSkills` in `jgrep.ts`). `buildRequest(question, chunks, kind = "code", model = "jev-latest")` gains the model param (used at line 125). Cache key (line 165) becomes `` sha1(`${model}\0${kind}\0${q}\0${c.text}`) `` — `model` flows in via `Options`; add `backend: Backend` to `Options` (replacing `apiKey` alone: keep `apiKey` but resolve it from the backend when absent). In `rows.ts`: change line 6 import to `providers.ts`; `buildRowsRequest` takes `model`; rows cache key (74) uses model. In `init.ts`: import `resolveApiKey/verifyApiKey/writeKeyFile` from `providers.ts`. Keep exported names used by tests stable; run `bun test src/` and fix any test imports (the existing 9 tests must stay green with a typesafe default backend). Note for the coder: `Options.fetchImpl` and the `Fetch` type stay in `jgrep.ts` (or re-export from providers) — do not break the test DI seam.

### Phase C — Isolation + circuit breaker (WI-12)

- [ ] **Step 5: Create `src/pool.ts` + `src/pool.test.ts`**
  - *Context*: Both `jgrep()` (jgrep.ts:188-200) and `scoreRows` (rows.ts:92-106) duplicate the worker pool; both need identical isolation semantics. One shared implementation.
  - *Instruction*:
    ```ts
    export interface PoolOptions {
      concurrency: number;
      failFast?: boolean;           // rethrow first fatal (today's behavior)
      breakerThreshold?: number;    // default 3 consecutive fatal-kind failures
      onProgress?: (done: number, total: number) => void;
    }
    export interface PoolResult<R> {
      results: R[];                          // successful per-item results (order not guaranteed)
      errors: { index: number; error: JevProviderError }[];
      aborted: boolean;                      // breaker tripped
      unprocessed: number;                   // items never attempted due to abort
      hadSuccess: boolean;                   // any item succeeded (drives invalid_api_key hint)
    }
    export async function runPool<T, R>(items: T[], opts: PoolOptions, worker: (item: T, index: number) => Promise<R>): Promise<PoolResult<R>>
    ```
    Semantics: shared-counter dispatch (preserve the no-await-between-read-and-increment invariant); non-fatal item failure → record in `errors[]`, continue; fatal-kind failure (`insufficient_credits|invalid_api_key|model_unavailable|server_unreachable|tls_error` — export a `FATAL_KINDS` set from `errors.ts` or pool) → consecutive counter++, any success resets it, counter reaches threshold → set breaker, stop dispatching, count remaining as `unprocessed`; `failFast` → throw the `JevProviderError` immediately. Tests: one failing batch among many → others complete; breaker trips after 3 consecutive fatals with at most 3 dispatched per failing scenario; success resets the counter; `failFast` throws; `hadSuccess` correct.

- [ ] **Step 6: Integrate pool + deadlines into `jgrep()` and `scoreRows`; `Result.errors`**
  - *Context*: This is where chunks actually become isolated units of failure (issue acceptance: "a run with one failing batch produces hits + errors[] + exit 2").
  - *Instruction*: In `jgrep()` (jgrep.ts:168-203): replace the hand-rolled pool with `runPool(batches, {...}, worker)`; the worker computes `deadlineMs = Date.now() + o.timeoutSec * 1000` at batch start and passes `{ deadlineMs, requestTimeoutMs, maxRetries, limiter, fetchImpl }` to `postSystemOne`; on batch success parse answers per id (existing logic), write cache entries for finite p-values **immediately into the in-memory cache object** (they persist because `cli.ts` saves in `finally` — Step 7); on batch failure map the error onto every chunk of that batch → `ChunkError {file, start, end, kind, message}`; after the pool: if `aborted`, append one `circuit_breaker_open` ChunkError per unprocessed chunk; assemble `Result {..., errors, cost}` (`cost` = sum of provider-reported costs, `undefined` if none). `Options` gains `timeoutSec = 15`, `requestTimeoutSec = 30`, `maxRetries = 4`, `ratePerSec?`, `failFast?`, `limiter?`. Mirror the same treatment in `scoreRows` (rows.ts:81-108): failed request-pack → rows recorded in `errors` (rows get `RowError` = same `ChunkError` shape with `start = row index`), missing-answer rows still excluded from cache. Existing tests must remain green (`Result` change is additive); add tests: batch-2-of-3 fails with 500s → hits from batches 1+3, `errors` has batch-2 chunks with kind `server_unreachable`, cache contains batch-1 answers; deadline exceeded → all batch chunks `timeout` kind and run continues; `--fail-fast` (opt) propagates throw.

### Phase D — Provider layer surfacing (WI-1 UX)

- [ ] **Step 7: `src/cli.ts` — flags, provider resolution, output, exit codes**
  - *Context*: The user-facing surface of WI-1 + WI-12.
  - *Instruction*: `parse()` (44-74) gains: `--api <name>` (validated; unknown → error listing `typesafe, openrouter, gateway`), `--model <id>`, `--timeout <s>` (default 15), `--request-timeout <s>` (default 30), `--retries <n>` (default 4), `--rate <req/s>`, `--fail-fast`, `--no-probe`; extend the numeric-validation at line 72 to the new numerics. `main()` (76-107): `resolveProvider(o.api)` → if backend is `openrouter` and `!o.noProbe`, run `verifyApiKey` once and turn failure into a fatal with the pin-model/`--api typesafe` hint; `model = o.model ?? env.JEV_MODEL ?? backend.model`; pass `{...o, backend, model, timeoutSec, ...}` into both `jgrep()` and `scoreRows`; **wrap the run in `try/finally` and `saveCache` in `finally`** (replaces line 90); render: `--json` emits `{ hits, errors }` (rows mode: `{ answers, errors }`); grep-style output unchanged for hits, plus after the summary line, when `errors.length > 0`, print to stderr a red breakdown; summary line becomes `` `${hits} hits / ${chunks} chunks (${cached} cached) · ${tokens} tokens · $${cost} · ${secs}s` `` where `cost` = provider-reported `result.cost` if present else `tokens * resolvePricePerMtok() / 1e6` (replaces cli.ts:104 math), appended with ` · ${errors.length} errored (${kindCounts})` when errors exist; error hints: when the caught/thrown error is `JevProviderError` kind `invalid_api_key`, prepend `hadSuccess ? "key worked earlier this run (expired/revoked?)" : "check you're using <provider>'s key"`. Exit codes: **2 when `errors.length > 0` or a fatal was thrown; else 0/1 grep semantics** (update the USAGE exit-status text). Update the `USAGE` string (7-39) with all new flags + provider precedence one-liner. Tests: `--api unknown` error text lists choices; `--timeout`/`--rate` numeric validation; `--model`/`--api` parsed; `JGREP_NO_MAIN` import pattern still works.

- [ ] **Step 8: `src/init.ts` — per-provider key setup**
  - *Context*: `jgrep init` must provision any of the three backends.
  - *Instruction*: First prompt: provider select (`typesafe` / `openrouter` / `gateway`) with one-line descriptions; gateway additionally prompts for `JEV_GATEWAY_URL` (validated as an http(s) URL). Key paste → `verifyApiKey(backend, key)` loop (spinner text no longer hardcodes api.typesafe.ai — say the backend URL host); on success choose storage: `key file` (default → `~/.config/jgrep/<name>.key` via `writeKeyFile`, Windows chmod warning per §1.5), `global env file` (legacy `~/.config/jgrep/env`, appended with the provider's `KEYENV=`), `project .env` (existing flow incl. the gitignore warning), `none`. Keep the agent-skills multiselect + star prompt unchanged. Provider-specific console/billing URLs: typesafe `https://console.typesafe.ai`, openrouter `https://openrouter.ai/credits` (used in the WI-12 hint too — export the map from `providers.ts` so CLI and init share it).

- [ ] **Step 9: Docs + version bump (`README.md`, `skill/SKILL.md`, `package.json`, `src/cli.ts`)**
  - *Context*: Issue WI-1 step 6 + amendment items (Windows chmod, .env gitignore, partial-answer caching finding, alpha-surface pinning).
  - *Instruction*: README: (a) **Providers** section — table per §1.4, precedence (`--api` > `JEV_API` > first key, typesafe-first), examples (`OPENROUTER_API_KEY=… jgrep "…" src/`, `--api openrouter`, gateway + LiteLLM mention), `--model` pinning guidance for the alpha surface with documented fallback `--api typesafe`; (b) **Reliability** section — retry/backoff/`Retry-After`, `--timeout` vs `--request-timeout`, `--rate`, `--retries`, circuit breaker, `--fail-fast`, error-kind table with hints, exit-code 2-on-errors semantics; (c) note the **breaking `--json` shape change** (`{hits, errors}`) and that cache keys are now provider/model-aware (first run after upgrade re-bills once); (d) note Windows chmod caveat and the `.env`-not-gitignored warning; (e) note the known limitation: a failed batch is retried as a whole (per-answer caching inside a failed batch depends on the provider returning per-question answers alongside errors — to be verified against the OpenRouter alpha surface); (f) a stub **Accuracy** section pointing to `bench/` (numbers land after the first CI bench run — WI-8 acceptance). `skill/SKILL.md`: sync any flags/options copy it duplicates from README. Bump `package.json` version to **0.4.0** and `src/cli.ts:6` `VERSION` to **0.4.0** (publish.yml verifies tag==version; do not tag). Update `package.json` `repository.url` to `https://github.com/Emasoft/jgrep.git` (fork correction, harmless).

### Phase E — Benchmark harness (WI-8)

- [ ] **Step 10: Create committed fixtures under `bench/fixtures/`**
  - *Context*: Issue amendment: "fixtures are committed so runs are reproducible". These fixtures are also the future acceptance set for WI-2/3/5/9.
  - *Instruction*: `bench/fixtures/sms_spam.csv` — header `label,text`; **200 rows, 100 spam / 100 ham**, deterministically sampled (fixed seed, stable sort) from the UCI SMS Spam Collection (`https://archive.ics.uci.edu/static/public/228/sms+spam+collection.zip`, tab-separated `label\ttext`); preserve original labels (`spam`/`ham`); quote-escape texts. `bench/fixtures/ag_news.csv` — header `label,text`; **120 rows, 30 per class** (`World`, `Sports`, `Business`, `Sci/Tech`), deterministic sample from the AG News train CSV (class index 1-4 → name; join title + description); source: `https://raw.githubusercontent.com/mhjabreel/CharCnn_Keras/master/data/ag_news_csv/train.csv`. `bench/fixtures/code_selection/cases.json` — **20 cases**; each `{ id, description, expected, candidates: [{ name, code }] }`: small self-contained TypeScript/Go functions (5 per case, written by hand in the fixture, no external copying) where exactly one matches the description; descriptions must require *behavioral* judgment (e.g. "retries a failing operation with exponential backoff"), not keyword matching. Add `bench/fixtures/README.md` documenting provenance, license note (UCI SMS: free for research; AG News: academic use), and the exact regeneration commands. If a download fails, abort with a clear error — never commit partial/empty fixtures.

- [ ] **Step 11: Create `bench/accuracy.ts`** (SMS + AG News precision/recall)
  - *Context*: Port of the sibling's `accuracy.py` idea; reuses `scoreRows` + provider resolution from `src/`.
  - *Instruction*: Loads a fixture CSV, maps each row to `{ id, label, text }`; asks one `noul` question per row (SMS: "Is this text message spam?"; AG News: per-class yes/no is wasteful — instead ask one `choice` question per row with the 4 classes as criteria, using the existing choice-question support in rows mode); computes per-class precision/recall/F1 + accuracy + macro-F1 (SMS: binary spam/ham at p ≥ 0.5; AG News: argmax over choice probabilities), prints a markdown table to stdout, writes `bench/results/<provider>-<fixture>-<UTCtimestamp>.json` (`{ fixture, provider, model, n, metrics, tokens, cost, durationSec }`). Flags: `--fixture sms|agnews|all`, `--api`, `--model`, `--limit N` (smoke runs), `--out dir`. Uses `resolveProvider`/`resolveApiKey` so `TYPESAFE_API_KEY`/`OPENROUTER_API_KEY` work; honors `--rate`/`--retries` passthrough. No cache writes (pass a throwaway cache or `noCache` option) so repeated runs measure true accuracy.

- [ ] **Step 12: Create `bench/code_selection.ts`**
  - *Context*: The sibling's `code_selection.py` equivalent — measures whether Jev picks the *right* chunk for a description (navigation accuracy without comments).
  - *Instruction*: For each case in `cases.json`, ask one request with `noul` questions per candidate ("Does that code match this description: …"), pick the argmax, score top-1 correctness; report accuracy + per-case table (expected vs picked + p), write `bench/results/<provider>-code_selection-<ts>.json`. Same flags/cache policy as Step 11. A smoke mode `--limit 2` must cost < $0.01.

- [ ] **Step 13: Create `.github/workflows/bench.yml`**
  - *Context*: Issue amendment: benchmarks "run on demand (`workflow_dispatch`) — they spend real money".
  - *Instruction*: `on: workflow_dispatch` with inputs `provider` (choice: typesafe/openrouter/both, default typesafe) and `limit` (string, default "0" = full). Steps mirror `ci.yml` setup (checkout, setup-bun, `bun install --frozen-lockfile`); map `secrets.TYPESAFE_API_KEY` / `secrets.OPENROUTER_API_KEY` per provider matrix (skip entries whose secret is empty); run `bun bench/accuracy.ts --fixture all` and `bun bench/code_selection.ts`; upload `bench/results/*.json` as artifacts; append the markdown metric tables to `$GITHUB_STEP_SUMMARY`. Add a concurrency group so two bench runs don't interleave. `ci.yml` stays untouched (no bench on push/PR).

### Phase F — Verification

- [ ] **Step 14: Full verification pass (tests, build, smoke, review)**
  - *Instruction*: Run in order and fix anything red: (1) `bun test src/` — all existing 9 tests + all new test files green; (2) `bun run build` then `node dist/jgrep.js --help` shows new flags; (3) smoke without network: `node dist/jgrep.js --api unknown "q" .` → error listing choices, exit 2; `node dist/jgrep.js --api gateway "q" .` without `JEV_GATEWAY_URL` → fatal hint; (4) if `TYPESAFE_API_KEY` exists in env/config, one real cheap run: `jgrep "swallows errors" src/ --timeout 30` with the default provider → standard result shape + summary line (skip if no key; report skipped); (5) run `bun bench/accuracy.ts --fixture sms --limit 10` only if a key exists, else verify it fails with the missing-key enumeration error; (6) `grep`-check that no `api.typesafe.ai` hardcode remains outside `providers.ts` and no `TYPESAFE_API_KEY` reference remains outside `providers.ts`/`init.ts`; (7) confirm the acceptance bullets of WI-1/11/12/8 (§3 below) one by one and report each PASS/FAIL. Optionally activate the `review-and-simplify-changes` skill on the final diff.

---

## 3. Verification (acceptance criteria from issue #1)

**WI-1:** with only `OPENROUTER_API_KEY` set, `jgrep "catches an error and silently ignores it" src/` returns the standard result shape; `--api openrouter` forces the backend; `--api unknown` errors listing choices; unit tests with a fake fetch per backend (same pattern as the existing batching test). Both-keys precedence documented **and** tested; Windows chmod warning; `.env` gitignore warning.
**WI-11:** fake-fetch tests — timeout then success (retried exactly once); 429 with `Retry-After: 2` (measured wait ≥ 2 s); permanent 400 (zero retries); per-batch deadline exceeded → `errors[]` entry and the run continues; jitter bounds asserted.
**WI-12:** fake-fetch scenarios for every kind; a run with one failing batch produces hits + `errors[]` + exit 2; the circuit breaker trips after 3 consecutive fatals with at most 3 requests dispatched; `--fail-fast` aborts on the first fatal.
**WI-8:** README gains an Accuracy section (stub + harness); bench runs on demand only; fixtures committed; SMS/AG News/code-selection scripts produce metrics JSON; (precision/recall numbers get published after the first real CI bench run — requires secrets, out of code scope).

**Manual checks:** grep-style output unchanged for a clean run; cache still prevents re-billing on a second identical run; `--no-cache` unchanged; `jgrep init` completes for typesafe (legacy flow) and writes `<name>.key` for openrouter.

## 4. Non-goals (per issue #1)

Streaming `tail -f`; multi-line/cross-file logic-bug reasoning; sqlite cache (WI-6), verification cascade (WI-2), clustering (WI-3), tagging (WI-4), tree-sitter/`--funcs` (WI-5/13), estimate/budget/SARIF (WI-7), envelopes (WI-9), comparison/privacy docs page (WI-10).

## 5. Deferred roadmap (after v0.4.0 ships)

`v0.5.0`: WI-3 signature clustering + `--group` · WI-4 `--tag` · WI-13 tree-sitter language matrix + markdown/skills chunking → `v0.6.0`: WI-2 `--verify`/`--votes` · WI-6 sqlite cache (WAL, XDG, eviction, JSON migration) · WI-7 `--estimate`/`--budget`/`--sarif` → `v0.7.0`: WI-5 two-phase function navigation → later: WI-9 numeric envelopes · WI-10 docs. Each later milestone re-measures with the WI-8 harness (issue: "every tuning change ships with before/after measurements").

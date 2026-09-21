// WI-11 HTTP engine — the slim PR-1 cut: RateLimiter + postSystemOne only. Per-attempt
// abort timeouts, a batch deadline that includes retries, Retry-After-aware full-jitter
// backoff and typed errors from errors.ts. No deps, no provider registry: the single
// endpoint lives in jgrep.ts (ENDPOINT import creates a module cycle with jgrep.ts ->
// postSystemOne that is safe because both sides touch the other's bindings only
// inside function bodies).
import {
  classifyStatus, classifyTransport, jitteredDelayMs, parseRetryAfter, JevProviderError,
  RETRY_AFTER_MAX_MS, type JevErrorKind,
} from "./errors";
import { ENDPOINT } from "./jgrep";

/** Ambient monotonic clock — the token bucket must not jump when the wall clock is adjusted. */
declare const performance: { now(): number };
const monotonicMs = (): number => performance.now();

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** DI seam for fetch — same shape as the export that lives in jgrep.ts. */
export type Fetch = typeof fetch;

/** Classic token bucket: `burst` tokens up front, refilled lazily at `ratePerSec`/s from a
 *  monotonic clock (no intervals). `acquire()` resolves immediately while a token is free;
 *  otherwise the waiter joins a FIFO queue and a single setTimeout is armed for the queue
 *  head's wait time. ratePerSec <= 0 or non-finite means unlimited. The read-then-write
 *  sections below are await-free — on a single-threaded loop that IS the lock (§1.7). */
export class RateLimiter {
  private readonly rate: number;
  private readonly capacity: number;
  private tokens: number;
  private lastMs: number;
  private queue: Array<() => void> = [];
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

  private pump(): void {
    this.timer = null;
    this.refill();
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()!();
    }
    if (this.queue.length > 0) this.timer = setTimeout(() => this.pump(), this.headWaitMs());
  }

  acquire(): Promise<void> {
    if (!(this.rate > 0) || !Number.isFinite(this.rate)) return Promise.resolve(); // unlimited
    this.refill();
    if (this.queue.length === 0 && this.tokens >= 1) { // never leapfrog queued waiters
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      if (this.timer === null) this.timer = setTimeout(() => this.pump(), this.headWaitMs());
    });
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
const SNIPPET_MAX = 300;

export interface PostOpts {
  fetchImpl?: Fetch;                     // DI seam (same as the old jgrep.ts option)
  requestTimeoutMs?: number;             // per attempt, default 30_000
  deadlineMs?: number;                   // absolute epoch ms — batch deadline INCLUDING all retries
  maxRetries?: number;                   // default 4 (=> 5 total attempts)
  sleep?: (ms: number) => Promise<void>; // DI for tests
  limiter?: RateLimiter;                 // shared token bucket
}

const headersFor = (apiKey: string): Record<string, string> => ({
  Authorization: `Bearer ${apiKey}`,
  "Content-Type": "application/json",
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

/** Actionable hint per error kind (§1.5); bad_request's depends on the snippet.
 *  Provider-generic — the slim PR-1 cut has a single provider and no registry, so
 *  hints name only what exists upstream (TYPESAFE_API_KEY, `jgrep init`, flags). */
function hintFor(kind: JevErrorKind, snippet: string): string | undefined {
  switch (kind) {
    case "insufficient_credits":
      return "top up credits or check your plan with the provider";
    case "invalid_api_key":
      return "check TYPESAFE_API_KEY or run `jgrep init`";
    case "model_unavailable":
      return "the provider does not serve this model — check the provider's model list or status page";
    case "bad_request":
      return snippet ? "request-shape problem — the snippet above is the provider's response body" : undefined;
    case "rate_limited":
      return "the provider is throttling — lower --concurrency and retry";
    case "timeout":
      return "the provider did not answer within the request timeout";
    case "server_unreachable":
      return "check the network or the provider's status page";
    case "malformed_response":
      return "the API surface may have changed — please report this";
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

function statusMessage(kind: JevErrorKind, status: number, snippet: string): string {
  const base = snippet ? `the provider ${status}: ${snippet}` : `the provider ${status}`;
  // The env var belongs in the message itself — it is the first thing to check on 401/403.
  return kind === "invalid_api_key" ? `${base} — is TYPESAFE_API_KEY a valid key?` : base;
}

function malformedResponseError(snippet: string): JevProviderError {
  return new JevProviderError(
    "malformed_response",
    `the provider 200 with unexpected body: ${snippet || "(empty body)"}`,
    { provider: "typesafe", status: 200, retryable: false, hint: hintFor("malformed_response", "") },
  );
}

/** POST one System One request with per-attempt timeouts, a batch deadline that
 *  includes retries, Retry-After-aware backoff and typed errors (WI-11). The
 *  caller owns `body` (including `body.model`) — it is never mutated here. */
export async function postSystemOne(
  body: unknown,
  apiKey: string,
  opts: PostOpts = {},
): Promise<{ answers: Record<string, any>; usage?: { input_tokens: number } }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 4;
  const requestTimeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const json = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    await opts.limiter?.acquire(); // pacing before EVERY attempt, retries included (§1.7)

    if (opts.deadlineMs !== undefined && opts.deadlineMs - Date.now() <= 0) {
      throw new JevProviderError(
        "timeout",
        `the provider deadline exceeded before attempt ${attempt + 1} (the batch deadline includes retries)`,
        { provider: "typesafe", retryable: false, hint: "lower --batch or --concurrency — the deadline includes all retries" },
      );
    }

    const perAttemptMs = opts.deadlineMs === undefined
      ? requestTimeoutMs
      : Math.min(requestTimeoutMs, opts.deadlineMs - Date.now());
    const signal = AbortSignal.timeout(perAttemptMs);

    // What failed THIS attempt (a retryable status or a retryable transport error).
    let retryStatus: number | undefined;
    let retryKind: JevErrorKind = "server_unreachable";
    let retryDetail = "";
    let retryCause: unknown;
    let retryAfterRaw: string | null = null;

    try {
      const res = await fetchImpl(ENDPOINT, {
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
          throw new JevProviderError(cls.kind, statusMessage(cls.kind, res.status, snippet), {
            provider: "typesafe", status: res.status, retryable: false, hint: hintFor(cls.kind, snippet),
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
        try { parsed = JSON.parse(text); } catch { throw malformedResponseError(text.slice(0, SNIPPET_MAX)); }
        if (parsed === null || typeof parsed !== "object"
          || (parsed as Record<string, unknown>).answers === null
          || typeof (parsed as Record<string, unknown>).answers !== "object") {
          throw malformedResponseError(text.slice(0, SNIPPET_MAX));
        }
        const p = parsed as Record<string, any>;
        const usage = p.usage !== null && typeof p.usage === "object" ? (p.usage as { input_tokens: number }) : undefined;
        return {
          answers: p.answers as Record<string, any>,
          usage,
        };
      }
    } catch (err) {
      if (err instanceof JevProviderError) throw err; // fatal status / malformed body: pass through untouched
      const cls = classifyTransport(err);
      if (!cls.retryable) {
        throw new JevProviderError(cls.kind, `the provider ${cls.kind}: ${detailOf(err)}`, {
          provider: "typesafe", retryable: false, cause: err, hint: transportHint(cls.kind, err),
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
        `the provider ${label} after ${attempt + 1} attempts: ${retryDetail}`.trimEnd(),
        {
          provider: "typesafe", status: retryStatus, retryable: true, cause: retryCause,
          hint: hintFor(retryKind, retryDetail),
        },
      );
    }

    const delay = jitteredDelayMs(attempt); // full jitter, base 500ms, cap 30s
    const retryAfterMs = parseRetryAfter(retryAfterRaw); // transport errors have no header -> null
    let wait = Math.min(Math.max(delay, retryAfterMs ?? 0), RETRY_AFTER_MAX_MS);
    if (opts.deadlineMs !== undefined) wait = Math.max(0, Math.min(wait, opts.deadlineMs - Date.now()));
    await sleep(wait);
  }
}

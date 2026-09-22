# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.0] - 2026-09-22 — roadmap completion (issue #1: WI-2, WI-3, WI-4, WI-5, WI-6, WI-7, WI-9, WI-10)

Completes the deferred roadmap of
[Emasoft/jgrep#1](https://github.com/Emasoft/jgrep/issues/1): every remaining
work item is implemented. [0.4.0](#040---2026-09-20--providers-reliability-isolation-benchmarks-issue-1-wi-1-wi-8-wi-11-wi-12)
shipped WI-1 (multi-provider), WI-8 (error taxonomy), WI-11 (partial-failure
isolation), and WI-12 (benchmarks); markdown chunking ships here too.

### Added

- **`--group`** (WI-3): chunks sharing a whitespace-normalized signature are
  near-identical boilerplate — the first is judged, siblings inherit its
  verdict (exactly one question for the whole family), and `--group` prints
  one group per signature (representative body + sites; `--json`/`--json-errors`
  gain `groups[]`).
- **`--tag <list>`** (WI-4): classify the standing hits — one `choice` question
  per hit (at most 16 per request), categories given comma-separated. The
  winning category prints after the `p` column (`[real bug]`) and rides on
  `--json` hit objects as `tag`/`tag_p`. Runs after `--verify` filtering; a
  failed tag batch never errors the run — those hits stay untagged.
- **Verification cascade** (WI-2): `--verify` re-asks every hit with strict
  instructions and keeps it only at `p >= 0.6 × threshold` (fail-open when the
  verify batch itself fails); `--votes <n>` (1–5) judges every chunk n times
  and the MEDIAN probability wins, with per-vote cache keys.
- **`--funcs`** (WI-5): two-phase function navigation — pass 1 packs all of a
  file's regex-extracted function/method/class signature lines into one
  signature chunk per file (tree-sitter is a future upgrade; the regexes are
  the documented fallback) and judges those first; pass 2 runs the normal
  chunk search only on the shortlisted files. Files in unsupported languages
  and files with no extractable signatures are skipped.
- **Cost controls & SARIF** (WI-7): `--estimate` is an offline chunk/token/cost
  preview (no network, no cache writes); `--budget <usd>` meters per-batch cost
  (provider-reported else tokens × price) and over-budget chunks error
  `budget_exhausted` (`JEV_BUDGET` env override); `--sarif` prints SARIF 2.1.0
  ingestible by GitHub code scanning.
- **`--envelopes`** (WI-9): appends each chunk's numbers (`[numbers: 42, 7]`)
  to the judged text, steadying Jev's counting of quantities; off by default,
  and envelope/non-envelope runs share one cache.
- **Cache hardening** (WI-6): keys hash the whitespace-normalized chunk text
  (reformatting a file no longer re-bills; old raw-text keys miss once and
  re-bill, no migration code), saves are atomic (temp file + rename, so
  concurrent processes never see a half-written cache), and the cache is
  capped at 10,000 entries with oldest-first eviction (v1 envelope with an
  insertion-order list).
- markdown-aware chunking: .md/.mdx files split at headings with section-trail
  context; fenced code blocks never split — sub-section extraction via
  -C/--json start-end.

### Fixed

- `--batch 0` or a fractional `--batch` (e.g. `-b 1.5`) is rejected by the CLI ("batch must be a positive integer"); library callers get the value floored and clamped at 1 — `+= 0` used to spin the batching loop forever and a fraction overlapped batches.
- rows mode, single description: `--out` now writes a CSV of the shown hits (`row,p,<answer columns>`) instead of being a silent no-op; `--json --out` still writes JSON; stdout keeps the pretty output.
- Per-chunk/per-row errors carry the provider error's `hint`: rendered as a grey indented line under each stderr example and included in `--json-errors` objects (hints previously surfaced only on fatal throws).
- A 200 response that answers only some chunks records the unanswered ones as `malformed_response` errors — they no longer appear as `p:NaN` entries in `all` with no error and no cache entry.
- rows mode `requests` no longer counts packs the circuit breaker never attempted.
- `JEV_PRICE_PER_MTOK` is validated right after provider resolution (both modes) — an invalid price can no longer surface only after the run has billed tokens.
- install-dev.sh: `check` and choice 6 never create the target directory (a missing `~/.local/bin` was mkdir'd under "no mutation").
- The gateway 402 hint drops the "top up credits at …" clause when the provider has no billing URL ("insufficient credits on the gateway provider").
- Reliability: expired waiters are evicted from the rate limiter without consuming a token, and the per-batch deadline is monotonic with a fail-fast settlement guard.
- Removed dead code: the redundant unreachable-codes branch in `classifyTransport` (identical fallthrough) and the unused `installSkills` (superseded by init's universal skill installer).
- Docs: README now says code-mode `--json` is byte-identical to 0.3.0 while rows mode is a flattened answer array; the bench `--limit` note reads "rows per class"; the Bench workflow input says "Rows per class / cases"; the `--help` init line reads "(provider, key, agent skills)".
- CI runs the bench unit tests too (`bun test src/ bench/`).

## [0.4.0] - 2026-09-20 — providers, reliability, isolation, benchmarks (issue #1: WI-1, WI-8, WI-11, WI-12)

### Added

- **Multi-provider layer**: `typesafe`, `openrouter`, and `gateway` (any System One-speaking endpoint, e.g. LiteLLM) speak the same protocol. Pick with `--api`, `$JEV_API`, or let jgrep find a key (typesafe first). `--model` / `$JEV_MODEL` override the model id; `JEV_GATEWAY_URL` + `JEV_GATEWAY_API_KEY` point at a self-hosted gateway.
- **Key chain**, per provider: env var > `~/.config/jgrep/<name>.key` (written 0600) > the legacy `~/.config/jgrep/env` > `./.env` in the project — with a warning when the `.env` key is not covered by `.gitignore`. `chmod 600` is a no-op on Windows; init warns there too.
- **Reliability engine**: full-jitter exponential backoff (500 ms base, 30 s cap), provider `Retry-After` honored (capped at 5 min), transport-error retries (`ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`/`EAI_AGAIN`), `--retries` (default 4 → 5 attempts), `--request-timeout` (30 s per attempt), `--timeout` (15 s per-batch deadline including retries), `--rate REQ/SEC` token-bucket pacing, `--fail-fast`, and an OpenRouter-only startup probe (`--no-probe` skips it).
- **Error taxonomy**: failures surface as one of 10 typed kinds — `insufficient_credits`, `invalid_api_key`, `model_unavailable`, `rate_limited`, `bad_request`, `malformed_response`, `server_unreachable`, `tls_error`, `timeout`, `circuit_breaker_open` — each with an actionable hint; `invalid_api_key` distinguishes a key that worked earlier this run (expired/revoked) from one that never worked.
- **Partial-failure isolation**: a failed batch marks only its chunks in `errors[]` and the run continues; answers already paid for stay in the cache; exit code is 2 when any chunk errored. A circuit breaker aborts after 3 consecutive fatal failures and reports untouched chunks as `circuit_breaker_open`.
- `--json-errors` (implies `--json`): opt-in object shape `{hits, errors}` (code) / `{answers, errors}` (rows) including per-row/per-chunk typed errors.
- **Cost**: the provider's reported number when it sends one (OpenRouter), else `tokens × $JEV_PRICE_PER_MTOK` (default `0.042` per Mtok).
- **Per-provider `jgrep init`**: pick the provider first, verify the key against it, then choose where to store it (per-provider key file, legacy env file, project `.env`, none).
- **Agent-skill install** via the vercel `skills` universal installer (`npx skills add`, every agent harness), falling back to `~/.agents/skills/jgrep`.
- **Benchmark harness**: `bench/accuracy.ts` (SMS spam + AG News) and `bench/code_selection.ts`, with fixtures committed so runs are reproducible; executed on demand by the `workflow_dispatch` Bench workflow.
- **Published accuracy numbers** (OpenRouter, `~typesafe/jev-latest`): SMS 0.95, AG News 0.84, code selection 1.00.
- install-dev.sh: dev-only interactive setup script; --choice N runs menu actions unattended for headless dev boxes (not shipped in the npm package); detects installed type/path ([CURRENT] markers), full uninstall (npm/symlink/copy/brew-aware, identity-verified, idempotent), npm/GitHub identity pinning (jevgrep ↔ kyu1204/jgrep); auto-refreshes the agent skill after local installs

### Changed

- `--json` output shape unchanged from 0.3.0 (bare array; rows entries position-aligned, errored rows `null` — no longer a run-fatal condition).
- Cache keys are model-scoped: queries against a different model (openrouter's `~typesafe/jev-latest`, any `--model` override) get their own entries and re-bill once on the first run.
- Rows and agent-skill docs updated; the bundled `skills/jgrep/SKILL.md` is rewritten around the v0.4 flags with the full `--help` screen embedded.

### Fixed

- The success-path response parse now runs inside the request timeout (the old code read the body after the abort signal had expired).
- A provider `Retry-After` header is no longer ignored.
- One failing batch no longer loses the whole run's results or cache.
- Doc: the agent example pipes `--json` through `jq '.[].file'`, matching the array shape (was `jq '.hits[].file'`).

### Security

- API keys are written with mode 0600 (per-provider key files and the legacy env file).
- A key loaded from `./.env` that is not gitignored warns on stderr.

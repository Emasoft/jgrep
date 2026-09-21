# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-09-20 — providers, reliability, isolation, benchmarks (issue #1: WI-1, WI-8, WI-11, WI-12)

### Added

- **Multi-provider layer**: `typesafe`, `openrouter`, and `gateway` (any System One-speaking endpoint, e.g. LiteLLM) speak the same protocol. Pick with `--api`, `$JEV_API`, or let jgrep find a key (typesafe first). `--model` / `$JEV_MODEL` override the model id; `JEV_GATEWAY_URL` + `JEV_GATEWAY_API_KEY` point at a self-hosted gateway.
- **Key chain**, per provider: env var > `~/.config/jgrep/<name>.key` (written 0600) > the legacy `~/.config/jgrep/env` > `./.env` in the project — with a warning when the `.env` key is not covered by `.gitignore`. `chmod 600` is a no-op on Windows; init warns there too.
- **Reliability engine**: full-jitter exponential backoff (500 ms base, 30 s cap), provider `Retry-After` honored (capped at 5 min), transport-error retries (`ECONNRESET`/`ETIMEDOUT`/`ECONNREFUSED`/`EAI_AGAIN`), `--retries` (default 4 → 5 attempts), `--request-timeout` (30 s per attempt), `--timeout` (15 s per-batch deadline including retries), `--rate REQ/SEC` token-bucket pacing, `--fail-fast`, and an OpenRouter-only startup probe (`--no-probe` skips it).
- **Error taxonomy**: failures surface as one of 10 typed kinds — `insufficient_credits`, `invalid_api_key`, `model_unavailable`, `rate_limited`, `bad_request`, `malformed_response`, `server_unreachable`, `tls_error`, `timeout`, `circuit_breaker_open` — each with an actionable hint; `invalid_api_key` distinguishes a key that worked earlier this run (expired/revoked) from one that never worked.
- **Partial-failure isolation**: a failed batch marks only its chunks in `errors[]` and the run continues; answers already paid for stay in the cache; exit code is 2 when any chunk errored. A circuit breaker aborts after 3 consecutive fatal failures and reports untouched chunks as `circuit_breaker_open`.
- **Cost**: the provider's reported number when it sends one (OpenRouter), else `tokens × $JEV_PRICE_PER_MTOK` (default `0.042` per Mtok).
- **Per-provider `jgrep init`**: pick the provider first, verify the key against it, then choose where to store it (per-provider key file, legacy env file, project `.env`, none).
- **Agent-skill install** via the vercel `skills` universal installer (`npx skills add`, every agent harness), falling back to `~/.agents/skills/jgrep`.
- **Benchmark harness**: `bench/accuracy.ts` (SMS spam + AG News) and `bench/code_selection.ts`, with fixtures committed so runs are reproducible; executed on demand by the `workflow_dispatch` Bench workflow.
- **Published accuracy numbers** (OpenRouter, `~typesafe/jev-latest`): SMS 0.95, AG News 0.84, code selection 1.00.
- install-dev.sh: dev-only interactive setup script; --choice N runs menu actions unattended for headless dev boxes (not shipped in the npm package)

### Changed

- **BREAKING**: `--json` is an object now — `{"hits":[…],"errors":[…]}` (rows mode: `{"answers":[…],"errors":[…]}`); it was a bare array.
- Cache keys are model-scoped: queries against a different model (openrouter's `~typesafe/jev-latest`, any `--model` override) get their own entries and re-bill once on the first run.
- Rows and agent-skill docs updated; the bundled `skill/SKILL.md` is rewritten around the v0.4 flags with the full `--help` screen embedded.

### Fixed

- The success-path response parse now runs inside the request timeout (the old code read the body after the abort signal had expired).
- A provider `Retry-After` header is no longer ignored.
- One failing batch no longer loses the whole run's results or cache.
- Doc: the agent example pipes `--json` through `jq '.hits[].file'`, matching the new shape (was `jq '.[].file'`).

### Security

- API keys are written with mode 0600 (per-provider key files and the legacy env file).
- A key loaded from `./.env` that is not gitignored warns on stderr.

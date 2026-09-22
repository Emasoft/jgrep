---
name: jgrep
license: MIT
compatibility: Requires Node.js 18+ (or Bun), git, and network access to the chosen provider API
description: >-
  Semantic grep for code. Use `jgrep` when you need to locate code by what it
  DOES rather than by an identifier you already know ("where do we retry
  failed requests", "code that swallows errors", "anything that shells out"),
  before opening many files to look for something, and as a cheap self-check
  of your own diff before committing. Returns file:line ranges with a
  probability, in about 2 seconds for a whole src/ tree. Keep using plain
  grep/rg for exact names and strings.
---

# jgrep

`jgrep "<description in English>" [paths]` asks a fast decision model (Jev, via
TypeSafe by default — OpenRouter and a self-hosted gateway also speak the
protocol) one yes/no question per 5-60 line chunk and prints the chunks that
match. It never reads files into your context: you get a short list, then you
Read only the ranges you need.

## Install

jgrep is usually already installed; if not:

```bash
npm i -g jevgrep     # installs the `jgrep` command
jgrep init           # pick a provider, paste your key, pick where to keep it
```

`jgrep init` asks **which provider** first (typesafe | openrouter | gateway),
verifies the key against it, stores it with `chmod 600` in
`~/.config/jgrep/<provider>.key` by default, and optionally installs this skill
into your agents via the vercel `skills` installer (every harness; fallback
`~/.agents/skills/jgrep`). Key env var already exported? Skip init.

Running from a local checkout instead of npm:

```bash
git clone <fork> && cd jgrep && bun install && bun run build && npm i -g .   # bin `jgrep` is bundled from dist
```

If you have a TypeSafe API key:

```bash
export TYPESAFE_API_KEY=...                                              # env
echo 'TYPESAFE_API_KEY=...' >> .env                                      # per project
mkdir -p ~/.config/jgrep && echo '...' > ~/.config/jgrep/typesafe.key    # global
```

If you have an OpenRouter API key:

```bash
export OPENROUTER_API_KEY=...                                            # env
echo 'OPENROUTER_API_KEY=...' >> .env                                    # per project
mkdir -p ~/.config/jgrep && echo '...' > ~/.config/jgrep/openrouter.key  # global
```

For a self-hosted gateway (any System One-speaking endpoint, e.g. LiteLLM):

```bash
export JEV_GATEWAY_URL=https://gw.example.com/v1/systemone  # full System One endpoint, required
export JEV_GATEWAY_API_KEY=...                              # or ~/.config/jgrep/gateway.key
```

Env vars win over key files, and `--api` overrides auto-detection
(`--api` > `$JEV_API` > first key found, typesafe first).

## When to use it instead of grep or reading files

- You know the behavior, not the name: "validates the webhook signature",
  "builds the SQL string by concatenation", "catches and ignores errors".
- You would otherwise open 5+ files hunting for something.
- You want a second opinion on your own change: run it on the diff.

Do not use it for exact identifiers, strings, or paths. `rg` is free and instant.

## Commands

```
jgrep "description" src/                 # hits with p >= 0.7, file order
jgrep -t 0.85 "description" src/         # fewer, higher-precision hits
jgrep -C "description" src/              # print the matching chunk bodies
jgrep --json "description" src/          # hits as a JSON array: [{file,start,end,p,text}]
jgrep --json-errors "description" src/   # object instead: {hits:[...], errors:[...]}
jgrep -a -t 0 "description" src/ | head  # everything, best first (when 0 hits)
jgrep --diff --staged "rule"             # lint your staged change
jgrep --diff origin/main "rule"          # lint the branch against main
jgrep --api openrouter "rule" src/       # pick a provider: typesafe | openrouter | gateway
```

## Help

`jgrep --help` prints the full reference — every flag, default, and exit status:

```
jgrep 0.4.0 — semantic grep powered by Jev (TypeSafe)

usage: jgrep init                       interactive setup (provider, key, agent skills)
       jgrep [options] "<description>" [path ...]
       jgrep [options] --diff [ref] "<description>"
       jgrep [options] --rows <file.csv|.jsonl> "<description>"
       jgrep [options] --rows <file> --questions <q.json> [--out scored.csv]

  -t, --threshold <p>   print chunks with probability >= p (default 0.7)
  -C, --show            print the matching chunk body under each hit
  -a, --all             print every chunk with its probability, best first
      --group/--votes <n>/--verify   grouped verdicts, N-vote medians, strict re-ask
      --estimate/--budget <usd>/--sarif/--envelopes   cost dry run, budget stop, SARIF, envelopes
      --json            machine-readable output: hits as a JSON array
                        (v0.3.0-compatible: [{file,start,end,p,text}]; rows: flattened objects)
      --json-errors     with --json: a JSON object instead — code mode
                        {hits:[...], errors:[{file,start,end,kind,message}]};
                        rows mode {answers:[...], errors:[{row,kind,message}]}
      --diff [ref]      grep git diff hunks instead of files
                        (working tree by default, or against <ref>)
      --staged          with --diff: staged changes only
      --rows <file>     grep rows of a CSV / JSONL file instead of code
      --questions <f>   with --rows: JSON of Jev questions (noul/choice/score)
                        asked of every row; prints the table with answer columns
      --out <file>      with --questions: write the CSV here instead of stdout
                        (with --json: the JSON output goes to the file)
  -b, --batch <n>       chunks per request (default 16)
  -c, --concurrency <n> parallel requests (default 16)
      --api <name>      provider: typesafe | openrouter | gateway
                        precedence: --api > $JEV_API > first key found (typesafe first)
      --model <id>      model id override (default: the provider's default; or $JEV_MODEL)
      --timeout <s>     per-batch deadline, retries included (default 15)
      --request-timeout <s>  per-attempt HTTP timeout (default 30)
      --retries <n>     failed attempts tolerated per batch (default 4)
      --rate <req/s>    global request pacing (token bucket); 0 = unlimited
      --fail-fast       abort on the first fatal error instead of isolating it
      --no-probe        skip the openrouter startup probe
      --no-cache        ignore and do not write ~/.cache/jgrep
  -v, --version         print version

exit status: 0 when something matched, 1 when nothing did, 2 on error or when any
chunk errored (partial failure: hits and errors are both reported; every failed
chunk carries a typed kind — timeout, rate_limited, insufficient_credits, ... — with a hint).
CI lint:    ! jgrep --diff origin/main "adds an endpoint without an auth check"

examples:
  jgrep "catches an error and silently ignores it" src/
  jgrep --estimate "swallows errors" src/
  jgrep --rows creators.csv "beauty is the main content of this account"
  jgrep --rows creators.csv --questions beauty.json --out scored.csv
  jgrep -C "reads user input without validating it" app/
  jgrep --diff --staged "changes billing logic without touching tests"
  OPENROUTER_API_KEY=sk-or-... jgrep --api openrouter "swallows errors" src/
```

## Reading results

```
src/loop/state.ts:108-115  p=0.96  export function readRun(...)
```

`p` is the probability the chunk matches. Treat >= 0.9 as reliable, 0.7-0.9
as worth a look, below 0.5 as no. After a run, Read only the listed ranges
(`offset`/`limit`), not whole files.

## Writing the description

- English, one concrete behavior per query. Split compound questions.
- Describe the code, not the feature name: "decides whether to send an
  alert based on OCR confidence" beats "alert feature".
- Chunks are 5-60 lines seen in isolation, so cross-file flow ("does this
  eventually write to the DB") will not match; ask about the local code.

## Reliability

Retries use full-jitter backoff and honor `Retry-After` (`--retries`, default 4);
`--timeout` bounds each batch including retries, `--request-timeout` each attempt;
`--rate REQ/SEC` paces requests. A circuit breaker aborts after 3 consecutive fatal
failures (`--fail-fast` restores abort-on-the-first); `--no-probe` skips the startup probe.

## Self-review before committing

Run 2-4 rules on the staged diff; each rule is one sentence about a mistake
you might have made. Exit 0 means a hit, so investigate those chunks.

```
jgrep --diff --staged "leaves debug output such as console.log or print"
jgrep --diff --staged "changes behavior without a corresponding test change"
jgrep --diff --staged "adds an endpoint or handler with no input validation"
```

## Tables, not code

`jgrep --rows data.csv "<description>"` treats every row as a chunk and prints
matching rows. With `--questions q.json` (a JSON object of Jev questions:
`{name: {type: noul|choice|score, instructions, criteria?}}`) it writes the
table back with one answer column per question (`--out scored.csv`, or
`--json` for the flattened answer array). Use it to label, triage or filter a
list of records instead of reading them one by one.

## Examples

No index. No embeddings. No LLM round-trips: a whole `src/` tree in ~2 s for about a cent.

| you want to find…                          | `grep` / `rg` | embeddings | an LLM | **jgrep** |
| ------------------------------------------ | :-----------: | :--------: | :----: | :-------: |
| an exact name or string                    | ✅ instant     | meh        | 🐢 $$  | use grep  |
| "code that swallows errors"                | ❌             | ❌ fuzzy    | ✅ slow | ✅ **2 s** |
| "endpoint with no auth check" *in my diff* | ❌             | ❌          | ✅ $$   | ✅ **¢**   |
| needs an index / vector DB                 | no            | yes        | no     | **no**    |

jgrep runs on [Jev](https://docs.typesafe.ai), a *System One* model: it never
generates text, it answers typed yes/no questions with calibrated
probabilities, in parallel, at $0.042 per million input tokens with output free
(`JEV_PRICE_PER_MTOK` overrides the estimate; a provider-reported cost wins
when the backend sends one). jgrep packs 16 code chunks and 16 questions into
one request and turns the probabilities into `file:line` hits.

### Find code by behavior

```bash
jgrep "reads user input without validating it" app/
jgrep -C "parses a JWT or decodes a base64 token payload" src/     # -C prints the chunk
jgrep -t 0.9 "builds an SQL string by concatenation" .            # stricter
jgrep -a -t 0 "is dead code nothing calls" lib/ | head            # everything, best first
```

### Lint a change with rules written in English

```bash
jgrep --diff --staged "leaves debug output such as console.log"
jgrep --diff origin/main "adds an HTTP endpoint that has no auth check"
jgrep --diff origin/main "changes billing logic without touching a test"
```

Exit 0 means a rule matched, so CI negates it. With a TypeSafe key:

```yaml
- run: npm i -g jevgrep
- run: '! jgrep --diff origin/${{ github.base_ref }} "adds an HTTP endpoint that has no auth check"'
  env: { TYPESAFE_API_KEY: "${{ secrets.TYPESAFE_API_KEY }}" }
```

With an OpenRouter key:

```yaml
- run: npm i -g jevgrep
- run: '! jgrep --diff origin/${{ github.base_ref }} "adds an HTTP endpoint that has no auth check"'
  env: { OPENROUTER_API_KEY: "${{ secrets.OPENROUTER_API_KEY }}" }
```

For CI that must not send code to third parties, `--api gateway` with
`JEV_GATEWAY_URL` + `JEV_GATEWAY_API_KEY` runs the same lint on your own endpoint.

### Score a table (CSV / JSONL), not just code

Every row becomes one state. One description works like grep; a JSON file of
Jev questions (noul, choice, score) adds one answer column per question.

```bash
jgrep --rows creators.csv "beauty is the main content of this account"
jgrep --rows creators.csv --questions beauty.json --out scored.csv
```

```json
{
  "beauty":   { "type": "noul",   "instructions": "Is beauty the main content of this account?" },
  "category": { "type": "choice", "instructions": "Dominant sub-category?",
                "criteria": { "skincare": "skin care", "makeup": "cosmetics", "other": "not beauty" } },
  "fit":      { "type": "score",  "instructions": "Fit for a Korean skincare seeding campaign?",
                "criteria": ["no fit", "weak", "moderate", "strong", "ideal"] }
}
```

Question objects are passed to the API verbatim, so anything Jev accepts works.
Output columns: `beauty` (probability), `category` + `category_p`, `fit` + `fit_conf`.
Eight creators and five questions is one request, 3k tokens, well under a cent;
see [`examples/`](examples/). This is the "AI map-reduce" shape: scrape N
things, ask k typed questions each, filter in a spreadsheet.

### Feed your coding agent

Agents burn most of their tokens *looking* for code. jgrep hands them a short
list of ranges instead of whole files. On a 115 KB module the agent read
6 KB of matching chunks instead of everything.

```bash
jgrep init                   # installs this skill into your AI agents (every harness)
jgrep --json "spawns a child process" src/ | jq '.[].file'             # bare array (v0.3.0 shape)
jgrep --json-errors "spawns a child process" src/ | jq '.hits[].file'  # opt-in object, errors included
```

`jgrep init` installs this skill via the vercel `skills` installer into every
agent-skills harness (fallback: `~/.agents/skills/jgrep`; manual:
`npx skills add <pkg-root>/skills -g`). The skill also has the agent run a few
`--diff --staged` rules on its own change before committing: a second model
checking the first one's work, for a fraction of a cent.

### More one-liners

```bash
jgrep -t 0.9 "locks a mutex but may return without releasing it" src/   # subtle bug, stricter threshold
jgrep -C "reads an env var and falls back to a default" bin/            # chunk bodies under each hit
jgrep --diff origin/main "introduces an N+1 query in a loop" backend/   # review a whole branch
jgrep --rows users.csv "account is likely a bot" --out bots.csv         # score rows into a file
jgrep --json "uses eval on user input" . | jq '.[0].file'               # first hit, machine-readable
jgrep -a -t 0.3 "handles timezone conversions" lib/ | head -20          # wide net, best first
```

## How it works

1. **Files** come from `git ls-files` (untracked included, ignored excluded),
   or a directory walk. Binaries and files over 1 MB are skipped.
2. **Chunks**: each file is split at column-0 line starts into 5 to 60 line
   pieces. Markdown files are split at their headings instead, each chunk
   carrying its section trail (like `jgrep > Help`) as context, and fenced code
   blocks are never split. With `--diff`, each hunk is a chunk and keeps its
   `+`/`-` markers.
3. **One request, 16 chunks, 16 questions**: `state.chunks[]` plus a Noul
   question per chunk, *"look only at chunk c3, does it match: …"*.
4. **Threshold**: probabilities at or above `-t` are printed in file order.
   Answers are cached by `(model, question, chunk)` in `~/.cache/jgrep/` —
   model-scoped keys (a different model re-judges), so a re-run is free.

A failed batch is retried, then reported on stderr (and in `errors[]` under
`--json-errors`) while the run continues: partial results still print; the
stderr summary gains `· K errored (kinds)`.

## Requirements

Installed globally as `jgrep`. Key lookup, per provider: env var >
`~/.config/jgrep/<provider>.key` > the legacy `~/.config/jgrep/env` > `./.env`
in the project. If it reports "No <provider> API key found. Looked in: …", tell
the user rather than working around it. It refuses to walk a non-git directory
with more than 5000 files — run it inside a project or pass the project path.
Exit 2 while hits still print means partial failure; the breakdown is on stderr.

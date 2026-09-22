#!/usr/bin/env bash
# shellcheck shell=bash
#
# jgrep dev installer — multi-source, for development checkouts ONLY.
# End users: `npm i -g jevgrep`. Never shipped in the npm package.
#
# Menu (stable numbering — an interface contract, never renumbered):
#   [1] local dev (symlink)   build current branch, symlink <target>/jgrep -> <repo>/dist/jgrep.js
#   [2] local pinned (copy)   build current branch, copy snapshot
#   [3] fork main (copy)      build origin/main, copy         (fetch + git worktree in a tmpdir)
#   [4] upstream main (copy)  build upstream/main, copy       (fetch + git worktree in a tmpdir)
#   [5] npm stable            npm install -g jevgrep (upstream's published release)
#   [6] check only            autodetect report, no mutation
#   [7] uninstall jgrep       remove every detected install (npm/symlink/copy/brew-aware)
#   [8] fork install (remote/curl)  clone or update the fork at ~/.local/share/jgrep, then
#                             full setup (deps, build, bin, agent skill)
#
# Modes: interactive by default. `--choice N` (or a bare N) runs one option fully
# non-interactively — zero prompts, everything auto-confirmed, deterministic
# exit codes — for headless dev boxes. `./install-dev.sh uninstall` is an alias
# for `--choice 7`. `check` prints the full autodetect report and mutates nothing.
#
# Remote/curl mode: `curl -fsSL https://raw.githubusercontent.com/Emasoft/jgrep/main/install-dev.sh | bash -s -- --choice 8`
# works without any local clone. Option 8 manages its own clone at
# ~/.local/share/jgrep (override the location with JGREP_DEV_DIR). That
# directory is SCRIPT-MANAGED: it is never a dev checkout — every re-run does
# `git fetch origin main` + `git reset --hard origin/main` there, then the full
# local setup (deps, build, system-wide bin, agent skill). A pre-existing jgrep
# install — including a symlink pointing at an old clone path — is autodetected
# and replaced exactly like option 1 does (real files archived as .bak). If bun
# is missing, [8] offers (interactive) or auto-installs (--choice/--yes) it via
# https://bun.sh/install; node >= 18 is still required to RUN the bin (missing
# node only warns). The interactive menu cannot run through a pipe — piped
# stdin or a script with no repo next to it refuses with the two documented
# one-liners (exit 2); [8] and help are the only piped-capable modes.
#
# Detection: before the menu a `current:` line reports the detected install
# (type + path + version) and the matching option is marked [CURRENT]. The scan
# covers every `jgrep` on PATH plus the classic bin dirs (npm global bin,
# /usr/local/bin, $HOME/.local/bin, brew's bin) even when off-PATH, so stale
# leftovers are reported; multiple installs produce an explicit warning.
#
# Identity: npm also hosts an UNRELATED `jgrep` package, and the jgrep/jevgrep
# names collide across GitHub. Every npm touch is identity-pinned: installs
# verify the REGISTRY entry of `jevgrep` (repository.url must contain
# github.com/kyu1204/jgrep), uninstalls verify the LOCALLY installed manifest
# (repository.url must point at upstream kyu1204/jgrep OR this fork
# Emasoft/jgrep — same project; npm-link installs of the fork carry the fork's
# manifest URL), options 3/4 verify the origin/upstream git remotes
# (Emasoft/jgrep / kyu1204/jgrep), and options 1/2 verify this checkout's
# package.json name. Mismatches refuse loudly (exit 1, no override).
#
# Agent skill: options 1/2/3/8 also refresh the agent skill from
# skills/jgrep/SKILL.md (it embeds a verbatim copy of `jgrep --help`, so a
# stale skill means wrong flags for AI agents). Step A runs the vercel `skills`
# universal installer (`npx -y skills add ./skills -g -y` — every detected
# harness); Step B falls back to copying it into the standard dir
# ~/.agents/skills/jgrep only when missing or different. Best-effort: a failed
# refresh warns but NEVER fails the install (exit code stays the install's).
# Option 4 (upstream) skips it — that tree has no skills/jgrep — and [5]/[6]/[7]
# never touch it. Only standard skill dirs are written; harness-private paths
# are never modified.
#
# Exit codes: 0 success · 2 usage error · 3 user-declined/aborted · 1 everything else.
# `--dry-run` always exits 0 (unless the usage itself is invalid).
#
# Dependency-free bash; macOS bash 3.2 and Linux compatible.

set -euo pipefail

PROG="install-dev.sh"

# ---------------------------------------------------------------------------
# identity pinning — single source of truth
# ---------------------------------------------------------------------------
# On npm the names collide: `jevgrep` is this project's upstream package
# (repository github.com/kyu1204/jgrep), while `jgrep` ("Recursive grep.",
# maintainer mustafar) is an UNRELATED package. Many GitHub repos also share
# the jgrep/jevgrep names. Every npm command below MUST go through
# $NPM_PACKAGE, and every install/uninstall is identity-verified before it
# touches anything: the REGISTRY must point at $EXPECTED_NPM_REPO, a LOCALLY
# installed manifest at $EXPECTED_NPM_REPO or the fork ($FORK_SLUG)
# (mismatch → loud refusal).
NPM_PACKAGE="jevgrep"            # the ONLY npm package this script installs/uninstalls
EXPECTED_NPM_REPO="github.com/kyu1204/jgrep"
UPSTREAM_SLUG="kyu1204/jgrep"
FORK_SLUG="Emasoft/jgrep"
FORK_URL="https://github.com/Emasoft/jgrep.git"   # clone URL for menu [8] (remote/curl)

# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------
REPO=""
INVOCATION_CWD=""
OPT_CHOICE=""
OPT_YES=0
OPT_DRY_RUN=0
OPT_TARGET=""
MODE_CHECK=0
DETACHED_MODE=0    # 1 = piped (`curl | bash`) or copied script: no repo next to $0

PLATFORM=""
NODE_BIN="" NODE_VER=""
BUN_BIN="" BUN_VER=""
NPM_BIN="" NPM_VER=""
NPM_PREFIX="" NPM_GLOBAL_BIN=""
BREW_BIN="" BREW_PREFIX="" BREW_BIN_DIR=""
SHA256_TOOL=""

REPO_BRANCH="" REPO_HEAD="" REPO_DIRTY=""
ORIGIN_SHA="" UPSTREAM_SHA=""
UPSTREAM_NPM_VER=""
DIST_SHA=""

# npm registry identity probe (check report + option 5)
NPM_REG_URL="" NPM_REG_VER="" NPM_REG_TARBALL="" NPM_IDENTITY_RC=""

# install detection (menu + uninstall share this)
CANDIDATE_LIST=""          # newline-separated raw candidate paths (deduped)
CANDIDATE_PATHS=()         # normalized, existing candidates
INSTALL_COUNT=0
INSTALL_KINDS=()
INSTALL_PATHS=()
INSTALL_SUMMARIES=()
CURRENT_PATH="" CURRENT_KIND="" CURRENT_DETAIL=""
CURRENT_VERSION_OUT="" CURRENT_SHA="" CURRENT_RESOLVED="" CURRENT_BRANCH=""
CURRENT_NPM_VER="" CURRENT_MENU_OPTION=""

# per-candidate classification scratchpad (set by classify_candidate)
C_KIND="" C_DETAIL="" C_SUMMARY="" C_SHA="" C_RESOLVED="" C_BRANCH="" C_NPM_VER=""

# uninstall bookkeeping
UNINSTALL_REMOVED=0 UNINSTALL_FAILED=0 UNINSTALL_DECLINED=0
REMOVED_LIST=""

DEST_DIR=""
BUILD_SHA=""
BUILD_OUTPUT=""

# option 8 (remote/curl) bookkeeping
REMOTE_CLONE_DIR=""   # script-managed fork clone (JGREP_DEV_DIR overrides the default)

TMP_ROOT=""
WORKTREE_DIR=""
WORKTREE_REPO=""

# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
log() { printf '%s\n' "$*"; }
warn() { printf '%s\n' "$*" >&2; }

die() {
	warn "$PROG: $*"
	exit 1
}

usage_error() {
	warn "$PROG: $1"
	warn ""
	print_usage >&2
	exit 2
}

have() { command -v "$1" >/dev/null 2>&1; }

on_path() {
	case ":$PATH:" in
	*":$1:"*) return 0 ;;
	*) return 1 ;;
	esac
}

normalize_lexical() {
	# absolute path in -> lexically normalized absolute path out (no filesystem
	# access: resolves . / .. / // and trailing slashes; bash 3.2-safe)
	local p="$1" comp out="" rest
	local -a parts=()
	case "$p" in
	/*) ;;
	*) p="$INVOCATION_CWD/$p" ;;
	esac
	rest="${p#/}"
	IFS=/ read -ra parts <<< "$rest" || true
	if [ "${#parts[@]}" -gt 0 ]; then
		for comp in "${parts[@]}"; do
			case "$comp" in
			"" | ".") continue ;;
			"..") out="${out%/*}" ;;
			*)
				if [ -z "$out" ]; then
					out="/$comp"
				else
					out="$out/$comp"
				fi
				;;
			esac
		done
	fi
	if [ -z "$out" ]; then
		out="/"
	fi
	printf '%s\n' "$out"
	return 0
}

abs_path() {
	# absolutize + normalize $1 against the invocation cwd (existence NOT required);
	# existing paths are resolved physically (pwd -P), missing ones lexically
	local p="$1" d
	case "$p" in
	"") return 1 ;;
	/*) ;;
	*) p="$INVOCATION_CWD/$p" ;;
	esac
	if [ -e "$p" ] || [ -L "$p" ]; then
		if d="$(cd -- "$(dirname -- "$p")" 2>/dev/null && pwd -P)"; then
			printf '%s/%s\n' "$d" "$(basename -- "$p")"
			return 0
		fi
	fi
	normalize_lexical "$p"
}

add_candidate() {
	# dedupe a raw candidate path into CANDIDATE_LIST (newline-separated)
	local p="$1"
	[ -n "$p" ] || return 0
	case "
$CANDIDATE_LIST
" in
	*"
$p
"*) return 0 ;;
	esac
	if [ -z "$CANDIDATE_LIST" ]; then
		CANDIDATE_LIST="$p"
	else
		CANDIDATE_LIST="$CANDIDATE_LIST
$p"
	fi
	return 0
}

dir_state() {
	# human verdict for a candidate target dir
	local d="$1"
	if [ ! -d "$d" ]; then
		printf 'missing (created on install)'
		return 0
	fi
	if [ ! -w "$d" ]; then
		printf 'not writable'
		return 0
	fi
	if on_path "$d"; then
		printf 'writable, on PATH'
	else
		printf 'writable, NOT on PATH'
	fi
	return 0
}

resolve_symlink() {
	# portable readlink -f replacement (bash 3.2 / macOS-safe)
	local p="$1" i=0 t
	while [ -L "$p" ] && [ "$i" -lt 40 ]; do
		t="$(readlink "$p")" || break
		case "$t" in
		/*) p="$t" ;;
		*) p="$(dirname "$p")/$t" ;;
		esac
		i=$((i + 1))
	done
	printf '%s\n' "$p"
	return 0
}

sha256_of() {
	# prints the hex digest of $1 (empty + rc 1 when no tool available)
	if [ "$SHA256_TOOL" = "shasum" ]; then
		shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
	elif [ "$SHA256_TOOL" = "sha256sum" ]; then
		sha256sum "$1" 2>/dev/null | awk '{print $1}'
	else
		return 1
	fi
}

jgrep_identity_line() {
	# identity proof: $1 must be executable AND answer like jgrep.
	# `--version` may print "jgrep 0.4.0" (banner style) or a bare "0.4.0"
	# (what dist/jgrep.js actually prints); `--help` banner starts with "jgrep ".
	# Prints a normalized "jgrep <version>" on success; nothing + rc 1 otherwise.
	local f="$1" out=""
	[ -n "$f" ] || return 1
	[ -x "$f" ] || return 1
	out="$("$f" --version </dev/null 2>/dev/null | head -n 1 || true)"
	case "$out" in
	"jgrep "*)
		printf 'jgrep %s\n' "$(printf '%s' "$out" | awk '{print $2}')"
		return 0
		;;
	[0-9].[0-9].[0-9]* | [0-9].[0-9]*.[0-9]*)
		printf 'jgrep %s\n' "$(printf '%s' "$out" | awk '{print $1}')"
		return 0
		;;
	esac
	out="$("$f" --help </dev/null 2>/dev/null | head -n 1 || true)"
	case "$out" in
	"jgrep "*)
		printf 'jgrep %s\n' "$(printf '%s' "$out" | awk '{print $2}')"
		return 0
		;;
	esac
	return 1
}

describe_identity() {
	# best-effort "<what it is>" for the refusal message of a non-jgrep file
	local f="$1" out=""
	if [ ! -x "$f" ]; then
		printf 'not executable'
		return 0
	fi
	out="$("$f" --version </dev/null 2>&1 | head -n 1 || true)"
	if [ -n "$out" ]; then
		printf 'it says "%s"' "${out:0:60}"
		return 0
	fi
	printf 'no --version output'
	return 0
}

remote_url() {
	git -C "$REPO" config --get "remote.$1.url" 2>/dev/null || true
}

ref_sha() {
	# short SHA of a local ref (no network, no fetch) — empty when the ref is absent
	git -C "$REPO" rev-parse --short --verify "$1" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# identity pinning helpers — git remotes + npm package
# ---------------------------------------------------------------------------
remote_expected_slug() {
	# origin -> $FORK_SLUG, anything else (upstream) -> $UPSTREAM_SLUG
	if [ "$1" = "origin" ]; then
		printf '%s\n' "$FORK_SLUG"
	else
		printf '%s\n' "$UPSTREAM_SLUG"
	fi
	return 0
}

remote_identity_state() {
	# $1 = remote name → "ok" | "missing" | "mismatch:<observed url>"
	local r="$1" url slug
	slug="$(remote_expected_slug "$r")"
	url="$(remote_url "$r")"
	if [ -z "$url" ]; then
		printf 'missing\n'
		return 0
	fi
	case "$url" in
	*"$slug"*) printf 'ok\n' ;;
	*) printf 'mismatch:%s\n' "$url" ;;
	esac
	return 0
}

remote_identity_ok() {
	[ "$(remote_identity_state "$1")" = "ok" ]
}

remote_display_url() {
	local u
	u="$(remote_url "$1")"
	[ -n "$u" ] || u="<not configured>"
	printf '%s\n' "$u"
	return 0
}

remote_identity_suffix() {
	# verdict appended to the remote URL in the check report
	local slug
	slug="$(remote_expected_slug "$1")"
	case "$(remote_identity_state "$1")" in
	ok) printf '(expected %s) — verified' "$slug" ;;
	missing) printf '(expected %s) — NOT CONFIGURED' "$slug" ;;
	mismatch:*) printf '(expected %s) — MISMATCH' "$slug" ;;
	esac
	return 0
}

remote_unavailable_marker() {
	# marker text for options 3/4 when the remote is missing or mispointed
	local s
	s="$(remote_identity_state "$1")"
	case "$s" in
	ok) return 0 ;;
	missing)
		printf '%s remote does not point to %s (remote not configured)' "$1" "$(remote_expected_slug "$1")"
		;;
	mismatch:*)
		printf '%s remote does not point to %s (observed: %s)' "$1" "$(remote_expected_slug "$1")" "${s#mismatch:}"
		;;
	esac
	return 0
}

verify_remote_identity_or_die() {
	# options 3/4 gate: the remote must be configured AND point at its
	# expected slug; refuses with the observed URL otherwise (exit 1).
	local r="$1" s
	s="$(remote_identity_state "$r")"
	case "$s" in
	ok) return 0 ;;
	missing)
		warn "$PROG: refusing: the git remote '$r' is not configured."
		warn "  expected: a URL containing $(remote_expected_slug "$r")"
		exit 1
		;;
	mismatch:*)
		warn "$PROG: refusing: the git remote '$r' does not point at $(remote_expected_slug "$r")."
		warn "  observed $r URL: ${s#mismatch:}"
		warn "  expected: a URL containing $(remote_expected_slug "$r")"
		exit 1
		;;
	esac
	return 0
}

npm_repo_url_matches() {
	# $1 = URL → 0 when it points at $EXPECTED_NPM_REPO (accepts the ssh-style
	# git@github.com:owner/repo spelling too — same repository)
	local url="$1"
	[ -n "$url" ] || return 1
	case "$url" in
	*"$EXPECTED_NPM_REPO"* | *"github.com:${EXPECTED_NPM_REPO#github.com/}"*) return 0 ;;
	*) return 1 ;;
	esac
}

npm_manifest_repo_url_matches() {
	# $1 = URL → 0 when a LOCALLY installed manifest points at this project:
	# upstream ($EXPECTED_NPM_REPO = kyu1204/jgrep) OR the fork ($FORK_SLUG =
	# Emasoft/jgrep) — same project, upstream or fork; npm-link installs of the
	# fork carry the fork's manifest URL. Accepts the ssh-style
	# git@github.com:owner/repo spelling for both. Anything else (the unrelated
	# 'jgrep' package, a hijacked name) is refused.
	local url="$1"
	[ -n "$url" ] || return 1
	case "$url" in
	*"$EXPECTED_NPM_REPO"* | *"github.com:${EXPECTED_NPM_REPO#github.com/}"* | *"github.com/$FORK_SLUG"* | *"github.com:$FORK_SLUG"*) return 0 ;;
	*) return 1 ;;
	esac
}

npm_registry_identity_probe() {
	# read-only registry probe; sets NPM_REG_URL / NPM_REG_VER / NPM_REG_TARBALL.
	# rc 0 = identity verified, 1 = MISMATCH, 2 = registry unreachable/empty.
	# (version reuses collect_repo_state's UPSTREAM_NPM_VER — one fewer call)
	NPM_REG_URL="" NPM_REG_VER="" NPM_REG_TARBALL=""
	NPM_REG_URL="$(npm view "$NPM_PACKAGE" repository.url 2>/dev/null | head -n 1 || true)"
	NPM_REG_VER="$UPSTREAM_NPM_VER"
	if [ -n "$NPM_REG_URL" ]; then
		NPM_REG_TARBALL="$(npm view "$NPM_PACKAGE" dist.tarball 2>/dev/null | head -n 1 || true)"
		if npm_repo_url_matches "$NPM_REG_URL"; then
			return 0
		fi
		return 1
	fi
	return 2
}

npm_registry_refuse() {
	# loud refusal for option 5; $1 = "mismatch" | "unreachable". No override.
	local reason="$1"
	if [ "$reason" = "unreachable" ]; then
		warn "$PROG: refusing to install: cannot verify the npm identity of '$NPM_PACKAGE' (registry did not answer)."
		warn "  expected repository: *$EXPECTED_NPM_REPO* — observed: <no answer from 'npm view $NPM_PACKAGE repository.url'>"
	else
		warn "$PROG: refusing to install: the npm package '$NPM_PACKAGE' does not point at $EXPECTED_NPM_REPO anymore."
		warn "  observed repository.url: $NPM_REG_URL"
		warn "  expected: a URL containing $EXPECTED_NPM_REPO"
	fi
	warn "  no override exists on purpose: npm also hosts an UNRELATED 'jgrep' package (name collision),"
	warn "  and this check guards against future takeovers of the '$NPM_PACKAGE' name."
	exit 1
}

npm_registry_verdict_text() {
	# one-line verdict for the check report
	case "${NPM_IDENTITY_RC:-}" in
	0) printf '— verified (repository.url: %s)' "$NPM_REG_URL" ;;
	1) printf '— MISMATCH (repository.url: %s)' "$NPM_REG_URL" ;;
	2) printf '— unverified (registry unreachable)' ;;
	*) printf '— unverified (not probed)' ;;
	esac
	return 0
}

npm_global_pkg_json() {
	# absolute path of the globally installed $NPM_PACKAGE manifest, rc 1 when
	# absent. `npm root -g` is the canonical location on every platform (incl.
	# Windows layouts); the <prefix>/lib/node_modules and <prefix>/node_modules
	# fallbacks cover npm layouts where root -g says something else.
	local root d f
	if [ -n "$NPM_BIN" ]; then
		root="$(npm root -g 2>/dev/null || true)"
		if [ -n "$root" ]; then
			f="$root/$NPM_PACKAGE/package.json"
			if [ -f "$f" ]; then
				printf '%s\n' "$f"
				return 0
			fi
		fi
	fi
	for d in "$NPM_PREFIX/lib/node_modules" "$NPM_PREFIX/node_modules"; do
		[ -n "$d" ] || continue
		f="$d/$NPM_PACKAGE/package.json"
		if [ -f "$f" ]; then
			printf '%s\n' "$f"
			return 0
		fi
	done
	return 1
}

npm_pkg_json_repository_url() {
	# best-effort repository URL from an npm-written package.json (no jq):
	# "repository": { ... "url": "..." } → string form → legacy _repository.
	# Prints nothing when no field is found (caller decides what that means).
	local f="$1" u=""
	u="$(sed -n 's/.*"repository"[[:space:]]*:[[:space:]]*{[^}]*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" 2>/dev/null | head -n 1 || true)"
	if [ -z "$u" ]; then
		u="$(sed -n 's/.*"repository"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" 2>/dev/null | head -n 1 || true)"
	fi
	if [ -z "$u" ]; then
		u="$(sed -n 's/.*"_repository"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$f" 2>/dev/null | head -n 1 || true)"
	fi
	[ -n "$u" ] && printf '%s\n' "$u"
	return 0
}

verify_npm_package_identity_local() {
	# offline identity gate for every `npm uninstall -g` this script runs: the
	# LOCALLY installed $NPM_PACKAGE manifest must point at upstream
	# ($EXPECTED_NPM_REPO) or this fork ($FORK_SLUG). Refuses loudly (exit 1)
	# on mismatch, on a missing repository field, and when npm claims the
	# package but no manifest can be found.
	local f url
	if ! f="$(npm_global_pkg_json)"; then
		warn "$PROG: refusing to uninstall: npm owns jgrep ('npm ls -g $NPM_PACKAGE' succeeds)"
		warn "  but the installed package manifest is missing or unreadable — identity unverifiable."
		warn "  expected: a manifest pointing at $UPSTREAM_SLUG or $FORK_SLUG — observed: <no $NPM_PACKAGE/package.json>"
		warn "  inspect it manually first: npm ls -g $NPM_PACKAGE && npm root -g"
		exit 1
	fi
	url="$(npm_pkg_json_repository_url "$f")"
	if [ -z "$url" ]; then
		warn "$PROG: refusing to uninstall: the installed $NPM_PACKAGE manifest has no repository field — identity unverifiable."
		warn "  manifest: $f"
		warn "  expected: a manifest pointing at $UPSTREAM_SLUG or $FORK_SLUG — observed: <no repository field>"
		exit 1
	fi
	if ! npm_manifest_repo_url_matches "$url"; then
		warn "$PROG: refusing to uninstall: the locally installed npm package '$NPM_PACKAGE' does not point at $UPSTREAM_SLUG or $FORK_SLUG."
		warn "  expected: a manifest pointing at $UPSTREAM_SLUG or $FORK_SLUG; observed: $url (manifest: $f)"
		warn "  no override exists on purpose: npm also hosts an UNRELATED 'jgrep' package (name collision),"
		warn "  and this check guards against future takeovers of the '$NPM_PACKAGE' name."
		exit 1
	fi
	log "==> npm identity verified: $NPM_PACKAGE ($f) -> $url"
	return 0
}

verify_local_checkout_identity() {
	# options 1/2 gate: they build THIS checkout, so its package.json must
	# name jevgrep (many GitHub repos share the jgrep name).
	local name=""
	name="$(sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO/package.json" 2>/dev/null | head -n 1 || true)"
	if [ "$name" != "$NPM_PACKAGE" ]; then
		warn "$PROG: refusing to build: this checkout's package.json says \"name\": \"${name:-<missing>}\", expected \"$NPM_PACKAGE\"."
		warn "  this script must run from the jevgrep checkout (the jgrep name is shared by unrelated repos)."
		exit 1
	fi
	return 0
}

# ---------------------------------------------------------------------------
# tmpdir + worktree cleanup (trap-based)
# ---------------------------------------------------------------------------
ensure_tmp_root() {
	if [ -z "$TMP_ROOT" ]; then
		TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/jgrep-install.XXXXXX")" || return 1
	fi
	return 0
}

remove_worktree() {
	if [ -n "$WORKTREE_DIR" ] && [ -n "$WORKTREE_REPO" ]; then
		git -C "$WORKTREE_REPO" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
		git -C "$WORKTREE_REPO" worktree prune >/dev/null 2>&1 || true
		WORKTREE_DIR=""
		WORKTREE_REPO=""
	fi
	return 0
}

cleanup() {
	local rc=$?
	trap - EXIT
	remove_worktree
	if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
		rm -rf "$TMP_ROOT"
	fi
	exit "$rc"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# environment autodetect
# ---------------------------------------------------------------------------
detect_environment() {
	PLATFORM="$(uname -sm)"

	if have node; then
		NODE_BIN="$(command -v node)"
		NODE_VER="$(node --version 2>/dev/null || true)"
	fi
	if have bun; then
		BUN_BIN="$(command -v bun)"
		BUN_VER="$(bun --version 2>/dev/null || true)"
	fi
	if have npm; then
		NPM_BIN="$(command -v npm)"
		NPM_VER="$(npm --version 2>/dev/null || true)"
		NPM_PREFIX="$(npm prefix -g 2>/dev/null || true)"
		if [ -n "$NPM_PREFIX" ]; then
			NPM_GLOBAL_BIN="$NPM_PREFIX/bin"
		fi
	fi

	if have brew; then
		BREW_BIN="$(command -v brew)"
		BREW_PREFIX="$(brew --prefix 2>/dev/null || true)"
		if [ -n "$BREW_PREFIX" ]; then
			BREW_BIN_DIR="$BREW_PREFIX/bin"
		fi
	fi

	if have shasum; then
		SHA256_TOOL="shasum"
	elif have sha256sum; then
		SHA256_TOOL="sha256sum"
	else
		SHA256_TOOL=""
	fi
}

npm_owns_live() {
	[ -n "$NPM_BIN" ] || return 1
	npm ls -g "$NPM_PACKAGE" >/dev/null 2>&1
}

npm_installed_jevgrep_version() {
	local out=""
	out="$(npm ls -g "$NPM_PACKAGE" --depth=0 2>/dev/null | sed -n "s/.*$NPM_PACKAGE@\([^ ]*\).*/\1/p" | head -n 1 || true)"
	if [ -z "$out" ]; then
		out="unknown"
	fi
	printf '%s\n' "$out"
	return 0
}

# ---------------------------------------------------------------------------
# repo state (LOCAL refs only — check mode never fetches)
# ---------------------------------------------------------------------------
collect_repo_state() {
	local n
	REPO_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
	if [ -z "$REPO_BRANCH" ]; then
		REPO_BRANCH="unknown"
	fi
	REPO_HEAD="$(ref_sha HEAD)"
	n="$(git -C "$REPO" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
	if [ "$n" -gt 0 ]; then
		REPO_DIRTY="dirty ($n uncommitted change(s))"
	else
		REPO_DIRTY="clean"
	fi
	ORIGIN_SHA="$(ref_sha origin/main)"
	UPSTREAM_SHA="$(ref_sha upstream/main)"

	if [ -f "$REPO/dist/jgrep.js" ]; then
		DIST_SHA="$(sha256_of "$REPO/dist/jgrep.js" || true)"
	fi

	if [ -n "$NPM_BIN" ]; then
		UPSTREAM_NPM_VER="$(npm view "$NPM_PACKAGE" version 2>/dev/null | head -n 1 || true)"
	fi
}

# ---------------------------------------------------------------------------
# install detection: scan ALL jgrep entries, classify each, pick the current
# ---------------------------------------------------------------------------
brew_owns_jevgrep() {
	[ -n "$BREW_BIN" ] || return 1
	brew list --formula jevgrep >/dev/null 2>&1
}

classify_candidate() {
	# $1 = candidate path (absolute; file or symlink on disk).
	# Static classification only — never executes the candidate (identity is
	# proven lazily via jgrep_identity_line for the selected install/uninstall).
	# Sets: C_KIND C_SUMMARY C_DETAIL C_SHA C_RESOLVED C_BRANCH C_NPM_VER
	C_KIND="copy" C_SUMMARY="" C_DETAIL="" C_SHA="" C_RESOLVED="" C_BRANCH="" C_NPM_VER=""
	local f="$1" dir
	if [ ! -e "$f" ] && [ ! -L "$f" ]; then
		C_KIND="missing"
		C_SUMMARY="missing"
		C_DETAIL="$f (already gone)"
		return 0
	fi
	dir="$(dirname "$f")"
	C_SHA="$(sha256_of "$f" || true)"

	# npm-owned: inside npm's global bin dir AND npm claims the package
	if [ -n "$NPM_GLOBAL_BIN" ] && [ "$dir" = "$NPM_GLOBAL_BIN" ] && npm_owns_live; then
		C_KIND="npm"
		C_NPM_VER="$(npm_installed_jevgrep_version)"
		C_SUMMARY="npm ($NPM_PACKAGE $C_NPM_VER)"
		C_DETAIL="$NPM_PACKAGE $C_NPM_VER — $f"
		return 0
	fi

	# Homebrew-owned: inside brew's bin dir AND brew owns the formula
	if [ -n "$BREW_BIN_DIR" ] && [ "$dir" = "$BREW_BIN_DIR" ] && brew_owns_jevgrep; then
		C_KIND="brew"
		C_SUMMARY="brew (formula jevgrep)"
		C_DETAIL="Homebrew formula jevgrep — $f"
		return 0
	fi

	if [ -L "$f" ]; then
		local repo_root
		C_RESOLVED="$(resolve_symlink "$f")"
		repo_root="$(git -C "$(dirname "$C_RESOLVED")" rev-parse --show-toplevel 2>/dev/null || true)"
		if [ -n "$repo_root" ] && [ -f "$repo_root/package.json" ]; then
			C_KIND="symlink-into-repo"
			C_BRANCH="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
			if [ -z "$C_BRANCH" ]; then
				C_BRANCH="detached"
			fi
			C_SUMMARY="symlink-into-repo ($C_BRANCH) -> $C_RESOLVED"
			C_DETAIL="$C_BRANCH — $f -> $C_RESOLVED"
		else
			C_KIND="symlink"
			C_SUMMARY="symlink -> $C_RESOLVED"
			C_DETAIL="$f -> $C_RESOLVED"
		fi
		return 0
	fi

	C_KIND="copy"
	C_SUMMARY="copy (sha256:${C_SHA:0:8})"
	C_DETAIL="sha256:${C_SHA:0:8} — $f"
	return 0
}

scan_installs() {
	# candidates = every `jgrep` on PATH (type -a) PLUS the classic bin dirs —
	# npm global bin, /usr/local/bin, $HOME/.local/bin, brew's bin — even when
	# off-PATH (stale leftovers), plus an explicit --target install.
	CANDIDATE_LIST=""
	CANDIDATE_PATHS=()
	INSTALL_COUNT=0
	INSTALL_KINDS=()
	INSTALL_PATHS=()
	INSTALL_SUMMARIES=()

	local p d
	while IFS= read -r p; do
		add_candidate "$p"
	done <<EOF
$(shadow_paths)
EOF
	for d in "$NPM_GLOBAL_BIN" "/usr/local/bin" "$HOME/.local/bin" "$BREW_BIN_DIR"; do
		[ -n "$d" ] || continue
		add_candidate "$d/jgrep"
	done
	if [ -n "$OPT_TARGET" ]; then
		add_candidate "$OPT_TARGET/jgrep"
	fi

	# normalize + keep only entries that actually exist on disk (drops
	# alias/function hits from `type -a`)
	while IFS= read -r p; do
		[ -n "$p" ] || continue
		p="$(abs_path "$p")"
		if [ -e "$p" ] || [ -L "$p" ]; then
			CANDIDATE_PATHS+=("$p")
		fi
	done <<EOF
$CANDIDATE_LIST
EOF

	if [ "${#CANDIDATE_PATHS[@]}" -eq 0 ]; then
		return 0
	fi
	for p in "${CANDIDATE_PATHS[@]}"; do
		classify_candidate "$p"
		INSTALL_COUNT=$((INSTALL_COUNT + 1))
		INSTALL_KINDS+=("$C_KIND")
		INSTALL_PATHS+=("$p")
		INSTALL_SUMMARIES+=("$C_SUMMARY")
	done
	return 0
}

select_current_install() {
	# the menu-relevant install: what `command -v jgrep` resolves to first;
	# when nothing is on PATH, an explicit --target install still counts
	# (it is the dir this invocation manages).
	CURRENT_PATH="" CURRENT_KIND="none" CURRENT_DETAIL="" CURRENT_VERSION_OUT=""
	CURRENT_SHA="" CURRENT_RESOLVED="" CURRENT_BRANCH="" CURRENT_NPM_VER=""
	CURRENT_MENU_OPTION=""

	local sel=""
	sel="$(command -v jgrep 2>/dev/null || true)"
	if [ -z "$sel" ] && [ -n "$OPT_TARGET" ]; then
		if [ -e "$OPT_TARGET/jgrep" ] || [ -L "$OPT_TARGET/jgrep" ]; then
			sel="$OPT_TARGET/jgrep"
		fi
	fi
	if [ -z "$sel" ]; then
		return 0
	fi
	sel="$(abs_path "$sel")" || true
	if [ -z "$sel" ]; then
		return 0
	fi
	CURRENT_PATH="$sel"
	classify_candidate "$sel"
	CURRENT_KIND="$C_KIND"
	CURRENT_DETAIL="$C_DETAIL"
	CURRENT_SHA="$C_SHA"
	CURRENT_RESOLVED="$C_RESOLVED"
	CURRENT_BRANCH="$C_BRANCH"
	CURRENT_NPM_VER="$C_NPM_VER"

	if [ "$CURRENT_KIND" = "missing" ]; then
		CURRENT_KIND="unknown"
		CURRENT_DETAIL="not a file on disk (shell alias/function?) — $CURRENT_PATH"
		return 0
	fi

	# identity proof: the selected install must run and answer like jgrep
	CURRENT_VERSION_OUT="$(jgrep_identity_line "$CURRENT_PATH" || true)"

	case "$CURRENT_KIND" in
	npm)
		CURRENT_MENU_OPTION="5"
		;;
	symlink-into-repo)
		# [1] only when the link points at THIS checkout's build
		if [ "$CURRENT_RESOLVED" = "$REPO/dist/jgrep.js" ]; then
			CURRENT_MENU_OPTION="1"
		fi
		;;
	copy)
		# [2] only when the copy is byte-identical to the current build
		if [ -n "$DIST_SHA" ] && [ -n "$CURRENT_SHA" ] && [ "$CURRENT_SHA" = "$DIST_SHA" ]; then
			CURRENT_MENU_OPTION="2"
		fi
		;;
	esac
	return 0
}

version_word() {
	# "jgrep 0.4.0" -> "0.4.0"; empty input -> "version unknown"
	local line="$1" v=""
	if [ -n "$line" ]; then
		v="$(printf '%s' "$line" | awk '{print $2}')"
	fi
	if [ -z "$v" ]; then
		v="version unknown"
	fi
	printf '%s\n' "$v"
	return 0
}

print_current_line() {
	# the `current:` line printed right above the menu (+ explicit warnings)
	local v
	case "$CURRENT_KIND" in
	none)
		log "current: none"
		;;
	npm)
		v="$(version_word "$CURRENT_VERSION_OUT")"
		if [ "$v" = "version unknown" ] && [ -n "$CURRENT_NPM_VER" ]; then
			v="$CURRENT_NPM_VER"
		fi
		log "current: npm ($NPM_PACKAGE $v) @ $CURRENT_PATH"
		;;
	brew)
		v="$(version_word "$CURRENT_VERSION_OUT")"
		log "current: brew (jevgrep $v) @ $CURRENT_PATH — Homebrew owns it (formula jevgrep)"
		;;
	symlink-into-repo)
		v="$(version_word "$CURRENT_VERSION_OUT")"
		log "current: symlink-into-repo ($CURRENT_BRANCH) @ $CURRENT_PATH -> $CURRENT_RESOLVED ($v)"
		;;
	symlink)
		v="$(version_word "$CURRENT_VERSION_OUT")"
		log "current: symlink @ $CURRENT_PATH -> $CURRENT_RESOLVED ($v)"
		;;
	copy)
		v="$(version_word "$CURRENT_VERSION_OUT")"
		if [ "$CURRENT_MENU_OPTION" = "2" ]; then
			log "current: copy @ $CURRENT_PATH ($v, sha256:${CURRENT_SHA:0:8})"
		else
			log "current: copy @ $CURRENT_PATH ($v, sha256:${CURRENT_SHA:0:8}, older snapshot — provenance unknown)"
		fi
		;;
	*)
		log "current: unknown — $CURRENT_DETAIL"
		;;
	esac
	if [ "$INSTALL_COUNT" -gt 1 ]; then
		warn "warning: $INSTALL_COUNT jgrep installs detected — uninstall [7] cleans all of them"
	fi
	if [ "$CURRENT_KIND" = "brew" ]; then
		warn "warning: Homebrew owns jgrep (formula jevgrep) — manage it with brew, not this script"
	fi
	return 0
}

print_install_list() {
	# every detected entry: type + path (+ on/off-PATH note)
	local i=0
	if [ "$INSTALL_COUNT" -eq 0 ]; then
		log "  none"
		return 0
	fi
	while [ "$i" -lt "$INSTALL_COUNT" ]; do
		if on_path "$(dirname "${INSTALL_PATHS[$i]}")"; then
			log "  ${INSTALL_SUMMARIES[$i]} @ ${INSTALL_PATHS[$i]} (on PATH)"
		else
			log "  ${INSTALL_SUMMARIES[$i]} @ ${INSTALL_PATHS[$i]} (off-PATH)"
		fi
		i=$((i + 1))
	done
	return 0
}

# ---------------------------------------------------------------------------
# target dir
# ---------------------------------------------------------------------------
validate_target() {
	# absolutize --target (against the invocation cwd) and refuse dangerous
	# destinations — fatal, exit 2 — before anything else runs.
	[ -n "$OPT_TARGET" ] || return 0
	local t
	t="$(abs_path "$OPT_TARGET")" || usage_error "cannot resolve --target '$OPT_TARGET'"
	if [ "$t" = "/" ]; then
		usage_error "--target / is not allowed (refusing to install into /)"
	fi
	if [ "$t" = "$HOME" ]; then
		usage_error "--target $HOME is not allowed (refusing to install into your home directory)"
	fi
	if [ "$t" = "$REPO" ]; then
		usage_error "--target $REPO is not allowed (refusing to target the repo root itself)"
	fi
	OPT_TARGET="$t"
	return 0
}

resolve_default_target() {
	# default chain: $(npm prefix -g)/bin -> /usr/local/bin -> $HOME/.local/bin
	# $1 = 1 → may create $HOME/.local/bin (real installs); 0 → report only
	local create="$1" cand
	if [ -n "$NPM_GLOBAL_BIN" ] && [ -d "$NPM_GLOBAL_BIN" ] && [ -w "$NPM_GLOBAL_BIN" ]; then
		printf '%s\n' "$NPM_GLOBAL_BIN"
		return 0
	fi
	if [ -d "/usr/local/bin" ] && [ -w "/usr/local/bin" ]; then
		printf '%s\n' "/usr/local/bin"
		return 0
	fi
	cand="$HOME/.local/bin"
	if [ ! -d "$cand" ] && [ "$create" -eq 1 ]; then
		mkdir -p "$cand" || return 1
	fi
	printf '%s\n' "$cand"
	return 0
}

resolve_dest_dir() {
	# `check` and choice 6 are report-only: they resolve DEST_DIR for the report but
	# must never CREATE it (a missing ~/.local/bin used to be mkdir'd under
	# "no mutation"); --dry-run already never mutates.
	local no_mutation=0
	if [ "$MODE_CHECK" -eq 1 ] || [ "$OPT_DRY_RUN" -eq 1 ] || [ "$OPT_CHOICE" = "6" ]; then
		no_mutation=1
	fi
	if [ -n "$OPT_TARGET" ]; then
		if [ "$OPT_DRY_RUN" -eq 1 ]; then
			DEST_DIR="$OPT_TARGET"
			if [ -e "$DEST_DIR" ] && [ ! -d "$DEST_DIR" ]; then
				warn "DRY-RUN: --target $DEST_DIR exists and is not a directory (a real run would fail)"
			elif [ ! -d "$DEST_DIR" ]; then
				log "DRY-RUN: target dir $DEST_DIR missing — a real run would create it"
			fi
			return 0
		fi
		if [ -e "$OPT_TARGET" ] && [ ! -d "$OPT_TARGET" ]; then
			die "--target $OPT_TARGET exists and is not a directory"
		fi
		if [ "$no_mutation" -eq 0 ]; then
			mkdir -p "$OPT_TARGET" || die "cannot create --target $OPT_TARGET"
		fi
		DEST_DIR="$OPT_TARGET"
		return 0
	fi

	DEST_DIR="$(resolve_default_target 0)" || die "cannot resolve a default target dir"
	if [ "$no_mutation" -eq 0 ] && [ ! -d "$DEST_DIR" ]; then
		mkdir -p "$DEST_DIR" || die "cannot create target dir $DEST_DIR"
	fi
	return 0
}

# ---------------------------------------------------------------------------
# menu + usage
# ---------------------------------------------------------------------------
menu_line() {
	# one menu row incl. the availability marker (used by the report)
	case "$1" in
	1) printf '  [1] local dev (symlink)   — build current branch, symlink <target>/jgrep -> <repo>/dist/jgrep.js' ;;
	2) printf '  [2] local pinned (copy)   — build current branch, copy snapshot' ;;
	3) printf '  [3] fork main (copy)      — build origin/main, copy         (fetch + git worktree in a tmpdir)' ;;
	4) printf '  [4] upstream main (copy)  — build upstream/main, copy       (fetch + git worktree in a tmpdir)' ;;
	5) printf '  [5] npm stable            — npm install -g %s (upstream'"'"'s published release)' "$NPM_PACKAGE" ;;
	6) printf '  [6] check only            — autodetect report, no mutation' ;;
	7) printf '  [7] uninstall jgrep       — remove every detected install (npm/symlink/copy/brew-aware, identity-verified)' ;;
	8) printf '  [8] fork install (remote/curl) — clone or update the fork at ~/.local/share/jgrep, then full setup (deps, build, bin, agent skill)' ;;
	esac
}

menu_marker() {
	# the currently-installed type wins over the availability marker
	if [ -n "$CURRENT_MENU_OPTION" ] && [ "$1" = "$CURRENT_MENU_OPTION" ]; then
		printf '[CURRENT]'
		return 0
	fi
	case "$1" in
	1 | 2 | 3 | 4)
		if [ -z "$BUN_BIN" ]; then
			printf '[unavailable: bun missing → only npm stable remains]'
			return 0
		fi
		if [ "$1" = "3" ] && ! remote_identity_ok origin; then
			printf '[unavailable: %s]' "$(remote_unavailable_marker origin)"
			return 0
		fi
		if [ "$1" = "4" ] && ! remote_identity_ok upstream; then
			printf '[unavailable: %s]' "$(remote_unavailable_marker upstream)"
			return 0
		fi
		printf '[AVAILABLE]'
		if [ -z "$NODE_BIN" ]; then
			printf ' (warning: node missing — the installed bin will not run)'
		fi
		;;
	5)
		if [ -z "$NPM_BIN" ]; then
			printf '[unavailable: npm missing]'
			return 0
		fi
		printf '[AVAILABLE]'
		if [ -z "$NODE_BIN" ]; then
			printf ' (warning: node missing — the bin will not run)'
		fi
		;;
	6 | 7) printf '[AVAILABLE]' ;;
	8)
		# [8] needs git + curl (it clones/updates the fork itself); bun is
		# handled inside the option (offered/auto-installed when missing)
		if ! have git; then
			printf '[unavailable: git missing]'
			return 0
		fi
		if ! have curl; then
			printf '[unavailable: curl missing]'
			return 0
		fi
		printf '[AVAILABLE]'
		if [ -z "$NODE_BIN" ]; then
			printf ' (warning: node missing — the installed bin will not run)'
		fi
		;;
	esac
	return 0
}

print_menu_with_markers() {
	print_current_line
	local i line marker pad
	for i in 1 2 3 4 5 6 7 8; do
		line="$(menu_line "$i")"
		marker="$(menu_marker "$i")"
		pad=$((101 - ${#line}))
		if [ "$pad" -lt 2 ]; then
			pad=2
		fi
		printf '%s%*s%s\n' "$line" "$pad" "" "$marker"
	done
	log "  [q] quit"
}

print_usage() {
	cat <<'USAGE'
Usage:
  ./install-dev.sh                       interactive menu
  ./install-dev.sh --choice N            NON-interactive: pick menu item N (implies --yes)
  ./install-dev.sh <n>                   bare number = same as --choice n
  ./install-dev.sh uninstall             alias for --choice 7 (full uninstall, implies --yes)
  ./install-dev.sh check                 autodetect report, no mutation
  ./install-dev.sh help | --help | -h    usage + menu
  ./install-dev.sh [n|--choice N] [--yes] [--dry-run] [--target DIR]
  curl -fsSL https://raw.githubusercontent.com/Emasoft/jgrep/main/install-dev.sh | bash -s -- --choice 8
                                         remote/curl install from GitHub — no clone needed (menu [8])

jgrep dev installer — multi-source, for development checkouts ONLY.
End users: `npm i -g jevgrep`. Never shipped in the npm package.

Options:
  --choice N   run menu item N fully non-interactively: zero prompts, everything
               auto-confirmed, deterministic exit codes (implies --yes) — for
               headless dev boxes. Accepts --choice=N; a bare N works the same.
  --yes        auto-confirm all prompts (implied by --choice N / bare N).
  --dry-run    do everything except the final target mutation; would-be commands
               are printed with DRY-RUN: prefixes; always exits 0.
  --target DIR install into DIR instead of the default target chain
               ($(npm prefix -g)/bin -> /usr/local/bin -> $HOME/.local/bin).
               /, your home directory, and the repo root are refused.

Menu (stable numbering — an interface contract, never renumbered):
  [1] local dev (symlink)   — build current branch, symlink <target>/jgrep -> <repo>/dist/jgrep.js
  [2] local pinned (copy)   — build current branch, copy snapshot
  [3] fork main (copy)      — build origin/main, copy         (fetch + git worktree in a tmpdir)
  [4] upstream main (copy)  — build upstream/main, copy       (fetch + git worktree in a tmpdir)
  [5] npm stable            — npm install -g jevgrep (upstream's published release)
  [6] check only            — autodetect report, no mutation
  [7] uninstall jgrep       — remove every detected install (npm/symlink/copy/brew-aware, identity-verified)
  [8] fork install (remote/curl) — clone or update the fork at ~/.local/share/jgrep, then full setup (deps, build, bin, agent skill)

Before the menu a `current:` line reports the detected install (type, path,
version) and the matching option is marked [CURRENT]. The scan covers every
`jgrep` on PATH plus the classic bin dirs (npm global bin, /usr/local/bin,
~/.local/bin, brew's bin) even when off-PATH; multiple installs produce an
explicit warning. Uninstall is idempotent: "jgrep is not installed — nothing
to do" when nothing is installed, and it refuses to remove files that are not
jgrep.

Remote/curl install ([8]): clones this fork into ~/.local/share/jgrep
(override with JGREP_DEV_DIR) — a SCRIPT-MANAGED directory, never a dev
checkout: every re-run fetches origin/main and `git reset --hard origin/main`
there, then runs the full local setup (bun install, build, system-wide `jgrep`
bin on PATH, agent-skill refresh). A pre-existing install — including a
symlink to an old clone path — is autodetected and replaced exactly like
option 1: symlinks are repointed, real files archived as .bak with the printed
`mv` revert command. Updating = re-running the same command. Works through a
pipe (`curl … | bash -s -- --choice 8`); the interactive menu does NOT work
through a pipe (no TTY on stdin → refusal with the two one-liners, exit 2).
If bun is missing, [8] offers it (interactive y/N) or auto-installs it
(--choice/--yes) via https://bun.sh/install; node >= 18 is still required at
runtime (a missing node only warns).

Identity pinning: every npm install/uninstall verifies that the `jevgrep`
package still points at github.com/kyu1204/jgrep (the npm package `jgrep` is
UNRELATED — name collision), options 3/4 verify the origin/upstream git
remotes (Emasoft/jgrep / kyu1204/jgrep), option 8 verifies the clone's origin
URL, and options 1/2 verify this checkout's package.json name. Mismatches
refuse loudly; there is no override.

Exit codes: 0 success · 2 usage error · 3 user-declined/aborted · 1 everything else.
USAGE
}

# ---------------------------------------------------------------------------
# report
# ---------------------------------------------------------------------------
shadow_paths() {
	type -a jgrep 2>/dev/null | awk '{print $NF}' || true
}

shadow_summary() {
	local list joined p
	list="$(shadow_paths)"
	if [ -z "$list" ]; then
		printf 'none (jgrep not found on PATH)'
		return 0
	fi
	joined=""
	while IFS= read -r p; do
		[ -n "$p" ] || continue
		if [ -z "$joined" ]; then
			joined="$p"
		else
			joined="$joined > $p"
		fi
	done <<< "$list"
	printf '%s\n' "$joined"
	return 0
}

ahead_behind_origin() {
	local ab ahead behind
	ab="$(git -C "$REPO" rev-list --left-right --count "HEAD...origin/main" 2>/dev/null || true)"
	if [ -z "$ab" ]; then
		printf 'unknown (no local origin/main ref)'
		return 0
	fi
	ahead="$(printf '%s\n' "$ab" | awk '{print $1}')"
	behind="$(printf '%s\n' "$ab" | awk '{print $2}')"
	if [ "${ahead:-0}" = "0" ] && [ "${behind:-0}" = "0" ]; then
		printf 'in sync with origin/main'
	else
		printf 'ahead %s / behind %s vs origin/main' "${ahead:-?}" "${behind:-?}"
	fi
	return 0
}

print_report() {
	# $1 = 0 compact (every run) | 1 full detail (check)
	local verbose="$1" chosen

	log "== jgrep dev installer — autodetect =="
	log "platform:        $PLATFORM"
	log "runtime:         bash $BASH_VERSION"
	if [ -n "$NODE_BIN" ]; then
		log "node:            $NODE_BIN ($NODE_VER) — required to run the installed bin"
	else
		log "node:            MISSING — installed bins will not run (need node >= 18)"
	fi
	if [ -n "$BUN_BIN" ]; then
		log "bun:             $BUN_BIN ($BUN_VER) — required to build options 1-4"
	else
		log "bun:             MISSING — options 1-4 unavailable; only npm stable remains"
	fi
	if [ -n "$NPM_BIN" ]; then
		log "npm:             $NPM_BIN ($NPM_VER) — global prefix $NPM_PREFIX, bin dir $NPM_GLOBAL_BIN"
	else
		log "npm:             MISSING — option 5 unavailable"
	fi
	if [ -n "$BREW_BIN" ]; then
		log "brew:            $BREW_BIN — bin dir $BREW_BIN_DIR"
	else
		log "brew:            not installed"
	fi
	log "sha256 tool:     ${SHA256_TOOL:-NONE (conflict archiving disabled)}"

	case "$CURRENT_KIND" in
	none) log "current install: none (command -v jgrep: not found)" ;;
	symlink-into-repo | npm | copy | brew) log "current install: $CURRENT_KIND ($CURRENT_DETAIL)" ;;
	*) log "current install: $CURRENT_KIND — $CURRENT_DETAIL" ;;
	esac
	if [ -n "$CURRENT_PATH" ]; then
		if [ -n "$CURRENT_VERSION_OUT" ]; then
			log "                 jgrep --version: $CURRENT_VERSION_OUT"
		else
			log "                 jgrep --version: (no output — node missing or broken bin?)"
		fi
	fi
	log "shadowing:       $(shadow_summary)"

	if [ "$INSTALL_COUNT" -gt 1 ]; then
		log "installs scan:   $INSTALL_COUNT jgrep entries found:"
		print_install_list
	fi

	log "repo:            $REPO_BRANCH @ ${REPO_HEAD:-unknown} — $REPO_DIRTY"
	log "refs (local):    origin/main @ ${ORIGIN_SHA:-<no local ref>} | upstream/main @ ${UPSTREAM_SHA:-<no local ref>}"
	if [ -n "$NPM_BIN" ]; then
		if [ -n "$UPSTREAM_NPM_VER" ]; then
			log "upstream npm:    $NPM_PACKAGE $UPSTREAM_NPM_VER (registry latest)"
		else
			log "upstream npm:    unknown (offline)"
		fi
	else
		log "upstream npm:    unknown (npm missing)"
	fi
	log "npm global bin:  ${NPM_GLOBAL_BIN:-<npm missing>}"
	log "target:          $DEST_DIR ($(dir_state "$DEST_DIR"))"

	log "menu:"
	print_menu_with_markers

	if [ "$verbose" -eq 1 ]; then
		log "--- full detail (check) ---"
		log "repo path:       $REPO"
		log "remotes:         origin -> $(remote_display_url origin) $(remote_identity_suffix origin)"
		log "                 upstream -> $(remote_display_url upstream) $(remote_identity_suffix upstream)"
		if [ -n "$NPM_BIN" ]; then
			log "npm package:     $NPM_PACKAGE (expected repository: ${EXPECTED_NPM_REPO#github.com/}) $(npm_registry_verdict_text)"
		fi
		log "HEAD:            $REPO_HEAD ($REPO_BRANCH), $(ahead_behind_origin)"
		if [ -n "$NODE_BIN" ]; then
			log "node resolved:   $(resolve_symlink "$NODE_BIN")"
		fi
		if [ -n "$BUN_BIN" ]; then
			log "bun resolved:    $(resolve_symlink "$BUN_BIN")"
		fi
		if [ -n "$NPM_BIN" ]; then
			log "npm resolved:    $(resolve_symlink "$NPM_BIN")"
		fi
		if [ -f "$REPO/dist/jgrep.js" ]; then
			local dh dsz dx
			dh="$(sha256_of "$REPO/dist/jgrep.js" || true)"
			dsz="$(wc -c < "$REPO/dist/jgrep.js" | tr -d ' ')"
			dx="NOT executable"
			if [ -x "$REPO/dist/jgrep.js" ]; then
				dx="executable"
			fi
			log "dist/jgrep.js:   present — sha256:${dh:0:12}, $dsz bytes, $dx"
		else
			log "dist/jgrep.js:   absent (option 1/2 builds it; 'bun run build' does too)"
		fi
		log "target chain walk:"
		chosen="$(resolve_default_target 0 || true)"
		if [ -n "$NPM_GLOBAL_BIN" ]; then
			log "  1. $NPM_GLOBAL_BIN — $(dir_state "$NPM_GLOBAL_BIN")"
		else
			log "  1. <npm global bin> — skipped (npm missing)"
		fi
		log "  2. /usr/local/bin — $(dir_state "/usr/local/bin")"
		log "  3. $HOME/.local/bin — $(dir_state "$HOME/.local/bin")"
		log "  chosen default: ${chosen:-<none>}"
		if [ -n "$OPT_TARGET" ]; then
			log "  --target override: $OPT_TARGET ($(dir_state "$OPT_TARGET"))"
		fi
		log "installs scan (all candidates — PATH + classic dirs + --target):"
		print_install_list
		local sl
		sl="$(shadow_paths)"
		if [ -n "$sl" ]; then
			log "shadowing (type -a jgrep), each entry on its own line:"
			while IFS= read -r p; do
				[ -n "$p" ] || continue
				log "  $p"
			done <<< "$sl"
		else
			log "shadowing: no jgrep entries found on PATH"
		fi
	fi
	return 0
}

# ---------------------------------------------------------------------------
# builds
# ---------------------------------------------------------------------------
ensure_bun_for_build() {
	if [ -z "$BUN_BIN" ]; then
		warn "$PROG: 'bun' is required to build (options 1-4) but was not found."
		warn "Install it: https://bun.sh — or use option 5 (npm stable)."
		exit 1
	fi
}

build_local_real() {
	ensure_bun_for_build
	if [ ! -d "$REPO/node_modules" ]; then
		log "==> Installing dependencies (bun install)"
		if ! bun install; then
			warn "$PROG: bun install failed — nothing was installed."
			exit 1
		fi
	fi
	log "==> Building current branch (${REPO_HEAD:-unknown}) (bun run build)"
	if ! bun run build; then
		warn "$PROG: build failed — nothing was installed."
		exit 1
	fi
	if [ ! -f "$REPO/dist/jgrep.js" ]; then
		warn "$PROG: build produced no dist/jgrep.js — nothing was installed."
		exit 1
	fi
	return 0
}

build_local_dry() {
	# emulate the build with the output redirected OUTSIDE the repo
	local out="$1"
	if [ ! -d "$REPO/node_modules" ]; then
		log "DRY-RUN: bun install   (node_modules missing — a real run would install deps first)"
	fi
	log "DRY-RUN: bun run build → redirected to: bun build src/cli.ts --target=node --outfile $out && chmod +x $out  (repo stays untouched)"
	if [ ! -d "$REPO/node_modules" ]; then
		return 0
	fi
	if bun build src/cli.ts --target=node --outfile "$out" >/dev/null 2>&1 && chmod +x "$out" 2>/dev/null; then
		local h
		h="$(sha256_of "$out" || true)"
		log "DRY-RUN: build OK -> $out (sha256:${h:0:12}; dist/ not written)"
	else
		warn "DRY-RUN: build FAILED (dry-run continues; nothing mutated)"
	fi
	return 0
}

build_from_remote_real() {
	# $1 = remote name; on success sets BUILD_SHA + BUILD_OUTPUT (dist/jgrep.js inside the worktree)
	local remote="$1" local_sha sha
	ensure_bun_for_build
	local_sha="$(ref_sha "$remote/main")"

	log "==> Fetching $remote main"
	if ! git -C "$REPO" fetch "$remote" main; then
		if [ -n "$local_sha" ]; then
			log "==> NOTE: fetch failed (offline?) — continuing with the local ref $remote/main @ $local_sha"
		else
			warn "$PROG: fetch of $remote/main failed and no local ref exists."
			exit 1
		fi
	fi

	sha="$(ref_sha "$remote/main")"
	if [ -z "$sha" ]; then
		warn "$PROG: cannot resolve $remote/main."
		exit 1
	fi
	BUILD_SHA="$sha"
	log "==> Building $remote/main @ $sha (git worktree in a tmpdir)"

	ensure_tmp_root || {
		warn "$PROG: cannot create a temp dir for the worktree."
		exit 1
	}
	WORKTREE_DIR="$TMP_ROOT/worktree"
	WORKTREE_REPO="$REPO"
	if ! git -C "$REPO" worktree add --detach "$WORKTREE_DIR" "$remote/main" >/dev/null; then
		warn "$PROG: git worktree add failed for $remote/main."
		exit 1
	fi
	if ! (cd "$WORKTREE_DIR" && bun install && bun run build); then
		warn "$PROG: build of $remote/main failed (bun install / bun run build inside the worktree)."
		exit 1
	fi
	if [ ! -f "$WORKTREE_DIR/dist/jgrep.js" ]; then
		warn "$PROG: the $remote/main build produced no dist/jgrep.js."
		exit 1
	fi
	BUILD_OUTPUT="$WORKTREE_DIR/dist/jgrep.js"
	return 0
}

build_from_remote_dry() {
	# dry-run: NO fetch (fetch mutates .git), NO worktree — print the plan only
	local remote="$1" sha
	sha="$(ref_sha "$remote/main")"
	log "DRY-RUN: git fetch $remote main   (skipped — dry-run does not mutate .git)"
	if [ -n "$sha" ]; then
		log "DRY-RUN: would build $remote/main @ $sha (local ref; a real run fetches it first)"
	else
		log "DRY-RUN: no local ref $remote/main — a real run would fetch it first"
	fi
	log "DRY-RUN: git worktree add --detach <tmpdir>/worktree $remote/main"
	log "DRY-RUN: (cd <tmpdir>/worktree && bun install && bun run build)"
	log "DRY-RUN: cp <tmpdir>/worktree/dist/jgrep.js $DEST_DIR/jgrep && chmod 0755 $DEST_DIR/jgrep"
	log "DRY-RUN: git worktree remove --force <tmpdir>/worktree   (trap-based cleanup)"
	return 0
}

# ---------------------------------------------------------------------------
# conflict auto-solving + install
# ---------------------------------------------------------------------------
archive_existing() {
	# $1 = existing real file; archives it with a UTC timestamp and prints the revert hint
	local bak
	bak="$1.bak-$(date -u +%Y%m%dT%H%M%SZ)"
	if ! mv "$1" "$bak"; then
		warn "$PROG: failed to archive $1."
		exit 1
	fi
	log "==> archived previous install: $bak"
	log "==> to revert: mv $bak $1"
	return 0
}

solve_npm_owned_conflict() {
	# called when the destination is the npm global bin dir and npm owns jevgrep
	# identity gate: `npm uninstall -g` only runs on a verified upstream/fork
	# package. A refused displacement is FATAL in every mode — the gate exits 1
	# with the refusal message, so headless (--choice/--yes) runs never succeed
	# silently; interactive runs refuse equally loudly (no override exists for
	# a hijacked identity).
	if [ "$OPT_DRY_RUN" -eq 0 ]; then
		verify_npm_package_identity_local
	fi
	if [ "$OPT_YES" -eq 1 ]; then
		if [ "$OPT_DRY_RUN" -eq 1 ]; then
			log "DRY-RUN: npm uninstall -g $NPM_PACKAGE   (auto-confirmed: non-interactive)"
			return 0
		fi
		log "==> non-interactive: npm owns jgrep — uninstalling $NPM_PACKAGE first"
		if ! npm uninstall -g "$NPM_PACKAGE"; then
			warn "$PROG: npm uninstall -g $NPM_PACKAGE failed."
			exit 1
		fi
		return 0
	fi
	echo
	warn "WARNING: npm owns jgrep here (package $NPM_PACKAGE is installed globally)."
	warn "Installing a dev build over it replaces the npm-managed file."
	local reply=""
	printf '%s' "npm owns jgrep — uninstall the package first? [y/N] "
	read -r reply || reply=""
	case "$reply" in
	y | Y | yes | YES)
		if ! npm uninstall -g "$NPM_PACKAGE"; then
			warn "$PROG: npm uninstall -g $NPM_PACKAGE failed."
			exit 1
		fi
		;;
	*)
		warn "$PROG: declined — npm keeps owning jgrep; aborting this option."
		exit 3
		;;
	esac
	return 0
}

dry_preview_install() {
	# $1 = mode (link|copy) · $2 = compare src · $3 = target path · $4 = displayed src
	local mode="$1" compare_src="$2" tgt="$3" display_src="$4"
	if [ -L "$tgt" ]; then
		if [ "$mode" = "link" ] && [ -n "$display_src" ] && [ "$(resolve_symlink "$tgt")" = "$display_src" ]; then
			log "DRY-RUN: nothing to do — $tgt already points to $display_src"
			return 0
		fi
		log "DRY-RUN: would replace symlink $tgt (points to: $(readlink "$tgt")) — no .bak for symlinks"
	elif [ -e "$tgt" ]; then
		if [ "$mode" = "copy" ] && [ -f "$compare_src" ]; then
			local old_h new_h
			old_h="$(sha256_of "$tgt" || true)"
			new_h="$(sha256_of "$compare_src" || true)"
			if [ -n "$old_h" ] && [ "$old_h" = "$new_h" ]; then
				log "DRY-RUN: nothing to do — $tgt already up to date"
				return 0
			fi
		fi
		log "DRY-RUN: would archive $tgt as $tgt.bak-<UTC timestamp> + print the revert hint"
	else
		log "DRY-RUN: no existing $tgt — clean install"
	fi
	case "$mode" in
	link) log "DRY-RUN: ln -sfn $display_src $tgt" ;;
	copy) log "DRY-RUN: cp $display_src $tgt && chmod 0755 $tgt" ;;
	esac
	return 0
}

install_artifact() {
	# $1 = mode (link|copy) · $2 = src to install · $3 = src used for the identical-content
	#      check (dry-run: a tmp build) · $4 = destination dir · $5 = src path shown in commands
	local mode="$1" src="$2" compare_src="$3" destdir="$4" display_src="$5"
	local tgt="$destdir/jgrep"

	# npm-owned conflict (mirrors the reference behavior)
	if [ -n "$NPM_GLOBAL_BIN" ] && [ "$destdir" = "$NPM_GLOBAL_BIN" ] && npm_owns_live; then
		solve_npm_owned_conflict
	fi

	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		dry_preview_install "$mode" "$compare_src" "$tgt" "$display_src"
		return 0
	fi

	if [ ! -d "$destdir" ]; then
		mkdir -p "$destdir" || {
			warn "$PROG: cannot create target dir $destdir."
			exit 1
		}
	fi

	if [ -L "$tgt" ]; then
		local points_to
		points_to="$(readlink "$tgt")"
		if [ "$mode" = "link" ]; then
			local resolved
			resolved="$(resolve_symlink "$tgt")"
			if [ "$resolved" = "$display_src" ]; then
				log "==> already up to date ($tgt -> $points_to)"
				return 0
			fi
		fi
		log "==> replacing symlink $tgt (pointed to: $points_to) — no .bak for symlinks"
	elif [ -e "$tgt" ]; then
		# real file at the target
		if [ "$mode" = "copy" ] && [ -f "$compare_src" ]; then
			local old_h new_h
			old_h="$(sha256_of "$tgt" || true)"
			new_h="$(sha256_of "$compare_src" || true)"
			if [ -n "$old_h" ] && [ "$old_h" = "$new_h" ]; then
				log "==> already up to date ($tgt)"
				return 0
			fi
		fi
		archive_existing "$tgt"
	fi

	case "$mode" in
	link)
		log "==> ln -sfn $display_src $tgt"
		if ! ln -sfn "$display_src" "$tgt"; then
			warn "$PROG: failed to create the symlink $tgt."
			exit 1
		fi
		;;
	copy)
		log "==> cp $display_src $tgt && chmod 0755"
		if ! cp "$src" "$tgt"; then
			warn "$PROG: failed to copy to $tgt."
			exit 1
		fi
		if ! chmod 0755 "$tgt"; then
			warn "$PROG: chmod failed on $tgt."
			exit 1
		fi
		;;
	esac
	return 0
}

verify_install() {
	# $1 = destination dir; runs <target>/jgrep --version (or --help) and re-checks shadowing
	local destdir="$1" tgt out=""
	tgt="$destdir/jgrep"
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		return 0
	fi
	if [ ! -e "$tgt" ]; then
		warn "$PROG: post-install check failed: $tgt does not exist."
		exit 1
	fi
	out="$("$tgt" --version 2>/dev/null | head -n 1 || true)"
	if [ -z "$out" ]; then
		out="$("$tgt" --help 2>/dev/null | head -n 1 || true)"
		if [ -n "$out" ]; then
			out="--help: $out"
		fi
	fi
	if [ -n "$out" ]; then
		log "==> verified: $tgt ($out)"
	else
		warn "install-dev.sh: warning: $tgt did not answer --version/--help (node missing or broken bin?)"
	fi

	hash -r 2>/dev/null || true
	local now
	now="$(command -v jgrep 2>/dev/null || true)"
	if [ -z "$now" ]; then
		warn "install-dev.sh: warning: 'jgrep' is not resolvable on PATH yet."
		warn "  add the target dir to PATH:  export PATH=\"$destdir:\$PATH\""
	elif [ "$now" != "$tgt" ]; then
		warn "install-dev.sh: warning: 'jgrep' resolves to $now, not the just-installed $tgt (PATH order)."
		warn "  shadowing order (type -a jgrep):"
		type -a jgrep 2>/dev/null 1>&2 || true
		warn "  to prefer the dev build: export PATH=\"$destdir:\$PATH\" (or remove the shadowing entry)"
	fi
	# install itself succeeded → exit stays 0
	return 0
}

# ---------------------------------------------------------------------------
# agent-skill refresh (options 1/2/3) — best-effort, never fails the install
# ---------------------------------------------------------------------------
refresh_agent_skill() {
	# After a local install the agent skill (skills/jgrep/SKILL.md) goes stale
	# whenever the CLI help changed: the skill embeds a verbatim copy of the
	# `jgrep --help` screen, so AI harnesses would keep quoting wrong flags.
	# Step A runs the vercel `skills` universal installer (every detected
	# harness); Step B falls back to the standard dir ~/.agents/skills/jgrep.
	# Only standard dirs are ever written — never a harness-private path.
	if [ ! -f "skills/jgrep/SKILL.md" ]; then
		log "==> agent skill: not present in this source (skipped)"
		return 0
	fi
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		log "DRY-RUN: would refresh the agent skill via 'npx -y skills add ./skills -g -y' (vercel skills installer -> every detected harness)"
		log "DRY-RUN: fallback if the installer fails or is offline: copy skills/jgrep/SKILL.md to $HOME/.agents/skills/jgrep/SKILL.md (only when missing or different)"
		return 0
	fi
	if have npx; then
		# Step A — universal installer (cwd is the repo; installs the skill
		# into every detected harness's standard skill dir)
		if npx -y skills add ./skills -g -y; then
			log "==> agent skill refreshed via the vercel skills installer (all detected harnesses)"
			log "hint: harnesses managing skills outside the standard dirs need a manual re-sync (late cli reads ~/.agents/skills soon)"
			return 0
		fi
		warn "$PROG: warning: 'npx -y skills add ./skills -g -y' failed — falling back to the ~/.agents/skills copy."
	else
		warn "$PROG: warning: npx not found — falling back to the ~/.agents/skills copy."
	fi
	# Step B — fallback: keep the standard-dir copy identical to the repo's
	local dest="$HOME/.agents/skills/jgrep/SKILL.md"
	if [ -f "$dest" ] && cmp -s "skills/jgrep/SKILL.md" "$dest"; then
		log "==> agent skill already up to date (~/.agents/skills/jgrep)"
		log "hint: harnesses managing skills outside the standard dirs need a manual re-sync (late cli reads ~/.agents/skills soon)"
		return 0
	fi
	if mkdir -p "$HOME/.agents/skills/jgrep" && cp "skills/jgrep/SKILL.md" "$dest"; then
		log "==> agent skill copied to ~/.agents/skills/jgrep (fallback)"
		log "hint: harnesses managing skills outside the standard dirs need a manual re-sync (late cli reads ~/.agents/skills soon)"
		return 0
	fi
	warn "$PROG: warning: could not update $dest — refresh it manually: npx skills add ./skills -g"
	return 1
}

refresh_agent_skill_best_effort() {
	# caller-facing wrapper: the refresh is best-effort and must never fail the
	# install — a failure only warns; the option's exit code stays the
	# install's. Identical behavior interactive vs --choice; the result is
	# always reported.
	if refresh_agent_skill; then
		return 0
	fi
	warn "$PROG: warning: the agent-skill refresh failed — the install itself succeeded (best-effort refresh, never fails the install)."
	return 0
}

# ---------------------------------------------------------------------------
# [8] fork install (remote/curl) — script-managed clone + full local setup
# ---------------------------------------------------------------------------
remote_one_liners() {
	# the two documented install one-liners (used by every refusal message)
	warn "  remote: curl -fsSL https://raw.githubusercontent.com/Emasoft/jgrep/main/install-dev.sh | bash -s -- --choice 8"
	warn "  local : ./install-dev.sh --choice 1   (run inside a clone of Emasoft/jgrep)"
	return 0
}

refuse_menu_unavailable() {
	# the interactive menu case (no --choice/check/help/uninstall) cannot run:
	# $1 = reason (piped/no repo, or non-TTY stdin). Exit 2.
	warn "$PROG: refusing: the interactive menu cannot run — $1."
	warn "Use one of the documented one-liners:"
	remote_one_liners
	exit 2
}

refuse_detached_needs_repo() {
	# piped/copied script + an option that needs a real checkout. Exit 2.
	warn "$PROG: refusing: $1 needs a real jgrep checkout, but no repo was found next to the script"
	warn "  (piped 'curl | bash' or a copied install-dev.sh — \$0 is not inside a checkout)."
	warn "Use one of the documented one-liners:"
	remote_one_liners
	exit 2
}

remote_clone_identity_or_die() {
	# $1 = clone dir; its origin must point at the fork ($FORK_SLUG) — the same
	# identity-pinning rule as the option-3 origin remote. A directory that is
	# NOT the fork is never fetched, reset, or built.
	local d="$1" url
	url="$(git -C "$d" remote get-url origin 2>/dev/null || true)"
	if [ -z "$url" ]; then
		warn "$PROG: refusing: $d has no 'origin' git remote (not a usable clone)."
		warn "  hint: point JGREP_DEV_DIR at another directory, or remove $d and re-run."
		exit 1
	fi
	case "$url" in
	*"$FORK_SLUG"*) return 0 ;;
	*)
		warn "$PROG: refusing: $d is not a clone of the fork Emasoft/jgrep."
		warn "  observed origin: $url"
		warn "  expected: a URL containing $FORK_SLUG"
		warn "  hint: point JGREP_DEV_DIR at another directory, or remove $d and re-run."
		exit 1
		;;
	esac
}

dir_is_empty() {
	# 0 = $1 has no entries · 1 = has entries (glob-based, no ls dependency)
	local f
	for f in "$1"/* "$1"/.[!.]* "$1"/..?*; do
		if [ -e "$f" ] || [ -L "$f" ]; then
			return 1
		fi
	done
	return 0
}

refuse_non_clone_dir() {
	# $1 = existing dir with no .git that is not empty — never overwritten
	warn "$PROG: refusing: $1 exists and is not a clone of the fork (no .git, not empty)."
	warn "  hint: point JGREP_DEV_DIR at another directory, or remove $1 and re-run."
	exit 1
}

clone_fork_or_die() {
	# $1 = destination; shallow-clones the fork and verifies its origin URL
	if ! git clone --depth 1 "$FORK_URL" "$1"; then
		warn "$PROG: git clone of $FORK_URL failed (offline? destination unwritable?)."
		exit 1
	fi
	remote_clone_identity_or_die "$1"
	return 0
}

ensure_bun_for_remote_install() {
	# option 8 ONLY: a fresh box may lack bun — confirm (interactive) or
	# auto-install (--choice/--yes) it via the official installer, then extend
	# PATH for this run. Options 1-4 keep today's hard unavailability markers;
	# this never runs for them.
	[ -n "$BUN_BIN" ] && return 0
	if ! have curl; then
		warn "$PROG: 'bun' is required to build and 'curl' is missing — install bun manually: https://bun.sh"
		exit 1
	fi
	local reply=""
	if [ "$OPT_YES" -eq 1 ]; then
		log "==> non-interactive: bun is missing — installing it via https://bun.sh/install"
	else
		echo
		printf '%s' "bun is required to build — install it now via https://bun.sh/install? [y/N] "
		read -r reply || reply=""
		case "$reply" in
		y | Y | yes | YES) ;;
		*)
			warn "$PROG: declined — bun is required to build; aborting option 8."
			exit 3
			;;
		esac
	fi
	log "==> curl -fsSL https://bun.sh/install | bash"
	if ! curl -fsSL https://bun.sh/install | bash; then
		warn "$PROG: the bun installer failed — install bun manually: https://bun.sh"
		exit 1
	fi
	export PATH="$HOME/.bun/bin:$PATH"
	if have bun; then
		BUN_BIN="$(command -v bun)"
		BUN_VER="$(bun --version 2>/dev/null || true)"
		log "==> bun ${BUN_VER:-unknown} installed ($BUN_BIN)"
		warn "note: this run extended PATH manually — new shells get bun from ~/.bun/bin (the installer updates your shell rc)."
	else
		warn "$PROG: bun is still missing after the installer ran — install it manually: https://bun.sh"
		exit 1
	fi
	return 0
}

opt_remote_install() {
	log "==> [8] fork install (remote/curl): clone or update the fork, then full setup (deps, build, bin, agent skill)"
	if ! have git; then
		warn "$PROG: 'git' is required for option 8 but was not found."
		exit 1
	fi

	# 1. the script-managed clone location (JGREP_DEV_DIR overrides it)
	REMOTE_CLONE_DIR="${JGREP_DEV_DIR:-$HOME/.local/share/jgrep}"
	log "==> script-managed clone: $REMOTE_CLONE_DIR (override with JGREP_DEV_DIR; re-runs reset it to origin/main)"

	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		# plan only — no clone, no fetch, no build, no target mutation
		if [ -e "$REMOTE_CLONE_DIR/.git" ]; then
			# same identity gate as the real run (refuses in dry-run too,
			# exactly like the options-3/4 remote identity check)
			remote_clone_identity_or_die "$REMOTE_CLONE_DIR"
			log "DRY-RUN: updating script-managed clone at $REMOTE_CLONE_DIR"
			log "DRY-RUN: git -C $REMOTE_CLONE_DIR fetch origin main   (skipped — dry-run does not mutate .git)"
			log "DRY-RUN: git -C $REMOTE_CLONE_DIR reset --hard origin/main"
		elif [ -e "$REMOTE_CLONE_DIR" ]; then
			if ! dir_is_empty "$REMOTE_CLONE_DIR"; then
				refuse_non_clone_dir "$REMOTE_CLONE_DIR"
			fi
			log "DRY-RUN: git clone --depth 1 $FORK_URL $REMOTE_CLONE_DIR   (into the existing empty directory)"
		else
			log "DRY-RUN: mkdir -p $(dirname "$REMOTE_CLONE_DIR")"
			log "DRY-RUN: git clone --depth 1 $FORK_URL $REMOTE_CLONE_DIR"
		fi
		log "DRY-RUN: cd $REMOTE_CLONE_DIR"
		if [ -z "$BUN_BIN" ]; then
			log "DRY-RUN: bun missing — a real run would install it via https://bun.sh/install (auto-confirmed with --choice/--yes)"
		fi
		log "DRY-RUN: bun install   (deps of the script-managed clone)"
		log "DRY-RUN: bun run build → $REMOTE_CLONE_DIR/dist/jgrep.js && chmod +x"
		# reuse install_artifact (option-1 path) so the npm-owned conflict and
		# the symlink/archive preview render exactly like a real run would
		install_artifact link "" "" "$DEST_DIR" "$REMOTE_CLONE_DIR/dist/jgrep.js"
		log "DRY-RUN: would refresh the agent skill from $REMOTE_CLONE_DIR/skills/jgrep via 'npx -y skills add ./skills -g -y' (vercel skills installer -> every detected harness)"
		log "DRY-RUN: fallback if the installer fails or is offline: copy $REMOTE_CLONE_DIR/skills/jgrep/SKILL.md to $HOME/.agents/skills/jgrep/SKILL.md (only when missing or different)"
		if [ -z "$NODE_BIN" ]; then
			warn "DRY-RUN: node missing — a real run would warn that the installed bin needs node >= 18 at runtime"
		fi
		log "==> dry-run complete (option 8) — nothing was mutated"
		return 0
	fi

	# 2. clone or update the script-managed clone
	if [ -e "$REMOTE_CLONE_DIR/.git" ]; then
		remote_clone_identity_or_die "$REMOTE_CLONE_DIR"
		log "==> updating script-managed clone at $REMOTE_CLONE_DIR"
		if ! git -C "$REMOTE_CLONE_DIR" fetch origin main; then
			warn "$PROG: 'git fetch origin main' failed in $REMOTE_CLONE_DIR (offline?)."
			exit 1
		fi
		if ! git -C "$REMOTE_CLONE_DIR" reset --hard origin/main; then
			warn "$PROG: 'git reset --hard origin/main' failed in $REMOTE_CLONE_DIR."
			exit 1
		fi
	elif [ -e "$REMOTE_CLONE_DIR" ]; then
		if ! dir_is_empty "$REMOTE_CLONE_DIR"; then
			refuse_non_clone_dir "$REMOTE_CLONE_DIR"
		fi
		log "==> cloning the fork into the empty directory $REMOTE_CLONE_DIR"
		clone_fork_or_die "$REMOTE_CLONE_DIR"
	else
		mkdir -p "$(dirname "$REMOTE_CLONE_DIR")" || {
			warn "$PROG: cannot create the parent directory of $REMOTE_CLONE_DIR."
			exit 1
		}
		log "==> cloning the fork into $REMOTE_CLONE_DIR"
		clone_fork_or_die "$REMOTE_CLONE_DIR"
	fi

	# 3. full local setup inside the clone — the same machinery as option 1
	#    (identity check, deps, build, symlink install, verification, skill)
	log "==> cd $REMOTE_CLONE_DIR"
	cd "$REMOTE_CLONE_DIR" || {
		warn "$PROG: cannot cd into $REMOTE_CLONE_DIR."
		exit 1
	}
	REPO="$REMOTE_CLONE_DIR"
	REPO_BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
	REPO_HEAD="$(ref_sha HEAD)"
	verify_local_checkout_identity
	ensure_bun_for_remote_install
	build_local_real
	install_artifact link "$REPO/dist/jgrep.js" "$REPO/dist/jgrep.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
	verify_install "$DEST_DIR"
	refresh_agent_skill_best_effort

	# 4. node is still needed to RUN the bin (bun only builds) — warn, never fail
	if [ -z "$NODE_BIN" ]; then
		warn "$PROG: warning: node is not installed — the installed bin needs node >= 18 at runtime."
		warn "  hint: install node (https://nodejs.org or via your package manager), then run: jgrep --version"
	fi

	log "==> done — to update later: re-run the curl one-liner (or: git -C $REMOTE_CLONE_DIR pull && ./install-dev.sh --choice 8)"
	return 0
}

# ---------------------------------------------------------------------------
# options
# ---------------------------------------------------------------------------
opt_local_symlink() {
	log "==> [1] local dev (symlink): build current branch, symlink <target>/jgrep -> <repo>/dist/jgrep.js"
	verify_local_checkout_identity
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		if ensure_tmp_root; then
			build_local_dry "$TMP_ROOT/dry-build.js"
			install_artifact link "$REPO/dist/jgrep.js" "$TMP_ROOT/dry-build.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
		else
			warn "DRY-RUN: no temp dir available — skipping the build emulation"
			install_artifact link "$REPO/dist/jgrep.js" "" "$DEST_DIR" "$REPO/dist/jgrep.js"
		fi
		refresh_agent_skill_best_effort
		log "==> dry-run complete (option 1) — nothing was mutated"
		return 0
	fi
	build_local_real
	install_artifact link "$REPO/dist/jgrep.js" "$REPO/dist/jgrep.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
	verify_install "$DEST_DIR"
	refresh_agent_skill_best_effort
	return 0
}

opt_local_copy() {
	log "==> [2] local pinned (copy): build current branch, copy snapshot"
	verify_local_checkout_identity
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		if ensure_tmp_root; then
			build_local_dry "$TMP_ROOT/dry-build.js"
			install_artifact copy "$TMP_ROOT/dry-build.js" "$TMP_ROOT/dry-build.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
		else
			warn "DRY-RUN: no temp dir available — skipping the build emulation"
			install_artifact copy "" "" "$DEST_DIR" "$REPO/dist/jgrep.js"
		fi
		refresh_agent_skill_best_effort
		log "==> dry-run complete (option 2) — nothing was mutated"
		return 0
	fi
	build_local_real
	install_artifact copy "$REPO/dist/jgrep.js" "$REPO/dist/jgrep.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
	verify_install "$DEST_DIR"
	refresh_agent_skill_best_effort
	return 0
}

opt_remote_copy() {
	# $1 = remote name (origin | upstream)
	local remote="$1"
	# remote identity gate (real run AND dry-run): origin must be this fork,
	# upstream must be the upstream project
	verify_remote_identity_or_die "$remote"
	if [ "$remote" = "origin" ]; then
		log "==> [3] fork main (copy): build origin/main, copy (fetch + git worktree in a tmpdir)"
	else
		log "==> [4] upstream main (copy): build upstream/main, copy (fetch + git worktree in a tmpdir)"
	fi
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		local optno="4"
		if [ "$remote" = "origin" ]; then
			optno="3"
		fi
		build_from_remote_dry "$remote"
		# [3] refreshes the agent skill too; [4] (upstream main) never does —
		# the upstream tree has no skills/jgrep to refresh from
		if [ "$remote" = "origin" ]; then
			refresh_agent_skill_best_effort
		fi
		log "==> dry-run complete (option $optno) — nothing was mutated"
		return 0
	fi
	BUILD_SHA=""
	BUILD_OUTPUT=""
	build_from_remote_real "$remote"
	log "==> built SHA: $BUILD_SHA"
	install_artifact copy "$BUILD_OUTPUT" "$BUILD_OUTPUT" "$DEST_DIR" "$BUILD_OUTPUT"
	verify_install "$DEST_DIR"
	# [3] refreshes the agent skill too; [4] (upstream main) never does —
	# the upstream tree has no skills/jgrep to refresh from
	if [ "$remote" = "origin" ]; then
		refresh_agent_skill_best_effort
	fi
	return 0
}

opt_npm_stable() {
	log "==> [5] npm stable: npm install -g $NPM_PACKAGE (upstream's published release)"
	if [ -z "$NPM_BIN" ]; then
		warn "$PROG: 'npm' is required for option 5 but was not found."
		exit 1
	fi
	# registry identity pinning (real run AND dry-run — the probe is read-only):
	# refuse unless the registry's jevgrep IS the upstream project
	NPM_IDENTITY_RC=0
	npm_registry_identity_probe || NPM_IDENTITY_RC=$?
	case "$NPM_IDENTITY_RC" in
	0) log "==> npm identity verified: $NPM_PACKAGE -> $NPM_REG_URL (expected *$EXPECTED_NPM_REPO*)" ;;
	1) npm_registry_refuse mismatch ;;
	*) npm_registry_refuse unreachable ;;
	esac
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		if npm_owns_live; then
			log "DRY-RUN: npm owns jgrep already — a real run would uninstall $NPM_PACKAGE first (auto-confirmed with --yes)"
		fi
		if [ -n "$NPM_GLOBAL_BIN" ] && [ -e "$NPM_GLOBAL_BIN/jgrep" ]; then
			log "DRY-RUN: npm will overwrite $NPM_GLOBAL_BIN/jgrep"
		fi
		log "DRY-RUN: would install $NPM_PACKAGE ${NPM_REG_VER:-version unknown} from ${NPM_REG_TARBALL:-<tarball unknown>}"
		log "DRY-RUN: npm install -g $NPM_PACKAGE --yes"
		log "==> dry-run complete (option 5) — nothing was mutated"
		return 0
	fi
	if [ -n "$NPM_GLOBAL_BIN" ] && [ -e "$NPM_GLOBAL_BIN/jgrep" ]; then
		if npm_owns_live; then
			solve_npm_owned_conflict
		elif [ -L "$NPM_GLOBAL_BIN/jgrep" ]; then
			log "==> npm will replace the symlink $NPM_GLOBAL_BIN/jgrep (pointed to: $(readlink "$NPM_GLOBAL_BIN/jgrep"))"
		else
			archive_existing "$NPM_GLOBAL_BIN/jgrep"
		fi
	fi
	if ! npm install -g "$NPM_PACKAGE" --yes; then
		warn "$PROG: npm install -g $NPM_PACKAGE failed."
		exit 1
	fi
	if [ -n "$NPM_GLOBAL_BIN" ]; then
		verify_install "$NPM_GLOBAL_BIN"
	fi
	log "==> installed $NPM_PACKAGE ${NPM_REG_VER:-version unknown} from ${NPM_REG_TARBALL:-<tarball unknown>}"
	log "==> repository verified: $NPM_REG_URL (expected *$EXPECTED_NPM_REPO*)"
	return 0
}

opt_check_only() {
	log "==> [6] check only: autodetect report, no mutation"
	print_report 1
	if [ "$NPM_IDENTITY_RC" = "1" ]; then
		warn "$PROG: warning: npm '$NPM_PACKAGE' does not point at $EXPECTED_NPM_REPO anymore (observed: $NPM_REG_URL) — do NOT run option 5."
	fi
	log ""
	log "==> check complete — no mutation performed"
	return 0
}

# ---------------------------------------------------------------------------
# [7] uninstall — npm/symlink/copy/brew-aware, identity-verified, idempotent
# ---------------------------------------------------------------------------
refuse_removal() {
	# never removes anything; counts as a failure outside dry-run
	warn "$PROG: refusing to remove $1: not a jgrep binary ($2)"
	if [ "$OPT_DRY_RUN" -eq 0 ]; then
		UNINSTALL_FAILED=$((UNINSTALL_FAILED + 1))
	fi
	return 0
}

remember_removed() {
	case "
$REMOVED_LIST
" in
	*"
$1
"*) return 0 ;;
	esac
	if [ -z "$REMOVED_LIST" ]; then
		REMOVED_LIST="$1"
	else
		REMOVED_LIST="$REMOVED_LIST
$1"
	fi
	return 0
}

uninstall_npm_entry() {
	# npm-managed entries cannot be archived — the package owns the file
	local f="$1"
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		log "DRY-RUN: npm uninstall -g $NPM_PACKAGE   (npm-owned entry: $f)"
		return 0
	fi
	log "==> npm owns $f (package $NPM_PACKAGE) — npm uninstall -g $NPM_PACKAGE"
	log "    npm-managed entries cannot be archived — reinstall with npm i -g $NPM_PACKAGE"
	if npm uninstall -g "$NPM_PACKAGE"; then
		UNINSTALL_REMOVED=$((UNINSTALL_REMOVED + 1))
		remember_removed "$f"
	else
		warn "$PROG: npm uninstall -g $NPM_PACKAGE failed (EACCES?)."
		warn "  hint: check the npm prefix permissions (npm config get prefix -> ${NPM_PREFIX:-?}), e.g."
		warn "  sudo chown -R \"\$(id -u):\$(id -g)\" \"$NPM_PREFIX\"  ·  or reinstall with npm i -g $NPM_PACKAGE"
		UNINSTALL_FAILED=$((UNINSTALL_FAILED + 1))
	fi
	return 0
}

uninstall_brew_entry() {
	# Homebrew owns the file — only brew may remove it (interactive unless --yes)
	local f="$1" reply=""
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		log "DRY-RUN: brew uninstall jevgrep   (Homebrew owns $f)"
		return 0
	fi
	if [ "$OPT_YES" -eq 1 ]; then
		log "==> Homebrew owns $f — brew uninstall jevgrep"
		if brew uninstall jevgrep; then
			UNINSTALL_REMOVED=$((UNINSTALL_REMOVED + 1))
			remember_removed "$f"
		else
			warn "$PROG: brew uninstall jevgrep failed."
			UNINSTALL_FAILED=$((UNINSTALL_FAILED + 1))
		fi
		return 0
	fi
	echo
	warn "WARNING: Homebrew owns $f (formula jevgrep)."
	printf '%s' "Run 'brew uninstall jevgrep'? [y/N] "
	read -r reply || reply=""
	case "$reply" in
	y | Y | yes | YES)
		if brew uninstall jevgrep; then
			UNINSTALL_REMOVED=$((UNINSTALL_REMOVED + 1))
			remember_removed "$f"
		else
			warn "$PROG: brew uninstall jevgrep failed."
			UNINSTALL_FAILED=$((UNINSTALL_FAILED + 1))
		fi
		;;
	*)
		log "==> skipped: brew keeps owning $f (declined)"
		UNINSTALL_DECLINED=$((UNINSTALL_DECLINED + 1))
		;;
	esac
	return 0
}

uninstall_symlink_entry() {
	# remove the LINK only when it resolves to a jgrep build; the repo file
	# (…/dist/jgrep.js) is never touched
	local f="$1" real
	real="$(resolve_symlink "$f")"
	case "$real" in
	*/dist/jgrep.js) ;;
	*)
		refuse_removal "$f" "symlink does not resolve to a jgrep build ($real)"
		return 0
		;;
	esac
	if ! jgrep_identity_line "$real" >/dev/null 2>&1; then
		refuse_removal "$f" "its target $real does not run as jgrep"
		return 0
	fi
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		log "DRY-RUN: rm $f   (symlink -> $real; the repo file stays untouched)"
		return 0
	fi
	log "==> verified symlink: $f -> $real"
	if rm "$f"; then
		log "==> removed $f (the repo file $real remains untouched)"
		UNINSTALL_REMOVED=$((UNINSTALL_REMOVED + 1))
		remember_removed "$f"
	else
		warn "$PROG: failed to remove the symlink $f."
		UNINSTALL_FAILED=$((UNINSTALL_FAILED + 1))
	fi
	return 0
}

uninstall_copy_entry() {
	# plain file: FIRST prove it really is jgrep (--version), then archive it
	local f="$1" ident what
	if [ ! -f "$f" ] || [ -L "$f" ]; then
		refuse_removal "$f" "not a regular file"
		return 0
	fi
	if [ ! -x "$f" ]; then
		refuse_removal "$f" "not executable"
		return 0
	fi
	ident="$(jgrep_identity_line "$f" || true)"
	if [ -z "$ident" ]; then
		what="$(describe_identity "$f")"
		refuse_removal "$f" "$what"
		return 0
	fi
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		log "DRY-RUN: would archive $f as $f.bak-<UTC timestamp> (verified: $ident)"
		return 0
	fi
	log "==> verified jgrep: $f ($ident)"
	archive_existing "$f"
	UNINSTALL_REMOVED=$((UNINSTALL_REMOVED + 1))
	remember_removed "$f"
	return 0
}

uninstall_one() {
	local f="$1"
	classify_candidate "$f"
	log ""
	log "==> entry: $f — $C_SUMMARY"
	case "$C_KIND" in
	missing)
		log "==> skip: $f is already gone"
		;;
	npm)
		uninstall_npm_entry "$f"
		;;
	brew)
		uninstall_brew_entry "$f"
		;;
	symlink-into-repo | symlink)
		uninstall_symlink_entry "$f"
		;;
	copy)
		uninstall_copy_entry "$f"
		;;
	*)
		refuse_removal "$f" "unrecognized install type"
		;;
	esac
	return 0
}

offer_backup_cleanup() {
	# archived siblings in DEST_DIR: <target>/jgrep.bak-* only — exact file paths
	local f
	local baks=()
	for f in "$DEST_DIR"/jgrep.bak-*; do
		[ -e "$f" ] || continue
		baks+=("$f")
	done
	if [ "${#baks[@]}" -eq 0 ]; then
		return 0
	fi
	log ""
	log "archived backup(s) in $DEST_DIR:"
	for f in "${baks[@]}"; do
		log "  $f"
	done
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		log "DRY-RUN: would ask to delete ${#baks[@]} archived backup(s) (a real run deletes them with --yes)"
		return 0
	fi
	local reply=""
	if [ "$OPT_YES" -eq 1 ]; then
		reply="y"
	else
		printf '%s' "also delete ${#baks[@]} archived backup(s)? [y/N] "
		read -r reply || reply=""
	fi
	case "$reply" in
	y | Y | yes | YES)
		for f in "${baks[@]}"; do
			if rm -f "$f"; then
				log "==> deleted $f"
			else
				warn "$PROG: could not delete $f."
				UNINSTALL_FAILED=$((UNINSTALL_FAILED + 1))
			fi
		done
		;;
	*)
		log "==> kept the archived backup(s)"
		;;
	esac
	return 0
}

uninstall_post_state() {
	# fresh detection + the new `current:` line; flag shadowed leftovers
	hash -r 2>/dev/null || true
	scan_installs
	select_current_install
	log ""
	log "==> after uninstall:"
	print_current_line
	if [ "$UNINSTALL_REMOVED" -gt 0 ]; then
		local now still=""
		now="$(command -v jgrep 2>/dev/null || true)"
		if [ -n "$now" ]; then
			case "
$REMOVED_LIST
" in
			*"
$now
"*) still="$now" ;;
			esac
		fi
		if [ -n "$still" ]; then
			warn "warning: 'jgrep' still resolves to $still (stale shell hash or shadowing entry)."
			warn "  current resolution (type -a jgrep):"
			type -a jgrep 1>&2 2>/dev/null || true
		fi
	fi
	return 0
}

opt_uninstall() {
	log "==> [7] uninstall jgrep — npm/symlink/copy/brew-aware, identity-verified, idempotent"
	local total=0
	if [ "${#CANDIDATE_PATHS[@]}" -gt 0 ]; then
		total=${#CANDIDATE_PATHS[@]}
	fi
	if [ "$total" -eq 0 ]; then
		log "jgrep is not installed — nothing to do"
		return 0
	fi
	if [ "$total" -gt 1 ]; then
		warn "warning: $total jgrep installs detected — uninstall [7] cleans all of them"
	fi
	# identity gate: never run `npm uninstall -g` unless the LOCALLY installed
	# package manifest proves it is upstream jevgrep or this fork (offline
	# check; also covers the npm-claims-but-manifest-missing case). The refusal
	# exits 1 in every mode — headless runs never succeed silently.
	if npm_owns_live; then
		verify_npm_package_identity_local
	fi
	UNINSTALL_REMOVED=0
	UNINSTALL_FAILED=0
	UNINSTALL_DECLINED=0
	REMOVED_LIST=""
	local p
	for p in "${CANDIDATE_PATHS[@]}"; do
		uninstall_one "$p"
	done
	offer_backup_cleanup

	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		log ""
		log "==> dry-run complete (option 7) — nothing was mutated"
		return 0
	fi

	uninstall_post_state

	if [ "$UNINSTALL_FAILED" -gt 0 ]; then
		if [ "$UNINSTALL_REMOVED" -gt 0 ]; then
			warn "$PROG: warning: uninstall completed with $UNINSTALL_FAILED failure(s) — partial success."
			return 0
		fi
		die "uninstall failed for all $total candidate(s) — nothing was removed"
	fi
	if [ "$UNINSTALL_REMOVED" -eq 0 ] && [ "$UNINSTALL_DECLINED" -gt 0 ]; then
		warn "$PROG: declined — nothing was removed."
		exit 3
	fi
	if [ "$UNINSTALL_REMOVED" -eq 0 ]; then
		log "==> nothing needed removal — jgrep was not installed"
	fi
	return 0
}

run_choice() {
	case "$1" in
	1) opt_local_symlink ;;
	2) opt_local_copy ;;
	3) opt_remote_copy origin ;;
	4) opt_remote_copy upstream ;;
	5) opt_npm_stable ;;
	6) opt_check_only ;;
	7) opt_uninstall ;;
	8) opt_remote_install ;;
	*)
		warn "$PROG: internal error: unknown choice '$1'."
		exit 2
		;;
	esac
	return 0
}

# ---------------------------------------------------------------------------
# argument parsing + main
# ---------------------------------------------------------------------------
parse_args() {
	while [ "$#" -gt 0 ]; do
		case "$1" in
		-h | --help | help)
			print_usage
			exit 0
			;;
		check)
			MODE_CHECK=1
			;;
		--choice)
			if [ "$#" -lt 2 ]; then
				usage_error "--choice requires a menu number (1-8)"
			fi
			OPT_CHOICE="$2"
			OPT_YES=1
			shift
			;;
		--choice=*)
			OPT_CHOICE="${1#--choice=}"
			OPT_YES=1
			;;
		--yes) OPT_YES=1 ;;
		--dry-run) OPT_DRY_RUN=1 ;;
		--target)
			if [ "$#" -lt 2 ]; then
				usage_error "--target requires a directory"
			fi
			OPT_TARGET="$2"
			shift
			;;
		--target=*)
			OPT_TARGET="${1#--target=}"
			;;
		uninstall)
			OPT_CHOICE="7"
			OPT_YES=1
			;;
		[1-8])
			OPT_CHOICE="$1"
			OPT_YES=1
			;;
		*)
			usage_error "unknown argument: '$1'"
			;;
		esac
		shift
	done

	if [ -n "$OPT_CHOICE" ]; then
		case "$OPT_CHOICE" in
		1 | 2 | 3 | 4 | 5 | 6 | 7 | 8) ;;
		*) usage_error "invalid choice: '$OPT_CHOICE' (expected an integer 1-8)" ;;
		esac
	fi
	return 0
}

run_interactive() {
	log ""
	print_menu_with_markers
	local reply=""
	printf '%s' "Select an option [1-8, q]: "
	read -r reply || reply=""
	case "$reply" in
	'' | q | Q)
		exit 0
		;;
	1 | 2 | 3 | 4 | 5 | 6 | 7 | 8)
		log ""
		run_choice "$reply"
		;;
	*)
		usage_error "unknown option: '$reply' (expected 1-8 or q)"
		;;
	esac
	return 0
}

run_detached_mode() {
	# Piped execution (`curl … | bash -s --`) or a copied install-dev.sh: no
	# repo next to $0. Only menu [8] works here — it manages its own clone and
	# needs no repo cwd. Every other option needs a real checkout.
	if [ "$MODE_CHECK" -eq 1 ]; then
		refuse_detached_needs_repo "'check'"
	fi
	case "$OPT_CHOICE" in
	8)
		detect_environment
		resolve_dest_dir
		scan_installs
		select_current_install
		print_current_line
		log ""
		run_choice "8"
		;;
	*)
		refuse_detached_needs_repo "choice $OPT_CHOICE (menu [1]-[7])"
		;;
	esac
	return 0
}

main() {
	parse_args "$@"

	# fatal (exit 2) before anything else runs when --target is dangerous
	validate_target

	# The interactive menu case (no --choice / check / help — help already
	# exited) cannot run without a repo next to the script (piped or copied)
	# and cannot read a choice from a non-TTY stdin. Refuse with the two
	# documented one-liners (exit 2); only [8] and help work through a pipe.
	if [ -z "$OPT_CHOICE" ] && [ "$MODE_CHECK" -eq 0 ]; then
		if [ "$DETACHED_MODE" -eq 1 ]; then
			refuse_menu_unavailable "no jgrep repo found next to the script (piped 'curl | bash' or a copied install-dev.sh)"
		fi
		if [ ! -t 0 ]; then
			refuse_menu_unavailable "stdin is not a TTY (piped stdin can't power the interactive read)"
		fi
	fi

	if [ "$DETACHED_MODE" -eq 1 ]; then
		run_detached_mode
		return 0
	fi

	detect_environment
	collect_repo_state
	scan_installs
	select_current_install
	resolve_dest_dir

	# check mode: full report, zero mutation (local refs only — no fetch)
	if [ "$MODE_CHECK" -eq 1 ] || [ "$OPT_CHOICE" = "6" ]; then
		if [ -n "$NPM_BIN" ]; then
			# read-only registry identity probe for the check report
			NPM_IDENTITY_RC=0
			npm_registry_identity_probe || NPM_IDENTITY_RC=$?
		fi
		log ""
		opt_check_only
		return 0
	fi

	log ""
	print_report 0

	if [ -n "$OPT_CHOICE" ]; then
		log ""
		run_choice "$OPT_CHOICE"
		return 0
	fi

	run_interactive
	return 0
}

# Repo anchoring. Piped execution (`curl … | bash -s --`) or a copied
# install-dev.sh has no checkout next to $0 — that is fine for menu [8] (it
# manages its own clone) and for help, but every other option needs a real
# repo. DETACHED_MODE=1 selects the restricted argument handling in main().
INVOCATION_CWD="$(pwd -P)" || {
	echo "install-dev.sh: cannot determine the current directory." >&2
	exit 1
}
DETACHED_MODE=1
REPO=""
case "$0" in
*/*) script_probe="$0" ;;
*) script_probe="$INVOCATION_CWD/$0" ;;
esac
if [ -f "$script_probe" ]; then
	SCRIPT_DIR="$(cd "$(dirname "$script_probe")" 2>/dev/null && pwd -P)" || SCRIPT_DIR=""
	if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/src/cli.ts" ]; then
		REPO="$SCRIPT_DIR"
		DETACHED_MODE=0
	fi
fi
if [ "$DETACHED_MODE" -eq 0 ]; then
	cd "$REPO" || exit 1
fi

main "$@"

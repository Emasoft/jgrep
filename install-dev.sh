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
#
# Modes: interactive by default. `--choice N` (or a bare N) runs one option fully
# non-interactively — zero prompts, everything auto-confirmed, deterministic
# exit codes — for headless dev boxes. `check` prints the full autodetect
# report and mutates nothing.
#
# Exit codes: 0 success · 2 usage error · 3 user-declined/aborted · 1 everything else.
# `--dry-run` always exits 0 (unless the usage itself is invalid).
#
# Dependency-free bash; macOS bash 3.2 and Linux compatible.

set -euo pipefail

PROG="install-dev.sh"

# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------
REPO=""
OPT_CHOICE=""
OPT_YES=0
OPT_DRY_RUN=0
OPT_TARGET=""
MODE_CHECK=0

PLATFORM=""
NODE_BIN="" NODE_VER=""
BUN_BIN="" BUN_VER=""
NPM_BIN="" NPM_VER=""
NPM_PREFIX="" NPM_GLOBAL_BIN=""
SHA256_TOOL=""

REPO_BRANCH="" REPO_HEAD="" REPO_DIRTY=""
ORIGIN_SHA="" UPSTREAM_SHA=""
UPSTREAM_NPM_VER=""

CURRENT_PATH="" CURRENT_KIND="" CURRENT_DETAIL=""
CURRENT_VERSION_OUT=""

DEST_DIR=""
BUILD_SHA=""
BUILD_OUTPUT=""

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

remote_url() {
	git -C "$REPO" config --get "remote.$1.url" 2>/dev/null || true
}

remote_configured() {
	[ -n "$(remote_url "$1")" ]
}

ref_sha() {
	# short SHA of a local ref (no network, no fetch) — empty when the ref is absent
	git -C "$REPO" rev-parse --short --verify "$1" 2>/dev/null || true
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
	npm ls -g jevgrep >/dev/null 2>&1
}

npm_installed_jevgrep_version() {
	local out=""
	out="$(npm ls -g jevgrep --depth=0 2>/dev/null | sed -n 's/.*jevgrep@\([^ ]*\).*/\1/p' | head -n 1 || true)"
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

	if [ -n "$NPM_BIN" ]; then
		UPSTREAM_NPM_VER="$(npm view jevgrep version 2>/dev/null | head -n 1 || true)"
	fi
}

# ---------------------------------------------------------------------------
# classify the current jgrep install
# ---------------------------------------------------------------------------
classify_current_install() {
	CURRENT_KIND="none"
	CURRENT_DETAIL=""
	CURRENT_VERSION_OUT=""
	CURRENT_PATH="$(command -v jgrep 2>/dev/null || true)"
	if [ -z "$CURRENT_PATH" ]; then
		return 0
	fi

	# normalize a relative PATH hit (rare, but possible) to an absolute one
	case "$CURRENT_PATH" in
	/*) ;;
	*)
		local nd nb
		nd="$(dirname "$CURRENT_PATH")"
		nb="$(basename "$CURRENT_PATH")"
		if [ "$nd" != "." ] && [ -d "$nd" ]; then
			CURRENT_PATH="$(cd "$nd" 2>/dev/null && pwd)/$nb" || true
		fi
		;;
	esac

	CURRENT_VERSION_OUT="$("$CURRENT_PATH" --version 2>/dev/null | head -n 1 || true)"

	if [ ! -e "$CURRENT_PATH" ] && [ ! -L "$CURRENT_PATH" ]; then
		CURRENT_KIND="unknown"
		CURRENT_DETAIL="not a file on disk (shell alias/function?) — $CURRENT_PATH"
		return 0
	fi

	# npm-owned: inside the npm global bin dir AND npm claims the package
	if [ -n "$NPM_GLOBAL_BIN" ] && [ "$(dirname "$CURRENT_PATH")" = "$NPM_GLOBAL_BIN" ] && npm_owns_live; then
		CURRENT_KIND="npm"
		CURRENT_DETAIL="jevgrep $(npm_installed_jevgrep_version) — $CURRENT_PATH"
		return 0
	fi

	if [ -L "$CURRENT_PATH" ]; then
		local real repo_root branch
		real="$(resolve_symlink "$CURRENT_PATH")"
		repo_root="$(git -C "$(dirname "$real")" rev-parse --show-toplevel 2>/dev/null || true)"
		if [ -n "$repo_root" ] && [ -f "$repo_root/package.json" ]; then
			branch="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
			if [ -z "$branch" ]; then
				branch="detached"
			fi
			CURRENT_KIND="symlink-into-repo"
			CURRENT_DETAIL="$branch — $CURRENT_PATH -> $real"
		else
			CURRENT_KIND="symlink"
			CURRENT_DETAIL="$CURRENT_PATH -> $real"
		fi
		return 0
	fi

	local h
	h="$(sha256_of "$CURRENT_PATH" || true)"
	CURRENT_KIND="copy"
	CURRENT_DETAIL="sha256:${h:0:8} — $CURRENT_PATH"
	return 0
}

# ---------------------------------------------------------------------------
# target dir
# ---------------------------------------------------------------------------
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
		mkdir -p "$OPT_TARGET" || die "cannot create --target $OPT_TARGET"
		DEST_DIR="$OPT_TARGET"
		return 0
	fi

	DEST_DIR="$(resolve_default_target 0)" || die "cannot resolve a default target dir"
	if [ "$OPT_DRY_RUN" -eq 0 ] && [ "$MODE_CHECK" -eq 0 ] && [ ! -d "$DEST_DIR" ]; then
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
	5) printf '  [5] npm stable            — npm install -g jevgrep (upstream'"'"'s published release)' ;;
	6) printf '  [6] check only            — autodetect report, no mutation' ;;
	esac
}

menu_marker() {
	case "$1" in
	1 | 2 | 3 | 4)
		if [ -z "$BUN_BIN" ]; then
			printf '[unavailable: bun missing → only npm stable remains]'
			return 0
		fi
		if [ "$1" = "3" ] && ! remote_configured origin; then
			printf '[unavailable: origin remote missing]'
			return 0
		fi
		if [ "$1" = "4" ] && ! remote_configured upstream; then
			printf '[unavailable: upstream remote missing]'
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
	6) printf '[AVAILABLE]' ;;
	esac
	return 0
}

print_menu_with_markers() {
	local i line marker pad
	for i in 1 2 3 4 5 6; do
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
  ./install-dev.sh check                 autodetect report, no mutation
  ./install-dev.sh help | --help | -h    usage + menu
  ./install-dev.sh [n|--choice N] [--yes] [--dry-run] [--target DIR]

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

Menu (stable numbering — an interface contract, never renumbered):
  [1] local dev (symlink)   — build current branch, symlink <target>/jgrep -> <repo>/dist/jgrep.js
  [2] local pinned (copy)   — build current branch, copy snapshot
  [3] fork main (copy)      — build origin/main, copy         (fetch + git worktree in a tmpdir)
  [4] upstream main (copy)  — build upstream/main, copy       (fetch + git worktree in a tmpdir)
  [5] npm stable            — npm install -g jevgrep (upstream's published release)
  [6] check only            — autodetect report, no mutation

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
	log "sha256 tool:     ${SHA256_TOOL:-NONE (conflict archiving disabled)}"

	case "$CURRENT_KIND" in
	none) log "current install: none (command -v jgrep: not found)" ;;
	symlink-into-repo | npm | copy) log "current install: $CURRENT_KIND ($CURRENT_DETAIL)" ;;
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

	log "repo:            $REPO_BRANCH @ ${REPO_HEAD:-unknown} — $REPO_DIRTY"
	log "refs (local):    origin/main @ ${ORIGIN_SHA:-<no local ref>} | upstream/main @ ${UPSTREAM_SHA:-<no local ref>}"
	if [ -n "$NPM_BIN" ]; then
		if [ -n "$UPSTREAM_NPM_VER" ]; then
			log "upstream npm:    jevgrep $UPSTREAM_NPM_VER (registry latest)"
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
		log "remotes:         origin -> $(remote_url origin)"
		log "                 upstream -> $(remote_url upstream)"
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
	if [ "$OPT_YES" -eq 1 ]; then
		if [ "$OPT_DRY_RUN" -eq 1 ]; then
			log "DRY-RUN: npm uninstall -g jevgrep   (auto-confirmed: non-interactive)"
			return 0
		fi
		log "==> non-interactive: npm owns jgrep — uninstalling jevgrep first"
		if ! npm uninstall -g jevgrep; then
			warn "$PROG: npm uninstall -g jevgrep failed."
			exit 1
		fi
		return 0
	fi
	echo
	warn "WARNING: npm owns jgrep here (package jevgrep is installed globally)."
	warn "Installing a dev build over it replaces the npm-managed file."
	local reply=""
	printf '%s' "npm owns jgrep — uninstall the package first? [y/N] "
	read -r reply || reply=""
	case "$reply" in
	y | Y | yes | YES)
		if ! npm uninstall -g jevgrep; then
			warn "$PROG: npm uninstall -g jevgrep failed."
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
# options
# ---------------------------------------------------------------------------
opt_local_symlink() {
	log "==> [1] local dev (symlink): build current branch, symlink <target>/jgrep -> <repo>/dist/jgrep.js"
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		if ensure_tmp_root; then
			build_local_dry "$TMP_ROOT/dry-build.js"
			install_artifact link "$REPO/dist/jgrep.js" "$TMP_ROOT/dry-build.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
		else
			warn "DRY-RUN: no temp dir available — skipping the build emulation"
			install_artifact link "$REPO/dist/jgrep.js" "" "$DEST_DIR" "$REPO/dist/jgrep.js"
		fi
		log "==> dry-run complete (option 1) — nothing was mutated"
		return 0
	fi
	build_local_real
	install_artifact link "$REPO/dist/jgrep.js" "$REPO/dist/jgrep.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
	verify_install "$DEST_DIR"
	return 0
}

opt_local_copy() {
	log "==> [2] local pinned (copy): build current branch, copy snapshot"
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		if ensure_tmp_root; then
			build_local_dry "$TMP_ROOT/dry-build.js"
			install_artifact copy "$TMP_ROOT/dry-build.js" "$TMP_ROOT/dry-build.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
		else
			warn "DRY-RUN: no temp dir available — skipping the build emulation"
			install_artifact copy "" "" "$DEST_DIR" "$REPO/dist/jgrep.js"
		fi
		log "==> dry-run complete (option 2) — nothing was mutated"
		return 0
	fi
	build_local_real
	install_artifact copy "$REPO/dist/jgrep.js" "$REPO/dist/jgrep.js" "$DEST_DIR" "$REPO/dist/jgrep.js"
	verify_install "$DEST_DIR"
	return 0
}

opt_remote_copy() {
	# $1 = remote name (origin | upstream)
	local remote="$1"
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
		log "==> dry-run complete (option $optno) — nothing was mutated"
		return 0
	fi
	BUILD_SHA=""
	BUILD_OUTPUT=""
	build_from_remote_real "$remote"
	log "==> built SHA: $BUILD_SHA"
	install_artifact copy "$BUILD_OUTPUT" "$BUILD_OUTPUT" "$DEST_DIR" "$BUILD_OUTPUT"
	verify_install "$DEST_DIR"
	return 0
}

opt_npm_stable() {
	log "==> [5] npm stable: npm install -g jevgrep (upstream's published release)"
	if [ -z "$NPM_BIN" ]; then
		warn "$PROG: 'npm' is required for option 5 but was not found."
		exit 1
	fi
	if [ "$OPT_DRY_RUN" -eq 1 ]; then
		if npm_owns_live; then
			log "DRY-RUN: npm owns jgrep already — a real run would uninstall jevgrep first (auto-confirmed with --yes)"
		fi
		if [ -n "$NPM_GLOBAL_BIN" ] && [ -e "$NPM_GLOBAL_BIN/jgrep" ]; then
			log "DRY-RUN: npm will overwrite $NPM_GLOBAL_BIN/jgrep"
		fi
		log "DRY-RUN: npm install -g jevgrep --yes"
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
	if ! npm install -g jevgrep --yes; then
		warn "$PROG: npm install -g jevgrep failed."
		exit 1
	fi
	if [ -n "$NPM_GLOBAL_BIN" ]; then
		verify_install "$NPM_GLOBAL_BIN"
	fi
	return 0
}

opt_check_only() {
	log "==> [6] check only: autodetect report, no mutation"
	print_report 1
	log ""
	log "==> check complete — no mutation performed"
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
				usage_error "--choice requires a menu number (1-6)"
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
		[1-6])
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
		1 | 2 | 3 | 4 | 5 | 6) ;;
		*) usage_error "invalid choice: '$OPT_CHOICE' (expected an integer 1-6)" ;;
		esac
	fi
	return 0
}

run_interactive() {
	log ""
	print_menu_with_markers
	local reply=""
	printf '%s' "Select an option [1-6, q]: "
	read -r reply || reply=""
	case "$reply" in
	'' | q | Q)
		exit 0
		;;
	1 | 2 | 3 | 4 | 5 | 6)
		log ""
		run_choice "$reply"
		;;
	*)
		usage_error "unknown option: '$reply' (expected 1-6 or q)"
		;;
	esac
	return 0
}

main() {
	parse_args "$@"

	detect_environment
	collect_repo_state
	classify_current_install
	resolve_dest_dir

	# check mode: full report, zero mutation (local refs only — no fetch)
	if [ "$MODE_CHECK" -eq 1 ] || [ "$OPT_CHOICE" = "6" ]; then
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

# cd to the script's own directory (works from any cwd), then verify the repo.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)" || {
	echo "install-dev.sh: cannot locate the script directory." >&2
	exit 1
}
REPO="$SCRIPT_DIR"
cd "$REPO" || exit 1

if [ ! -f "$REPO/package.json" ] || [ ! -f "$REPO/src/cli.ts" ]; then
	echo "install-dev.sh: fatal: this is not the jgrep repo (expected package.json and src/cli.ts in $REPO)" >&2
	exit 1
fi

main "$@"

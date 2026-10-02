// --funcs (WI-5) signature extraction: the pass-1 input for two-phase function
// navigation. Regex per language — tree-sitter is explicitly deferred (later
// milestone) — so a "signature" is a LINE that looks like a function/method/class
// declaration, not a parsed AST node. That is good enough to shortlist files
// ("which file even has a retry helper?"): pass 2 re-judges the real code, so a
// false positive here only costs a few chunks, while a false negative hides the
// file — the documented trade-off of the regex fallback.
//
// --funcs mode policy (documented in the README): files in unsupported languages
// are SKIPPED entirely (pass 1 has no signature chunk to shortlist them with), and
// a supported file with no extractable signature line (imports/types/prose only)
// is skipped the same way.

export interface Signature { line: number; text: string }
/** Structural subset of jgrep's Chunk: one SIGNATURE CHUNK per file (no context). */
export interface SignatureChunk { file: string; start: number; end: number; text: string }

/** Cap per file: beyond 200 signatures the list is cut and a truncation marker is
 *  appended (the signature chunk is a hint for the judge, not a transcript). */
export const MAX_SIGNATURES = 200;

/** Extension → language id for signature extraction; anything else is unsupported. */
const EXT_LANG: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript",
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".c": "c", ".h": "c",
  ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
  ".sh": "bash", ".bash": "bash",
};

/** The language behind `file`, or null when --funcs does not support it (skipped). */
export function detectLanguage(file: string): string | null {
  const dot = file.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like .gitignore
  return EXT_LANG[file.slice(dot).toLowerCase()] ?? null;
}

// Line-start patterns per language, heuristic on purpose (see the header). Indented
// matches count for the brace languages where methods legitimately carry whitespace;
// c/cpp additionally reject `;`-terminated lines in extractSignatures (prototypes).
const SIG_PATTERNS: Record<string, RegExp[]> = {
  // function declarations (incl. export/async/generators), classes, and the
  // `const X = (…) =>` / `const X: T = function` arrow/function-expression forms
  typescript: [
    /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*[A-Za-z_$][\w$]*/,
    /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+[A-Za-z_$][\w$]*/,
    /^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/,
  ],
  python: [
    /^\s*(?:async\s+)?def\s+[A-Za-z_]\w*/,
    /^\s*class\s+[A-Za-z_]\w*/,
  ],
  go: [
    // top-level funcs and receiver methods: func Retry(...) / func (s *Store) Get(...)
    /^func\s+(?:\([^)]*\)\s*)?[A-Za-z_]\w*/,
  ],
  rust: [
    /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+|const\s+|unsafe\s+|extern\s+)*fn\s+[A-Za-z_]\w*/,
  ],
  // java + csharp share the visibility/modifiers + [return type] + name + "(" shape;
  // the lazy return-type loop admits multi-token generic types (`public static <T> T foo(`)
  java: [
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|virtual|override|sealed|async|synchronized|partial|unsafe|extern|new)\s+)+(?:[\w<>\[\],?.]*\s+)*?[A-Za-z_]\w*\s*\(/,
    /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|partial)\s+)*(?:class|interface|enum|record|struct)\s+[A-Za-z_]\w*/,
  ],
  kotlin: [
    /^\s*(?:(?:public|private|protected|internal|suspend|inline|override|open|abstract|final|expected|actual|operator|infix)\s+)*fun\s+(?:<[^(]*>\s+)?[A-Za-z_][\w.]*/,
  ],
  swift: [
    /^\s*(?:(?:public|private|fileprivate|internal|open|static|class|final|override|mutating)\s+)*func\s+[A-Za-z_]\w*/,
  ],
  ruby: [
    /^\s*def\s+[A-Za-z_][\w.?!]*(?:\s*\([^)]*\))?/,
    /^\s*(?:class|module)\s+[A-Z]\w*/,
  ],
  php: [
    /^\s*(?:(?:public|private|protected|static|final|abstract)\s+)*function\s+&?[A-Za-z_]\w*/,
    /^\s*(?:abstract\s+|final\s+)*class\s+[A-Za-z_]\w*/,
  ],
  c: [
    // `type name(` at column 0 — a definition only when the line has no trailing `;`
    /^[A-Za-z_][\w\s\*]*[\s\*]+[A-Za-z_]\w*\s*\(/,
  ],
  cpp: [
    // like c plus namespaces (`Foo::bar`), destructors (`~Foo`) and separators via `:`
    /^[A-Za-z_~][\w:<>,\s\*&~]*[\s\*&:]+~?[A-Za-z_]\w*(?:::\w+)?\s*\(/,
  ],
  bash: [
    /^function\s+[A-Za-z_]\w*/,
    /^[A-Za-z_]\w*\s*\(\)\s*\{/,
  ],
};
SIG_PATTERNS.javascript = SIG_PATTERNS.typescript; // same signature shapes
SIG_PATTERNS.csharp = SIG_PATTERNS.java;

/**
 * Signatures of one file: 1-based line numbers, trimmed text, at most
 * MAX_SIGNATURES entries. When the file has more, the returned array carries the
 * first MAX_SIGNATURES plus a final `{ line: 0, text: "[truncated: N more
 * signatures]" }` marker (line 0 = not a real location). An unknown language id
 * extracts nothing.
 */
export function extractSignatures(text: string, lang: string): Signature[] {
  const patterns = SIG_PATTERNS[lang];
  if (!patterns) return []; // unsupported language: nothing extractable
  const out: Signature[] = [];
  let overflow = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!patterns.some((re) => re.test(line))) continue;
    if ((lang === "c" || lang === "cpp") && /;\s*$/.test(line)) continue; // prototype, not a definition
    if (out.length >= MAX_SIGNATURES) { overflow++; continue; } // keep counting for the marker
    out.push({ line: i + 1, text: line.trim() });
  }
  if (overflow > 0) out.push({ line: 0, text: `[truncated: ${overflow} more signatures]` });
  return out;
}

/** --funcs pass-1 chunk cap, the same per-chunk budget the chunker's callers assume. */
export const SIGNATURE_CHUNK_MAX_CHARS = 8000;

/**
 * Pack ALL of a file's signatures into ONE chunk: the signature lines with 1-based
 * "L12: " prefixes (a truncation marker has line 0 and renders bare). `start`/`end`
 * span the first/last signature line shown — the range to open in an editor.
 * Returns null when the file yields no signatures (the caller skips it in --funcs
 * mode); bodies over SIGNATURE_CHUNK_MAX_CHARS are cut at a line boundary with a note.
 */
export function signatureChunk(file: string, text: string, lang: string): SignatureChunk | null {
  const sigs = extractSignatures(text, lang);
  if (sigs.length === 0) return null;
  let body = sigs.map((s) => (s.line > 0 ? `L${s.line}: ${s.text}` : s.text)).join("\n");
  if (body.length > SIGNATURE_CHUNK_MAX_CHARS) {
    let cut = body.lastIndexOf("\n", SIGNATURE_CHUNK_MAX_CHARS);
    if (cut <= 0) cut = SIGNATURE_CHUNK_MAX_CHARS; // one absurdly long signature line
    body = body.slice(0, cut) + `\n[note: signature chunk truncated at ${SIGNATURE_CHUNK_MAX_CHARS} chars]`;
  }
  const ls = [...body.matchAll(/^L(\d+):/gm)].map((m) => Number(m[1]));
  return { file, start: ls.length ? Math.min(...ls) : 1, end: ls.length ? Math.max(...ls) : 1, text: body };
}

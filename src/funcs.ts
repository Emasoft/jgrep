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
/** Structural subset of jgrep's Chunk: a SIGNATURE CHUNK (no context). */
export interface SignatureChunk { file: string; start: number; end: number; text: string }

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
 * Signatures of one file: 1-based line numbers, trimmed text — ALL of them. USER
 * 2026-10-02: content is never truncated to fit the context; the old 200-signature cap
 * (with a "[truncated: N more]" marker) dropped the rest of a big file from pass 1, so a
 * match there could never shortlist it. signatureChunks splits instead. An unknown
 * language id extracts nothing.
 */
export function extractSignatures(text: string, lang: string): Signature[] {
  const patterns = SIG_PATTERNS[lang];
  if (!patterns) return []; // unsupported language: nothing extractable
  const out: Signature[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!patterns.some((re) => re.test(line))) continue;
    if ((lang === "c" || lang === "cpp") && /;\s*$/.test(line)) continue; // prototype, not a definition
    out.push({ line: i + 1, text: line.trim() });
  }
  return out;
}

/** Per-chunk byte budget for signature chunks: jgrep's MAX_CHUNK_BYTES (not imported —
 *  jgrep.ts imports this module). */
export const SIGNATURE_CHUNK_MAX_BYTES = 8000;

/**
 * The --funcs pass-1 chunks of a file: its signature lines with 1-based "L12: " prefixes,
 * grouped into chunks of at most SIGNATURE_CHUNK_MAX_BYTES (a small file is ONE chunk).
 * Each chunk's `start`/`end` span its own first/last signature line. Pass 1 shortlists a
 * file when ANY of its chunks matches — the per-file verdict is the best chunk's (USER:
 * "consider the highest scored chunk"), never a truncated view. Empty when the file
 * yields no signatures (the caller skips it in --funcs mode).
 */
export function signatureChunks(file: string, text: string, lang: string): SignatureChunk[] {
  const enc = new TextEncoder();
  const out: SignatureChunk[] = [];
  let cur: Signature[] = [];
  let bytes = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push({ file, start: cur[0].line, end: cur[cur.length - 1].line, text: cur.map((s) => `L${s.line}: ${s.text}`).join("\n") });
    cur = []; bytes = 0;
  };
  for (const s of extractSignatures(text, lang)) {
    const n = enc.encode(`L${s.line}: ${s.text}`).length + 1;
    if (cur.length && bytes + n > SIGNATURE_CHUNK_MAX_BYTES) flush();
    cur.push(s); bytes += n; // a single over-budget line goes alone; jgrep() cuts it further
  }
  flush();
  return out;
}

// ============================================================================
// mex code-graph — grammar loading + language detection  (A5)
// ============================================================================
//
// Wraps web-tree-sitter (WASM) — the same universal, native-build-free runtime
// CodeGraph used. 0.7.0 ships five vendored grammars for TypeScript/TSX,
// JavaScript/JSX, Python, and Rust. The lazy-load infrastructure is deliberately
// general (a `Language → wasm` map) so the 0.7.x contributor program can slot
// new grammars in without touching the core.
//
// Grammars are loaded on demand — only languages actually present in the project
// are compiled — keeping WASM heap pressure low on large repos.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Parser, Language as WasmLanguage } from "web-tree-sitter";
import type { Language } from "../types.js";
import type { TSTree } from "./types.js";
import { grammarWasmPath } from "../assets.js";

/**
 * Languages 0.7.0 can parse, mapped to the vendored grammar WASM basename.
 * TSX and JSX reuse the tsx / javascript grammars respectively. Extend this map
 * (and vendor the grammar) to add a language — nothing else here changes.
 */
const WASM_GRAMMAR_FILES: Partial<Record<Language, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  jsx: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  rust: "tree-sitter-rust.wasm",
  csharp: "tree-sitter-c-sharp.wasm",
};
let grammarHashCache: string | null = null;

/**
 * Content hash of the exact grammar assets this build can use. Persisting the
 * asset bytes (rather than package versions) makes copied/bundled installs and
 * local development obey the same rebuild contract.
 */
export function grammarManifestHash(): string {
  if (grammarHashCache) return grammarHashCache;
  const hash = createHash("sha256");
  for (const wasmFile of [...new Set(Object.values(WASM_GRAMMAR_FILES))].sort()) {
    hash.update(wasmFile);
    hash.update("\0");
    hash.update(readFileSync(grammarWasmPath(wasmFile)));
    hash.update("\0");
  }
  grammarHashCache = hash.digest("hex");
  return grammarHashCache;
}

/** File extension → language. The single source of truth for "index this file?". */
const EXTENSION_MAP: Record<string, Language> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".rs": "rust",
  ".cs": "csharp",
};

/** Glob pattern for every extension registered above. */
export const SUPPORTED_SOURCE_GLOB =
  `**/*.{${Object.keys(EXTENSION_MAP).map((extension) => extension.slice(1)).join(",")}}`;

const parserCache = new Map<Language, Parser>();
const languageCache = new Map<Language, WasmLanguage>();
let runtimeInitialized = false;

/**
 * Initialize the tree-sitter WASM runtime. Idempotent. Locates its own
 * `tree-sitter.wasm` relative to the installed `web-tree-sitter` package (a
 * runtime dependency), so no path wiring is needed here.
 */
export async function initRuntime(): Promise<void> {
  if (runtimeInitialized) return;
  await Parser.init();
  runtimeInitialized = true;
}

/**
 * Lazily load the grammars for the given languages (deduped; already-loaded and
 * grammar-less languages are skipped). Loads SEQUENTIALLY: web-tree-sitter has a
 * documented WASM-heap race when grammars load concurrently on Node.
 */
export async function loadGrammars(languages: Language[]): Promise<void> {
  await initRuntime();
  const toLoad = [...new Set(languages)].filter(
    (lang) => lang in WASM_GRAMMAR_FILES && !languageCache.has(lang),
  );
  for (const lang of toLoad) {
    const wasmFile = WASM_GRAMMAR_FILES[lang]!;
    const grammar = await WasmLanguage.load(grammarWasmPath(wasmFile));
    languageCache.set(lang, grammar);
  }
}

/** A ready parser for `language`, or null if its grammar was never loaded. */
function getParser(language: Language): Parser | null {
  const cached = parserCache.get(language);
  if (cached) return cached;
  const grammar = languageCache.get(language);
  if (!grammar) return null;
  const parser = new Parser();
  parser.setLanguage(grammar);
  parserCache.set(language, parser);
  return parser;
}

/** Whether the graph can extract symbols from this file (by extension). */
export function isSupportedSourceFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  return filePath.slice(dot).toLowerCase() in EXTENSION_MAP;
}

/** Detect a file's language from its extension (`"unknown"` if unsupported). */
export function detectLanguage(filePath: string): Language {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return "unknown";
  return EXTENSION_MAP[filePath.slice(dot).toLowerCase()] ?? "unknown";
}

/** Every language 0.7.0 ships a grammar for. */
export function supportedLanguages(): Language[] {
  return Object.keys(WASM_GRAMMAR_FILES) as Language[];
}

/**
 * Parse a source file into a tree-sitter tree, or null if the grammar for
 * `language` was not loaded / the parse failed. The returned tree is typed as
 * the frozen structural {@link TSTree} — this is the single boundary where the
 * concrete web-tree-sitter `Tree` is narrowed to the read-only surface every
 * extractor programs against (spec §8.1), so extractors never import
 * web-tree-sitter directly.
 */
export function parse(source: string, language: Language): TSTree | null {
  const parser = getParser(language);
  if (!parser) return null;
  const tree = parser.parse(source);
  if (!tree) return null;
  // web-tree-sitter's `Tree`/`Node` are structurally a superset of TSTree/TSNode
  // (they add mutation + native-cursor members extractors must not touch). The
  // frozen aliases are the read-only subset; narrow here, once.
  return tree as unknown as TSTree;
}

/**
 * Free a parsed tree's WASM-heap memory. web-tree-sitter trees are allocated in
 * the Emscripten heap and are not reclaimed by JavaScript GC, so every parsed
 * tree must be deleted at the extraction boundary.
 */
export function disposeTree(tree: TSTree): void {
  (tree as unknown as { delete(): void }).delete();
}

/** Compatibility name used by the v0.7.3 extraction implementation. */
export const freeTree = disposeTree;

/** Free all cached parsers + reset the runtime flag (tests / teardown). */
export function disposeParsers(): void {
  for (const parser of parserCache.values()) parser.delete();
  parserCache.clear();
}

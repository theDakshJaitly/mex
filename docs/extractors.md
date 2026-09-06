# Extending the code graph

mex v0.7.0 exposes two source-level contribution seams:

- `LanguageExtractor` turns one parsed source file into normalized graph nodes and references.
- `FrameworkResolver` adds framework-specific nodes and relationships that a plain syntax walk cannot infer.

The [code graph support reference](code-graph-support.md) records which language and framework behavior is fixture-backed today, which wiring is only partially covered, and which work remains unsupported.

These interfaces are frozen for the 0.7.x contributor program. They are not public npm exports. Contributions target `main`.

## Before starting

Use an issue labeled `code-graph`, agree on a bounded fixture-backed scope, and create your branch from `main`:

```bash
git switch main
git pull
git switch -c <feature-or-fix-branch>
```

Changes to node identity, fingerprint reconciliation, the SQLite schema, or grounding/drift semantics require a `core / discuss-first` issue and maintainer agreement before implementation.

## Graph vocabulary

Extractors emit only the shared kinds in [`src/graph/types.ts`](../src/graph/types.ts).

Node kinds include files, modules, classes, structs, interfaces, traits, protocols, functions, methods, properties, fields, variables, constants, enums, type aliases, namespaces, parameters, imports, exports, routes, and components.

Persisted edge kinds are:

| Kind | Meaning |
|---|---|
| `contains` | A file or symbol contains another symbol |
| `calls` | A function or method calls another callable |
| `imports` / `exports` | Module dependency or export relationships |
| `extends` / `implements` | Type inheritance relationships |
| `references` | A general symbol reference |
| `type_of` / `returns` | Type relationships |
| `instantiates` | Construction of a class or struct |
| `overrides` | A method overrides a parent method |
| `decorates` | A decorator or annotation applies to a symbol |

`function_ref` is an extraction-only reference kind for a callable used as a value. Resolution converts it into a persisted `references` edge.

## Language extractors

The frozen interface is [`src/graph/extraction/types.ts`](../src/graph/extraction/types.ts). The TypeScript implementation in [`src/graph/extraction/languages/typescript.ts`](../src/graph/extraction/languages/typescript.ts) is the reference implementation.

A `LanguageExtractor` must be:

- Pure and deterministic for the same tree, file path, and source.
- Limited to one parsed file: no filesystem, network, LLM, or cross-file lookups.
- Read-only with respect to the Tree-sitter tree.
- Complete for the language constructs claimed by its tests.
- Based on `generateNodeId(filePath, kind, name)` for stable node identity.

The engine owns parsing, grammar loading, body hashes, fingerprints, resolution, persistence, and timestamps. Do not implement those concerns inside an extractor.

### Required files and registration

1. Add `src/graph/extraction/languages/<language>.ts` implementing `LanguageExtractor`.
2. Register it in `src/graph/extraction/languages/index.ts`.
3. Add its extensions and grammar filename to `src/graph/extraction/grammars.ts`.
4. Vendor the compatible Tree-sitter WASM grammar under `src/graph/wasm/`.
5. Add a representative fixture under `src/graph/__tests__/fixtures/`.
6. Add focused extractor tests under `src/graph/__tests__/`.

The build copies every vendored `.wasm` file into `dist/wasm/`. A new grammar must therefore be present in the source directory and covered by a clean build or packed-install test.

### Output rules

- Emit a `file` node that roots the containment tree.
- Use 1-indexed lines and 0-indexed columns for emitted nodes.
- Emit resolved `contains` edges when both endpoints are known in the file.
- Leave cross-file targets unresolved with `targetName` and optional candidates.
- Include signatures, documentation, visibility, export state, and type information when the grammar exposes them reliably.
- Prefer stable semantic assertions over exact node/edge counts that make fixtures hard to extend.

Use [`src/graph/__tests__/extractor.test.ts`](../src/graph/__tests__/extractor.test.ts) and its `sample.ts` fixture as the test pattern. Cover at least:

- File and language identification.
- Representative declarations and qualified names.
- Containment relationships.
- Imports and cross-file references.
- Calls and language-relevant type relationships.
- A construct that must be deliberately skipped or degraded safely.

## Framework resolvers

The frozen interface is [`src/graph/resolution/types.ts`](../src/graph/resolution/types.ts). The Express implementation in [`src/graph/resolution/frameworks/express.ts`](../src/graph/resolution/frameworks/express.ts) is the reference resolver.

A resolver should add only relationships that require framework knowledge. It must detect the framework from project evidence and return `null` when it cannot resolve a reference confidently.

### Required files and registration

1. Add `src/graph/resolution/frameworks/<framework>.ts` implementing `FrameworkResolver`.
2. Register and export it from `src/graph/resolution/frameworks/index.ts`.
3. Add a minimal framework fixture under `src/graph/__tests__/fixtures/`.
4. Add focused detection, extraction, and resolution tests under `src/graph/__tests__/`.

The resolver's language extractor must already be merged before a framework issue is marked available. Do not bundle a new language extractor and its framework resolver into one pull request.

Use [`src/graph/__tests__/resolver-express.test.ts`](../src/graph/__tests__/resolver-express.test.ts) as the test pattern. Test positive and negative detection, the framework-specific node/reference shape, successful binding, and ambiguous or missing-target behavior.

## Vendored Grammars

When adding a language, document the grammar source and version.

### Rust
- **Binary source:** `tree-sitter-wasms` package, version `0.1.12`
- **Vendored path:** `src/graph/wasm/tree-sitter-rust.wasm`
- **SHA-256:** matches `node_modules/tree-sitter-wasms@0.1.12/out/tree-sitter-rust.wasm` exactly
- **Binary package license:** Unlicense
- **Upstream grammar:** [tree-sitter/tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust)
- **Upstream grammar license:** MIT

### C#
- **Binary source:** `tree-sitter-c-sharp` package, version `0.23.5` (the grammar's own published package, not `tree-sitter-wasms` — see note below)
- **Vendored path:** `src/graph/wasm/tree-sitter-c-sharp.wasm`
- **SHA-256:** matches `node_modules/tree-sitter-c-sharp@0.23.5/tree-sitter-c_sharp.wasm` exactly
- **Binary package license:** MIT
- **Upstream grammar:** [tree-sitter/tree-sitter-c-sharp](https://github.com/tree-sitter/tree-sitter-c-sharp)
- **Upstream grammar license:** MIT
- **Note:** `tree-sitter-wasms@0.1.12` also ships a `tree-sitter-c_sharp.wasm`, but it is built from a different grammar revision than the `node-types.json` published with `tree-sitter-c-sharp@0.23.5`. Several fields that `node-types.json` declares (`variable_declarator.name`, `using_directive.name`) return `undefined` via `childForFieldName` against that older build. The extractor is written and tested against 0.23.5's own field layout — use the grammar's own published wasm for this language, not `tree-sitter-wasms`'s copy.

## Pull request proof

Before opening a pull request, run:

```bash
npm run typecheck
npm test
npm run build
```

Your pull request must:

- Target `main`.
- Link the approved issue.
- Include a fixture and focused node/edge assertions.
- Keep changes inside the extractor or resolver boundary plus its registrations and tests.
- Document the grammar source and version when adding a language.
- Avoid core identity, reconciliation, schema, and drift changes unless the linked issue was explicitly approved for that scope.

Maintainers may mark new community-contributed language and framework support experimental if fixtures, upstream grammars, or active maintenance are insufficient.

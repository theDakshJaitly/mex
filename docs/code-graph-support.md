# Code graph support

This page documents the fixture-backed code-graph support shipped in mex v0.7.0.

This page distinguishes three evidence levels:

- **Supported** — implemented and exercised by a focused fixture and test.
- **Partial** — wired into the release, but not independently fixture-tested for
  every listed extension or syntax family.
- **Unsupported** — no grammar and extractor are registered in this release.

## Language and file support

The extension and grammar mappings live in
[`src/graph/extraction/grammars.ts`](../src/graph/extraction/grammars.ts), and the
extractor registry lives in
[`src/graph/extraction/languages/index.ts`](../src/graph/extraction/languages/index.ts).

| Status | Language | Extensions | Current evidence |
|---|---|---|---|
| **Supported** | TypeScript | `.ts` | [`sample.ts`](../src/graph/__tests__/fixtures/sample.ts), [`typescript-edge-cases.ts`](../src/graph/__tests__/fixtures/typescript-edge-cases.ts), and their focused tests exercise declarations, calls, imports, visibility, async functions, and type shapes. |
| **Partial** | TypeScript modules | `.mts`, `.cts` | Both extensions map to the TypeScript grammar and extractor, but the current `sample.ts` fixture does not exercise them separately. |
| **Supported** | TSX | `.tsx` | [`tsx-component.tsx`](../src/graph/__tests__/fixtures/tsx-component.tsx) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover components, interfaces, imports, and calls. |
| **Supported** | JavaScript | `.js` | [`javascript-edge-cases.js`](../src/graph/__tests__/fixtures/javascript-edge-cases.js) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover classes, static methods, construction, calls, and resilient parsing. |
| **Partial** | JavaScript modules | `.mjs`, `.cjs` | Both extensions map to the JavaScript grammar and extractor, but they are not exercised by dedicated fixtures. |
| **Supported** | JSX | `.jsx` | [`jsx-component.jsx`](../src/graph/__tests__/fixtures/jsx-component.jsx) and [`extraction-regression.test.ts`](../src/graph/__tests__/extraction-regression.test.ts) cover components, imports, calls, and construction. |
| **Supported** | Python | `.py` | [`sample.py`](../src/graph/__tests__/fixtures/sample.py), [`extractor-python.test.ts`](../src/graph/__tests__/extractor-python.test.ts), and the [`python-package`](../src/graph/__tests__/fixtures/python-package) integration fixture cover extraction and cross-file package resolution. |
| **Supported** | Rust | `.rs` | [`sample.rs`](../src/graph/__tests__/fixtures/sample.rs) and [`extractor-rust.test.ts`](../src/graph/__tests__/extractor-rust.test.ts) cover structs, traits, enums, modules, functions, methods, generics, imports, calls, implementations, construction, returns, and field types. |
| **Partial** | C# | `.cs` | [`sample.cs`](../src/graph/__tests__/fixtures/sample.cs) and [`extractor-csharp.test.ts`](../src/graph/__tests__/extractor-csharp.test.ts) cover namespaces (including nested/file-scoped), classes, interfaces, structs, enums, properties, fields, `const` fields, constructors, static methods, parameters, attributes, `using` imports, calls, instantiation, and base-list extends/implements. Ran clean (0 partial/failed) across 694 real-world `.cs` files in one large external repository. Marked partial, not supported: the `extends`/`implements` split on a class's base list is a first-listed-entry heuristic, not a semantic resolution (documented in `csharp.ts`), and generics/type-parameter capture (`typeParameters`, matching Rust's `.rs` support) is not yet implemented. |
| **Unsupported** | Go and other languages | All other extensions | These names may be reserved in [`src/graph/types.ts`](../src/graph/types.ts), but no grammar or extractor is registered for them. Unsupported files are skipped rather than failing a graph build. |

`src/graph/types.ts` contains a wider future-facing language vocabulary. A name
in that type union is not a support promise; the grammar and extractor
registries above are the current sources of truth.

## Fixture-backed extraction

The core TypeScript fixture contains an import, an exported function, a class, methods,
a callable field, a property, a constant, inheritance, interface
implementation, calls, and construction:

```ts
import { formatName } from "./helpers";

const PREFIX = "hello";

export function greet(name: string): string {
  return formatName(name);
}

export class Greeter extends Base implements Speaker {
  greeting = PREFIX;
  speak(name: string): string {
    const w = new Warmup();
    return greet(name);
  }
}
```

[`extractor.test.ts`](../src/graph/__tests__/extractor.test.ts) proves the
following output from [`sample.ts`](../src/graph/__tests__/fixtures/sample.ts):

| Output | Fixture-backed behavior |
|---|---|
| Nodes | `file`, `function`, `class`, `method`, `property`, and `constant` |
| Symbol metadata | exported state, function signature, docstring, and qualified method name |
| Relationships | `contains`, `imports`, `calls`, `extends`, `implements`, and `instantiates` |

The complete shared vocabulary in
[`src/graph/types.ts`](../src/graph/types.ts) includes additional node and edge
kinds for current internals and future extractors. Kinds not named in the table
above are not claimed as fixture-backed TypeScript behavior by this page.

The shared TypeScript-family walker and regression fixtures cover
`interface`, `enum`, `enum_member`, `type_alias`, and top-level `variable`
nodes in
[`src/graph/extraction/languages/typescript.ts`](../src/graph/extraction/languages/typescript.ts).
The Express fixture separately proves the framework-specific `route` node and
resolved `references` relationship below.

## Express route resolution

Express is the only framework resolver included in v0.7.0. It activates
when `express` appears in `dependencies` or `devDependencies`, recognizes a
literal route registered through `app` or `router`, emits a `route` node, and
links an identifier handler when it can resolve that handler confidently.

```ts
import express from "express";

const app = express();
export function healthHandler(): void {}
app.get("/health", healthHandler);
```

[`express-app.ts`](../src/graph/__tests__/fixtures/express-app.ts) and
[`resolver-express.test.ts`](../src/graph/__tests__/resolver-express.test.ts)
prove detection, the `GET /health` route node, the `healthHandler` reference,
and same-file handler binding. The end-to-end persistence path is covered by
the “activates the Express resolver and links a route to its handler” case in
[`engine.test.ts`](../src/graph/__tests__/engine.test.ts).

This resolver does not promise general framework or dynamic-dispatch analysis.
Computed route strings, inline callbacks, handler arrays, middleware chains,
and registrations hidden behind arbitrary helper functions are outside the
fixture-backed shape. NestJS and Next.js resolvers are not included.

## Graceful degradation

The code graph requires Node.js 22.5 or newer because it uses the built-in
`node:sqlite` module. There is no alternate database fallback.

When the graph database or SQLite capability is unavailable:

- setup warns and continues without the code graph (see
  [`src/setup/index.ts`](../src/setup/index.ts));
- ordinary filesystem and lexical drift checks continue while grounding checks
  are skipped with a warning (see
  [`src/drift/index.ts`](../src/drift/index.ts)); and
- graph query/scope commands return a machine-readable `GRAPH_UNAVAILABLE`
  error instead of inventing results.

These paths are covered by the “scope degrades” and “graph loading fails” cases
in [`graph-cli-agent.test.ts`](../test/graph-cli-agent.test.ts) and the “keeps
legacy checks running” case in
[`graph-integration.test.ts`](../test/graph-integration.test.ts).

Unsupported source-language files are also skipped. A missing extractor does
not make the rest of setup or drift checking fail.

## Known limitations

- **Ambiguous references stay unresolved.** The base resolver prefers a
  same-file definition, an unambiguous imported definition, a sole candidate,
  or a unique exported candidate. Otherwise it emits no edge rather than
  guessing; see
  [`src/graph/resolution/resolver.ts`](../src/graph/resolution/resolver.ts).
- **Dynamic dispatch is not general-purpose.** Tree-sitter extraction and the
  narrow Express resolver cover statically recognizable shapes, not runtime
  reflection, dependency injection, monkey-patching, or computed calls.
- **Generated code is path-filtered, not identified semantically.** Common
  output trees such as `node_modules`, `dist`, `build`, `.next`, `out`,
  `coverage`, and `.mex` are excluded by the source globs in
  [`engine-impl.ts`](../src/graph/engine-impl.ts) and
  [`runtime.ts`](../src/graph/runtime.ts). Generated files outside those paths
  may still be indexed.
- **Framework behavior is opt-in and narrow.** Express route-to-handler binding
  is the only framework fixture in v0.7.0. Other frameworks remain unsupported
  until their language extractor and resolver work merges.
- **Support claims are fixture-bounded.** This page describes behavior exercised
  in v0.7.0. It does not promise complete semantic analysis for every construct
  in a supported language or support for unmerged Go, NestJS, or Next.js work.

For contributor interfaces, fixture requirements, and registration points, see
[Extending the code graph](extractors.md).

// ============================================================================
// mex code-graph — C# extractor  (community contribution, tree-sitter-c-sharp)
// ============================================================================
//
// Modeled on the reference tree-sitter walker in `./python.ts` (Track A/B
// pattern, not the TypeScript compiler-based path in `../compiler.ts` — C# has
// no equivalent compiler-service integration here).
//
// Grammar facts below were verified against `tree-sitter-c-sharp@0.23.5`'s
// published `src/node-types.json`, not guessed. Two structural quirks that
// differ from Python/Rust:
//   - `field_declaration` / `event_field_declaration` report NO named fields
//     (unlike `class_declaration`, `method_declaration`, etc.), so a field's
//     name is reached by walking `.namedChildren` by `.type` two levels down:
//     field_declaration -> variable_declaration -> variable_declarator[name].
//   - `base_list` also has no fields and does not syntactically distinguish a
//     base *class* from an implemented *interface* — both are just entries in
//     one list. This extractor applies the conventional heuristic (base class,
//     if any, is listed first) for `class`/`struct`/`record`; every entry on an
//     `interface_declaration` is `extends` (an interface can only extend other
//     interfaces). This is a documented best-effort, not a semantic guarantee.

import type { Language, NodeKind } from "../../types.js";
import type {
  ExtractedEdge,
  ExtractedNode,
  LanguageExtractor,
  TSNode,
  TSTree,
} from "../types.js";
import { canonicalNodeIdentity, generateNodeId, getChildByField, getNodeText } from "../node-id.js";

const TYPE_DECLARATION_KINDS: Record<string, NodeKind> = {
  class_declaration: "class",
  struct_declaration: "struct",
  record_declaration: "class", // no dedicated "record" NodeKind yet
  interface_declaration: "interface",
};
const TYPE_DECLARATION_TYPES = new Set(Object.keys(TYPE_DECLARATION_KINDS));

const METHOD_TYPES = new Set([
  "method_declaration",
  "constructor_declaration",
  "destructor_declaration",
  "operator_declaration",
  "conversion_operator_declaration",
]);
const LOCAL_FUNCTION_TYPES = new Set(["local_function_statement"]);
const PROPERTY_TYPES = new Set(["property_declaration", "indexer_declaration", "event_declaration"]);
const FIELD_DECL_TYPES = new Set(["field_declaration", "event_field_declaration"]);
const ENUM_TYPES = new Set(["enum_declaration"]);
const DELEGATE_TYPES = new Set(["delegate_declaration"]);
const NAMESPACE_TYPES = new Set(["namespace_declaration", "file_scoped_namespace_declaration"]);
const CALL_TYPES = new Set(["invocation_expression"]);
const INSTANTIATION_TYPES = new Set(["object_creation_expression", "implicit_object_creation_expression"]);

const VISIBILITY_MODIFIERS = new Set(["public", "private", "protected", "internal"]);

class CSharpWalker {
  private readonly nodes: ExtractedNode[] = [];
  private readonly edges: ExtractedEdge[] = [];
  private readonly scopeStack: string[] = [];
  private readonly identityOccurrences = new Map<string, number>();

  constructor(
    private readonly filePath: string,
    private readonly source: string,
    private readonly language: Language,
  ) {}

  run(root: TSNode): { nodes: ExtractedNode[]; edges: ExtractedEdge[] } {
    const fileName = baseName(this.filePath);
    const fileId = generateNodeId(this.filePath, "file", fileName, this.filePath, "source-file");
    this.nodes.push({
      id: fileId,
      identityKey: canonicalNodeIdentity(this.filePath, "file", this.filePath, "source-file"),
      kind: "file",
      name: fileName,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: this.language,
      startLine: 1,
      endLine: root.endPosition.row + 1,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
    });

    this.scopeStack.push(fileId);
    for (const child of root.namedChildren) this.visit(child);
    this.scopeStack.pop();

    return { nodes: this.nodes, edges: this.edges };
  }

  private visit(node: TSNode): void {
    const type = node.type;

    if (NAMESPACE_TYPES.has(type)) return this.extractNamespace(node);
    if (TYPE_DECLARATION_TYPES.has(type)) return this.extractTypeDeclaration(node);
    if (ENUM_TYPES.has(type)) return this.extractEnum(node);
    if (DELEGATE_TYPES.has(type)) return this.extractDelegate(node);
    if (METHOD_TYPES.has(type) || LOCAL_FUNCTION_TYPES.has(type)) {
      return this.extractMethod(node, LOCAL_FUNCTION_TYPES.has(type));
    }
    if (PROPERTY_TYPES.has(type)) return this.extractProperty(node);
    if (FIELD_DECL_TYPES.has(type)) return this.extractFieldDeclaration(node);
    if (type === "using_directive") return this.extractUsing(node);

    // Namespaces, blocks, and statements nest arbitrarily; keep descending
    // until a declaration or a call/instantiation site is found.
    for (const child of node.namedChildren) this.visit(child);
  }

  private createNode(
    kind: NodeKind,
    name: string,
    node: TSNode,
    extra?: Partial<ExtractedNode>,
  ): string | null {
    if (!name) return null;
    const qualifiedName = this.qualify(name);
    const baseIdentity = canonicalNodeIdentity(this.filePath, kind, qualifiedName, kind, extra?.signature);
    const ordinal = this.identityOccurrences.get(baseIdentity) ?? 0;
    this.identityOccurrences.set(baseIdentity, ordinal + 1);
    const declarationRole = ordinal === 0 ? kind : `${kind}:ordinal:${ordinal}`;
    const identityKey = canonicalNodeIdentity(this.filePath, kind, qualifiedName, declarationRole, extra?.signature);
    const id = generateNodeId(this.filePath, kind, name, qualifiedName, declarationRole, extra?.signature);
    this.nodes.push({
      id,
      identityKey,
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      ...extra,
    });

    const parent = this.scopeStack[this.scopeStack.length - 1];
    if (parent) this.edges.push({ source: parent, target: id, kind: "contains" });
    return id;
  }

  private qualify(name: string): string {
    const parts: string[] = [];
    for (const scopeId of this.scopeStack) {
      const scope = this.nodes.find((n) => n.id === scopeId);
      if (scope && scope.kind !== "file") parts.push(scope.name);
    }
    parts.push(name);
    return parts.join(".");
  }

  private extractNamespace(node: TSNode): void {
    const nameNode = getChildByField(node, "name");
    const name = nameNode ? getNodeText(nameNode, this.source) : "";
    if (!name) return;
    const id = this.createNode("namespace", name, node);
    if (!id) return;

    const body = getChildByField(node, "body");
    this.scopeStack.push(id);
    if (body) {
      for (const child of body.namedChildren) this.visit(child);
    } else {
      // File-scoped namespace: `namespace Foo;` — every following declaration
      // in the file belongs to it, tree-sitter keeps them as later siblings.
      let sibling = node.nextNamedSibling;
      while (sibling) {
        this.visit(sibling);
        sibling = sibling.nextNamedSibling;
      }
    }
    this.scopeStack.pop();
  }

  private extractTypeDeclaration(node: TSNode): void {
    const nameNode = getChildByField(node, "name");
    const name = nameNode ? getNodeText(nameNode, this.source) : "";
    if (!name) return;

    const kind = TYPE_DECLARATION_KINDS[node.type]!;
    const modifiers = modifiersOf(node, this.source);
    const id = this.createNode(kind, name, node, {
      visibility: visibilityOf(modifiers),
      isExported: modifiers.includes("public"),
      isAbstract: modifiers.includes("abstract"),
      isStatic: modifiers.includes("static"),
    });
    if (!id) return;

    this.extractHeritage(node, id, kind === "interface");
    this.extractAttributes(node, id);

    const body = getChildByField(node, "body");
    this.scopeStack.push(id);
    if (body) for (const member of body.namedChildren) this.visit(member);
    this.scopeStack.pop();
  }

  private extractEnum(node: TSNode): void {
    const nameNode = getChildByField(node, "name");
    const name = nameNode ? getNodeText(nameNode, this.source) : "";
    if (!name) return;
    const modifiers = modifiersOf(node, this.source);
    const id = this.createNode("enum", name, node, {
      visibility: visibilityOf(modifiers),
      isExported: modifiers.includes("public"),
    });
    if (!id) return;

    const body = getChildByField(node, "body"); // enum_member_declaration_list
    if (!body) return;
    this.scopeStack.push(id);
    for (const member of body.namedChildren) {
      if (member.type !== "enum_member_declaration") continue;
      const memberName = getNodeText(member, this.source).split(/[\s=]/)[0]!.trim();
      this.createNode("enum_member", memberName, member);
    }
    this.scopeStack.pop();
  }

  private extractDelegate(node: TSNode): void {
    const nameNode = getChildByField(node, "name");
    const name = nameNode ? getNodeText(nameNode, this.source) : "";
    if (!name) return;
    const modifiers = modifiersOf(node, this.source);
    const returnType = getChildByField(node, "type");
    // No dedicated "delegate" NodeKind: a delegate is a named callable type,
    // closest existing kind is type_alias.
    this.createNode("type_alias", name, node, {
      visibility: visibilityOf(modifiers),
      isExported: modifiers.includes("public"),
      returnType: returnType ? getNodeText(returnType, this.source) : undefined,
      signature: signatureOf(node, this.source),
    });
  }

  private extractMethod(node: TSNode, isLocalFunction: boolean): void {
    // constructor_declaration/destructor_declaration both carry a `name` field
    // in tree-sitter-c-sharp@0.23.5 (verified in node-types.json), so this
    // reads their identifier directly. The enclosing-type fallback is
    // defensive only, for a grammar revision where that field is absent.
    const nameNode = getChildByField(node, "name");
    const name = nameNode ? getNodeText(nameNode, this.source) : enclosingTypeName(node, this.source);
    if (!name) return;

    const modifiers = modifiersOf(node, this.source);
    const returnType = getChildByField(node, "returns") ?? getChildByField(node, "type");
    const id = this.createNode(isLocalFunction ? "function" : "method", name, node, {
      visibility: visibilityOf(modifiers),
      isExported: modifiers.includes("public"),
      isStatic: modifiers.includes("static"),
      isAbstract: modifiers.includes("abstract"),
      isAsync: modifiers.includes("async"),
      returnType: returnType ? getNodeText(returnType, this.source) : undefined,
      signature: signatureOf(node, this.source),
    });
    if (!id) return;

    this.extractAttributes(node, id);
    this.scopeStack.push(id);
    this.extractParameters(node);
    this.scopeStack.pop();

    const body = getChildByField(node, "body") ?? getChildByField(node, "value");
    if (body) this.walkBody(body, id);
  }

  private extractProperty(node: TSNode): void {
    const nameNode = getChildByField(node, "name");
    const name = nameNode ? getNodeText(nameNode, this.source) : "";
    if (!name) return;
    const modifiers = modifiersOf(node, this.source);
    const type = getChildByField(node, "type");
    const id = this.createNode("property", name, node, {
      visibility: visibilityOf(modifiers),
      isExported: modifiers.includes("public"),
      isStatic: modifiers.includes("static"),
      returnType: type ? getNodeText(type, this.source) : undefined,
    });
    if (!id) return;

    this.extractAttributes(node, id);
    const value = getChildByField(node, "value");
    if (value) this.walkBody(value, id);
    // Accessor bodies (get/set with expression bodies) can contain calls too.
    const accessors = getChildByField(node, "accessors");
    if (accessors) this.walkBody(accessors, id);
  }

  /**
   * `field_declaration` / `event_field_declaration` expose no named fields
   * (verified: `node-types.json` reports `fields: {}` for both). Structure is
   * `field_declaration -> variable_declaration -> variable_declarator[name]`,
   * and a single declaration can list multiple comma-separated declarators
   * (`int x, y;`) — each becomes its own field node.
   */
  private extractFieldDeclaration(node: TSNode): void {
    const modifiers = modifiersOf(node, this.source);
    const varDecl = node.namedChildren.find((child) => child.type === "variable_declaration");
    if (!varDecl) return;
    const type = getChildByField(varDecl, "type");

    // `const` fields have no runtime storage location distinct from their
    // value — mirror Rust's const_item -> "constant" mapping (rust.ts:104,308)
    // rather than emitting them as ordinary mutable fields.
    const isConst = modifiers.includes("const");

    for (const declarator of varDecl.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const nameNode = getChildByField(declarator, "name");
      const name = nameNode ? getNodeText(nameNode, this.source) : "";
      if (!name) continue;
      const id = this.createNode(isConst ? "constant" : "field", name, declarator, {
        visibility: visibilityOf(modifiers),
        isExported: modifiers.includes("public"),
        isStatic: modifiers.includes("static") || isConst,
        returnType: type ? getNodeText(type, this.source) : undefined,
      });
      if (id) this.extractAttributes(node, id);
    }
  }

  /**
   * `using_directive`'s `name` field is documented in `node-types.json` but was
   * observed unset at runtime for plain `using X;` / `using X.Y;` forms in the
   * vendored `tree-sitter-c-sharp@0.23.5` grammar — verified against this
   * fixture, not assumed. Fall back to the (single, unambiguous) first named
   * child, matching the defensive field-or-positional pattern other extractors
   * use for the same class of grammar quirk (e.g. `python.ts`'s
   * `getChildByField(node, "left") ?? node.namedChild(0)`).
   */
  private extractUsing(node: TSNode): void {
    const fileId = this.scopeStack[0];
    if (!fileId) return;
    const nameNode = getChildByField(node, "name") ?? node.namedChild(0);
    const name = nameNode ? getNodeText(nameNode, this.source) : "";
    if (!name) return;
    this.addRef(fileId, name, "imports", node);
  }

  /**
   * `base_list` reports no fields (verified: `node-types.json`); its children
   * are `type` / `primary_constructor_base_type` entries with no syntactic
   * marker for "base class" vs. "implemented interface". Heuristic: on an
   * interface every entry is `extends`; on a class/struct/record, the first
   * entry is treated as the base class (`extends`) and the rest as
   * `implements` — the common convention, not a grammar guarantee.
   */
  private extractHeritage(node: TSNode, fromId: string, isInterface: boolean): void {
    const baseList = node.namedChildren.find((child) => child.type === "base_list");
    if (!baseList) return;
    const entries = baseList.namedChildren.filter(
      (child) => child.type === "type" || child.type === "identifier" || child.type === "generic_name"
        || child.type === "qualified_name" || child.type === "primary_constructor_base_type",
    );
    entries.forEach((entry, index) => {
      const kind = isInterface || index > 0 ? "implements" : "extends";
      this.addRef(fromId, getNodeText(entry, this.source), kind, entry);
    });
  }

  private extractAttributes(node: TSNode, ownerId: string): void {
    for (const child of node.namedChildren) {
      if (child.type !== "attribute_list") continue;
      for (const attribute of child.namedChildren) {
        if (attribute.type !== "attribute") continue;
        const nameNode = getChildByField(attribute, "name");
        const name = nameNode ? getNodeText(nameNode, this.source) : "";
        if (name) this.addRef(ownerId, name, "decorates", attribute);
      }
    }
  }

  /** Caller must have the owning method pushed as the current scope. */
  private extractParameters(node: TSNode): void {
    const params = getChildByField(node, "parameters");
    if (!params) return;
    for (const param of params.namedChildren) {
      if (param.type !== "parameter") continue;
      const nameNode = getChildByField(param, "name");
      const name = nameNode ? getNodeText(nameNode, this.source) : "";
      if (!name) continue;
      const type = getChildByField(param, "type");
      this.createNode("parameter", name, param, {
        returnType: type ? getNodeText(type, this.source) : undefined,
      });
    }
  }

  private walkBody(body: TSNode, ownerId: string): void {
    const type = body.type;

    if (CALL_TYPES.has(type)) {
      this.extractCall(body, ownerId);
    } else if (INSTANTIATION_TYPES.has(type)) {
      this.extractInstantiation(body, ownerId);
    } else if (METHOD_TYPES.has(type) || LOCAL_FUNCTION_TYPES.has(type)) {
      this.scopeStack.push(ownerId);
      this.visit(body);
      this.scopeStack.pop();
      return;
    } else if (TYPE_DECLARATION_TYPES.has(type)) {
      // Local/nested type declarations inside a method body.
      this.scopeStack.push(ownerId);
      this.visit(body);
      this.scopeStack.pop();
      return;
    }

    for (const child of body.namedChildren) this.walkBody(child, ownerId);
  }

  private extractCall(node: TSNode, ownerId: string): void {
    const fn = getChildByField(node, "function");
    let calleeName = "";
    if (fn) {
      if (fn.type === "member_access_expression") {
        const nameNode = getChildByField(fn, "name");
        calleeName = nameNode ? getNodeText(nameNode, this.source) : "";
      } else {
        calleeName = getNodeText(fn, this.source);
      }
    }
    if (calleeName) this.addRef(ownerId, calleeName, "calls", node);
  }

  private extractInstantiation(node: TSNode, ownerId: string): void {
    const typeNode = getChildByField(node, "type");
    const typeName = typeNode ? getNodeText(typeNode, this.source) : "";
    if (typeName) this.addRef(ownerId, typeName, "instantiates", node);
  }

  private addRef(
    source: string,
    targetName: string,
    kind: ExtractedEdge["kind"],
    node: TSNode,
    metadata?: Record<string, unknown>,
  ): void {
    if (!targetName) return;
    this.edges.push({
      source,
      targetName,
      kind,
      line: node.startPosition.row,
      column: node.startPosition.column,
      metadata,
    });
  }
}

// ----------------------------------------------------------------------------
// C# node helpers
// ----------------------------------------------------------------------------

/** `modifier` nodes have no fields (verified in `node-types.json`) — read their text directly. */
function modifiersOf(node: TSNode, source: string): string[] {
  return node.namedChildren
    .filter((child) => child.type === "modifier")
    .map((child) => getNodeText(child, source));
}

function visibilityOf(modifiers: string[]): "public" | "private" | "protected" | "internal" | undefined {
  return modifiers.find((m): m is "public" | "private" | "protected" | "internal" =>
    VISIBILITY_MODIFIERS.has(m),
  );
}

function signatureOf(node: TSNode, source: string): string | undefined {
  const params = getChildByField(node, "parameters");
  if (!params) return undefined;
  return getNodeText(params, source);
}

/** Constructors/destructors: fall back to the nearest enclosing type's name. */
function enclosingTypeName(node: TSNode, source: string): string {
  let current: TSNode | null = node.parent;
  while (current) {
    if (TYPE_DECLARATION_TYPES.has(current.type)) {
      const nameField = getChildByField(current, "name");
      if (nameField) return getNodeText(nameField, source);
    }
    current = current.parent;
  }
  return "";
}

function baseName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export const csharpExtractor: LanguageExtractor = {
  language: "csharp",
  fileExtensions: [".cs"],
  grammarWasm: "tree-sitter-c-sharp.wasm",
  extract(tree: TSTree, filePath: string, source: string) {
    return new CSharpWalker(filePath, source, "csharp").run(tree.rootNode);
  },
};

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { extractFile, loadGrammars } from "../extraction/index.js";
import type { FileExtraction } from "../extraction/index.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample.cs");

describe("C# extractor", () => {
  let result: FileExtraction;

  beforeAll(async () => {
    await loadGrammars(["csharp"]);
    const source = readFileSync(FIXTURE, "utf-8");
    result = extractFile("fixtures/sample.cs", source, "csharp")!;
    expect(result).not.toBeNull();
  });

  const node = (kind: string, name: string) =>
    result.nodes.find((n) => n.kind === kind && n.name === name);
  const hasEdge = (kind: string, targetName: string) =>
    result.edges.some((e) => e.kind === kind && e.targetName === targetName);

  it("emits a file node and stamps the language", () => {
    expect(result.language).toBe("csharp");
    expect(node("file", "sample.cs")).toBeDefined();
  });

  it("extracts namespaces, including nested ones", () => {
    expect(node("namespace", "MyApp.Models")).toBeDefined();
    const auditLog = node("class", "AuditLog");
    expect(auditLog).toBeDefined();
    expect(auditLog!.qualifiedName).toBe("MyApp.Models.Admin.AuditLog");
  });

  it("extracts interfaces, structs, and enums", () => {
    expect(node("interface", "IGreeter")).toBeDefined();

    const point = node("struct", "Point");
    expect(point).toBeDefined();
    expect(node("field", "X")).toBeDefined();
    expect(node("field", "Y")).toBeDefined();

    const role = node("enum", "Role");
    expect(role).toBeDefined();
    expect(node("enum_member", "Admin")).toBeDefined();
    expect(node("enum_member", "Member")).toBeDefined();
  });

  it("extracts a class, its visibility, and its members", () => {
    const user = node("class", "User");
    expect(user).toBeDefined();
    expect(user!.visibility).toBe("public");
    expect(user!.isExported).toBe(true);

    const nameProp = node("property", "Name");
    expect(nameProp).toBeDefined();
    expect(nameProp!.returnType).toBe("string");

    expect(node("field", "name")).toBeDefined();

    const maxAge = node("constant", "MaxAge");
    expect(maxAge).toBeDefined();
    expect(maxAge!.isStatic).toBe(true);
  });

  it("extracts a constructor named after the class", () => {
    const ctor = result.nodes.find(
      (n) => n.kind === "method" && n.qualifiedName === "MyApp.Models.User.User",
    );
    expect(ctor).toBeDefined();
  });

  it("extracts methods, including static ones, with parameters", () => {
    // "Greet" is declared on both IGreeter and User — disambiguate by qualifiedName.
    const greet = result.nodes.find(
      (n) => n.kind === "method" && n.qualifiedName === "MyApp.Models.User.Greet",
    );
    expect(greet).toBeDefined();

    const create = node("method", "Create");
    expect(create).toBeDefined();
    expect(create!.isStatic).toBe(true);

    const param = result.nodes.find(
      (n) => n.kind === "parameter" && n.qualifiedName === "MyApp.Models.User.Create.name",
    );
    expect(param).toBeDefined();
  });

  it("emits extends/implements from the base list", () => {
    expect(hasEdge("extends", "BaseEntity")).toBe(true);
    expect(hasEdge("implements", "IGreeter")).toBe(true);
  });

  it("emits an attribute as a decorates edge", () => {
    expect(hasEdge("decorates", "Serializable")).toBe(true);
  });

  it("emits import edges for using directives", () => {
    expect(hasEdge("imports", "System")).toBe(true);
    expect(hasEdge("imports", "System.Collections.Generic")).toBe(true);
  });

  it("emits calls and instantiates references", () => {
    expect(hasEdge("instantiates", "User")).toBe(true);
    expect(hasEdge("calls", "Log")).toBe(true);
    expect(hasEdge("calls", "Greet")).toBe(true);
    expect(hasEdge("calls", "WriteLine")).toBe(true);
  });

  it("nests methods under their class via contains edges", () => {
    const userClass = node("class", "User")!;
    const greet = result.nodes.find(
      (n) => n.kind === "method" && n.qualifiedName === "MyApp.Models.User.Greet",
    )!;
    expect(
      result.edges.some(
        (e) => e.kind === "contains" && e.source === userClass.id && e.target === greet.id,
      ),
    ).toBe(true);
  });
});

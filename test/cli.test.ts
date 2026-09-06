import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Command, InvalidArgumentError } from "commander";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runLog, runTimeline } from "../src/events.js";
import { createRepositoryGraphPort } from "../src/graph/application-adapter.js";
import type { MexConfig } from "../src/types.js";

vi.mock("../src/events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events.js")>()),
  runLog: vi.fn(),
  runTimeline: vi.fn(),
}));

let parseIntArg: typeof import("../src/cli.js").parseIntArg;
let parsePositiveIntArg: typeof import("../src/cli.js").parsePositiveIntArg;

const config: MexConfig = {
  projectRoot: process.cwd(),
  scaffoldRoot: `${process.cwd()}/.mex`,
  aiTools: [],
};

beforeAll(async () => {
  const originalArgv = process.argv;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = ["node", "mex", "completion", "bash"];
  try {
    ({ parseIntArg, parsePositiveIntArg } = await import("../src/cli.js"));
  } finally {
    process.argv = originalArgv;
    logSpy.mockRestore();
  }
});

beforeEach(() => {
  vi.mocked(runLog).mockResolvedValue(undefined);
  vi.mocked(runTimeline).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildProgram(): Command {
  const program = new Command();
  program
    .name("mex")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });

  program
    .command("log <message>")
    .description("Append a decision, note, risk, or todo to the mex event log")
    .option("--type <type>", "Event type: decision, note, risk, todo", "note")
    .option("--file <path>", "Related file path (repeatable)", (value, prev: string[]) => [...prev, value], [])
    .action(async (message, opts) => {
      try {
        const { runLog } = await import("../src/events.js");
        await runLog(config, message, { kind: opts.type, files: opts.file });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  program
    .command("timeline")
    .description("Show recent mex event log entries")
    .option("--json", "Output events as JSON")
    .option("--since <date>", "Filter from YYYY-MM-DD or relative Nd, e.g. 30d")
    .option("--type <type>", "Filter by event type")
    .option("--limit <n>", "Maximum number of entries", parsePositiveIntArg)
    .action(async (opts) => {
      try {
        const { runTimeline } = await import("../src/events.js");
        await runTimeline(config, {
          json: opts.json,
          since: opts.since,
          kind: opts.type,
          limit: opts.limit,
        });
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  return program;
}

describe("CLI argument parsers", () => {
  it("parses non-negative integers", () => {
    expect(parseIntArg("0")).toBe(0);
    expect(parseIntArg("12")).toBe(12);
  });

  it("parses positive integers", () => {
    expect(parsePositiveIntArg("1")).toBe(1);
    expect(parsePositiveIntArg("12")).toBe(12);
  });

  it("rejects non-positive and non-numeric values for positive integers", () => {
    for (const value of ["0", "-1", "foo"]) {
      expect(() => parsePositiveIntArg(value)).toThrow(InvalidArgumentError);
    }
  });
});

describe("mex log parsing", () => {
  it("passes the default type through as note", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "log", "captured context"]);

    expect(runLog).toHaveBeenCalledWith(config, "captured context", {
      kind: "note",
      files: [],
    });
  });

  it("preserves repeated --file values", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "mex",
      "log",
      "tracked files",
      "--file",
      "src/cli.ts",
      "--file",
      "test/cli.test.ts",
      "--file",
      "README.md",
    ]);

    expect(runLog).toHaveBeenCalledWith(config, "tracked files", {
      kind: "note",
      files: ["src/cli.ts", "test/cli.test.ts", "README.md"],
    });
  });

  it("passes --type decision through as kind", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "log", "choose commander", "--type", "decision"]);

    expect(runLog).toHaveBeenCalledWith(config, "choose commander", {
      kind: "decision",
      files: [],
    });
  });

  it("reports invalid --type failures from the log handler", async () => {
    vi.mocked(runLog).mockRejectedValueOnce(
      new Error('Unknown event type "invalid". Use decision, note, risk, or todo.'),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);
    const program = buildProgram();

    await expect(
      program.parseAsync(["node", "mex", "log", "bad type", "--type", "invalid"]),
    ).rejects.toThrow("process.exit 1");

    expect(runLog).toHaveBeenCalledWith(config, "bad type", {
      kind: "invalid",
      files: [],
    });
    expect(errorSpy).toHaveBeenCalledWith('Unknown event type "invalid". Use decision, note, risk, or todo.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("mex timeline parsing", () => {
  it("parses --limit as an integer", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "timeline", "--limit", "5"]);

    expect(runTimeline).toHaveBeenCalledWith(config, {
      json: undefined,
      since: undefined,
      kind: undefined,
      limit: 5,
    });
  });

  it("rejects invalid --limit values", async () => {
    for (const value of ["0", "foo"]) {
      const program = buildProgram();
      await expect(program.parseAsync(["node", "mex", "timeline", "--limit", value])).rejects.toMatchObject({
        code: "commander.invalidArgument",
        message: expect.stringContaining(`argument '${value}' is invalid`),
      });
    }
  });

  it("maps --type onto the handler's `kind` option", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "mex",
      "timeline",
      "--json",
      "--since",
      "30d",
      "--type",
      "risk",
    ]);

    expect(runTimeline).toHaveBeenCalledWith(config, {
      json: true,
      since: "30d",
      kind: "risk",
      limit: undefined,
    });
  });
});

describe("built CLI main-module guard", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cliPath = join(repoRoot, "dist", "cli.js");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
  const yieldToVitestRpc = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeAll(async () => {
    // Vitest 3's fork worker RPC has a fixed 60-second response deadline. Give
    // its task update one turn before this synchronous production build blocks
    // the worker event loop.
    await yieldToVitestRpc();
    // Vitest sets NODE_ENV=test. The build must still select React's production
    // condition and must not leave a development Hub bundle in dist/.
    execSync("npm run build", {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: "pipe",
      // execSync blocks Vitest's hook timer, so bound the child build itself.
      timeout: 60_000,
    });
  }, 65_000);

  beforeEach(async () => {
    // The cases below intentionally use synchronous child processes to exercise
    // the real CLI boundary. Let Vitest acknowledge the pending task update
    // before each case starts blocking this worker again.
    await yieldToVitestRpc();
  });

  it("parses argv when invoked through a symlinked bin (npm/npx layout)", () => {
    const binDir = mkdtempSync(join(tmpdir(), "mex-bin-"));
    const symlinkedCli = join(binDir, "mex");
    try {
      symlinkSync(cliPath, symlinkedCli);
      const result = spawnSync(process.execPath, [symlinkedCli, "--version"], {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      expect(result.status).toBe(0);
      expect((result.stdout ?? "").trim()).toBe(pkg.version);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("emits one strict JSON error for malformed skills sync JSON arguments", () => {
    const project = mkdtempSync(join(tmpdir(), "mex-skills-sync-cli-invalid-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-skills-sync-cli-home-"));
    try {
      const result = spawnSync(
        process.execPath,
        [cliPath, "skills", "sync", "--json", "--tool", "invalid"],
        {
          cwd: project,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: userHome,
            MEX_TELEMETRY: "0",
            DO_NOT_TRACK: "1",
            NO_COLOR: "1",
          },
        },
      );
      const expected = {
        schemaVersion: 1,
        ok: false,
        error: {
          code: "SKILL_SYNC_FAILED",
          message: "The skills sync arguments are invalid. Review mex skills sync --help and retry.",
        },
      };

      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(`${JSON.stringify(expected)}\n`);
      expect(JSON.parse(result.stdout)).toEqual(expected);
      expect(readdirSync(project)).toEqual([]);
      expect(readdirSync(userHome)).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("emits the capability golden without writing project or global state", () => {
    const project = mkdtempSync(join(tmpdir(), "mex-capability-cli-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-capability-home-"));
    const projectSentinel = join(project, "sentinel.txt");
    const homeSentinel = join(userHome, "sentinel.txt");
    writeFileSync(projectSentinel, "project-before\n");
    writeFileSync(homeSentinel, "home-before\n");
    const projectEntries = readdirSync(project);
    const homeEntries = readdirSync(userHome);
    try {
      const result = spawnSync(process.execPath, [cliPath, "capabilities", "--json"], {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: userHome,
          MEX_TELEMETRY: "1",
          NO_COLOR: "1",
        },
      });
      const golden = JSON.parse(
        readFileSync(join(repoRoot, "test/fixtures/capabilities/not-git.json"), "utf8"),
      ) as unknown;

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(JSON.stringify(golden) + "\n");
      expect(result.stderr).toBe("");
      expect(readdirSync(project)).toEqual(projectEntries);
      expect(readdirSync(userHome)).toEqual(homeEntries);
      expect(readFileSync(projectSentinel, "utf8")).toBe("project-before\n");
      expect(readFileSync(homeSentinel, "utf8")).toBe("home-before\n");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("uses the capability problem envelope for malformed JSON invocations", () => {
    const project = mkdtempSync(join(tmpdir(), "mex-capability-cli-invalid-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-capability-invalid-home-"));
    try {
      for (const args of [
        ["capabilities", "--json", "unexpected"],
        ["capabilities", "--json", "--unknown"],
      ] as const) {
        const result = spawnSync(process.execPath, [cliPath, ...args], {
          cwd: project,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
        });
        expect(result.status, args.join(" ")).toBe(2);
        expect(result.stderr, args.join(" ")).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          schemaVersion: 1,
          ok: false,
          data: null,
          diagnostics: [],
          problem: {
            title: "Invalid capability command",
            status: 400,
            code: "INVALID_REQUEST",
            detail: "Use exactly: mex capabilities --json",
          },
        });
      }
      expect(readdirSync(project)).toEqual([]);
      expect(readdirSync(userHome)).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("resolves Inbox contracts before repository readiness with structured parse failures", () => {
    const project = mkdtempSync(join(tmpdir(), "mex-inbox-contract-cli-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-inbox-contract-home-"));
    try {
      const projectBefore = snapshotProcessTree(project);
      const homeBefore = snapshotProcessTree(userHome);
      const environment = {
        ...process.env,
        HOME: userHome,
        MEX_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      };
      const resolved = spawnSync(
        process.execPath,
        [cliPath, "inbox", "contract", "--json"],
        { cwd: project, encoding: "utf8", env: environment },
      );
      expect(resolved.status, resolved.stderr).toBe(0);
      expect(Buffer.byteLength(resolved.stdout, "utf8")).toBeLessThanOrEqual(65_536);
      const catalogEnvelope = JSON.parse(resolved.stdout) as any;
      expect(catalogEnvelope).toMatchObject({
        schemaVersion: 1,
        command: "inbox.contract",
        mode: "read",
        ok: true,
        data: {
          catalogVersion: 1,
          contractId: "team.inbox.contract-catalog.v1",
          requestFile: { schemaRef: "https://mex.dev/contracts/team-inbox-request-v1.json", examples: [{}, {}] },
          applyFile: { schemaRef: "https://mex.dev/contracts/team-inbox-preview-envelope-v1.json" },
        },
      });
      const focused = spawnSync(
        process.execPath,
        [cliPath, "inbox", "contract", "--action", "inbox.draft.save", "--json"],
        { cwd: project, encoding: "utf8", env: environment },
      );
      expect(focused.status, focused.stderr).toBe(0);
      expect(Buffer.byteLength(focused.stdout, "utf8")).toBeLessThanOrEqual(32 * 1024);
      expect(Buffer.byteLength(focused.stdout, "utf8"))
        .toBeLessThan(Buffer.byteLength(resolved.stdout, "utf8"));
      expect(JSON.parse(focused.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "inbox.contract",
        mode: "read",
        ok: true,
        data: {
          action: "inbox.draft.save",
          commands: {
            preview: { usage: "mex inbox draft save <request-file> --json" },
            apply: { usage: "mex inbox draft save --apply <preview-envelope> --json" },
          },
          requestFile: { schema: { $defs: expect.any(Object) } },
        },
      });
      const focusedData = JSON.parse(focused.stdout).data;
      expect(focusedData).not.toHaveProperty("catalog");
      expect(JSON.stringify(focusedData.requestFile.schema)).not.toContain("previewEnvelope");
      expect(snapshotProcessTree(project)).toEqual(projectBefore);
      expect(snapshotProcessTree(userHome)).toEqual(homeBefore);

      for (const args of [
        ["inbox", "contract", "--json", "unexpected"],
        ["inbox", "contract", "--json", "--unknown"],
        ["inbox", "contract", "--action", "inbox.not-real", "--json"],
      ] as const) {
        const malformed = spawnSync(process.execPath, [cliPath, ...args], {
          cwd: project,
          encoding: "utf8",
          env: environment,
        });
        expect(malformed.status, args.join(" ")).toBe(2);
        expect(malformed.stderr, args.join(" ")).toBe("");
        expect(JSON.parse(malformed.stdout)).toMatchObject({
          schemaVersion: 1,
          command: "inbox.contract",
          mode: "read",
          ok: false,
          problem: { code: "INVALID_REQUEST" },
        });
      }
      expect(snapshotProcessTree(project)).toEqual(projectBefore);
      expect(snapshotProcessTree(userHome)).toEqual(homeBefore);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("resolves the complete Relay contract before repository readiness", () => {
    const project = mkdtempSync(join(tmpdir(), "mex-relay-contract-cli-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-relay-contract-home-"));
    try {
      const beforeProject = snapshotProcessTree(project);
      const beforeHome = snapshotProcessTree(userHome);
      const environment = {
        ...process.env,
        HOME: userHome,
        MEX_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      };
      const resolved = spawnSync(
        process.execPath,
        [cliPath, "relay", "contract", "--json"],
        { cwd: project, encoding: "utf8", env: environment },
      );
      expect(resolved.status, resolved.stderr).toBe(0);
      expect(Buffer.byteLength(resolved.stdout, "utf8")).toBeLessThanOrEqual(65_536);
      const catalogEnvelope = JSON.parse(resolved.stdout);
      expect(catalogEnvelope).toMatchObject({
        schemaVersion: 1,
        command: "relay.contract",
        mode: "read",
        ok: true,
        data: {
          contractId: "team.relay.contract-catalog.v1",
          requestFile: {
            schemaRef: "https://mex.dev/contracts/team-relay-request-v1.json",
            maxRecipients: 32,
          },
          applyFile: {
            schemaRef: "https://mex.dev/contracts/team-relay-preview-envelope-v1.json",
          },
        },
      });
      const examples = catalogEnvelope.data.requestFile.examples as any[];
      expect(Object.keys(examples[0].request.action.draft).sort())
        .toEqual(["recipients", "summary"]);
      const evidence = examples.flatMap((example) => example.request.action?.draft?.evidence ?? []);
      expect(evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "commit" }),
        expect.objectContaining({ kind: "external" }),
      ]));
      const focused = spawnSync(
        process.execPath,
        [cliPath, "relay", "contract", "--action", "relay.draft.save", "--json"],
        { cwd: project, encoding: "utf8", env: environment },
      );
      expect(focused.status, focused.stderr).toBe(0);
      expect(Buffer.byteLength(focused.stdout, "utf8")).toBeLessThanOrEqual(32 * 1024);
      expect(Buffer.byteLength(focused.stdout, "utf8"))
        .toBeLessThan(Buffer.byteLength(resolved.stdout, "utf8"));
      expect(JSON.parse(focused.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "relay.contract",
        mode: "read",
        ok: true,
        data: {
          action: "relay.draft.save",
          commands: {
            preview: { usage: "mex relay draft save <request-file> --json" },
            apply: { usage: "mex relay draft save --apply <preview-envelope> --json" },
          },
          requestFile: { schema: { $defs: expect.any(Object) } },
        },
      });
      const focusedData = JSON.parse(focused.stdout).data;
      expect(focusedData).not.toHaveProperty("catalog");
      expect(JSON.stringify(focusedData.requestFile.schema)).not.toContain("previewEnvelope");
      expect(snapshotProcessTree(project)).toEqual(beforeProject);
      expect(snapshotProcessTree(userHome)).toEqual(beforeHome);

      const malformed = spawnSync(
        process.execPath,
        [cliPath, "relay", "contract", "--json", "unexpected"],
        { cwd: project, encoding: "utf8", env: environment },
      );
      expect(malformed.status).toBe(2);
      expect(malformed.stderr).toBe("");
      expect(JSON.parse(malformed.stdout)).toMatchObject({
        command: "relay.contract",
        mode: "read",
        ok: false,
        problem: { code: "INVALID_REQUEST" },
      });

      const invalidSelector = spawnSync(
        process.execPath,
        [cliPath, "relay", "contract", "--action", "relay.not-real", "--json"],
        { cwd: project, encoding: "utf8", env: environment },
      );
      expect(invalidSelector.status).toBe(2);
      expect(invalidSelector.stderr).toBe("");
      expect(JSON.parse(invalidSelector.stdout)).toMatchObject({
        command: "relay.contract",
        mode: "read",
        ok: false,
        problem: { code: "INVALID_REQUEST" },
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("keeps the Relay draft ID process boundary aligned with local storage", () => {
    const project = mkdtempSync(join(tmpdir(), "mex-relay-id-cli-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-relay-id-home-"));
    try {
      const environment = {
        ...process.env,
        HOME: userHome,
        MEX_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      };
      const acceptedId = `d${"a".repeat(127)}`;
      const accepted = spawnSync(
        process.execPath,
        [cliPath, "relay", "draft", "show", acceptedId, "--json"],
        { cwd: project, encoding: "utf8", env: environment },
      );
      expect(accepted.status, accepted.stderr).toBe(3);
      expect(accepted.stderr).toBe("");
      expect(JSON.parse(accepted.stdout)).toMatchObject({
        command: "relay.draft.show",
        mode: "read",
        ok: false,
        problem: { code: "NOT_FOUND" },
      });

      const rejected = spawnSync(
        process.execPath,
        [cliPath, "relay", "draft", "show", `${acceptedId}a`, "--json"],
        { cwd: project, encoding: "utf8", env: environment },
      );
      expect(rejected.status, rejected.stderr).toBe(2);
      expect(rejected.stderr).toBe("");
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        command: "relay.draft.show",
        mode: "read",
        ok: false,
        problem: { code: "INVALID_REQUEST" },
      });
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("round-trips sparse standalone Relay previews with bounded Git identity and WHATWG evidence", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-relay-local-cli-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-relay-local-home-"));
    const requestRoot = mkdtempSync(join(tmpdir(), "mex-relay-local-request-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(mexPath, { recursive: true });
      writeFileSync(join(fixture, ".gitignore"), ".mex/local/\n");
      writeFileSync(join(mexPath, "ROUTER.md"), "# Router\n");
      writeFileSync(join(mexPath, "config.json"), JSON.stringify({
        scaffold_id: "scaffold-relay-local-process-001",
      }));
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      execFileSync("git", ["config", "user.email", "not-an-email"], { cwd: fixture });
      const gitActorName = "Relay\u0085Agent";
      execFileSync("git", ["config", "user.name", gitActorName], { cwd: fixture });
      execFileSync("git", ["add", ".gitignore", ".mex/ROUTER.md", ".mex/config.json"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });
      const environment = {
        ...process.env,
        HOME: userHome,
        MEX_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      };
      const requestPath = join(requestRoot, "save.json");
      const externalUris = [
        "HTTPS://example.test/path",
        "http:example.test",
        "https://example.test/a b",
      ];
      writeFileSync(requestPath, JSON.stringify({
        operationId: "relay-local-process-001",
        action: {
          kind: "relay.draft.save",
          draft: {
            recipients: [{
              kind: "member",
              memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            }],
            summary: "Preserve the local Relay authority contract.",
            evidence: externalUris.map((uri) => ({ kind: "external", uri })),
          },
        },
        expectedRevisions: [],
      }));
      const preview = spawnSync(
        process.execPath,
        [cliPath, "relay", "draft", "save", requestPath, "--json"],
        { cwd: fixture, encoding: "utf8", env: environment },
      );
      expect(preview.status, preview.stderr).toBe(0);
      const envelope = JSON.parse(preview.stdout) as any;
      expect(envelope).toMatchObject({
        command: "relay.draft.save",
        mode: "preview",
        ok: true,
        data: {
          request: {
            action: {
              draft: {
                completed: [],
                inProgress: [],
                decisions: [],
                blockers: [],
                unresolvedQuestions: [],
                changedFiles: [],
                code: [],
                evidence: externalUris.map((uri) => ({ kind: "external", uri })),
                nextActions: [],
              },
            },
          },
          receipt: {
            authority: {
              actor: {
                kind: "git",
                name: gitActorName,
                email: "not-an-email",
              },
            },
          },
        },
      });
      expect(envelope.data.request.action.draft).not.toHaveProperty("workstream");

      const previewPath = join(requestRoot, "preview.json");
      writeFileSync(previewPath, preview.stdout);
      const applied = spawnSync(
        process.execPath,
        [cliPath, "relay", "draft", "save", `--apply=${previewPath}`, "--json"],
        { cwd: fixture, encoding: "utf8", env: environment },
      );
      expect(applied.status, applied.stderr).toBe(0);
      const appliedEnvelope = JSON.parse(applied.stdout) as any;
      expect(appliedEnvelope).toMatchObject({
        command: "relay.draft.save",
        mode: "apply",
        ok: true,
        data: { applied: true },
      });
      const createdDraftId = appliedEnvelope.data.localChanges[0]?.id;
      expect(typeof createdDraftId).toBe("string");
      const shown = spawnSync(
        process.execPath,
        [cliPath, "relay", "draft", "show", createdDraftId, "--json"],
        { cwd: fixture, encoding: "utf8", env: environment },
      );
      expect(shown.status, shown.stderr).toBe(0);
      expect(JSON.parse(shown.stdout)).toMatchObject({
        command: "relay.draft.show",
        mode: "read",
        ok: true,
        data: {
          id: createdDraftId,
          input: {
            recipients: [{ memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV" }],
            summary: "Preserve the local Relay authority contract.",
            completed: [],
            inProgress: [],
            decisions: [],
            blockers: [],
            unresolvedQuestions: [],
            changedFiles: [],
            code: [],
            evidence: externalUris.map((uri) => ({ kind: "external", uri })),
            nextActions: [],
          },
        },
      });
      expect(JSON.parse(shown.stdout).data.input).not.toHaveProperty("workstream");

      const legacyRequestPath = join(requestRoot, "legacy-save.json");
      writeFileSync(legacyRequestPath, JSON.stringify({
        operationId: "relay-legacy-local-process-001",
        action: {
          kind: "relay.draft.save",
          draft: {
            recipients: [{
              kind: "member",
              memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            }],
            workstream: {
              id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV",
              kind: "workstream",
              title: "Legacy Relay lane",
            },
            summary: "Translate the pre-change local Relay request.",
            completed: [],
            inProgress: [],
            decisions: [],
            blockers: [],
            unresolvedQuestions: [],
            changedFiles: [],
            code: [],
            evidence: [{ kind: "manual", note: "Preserve this context" }],
            nextActions: [],
          },
        },
        expectedRevisions: [],
      }));
      const translated = spawnSync(
        process.execPath,
        [cliPath, "relay", "draft", "save", legacyRequestPath, "--json"],
        { cwd: fixture, encoding: "utf8", env: environment },
      );
      expect(translated.status, translated.stderr).toBe(0);
      const translatedDraft = JSON.parse(translated.stdout).data.request.action.draft;
      expect(translatedDraft).not.toHaveProperty("workstream");
      expect(translatedDraft.evidence).toEqual([
        {
          kind: "entity",
          entity: {
            id: "ws_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            kind: "workstream",
            title: "Legacy Relay lane",
          },
        },
        { kind: "manual", note: "Preserve this context" },
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
      rmSync(requestRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it("fails closed when a real signed Relay preview cannot fit the saved CLI wrapper", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-relay-wrapper-cli-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-relay-wrapper-home-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(mexPath, { recursive: true });
      writeFileSync(join(fixture, ".gitignore"), ".mex/local/\n");
      writeFileSync(join(mexPath, "ROUTER.md"), "# Router\n");
      writeFileSync(join(mexPath, "config.json"), JSON.stringify({
        scaffold_id: "scaffold-relay-wrapper-process-001",
      }));
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      execFileSync("git", ["config", "user.email", "wrapper@example.test"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "Relay Wrapper"], { cwd: fixture });
      execFileSync("git", ["add", ".gitignore", ".mex/ROUTER.md", ".mex/config.json"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });

      const request = {
        operationId: "relay-wrapper-boundary-001",
        action: {
          kind: "relay.draft.save" as const,
          draft: {
            recipients: [{
              kind: "member" as const,
              memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            }],
            summary: "s".repeat(8_192),
            completed: Array.from({ length: 12 }, (_, index) =>
              `${String(index).padStart(2, "0")}:${"c".repeat(4_093)}`),
            inProgress: [`p${"x".repeat(4_095)}`],
            decisions: [],
            blockers: [`b${"y".repeat(2_687)}`],
            unresolvedQuestions: [],
            changedFiles: [],
            code: [],
            evidence: [],
            nextActions: [],
          },
        },
        expectedRevisions: [],
      };
      const requestPath = join(fixture, "relay-wrapper-request.json");
      const requestJson = JSON.stringify(request);
      expect(Buffer.byteLength(requestJson, "utf8")).toBeLessThanOrEqual(65_536);
      writeFileSync(requestPath, requestJson);

      const { createRepositoryTeamWorkflowPort } = await import(
        "../src/team/workflow/repository-team-workflow-port.js"
      );
      const { boundedRelayJson } = await import("../src/team/relay/handoff.js");
      const { renderTeamEnvelope, teamEnvelope } = await import("../src/team/cli/envelope.js");
      const service = await createRepositoryTeamWorkflowPort(fixture);
      const inner = await service.previewRelay(request);
      expect(Buffer.byteLength(boundedRelayJson(inner), "utf8")).toBeLessThanOrEqual(65_536);
      const outer = teamEnvelope({
        command: "relay.draft.save",
        mode: "preview",
        data: inner,
        diagnostics: inner.preview.diagnostics,
        valid: inner.preview.valid,
      });
      expect(Buffer.byteLength(renderTeamEnvelope(outer), "utf8") + 1).toBeGreaterThan(65_536);

      const result = spawnSync(
        process.execPath,
        [cliPath, "relay", "draft", "save", requestPath, "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: userHome,
            MEX_TELEMETRY: "0",
            DO_NOT_TRACK: "1",
            NO_COLOR: "1",
          },
        },
      );
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.stdout.endsWith("\n")).toBe(true);
      expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(65_536);
      expect(JSON.parse(result.stdout)).toMatchObject({
        command: "relay.draft.save",
        mode: "preview",
        ok: false,
        data: null,
        problem: {
          code: "VALIDATION_FAILED",
          title: "Relay preview exceeds CLI envelope limit",
        },
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  }, 40_000);

  it("does not auto-parse when dist/cli.js is imported as a module", () => {
    const result = spawnSync(
      process.execPath,
      ["-e", "import('./dist/cli.js').then(() => console.log('imported'))"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("imported");
    expect(result.stdout).not.toContain(pkg.version);
  });

  it("backfills scaffold_id on an existing scaffold when a command loads config", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-migrate-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(mexPath, { recursive: true });
      writeFileSync(join(mexPath, "ROUTER.md"), "");
      writeFileSync(join(mexPath, "config.json"), JSON.stringify({ aiTools: ["claude"] }));

      // timeline reads config (via loadConfig) and returns [] on an empty log.
      const result = spawnSync(process.execPath, [cliPath, "timeline", "--json"], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      expect(result.status).toBe(0);

      const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf8")) as {
        aiTools: string[];
        scaffold_id?: string;
      };
      expect(raw.scaffold_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(raw.aiTools).toEqual(["claude"]); // existing keys preserved
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 10_000);

  it("keeps every advertised Wiki read and preview from minting scaffold identity", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-wiki-readonly-config-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-wiki-readonly-home-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(join(fixture, ".git"));
      mkdirSync(mexPath);
      const routerPath = join(mexPath, "ROUTER.md");
      const routerBytes = "# Router\n";
      writeFileSync(routerPath, routerBytes);
      const configPath = join(mexPath, "config.json");
      const configBytes = JSON.stringify({ aiTools: ["claude"], wiki: { exclude: ["private/**"] } });
      writeFileSync(configPath, configBytes);
      const operationPath = join(fixture, "operation.json");
      const operationBytes = "{}\n";
      writeFileSync(operationPath, operationBytes);
      const mexEntriesBefore = readdirSync(mexPath).sort();
      const homeEntriesBefore = readdirSync(userHome).sort();

      const invocations = [
        ["wiki", "list", "--json"],
        ["wiki", "show", "missing", "--json"],
        ["wiki", "query", "missing", "--json"],
        ["wiki", "related", "missing", "--json"],
        ["wiki", "backlinks", "missing", "--json"],
        ["wiki", "validate", "--json"],
        ["wiki", "graph", "--json"],
        ["wiki", "for-code", "missing", "--json"],
        ["wiki", "apply", operationPath, "--json"],
        ["wiki", "regenerate-views", "--dry-run", "--json"],
        ["wiki", "migrate", "--dry-run", "--json"],
      ] as const;

      for (const args of invocations) {
        const result = spawnSync(process.execPath, [cliPath, ...args], {
          cwd: fixture,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: userHome,
            MEX_TELEMETRY: "0",
            DO_NOT_TRACK: "1",
            NO_COLOR: "1",
          },
        });
        expect(result.error, args.join(" ")).toBeUndefined();
      }

      expect(readFileSync(configPath, "utf8")).toBe(configBytes);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).not.toHaveProperty("scaffold_id");
      expect(readFileSync(routerPath, "utf8")).toBe(routerBytes);
      expect(readFileSync(operationPath, "utf8")).toBe(operationBytes);
      expect(readdirSync(mexPath).sort()).toEqual(mexEntriesBefore);
      expect(readdirSync(userHome).sort()).toEqual(homeEntriesBefore);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  }, 40_000);

  it("keeps advertised grounded Spec reads available when only Team config attestation changes", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-spec-cli-config-drift-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-spec-cli-config-home-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(join(mexPath, "context"), { recursive: true });
      mkdirSync(join(fixture, "src"), { recursive: true });
      writeFileSync(join(fixture, ".gitignore"), ".mex/*.db*\n.mex/local/\n");
      writeFileSync(
        join(fixture, "src", "release-spec.ts"),
        "export function releaseSpecTarget(): string { return 'ready'; }\n",
      );
      writeFileSync(join(mexPath, "ROUTER.md"), "# Router\n");
      const configPath = join(mexPath, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        scaffold_id: "scaffold-spec-config-drift-001",
        scaffold_name: "Spec fixture",
      })}\n`);
      const specId = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
      writeFileSync(join(mexPath, "context", "release-spec.md"), `<!-- mex:entity
id: ${specId}
type: spec
status: promoted
revision: 1
title: Release Spec
-->
# Release Spec

Canonical read-only release requirements.
`);
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      execFileSync("git", ["config", "user.email", "spec-cli@example.invalid"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "Spec CLI Contract"], { cwd: fixture });
      execFileSync("git", ["add", ".gitignore", ".mex", "src"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });

      const graph = createRepositoryGraphPort(fixture);
      await graph.rebuild();
      const symbol = (await graph.searchNodes({ query: "releaseSpecTarget", limit: 10 }))
        .items.find((item) => item.name === "releaseSpecTarget");
      if (symbol === undefined) throw new Error("Expected the Spec CLI fixture symbol.");
      const grounding = await graph.withFreshGroundingSnapshot((snapshot) => ({
        node: snapshot.getNode(symbol.ref.symbolId),
        fingerprint: snapshot.getFingerprint(symbol.ref.symbolId),
      }));
      if (grounding.node == null || grounding.fingerprint == null) {
        throw new Error("Expected exact grounding facts for the Spec CLI fixture.");
      }
      writeFileSync(join(mexPath, "context", "release-spec.md"), `<!-- mex:entity
id: ${specId}
type: spec
status: promoted
revision: 1
title: Release Spec
grounds_to:
  - node: ${JSON.stringify(symbol.ref.symbolId)}
    fingerprint: ${JSON.stringify(grounding.fingerprint)}
    bodyHash: ${JSON.stringify(grounding.node.bodyHash)}
    reason: Exact Spec CLI grounding.
-->
# Release Spec

Canonical read-only release requirements.
`);
      execFileSync("git", ["add", ".mex/context/release-spec.md"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "ground spec fixture"], { cwd: fixture });
      await graph.rebuild();

      const rebuilt = spawnSync(
        process.execPath,
        [cliPath, "wiki", "rebuild-index", "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "0", NO_COLOR: "1" },
        },
      );
      expect(rebuilt.status, rebuilt.stderr).toBe(0);
      writeFileSync(configPath, `${JSON.stringify({
        scaffold_id: "scaffold-spec-config-drift-001",
        scaffold_name: "Locally renamed Spec fixture",
      })}\n`);

      const capabilityResult = spawnSync(
        process.execPath,
        [cliPath, "capabilities", "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "0", NO_COLOR: "1" },
        },
      );
      expect(capabilityResult.status, capabilityResult.stderr).toBe(0);
      const capabilities = JSON.parse(capabilityResult.stdout) as {
        data: { capabilities: Array<{ id: string; availability: string }> };
      };
      expect(capabilities.data.capabilities.find((entry) => entry.id === "spec_read"))
        .toMatchObject({ availability: "available" });
      expect(capabilities.data.capabilities.find((entry) => entry.id === "team_workstreams"))
        .toMatchObject({ availability: "unavailable" });

      const listed = spawnSync(
        process.execPath,
        [cliPath, "spec", "list", "--grounding", "fresh", "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "0", NO_COLOR: "1" },
        },
      );
      expect(listed.status, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "spec.list",
        ok: true,
        data: {
          availability: "ready",
          page: { items: [{ id: specId, groundingHealth: "fresh" }] },
        },
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  }, 40_000);

  it("runs the nested Inbox command tree with read-only discovery and exact --apply= envelopes", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-inbox-cli-process-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-inbox-cli-home-"));
    const requestRoot = mkdtempSync(join(tmpdir(), "mex-inbox-cli-request-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(mexPath, { recursive: true });
      writeFileSync(join(fixture, ".gitignore"), ".mex/local/\n");
      writeFileSync(join(mexPath, "ROUTER.md"), "# Router\n");
      writeFileSync(join(mexPath, "config.json"), JSON.stringify({
        scaffold_id: "scaffold-inbox-cli-process-001",
      }));
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      execFileSync("git", ["config", "user.email", "local-identity"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "Inbox CLI Contract"], { cwd: fixture });
      execFileSync("git", ["add", ".gitignore", ".mex/ROUTER.md", ".mex/config.json"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });
      const environment = {
        ...process.env,
        HOME: userHome,
        MEX_TELEMETRY: "0",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
      };
      const run = (args: readonly string[]) => spawnSync(process.execPath, [cliPath, ...args], {
        cwd: fixture,
        encoding: "utf8",
        env: environment,
      });

      const projectBeforeReads = snapshotProcessTree(fixture);
      const homeBeforeReads = snapshotProcessTree(userHome);
      for (const args of [
        ["inbox", "draft", "list", "--json"],
        ["inbox", "proposal", "list", "--state", "pending", "--json"],
      ] as const) {
        const result = run(args);
        expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, ok: true, mode: "read" });
      }
      expect(snapshotProcessTree(fixture)).toEqual(projectBeforeReads);
      expect(snapshotProcessTree(userHome)).toEqual(homeBeforeReads);

      const invalidId = run(["inbox", "draft", "show", "nested/draft", "--json"]);
      expect(invalidId.status).toBe(2);
      expect(JSON.parse(invalidId.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "inbox.draft.show",
        mode: "read",
        ok: false,
        problem: { code: "INVALID_REQUEST" },
      });

      const malformedPath = join(requestRoot, "malformed.json");
      writeFileSync(malformedPath, "{ not JSON", "utf8");
      const malformed = run(["inbox", "draft", "save", malformedPath, "--json"]);
      expect(malformed.status).toBe(2);
      expect(JSON.parse(malformed.stdout)).toMatchObject({
        command: "inbox.draft.save",
        mode: "preview",
        ok: false,
        problem: { code: "INVALID_REQUEST" },
      });

      const requestPath = join(requestRoot, "save.json");
      const saveRequest = {
        operationId: "inbox-draft-save-process-001",
        action: {
          kind: "inbox.draft.save",
          draft: {
            change: {
              kind: "spec.create",
              entityKind: "spec",
              title: "Release contract",
              body: "Reviewed scope for the process-level command test.",
              status: "in_flight",
            },
            rationale: "Review this exact scope.",
            evidence: [],
            targetRevisions: [],
          },
        },
        expectedRevisions: [],
      };
      const beforeInvalidEvidence = snapshotProcessTree(fixture);
      // Exhaustive evidence and string-shape matrices live in the direct
      // command/capability contract suites. Keep a representative process-level
      // rejection here so this smoke test exercises the built CLI boundary
      // without synchronously launching a separate Node process per schema leaf.
      const invalidEvidenceRequest = structuredClone(saveRequest) as any;
      invalidEvidenceRequest.action.draft.evidence = [{ kind: "manual", note: 42 }];
      const invalidEvidencePath = join(requestRoot, "invalid-evidence-manual-number.json");
      writeFileSync(invalidEvidencePath, JSON.stringify(invalidEvidenceRequest), "utf8");
      const invalidEvidence = run(["inbox", "draft", "save", invalidEvidencePath, "--json"]);
      expect(invalidEvidence.status, invalidEvidence.stderr).toBe(2);
      expect(JSON.parse(invalidEvidence.stdout)).toMatchObject({
        command: "inbox.draft.save", mode: "preview", ok: false,
        problem: { code: "INVALID_REQUEST" },
      });

      const unsafeRevisionRequest = structuredClone(saveRequest) as any;
      unsafeRevisionRequest.action.draft.change.topics = ["mx_01ARZ3NDEKTSV4RRFFQ69G5FAV"];
      unsafeRevisionRequest.action.draft.targetRevisions = [{
        target: { kind: "entity", id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        revision: "a".repeat(64),
        semanticRevision: 9_007_199_254_740_992,
      }];
      const unsafeRevisionPath = join(requestRoot, "invalid-request-unsafe-semantic-revision.json");
      writeFileSync(unsafeRevisionPath, JSON.stringify(unsafeRevisionRequest), "utf8");
      const unsafeRevision = run(["inbox", "draft", "save", unsafeRevisionPath, "--json"]);
      expect(unsafeRevision.status, unsafeRevision.stderr).toBe(2);
      expect(JSON.parse(unsafeRevision.stdout)).toMatchObject({
        command: "inbox.draft.save", mode: "preview", ok: false,
        problem: { code: "INVALID_REQUEST" },
      });
      const repairWithInvalidEvidence = {
        operationId: "inbox-repair-invalid-evidence-process-001",
        action: {
          kind: "inbox.repair",
          proposalId: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          replacement: {
            ...saveRequest.action.draft,
            evidence: [{ kind: "manual", note: 42 }],
          },
        },
        expectedRevisions: [{
          target: { kind: "artifact", path: ".mex/inbox/proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV.md" },
          revision: "a".repeat(64),
        }],
      };
      const invalidRepairPath = join(requestRoot, "invalid-repair-evidence.json");
      writeFileSync(invalidRepairPath, JSON.stringify(repairWithInvalidEvidence), "utf8");
      const invalidRepair = run(["inbox", "proposal", "repair", invalidRepairPath, "--json"]);
      expect(invalidRepair.status, invalidRepair.stderr).toBe(2);
      expect(JSON.parse(invalidRepair.stdout)).toMatchObject({
        command: "inbox.proposal.repair", mode: "preview", ok: false,
        problem: { code: "INVALID_REQUEST" },
      });
      expect(snapshotProcessTree(fixture)).toEqual(beforeInvalidEvidence);

      writeFileSync(requestPath, JSON.stringify(saveRequest), "utf8");
      const preview = run(["inbox", "draft", "save", requestPath, "--json"]);
      expect(preview.status, preview.stderr).toBe(0);
      const previewEnvelope = JSON.parse(preview.stdout) as any;
      expect(previewEnvelope).toMatchObject({
        schemaVersion: 1,
        command: "inbox.draft.save",
        mode: "preview",
        ok: true,
      });
      expect(previewEnvelope.data.receipt.authority.actor).toEqual({
        kind: "git", name: "Inbox CLI Contract", email: "local-identity",
      });
      const draftId = previewEnvelope.data.receipt.purposeIds
        .find((entry) => entry.purpose === "inbox-draft")?.id;
      expect(draftId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
      const previewPath = join(requestRoot, "preview.json");
      writeFileSync(previewPath, preview.stdout, "utf8");

      const expectInvalidApply = (
        candidate: unknown,
        name: string,
        args: readonly string[] = ["inbox", "draft", "save"],
      ): void => {
        const path = join(requestRoot, `invalid-apply-${name}.json`);
        writeFileSync(path, JSON.stringify(candidate), "utf8");
        const result = run([...args, `--apply=${path}`, "--json"]);
        expect(result.status, `${name}\n${result.stderr}`).toBe(2);
        expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, problem: { code: "INVALID_REQUEST" } });
      };
      const validDiagnostic = {
        code: "INBOX_TEST",
        severity: "warning",
        message: "Review the target.",
        path: "specs/release.md",
        location: { path: "specs/release.md", startLine: 1 },
        entity: { id: "mx_01ARZ3NDEKTSV4RRFFQ69G5FAV", kind: "spec" },
        remediation: [{ label: "Inspect", command: "mex inbox draft list --json" }],
        detail: { safe: true },
      };
      const invalidDiagnostic = { ...validDiagnostic, detail: [] };
      const diagnosticCandidate = structuredClone(previewEnvelope);
      diagnosticCandidate.diagnostics = [invalidDiagnostic];
      diagnosticCandidate.data.preview.diagnostics = [invalidDiagnostic];
      expectInvalidApply(diagnosticCandidate, "diagnostic-detail");
      const invalidTimestamp = structuredClone(previewEnvelope);
      invalidTimestamp.data.receipt.authority.occurredAt = "2026-99-99T00:00:00.000Z";
      expectInvalidApply(invalidTimestamp, "timestamp");
      const missingPurpose = structuredClone(previewEnvelope);
      missingPurpose.data.receipt.purposeIds = [];
      expectInvalidApply(missingPurpose, "purpose-missing");

      const applied = run(["inbox", "draft", "save", `--apply=${previewPath}`, "--json"]);
      expect(applied.status, applied.stderr).toBe(0);
      expect(JSON.parse(applied.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "inbox.draft.save",
        mode: "apply",
        ok: true,
        data: { applied: true },
      });

      const listed = run(["inbox", "draft", "list", "--limit", "1", "--json"]);
      expect(listed.status, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        command: "inbox.draft.list",
        mode: "read",
        ok: true,
        data: { items: [{ id: draftId }] },
      });
      const shown = run(["inbox", "draft", "show", draftId!, "--json"]);
      expect(shown.status, shown.stderr).toBe(0);
      const shownEnvelope = JSON.parse(shown.stdout) as any;
      expect(shownEnvelope).toMatchObject({
        command: "inbox.draft.show",
        mode: "read",
        ok: true,
        data: { id: draftId, input: { rationale: "Review this exact scope." } },
      });

      const publishRequest = {
        operationId: "inbox-publish-process-001",
        action: { kind: "inbox.publish", draftId },
        expectedRevisions: [{
          target: { kind: "local", namespace: "inbox-draft", id: draftId },
          revision: shownEnvelope.data.revision,
        }],
      };
      const publishEnvelope = structuredClone(previewEnvelope);
      publishEnvelope.command = "inbox.publish";
      publishEnvelope.data.request = publishRequest;
      publishEnvelope.data.receipt.purposeIds = [
        { purpose: "activity", id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
        { purpose: "proposal", id: "proposal_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      ];
      publishEnvelope.data.receipt.purposeIds.reverse();
      expectInvalidApply(publishEnvelope, "publish-purpose-reversed", ["inbox", "publish"]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
      rmSync(requestRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it("keeps Team reads immutable and provisions only the signed preview key", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-team-cli-process-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-team-cli-home-"));
    const requestRoot = mkdtempSync(join(tmpdir(), "mex-team-cli-request-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(mexPath);
      writeFileSync(join(mexPath, "ROUTER.md"), "# Router\n");
      writeFileSync(join(mexPath, "config.json"), JSON.stringify({
        scaffold_id: "scaffold-team-cli-process-001",
      }));
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      execFileSync("git", ["config", "user.email", "team-cli@example.invalid"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "Team CLI Contract"], { cwd: fixture });
      execFileSync("git", ["add", ".mex/ROUTER.md", ".mex/config.json"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });

      const projectBefore = snapshotProcessTree(fixture);
      const homeBefore = snapshotProcessTree(userHome);
      for (const args of [
        ["member", "list", "--json"],
        ["member", "current", "--json"],
        ["activity", "list", "--json"],
      ] as const) {
        const result = spawnSync(process.execPath, [cliPath, ...args], {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
        });
        expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, ok: true });
      }
      expect(snapshotProcessTree(fixture)).toEqual(projectBefore);
      expect(snapshotProcessTree(userHome)).toEqual(homeBefore);

      const requestPath = join(requestRoot, "activity-record.json");
      writeFileSync(requestPath, JSON.stringify({
        operationId: "activity-record-process-001",
        action: {
          kind: "activity.record",
          activity: {
            action: "review.completed",
            subjects: [{ kind: "file", path: "src/index.ts" }],
          },
        },
        expectedRevisions: [],
      }));
      const preview = spawnSync(
        process.execPath,
        [cliPath, "activity", "record", requestPath, "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
        },
      );
      expect(preview.status, preview.stderr).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "activity.record",
        mode: "preview",
        ok: true,
      });
      expect(readdirSync(join(mexPath, "local"))).toEqual([
        "identity-activity-signing.key",
      ]);
      expect(snapshotProcessTree(userHome)).toEqual(homeBefore);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
      rmSync(requestRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it("uses the Team JSON envelope for parser and repository-readiness failures", () => {
    const outsideRepository = mkdtempSync(join(tmpdir(), "mex-team-cli-no-repo-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-team-cli-problem-home-"));
    try {
      const cases = [
        {
          args: ["member", "show", "--json"],
          command: "member.show",
          mode: "read",
        },
        {
          args: ["member", "unknown", "--json"],
          command: "member",
          mode: "read",
        },
        {
          args: ["activity", "record", "--apply", "--json"],
          command: "activity.record",
          mode: "apply",
        },
        {
          args: ["member", "add", "--apply=preview.json", "--unknown", "--json"],
          command: "member.add",
          mode: "apply",
        },
        {
          args: ["relay", "show", "--json"],
          command: "relay.show",
          mode: "read",
        },
        {
          args: ["relay", "close", "--apply", "--json"],
          command: "relay.close",
          mode: "apply",
        },
      ] as const;

      for (const testCase of cases) {
        const result = spawnSync(process.execPath, [cliPath, ...testCase.args], {
          cwd: outsideRepository,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
        });
        expect(result.status, testCase.args.join(" ")).toBe(2);
        expect(result.stderr, testCase.args.join(" ")).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          command: testCase.command,
          data: null,
          diagnostics: [],
          mode: testCase.mode,
          ok: false,
          problem: {
            code: "INVALID_REQUEST",
            detail: "The Team command arguments are invalid. Review the command help and retry.",
            status: 400,
            title: "Invalid Team command request",
          },
          schemaVersion: 1,
        });
      }

      const unavailable = spawnSync(process.execPath, [cliPath, "member", "list", "--json"], {
        cwd: outsideRepository,
        encoding: "utf8",
        env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
      });
      expect(unavailable.status).toBe(3);
      expect(unavailable.stderr).toBe("");
      expect(JSON.parse(unavailable.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "member.list",
        mode: "read",
        ok: false,
        problem: { code: "NOT_FOUND" },
      });
      expect(readdirSync(outsideRepository)).toEqual([]);
      expect(readdirSync(userHome)).toEqual([]);
    } finally {
      rmSync(outsideRepository, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("rejects unsafe or oversized Team config without following or initializing it", () => {
    const userHome = mkdtempSync(join(tmpdir(), "mex-team-cli-config-home-"));
    const outside = mkdtempSync(join(tmpdir(), "mex-team-cli-config-outside-"));
    const outsideConfig = join(outside, "config.json");
    writeFileSync(outsideConfig, JSON.stringify({ scaffold_id: "outside-secret" }));
    try {
      for (const fixtureKind of ["symlink", "oversized"] as const) {
        const fixture = mkdtempSync(join(tmpdir(), `mex-team-cli-${fixtureKind}-`));
        try {
          mkdirSync(join(fixture, ".git"));
          mkdirSync(join(fixture, ".mex"));
          writeFileSync(join(fixture, ".mex", "ROUTER.md"), "# Router\n");
          const configPath = join(fixture, ".mex", "config.json");
          if (fixtureKind === "symlink") {
            symlinkSync(outsideConfig, configPath);
          } else {
            writeFileSync(configPath, JSON.stringify({
              scaffold_id: `scaffold-${"x".repeat(70 * 1024)}`,
            }));
          }
          const before = snapshotProcessTree(fixture);
          const result = spawnSync(process.execPath, [cliPath, "activity", "list", "--json"], {
            cwd: fixture,
            encoding: "utf8",
            env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
          });
          expect(result.status).toBe(fixtureKind === "symlink" ? 5 : 1);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toMatchObject({
            schemaVersion: 1,
            command: "activity.list",
            mode: "read",
            ok: false,
            problem: {
              code: fixtureKind === "symlink" ? "PATH_OUTSIDE_PROJECT" : "VALIDATION_FAILED",
            },
          });
          expect(snapshotProcessTree(fixture)).toEqual(before);
          expect(readFileSync(outsideConfig, "utf8")).toBe(
            JSON.stringify({ scaffold_id: "outside-secret" }),
          );
        } finally {
          rmSync(fixture, { recursive: true, force: true });
        }
      }
      expect(readdirSync(userHome)).toEqual([]);
    } finally {
      rmSync(userHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("filters the timeline by --type through the real binary", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-timeline-"));
    const env = { ...process.env, NO_COLOR: "1" };
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(join(mexPath, "events"), { recursive: true });
      writeFileSync(join(mexPath, "ROUTER.md"), "");
      writeFileSync(
        join(mexPath, "events", "decisions.jsonl"),
        [
          { timestamp: "2026-05-14T00:00:00.000Z", kind: "decision", message: "picked sqlite", files: [] },
          { timestamp: "2026-05-15T00:00:00.000Z", kind: "risk", message: "wasm heap pressure", files: [] },
        ]
          .map((e) => JSON.stringify(e))
          .join("\n") + "\n",
      );

      const result = spawnSync(
        process.execPath,
        [cliPath, "timeline", "--type", "decision", "--json"],
        { cwd: fixture, encoding: "utf8", env },
      );
      expect(result.status).toBe(0);

      const { events } = JSON.parse(result.stdout) as { events: { kind: string }[] };
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe("decision");

      // An unknown kind must fail the way `mex log` does, not quietly list everything.
      const unknown = spawnSync(
        process.execPath,
        [cliPath, "timeline", "--type", "session_start"],
        { cwd: fixture, encoding: "utf8", env },
      );
      expect(unknown.status).toBe(1);
      expect(unknown.stderr).toContain('Unknown event type "session_start"');
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("mex --version", () => {
  it("reports the version from package.json (guards against hard-coded drift)", async () => {
    // cli.js is imported (and parsed with a safe argv) in beforeAll; this
    // returns the cached module, so we read the version commander was configured with.
    const { program } = await import("../src/cli.js");

    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

    expect(program.version()).toBe(version);
    expect(program.version()).not.toBe("0.3.5"); // the original bug (#48)
  });
});

describe("snapshotProcessTree", () => {
  it("skips an entry that disappears after listing without hiding a dangling-link error", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-snapshot-race-"));
    try {
      const transient = join(fixture, "maintenance.lock");
      writeFileSync(transient, "locked");
      expect(readdirSync(fixture)).toContain("maintenance.lock");
      rmSync(transient);

      expect(readFileOrDirectory(transient)).toBeUndefined();

      const dangling = join(fixture, "dangling");
      symlinkSync(join(fixture, "missing-target"), dangling);
      let danglingError: unknown;
      try {
        readFileOrDirectory(dangling);
      } catch (error) {
        danglingError = error;
      }
      expect(danglingError).toMatchObject({ code: "ENOENT" });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("excludes only Git's transient maintenance lock", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-snapshot-git-lock-"));
    try {
      mkdirSync(join(fixture, ".git", "objects"), { recursive: true });
      writeFileSync(join(fixture, ".git", "objects", "maintenance.lock"), "transient");
      writeFileSync(join(fixture, ".git", "objects", "other.lock"), "object lock");
      writeFileSync(join(fixture, ".git", "maintenance.lock"), "different path");
      writeFileSync(join(fixture, "maintenance.lock"), "project file");

      const snapshot = snapshotProcessTree(fixture);

      expect(snapshot[".git/objects/maintenance.lock"]).toBeUndefined();
      expect(snapshot[".git/objects/other.lock"]).toBe(
        Buffer.from("object lock").toString("base64"),
      );
      expect(snapshot[".git/maintenance.lock"]).toBe(
        Buffer.from("different path").toString("base64"),
      );
      expect(snapshot["maintenance.lock"]).toBe(
        Buffer.from("project file").toString("base64"),
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

function snapshotProcessTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch (error) {
      // A child directory can disappear after it was classified below. The root
      // itself must always remain readable, and no other filesystem error is safe
      // to interpret as a transient Git-maintenance race.
      if (prefix.length > 0 && isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    for (const name of names) {
      const absolute = join(directory, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      // `git maintenance run --auto --detach` can outlive the fixture's Git
      // command and create/remove this lock between the before/after snapshots.
      // Exclude this one Git-owned transient path while retaining every other
      // project, Git, and lock file in the non-mutation comparison.
      if (relative === ".git/objects/maintenance.lock") continue;
      const entry = readFileOrDirectory(absolute);
      if (entry === undefined) continue;
      result[relative] = entry.kind === "file" ? entry.bytes : "directory";
      if (entry.kind === "directory") visit(absolute, relative);
    }
  };
  visit(root, "");
  return result;
}

function readFileOrDirectory(path: string):
  | { kind: "file"; bytes: string }
  | { kind: "directory" }
  | undefined {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    // The parent directory was just listed, so ENOENT here proves that this
    // entry disappeared during the snapshot (for example Git's maintenance
    // lock). Permission, I/O, and malformed-path errors must still fail loudly.
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (stats.isDirectory()) return { kind: "directory" };

  try {
    return { kind: "file", bytes: readFileSync(path).toString("base64") };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      try {
        lstatSync(path);
      } catch (currentError) {
        if (isFileSystemError(currentError, "ENOENT")) return undefined;
        throw currentError;
      }
    }
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

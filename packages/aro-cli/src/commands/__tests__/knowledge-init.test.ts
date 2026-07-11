import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeKnowledgeInit,
  KNOWLEDGE_INIT_EXIT,
  type KnowledgeInitIo,
  type KnowledgeInitOptions,
} from "../knowledge-init.js";
import { executeInit, type InitIo } from "../init.js";
import {
  executeKnowledgeCheck,
  KNOWLEDGE_CHECK_EXIT,
  type KnowledgeCheckIo,
} from "../knowledge-check.js";
import { KNOWLEDGE_INDEX_PATH, KNOWLEDGE_ROOT } from "../../core/knowledge-index.js";
import { AroError } from "../../core/errors.js";
import {
  applyKnowledgeInit,
  KNOWLEDGE_OVERVIEW_PATH,
  KnowledgeInitPartialWriteError,
  MANAGED_KNOWLEDGE_PROMPT_PATH,
  MANAGED_KNOWLEDGE_SCHEMA_PATH,
  prepareKnowledgeInit,
} from "../../core/knowledge-init.js";
import { parseProjectConfig } from "../../core/project-config.js";
import { makeTempDir, writeRaw } from "../../test-support/distribution.fixture.js";
import {
  gitCheckoutNewBranch,
  gitCommitAll,
  gitRevParse,
  initRealGitRepo,
} from "../../test-support/git.fixture.js";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
);

let repoRoot: string;

beforeEach(async () => {
  repoRoot = await makeTempDir("aro-knowledge-init-");
  await initRealGitRepo(repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function projectYaml(allowKnowledge: boolean): string {
  return `schema_version: 1
project:
  name: demo
  type: generic
  risk_level: medium
ai:
  allowed_paths:
    - "src/**"
${allowKnowledge ? '    - ".ai/local/knowledge/**"\n' : ""}  forbidden_paths:
    - ".env"
`;
}

async function seedEnabledRepo(options: { allowKnowledge?: boolean; managed?: boolean } = {}): Promise<void> {
  await writeRaw(repoRoot, ".ai/project.yaml", projectYaml(options.allowKnowledge ?? true));
  if (options.managed ?? true) {
    await writeRaw(repoRoot, MANAGED_KNOWLEDGE_SCHEMA_PATH, "{}\n");
    await writeRaw(repoRoot, MANAGED_KNOWLEDGE_PROMPT_PATH, "# refresh\n");
  }
  await gitCommitAll(repoRoot, "chore: configure knowledge");
}

function options(overrides: Partial<KnowledgeInitOptions> = {}): KnowledgeInitOptions {
  return {
    repo: repoRoot,
    base: "HEAD",
    source: SOURCE_ROOT,
    dryRun: false,
    json: false,
    color: false,
    ...overrides,
  };
}

function captureIo(): { io: KnowledgeInitIo; out: () => string; err: () => string } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      color: false,
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("executeKnowledgeInit", () => {
  it("indexとoverviewを新規作成しexit 0", async () => {
    await seedEnabledRepo();
    const cap = captureIo();

    const code = await executeKnowledgeInit(options(), cap.io);

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.ok);
    expect(await readFile(path.join(repoRoot, KNOWLEDGE_INDEX_PATH), "utf8")).toContain("entries: []");
    expect(await readFile(path.join(repoRoot, KNOWLEDGE_OVERVIEW_PATH), "utf8")).toContain("Repo Knowledge");
    expect(cap.out()).toContain("Created:");
    expect(cap.err()).toBe("");
  });

  it("dry-runは作成予定を表示してファイルを書かない", async () => {
    await seedEnabledRepo();
    const cap = captureIo();

    const code = await executeKnowledgeInit(options({ dryRun: true }), cap.io);

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.ok);
    await expect(readFile(path.join(repoRoot, KNOWLEDGE_INDEX_PATH), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(cap.out()).toContain("dry-run");
  });

  it("既存indexを上書きせずblocked(exit 2)", async () => {
    await seedEnabledRepo();
    await writeRaw(repoRoot, KNOWLEDGE_INDEX_PATH, "keep: me\n");
    const cap = captureIo();

    const code = await executeKnowledgeInit(options(), cap.io);

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.blocked);
    expect(await readFile(path.join(repoRoot, KNOWLEDGE_INDEX_PATH), "utf8")).toBe("keep: me\n");
    expect(cap.err()).toContain("上書きしません");
  });

  it("HEAD側allowed_pathsがknowledgeを許可しなければblocked", async () => {
    await seedEnabledRepo({ allowKnowledge: false });
    const cap = captureIo();

    const code = await executeKnowledgeInit(options(), cap.io);

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.blocked);
    expect(cap.err()).toContain("設定PR");
  });

  it("working treeだけでallowed_pathsを緩めてもblocked", async () => {
    await seedEnabledRepo({ allowKnowledge: false });
    await writeRaw(repoRoot, ".ai/project.yaml", projectYaml(true));
    const cap = captureIo();

    const code = await executeKnowledgeInit(options(), cap.io);

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.blocked);
  });

  it("feature branchの先行commitでallowed_pathsを緩めてもbase=mainならblocked", async () => {
    await seedEnabledRepo({ allowKnowledge: false });
    await gitCheckoutNewBranch(repoRoot, "feature/enable-knowledge");
    await writeRaw(repoRoot, ".ai/project.yaml", projectYaml(true));
    await gitCommitAll(repoRoot, "chore: allow knowledge on feature branch");
    const cap = captureIo();

    const code = await executeKnowledgeInit(options({ base: "main" }), cap.io);

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.blocked);
    expect(cap.err()).toContain("base（merge-base:");
    expect(cap.err()).toContain("設定PR");
  });

  it("新規repo初期commit直後は明示的なbase=HEADで初期化できる", async () => {
    await seedEnabledRepo();
    const cap = captureIo();

    const code = await executeKnowledgeInit(options({ base: "HEAD" }), cap.io);

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.ok);
  });

  it("managed schema/promptが未導入ならblocked", async () => {
    await seedEnabledRepo({ managed: false });
    const cap = captureIo();

    const code = await executeKnowledgeInit(options(), cap.io);

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.blocked);
    expect(cap.err()).toContain("aro sync");
  });

  it("--jsonは作成結果を安定したenvelopeで返す", async () => {
    await seedEnabledRepo();
    const cap = captureIo();

    const code = await executeKnowledgeInit(options({ json: true }), cap.io);
    const parsed = JSON.parse(cap.out()) as { command: string; ok: boolean; created: string[] };

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.ok);
    expect(parsed.command).toBe("knowledge init");
    expect(parsed.ok).toBe(true);
    expect(parsed.created.sort()).toEqual([KNOWLEDGE_INDEX_PATH, KNOWLEDGE_OVERVIEW_PATH].sort());
  });

  it("plan後にindexが競合すると作成済みpathとhuman向け復旧手順を報告してexit 3", async () => {
    await seedEnabledRepo();
    const cap = captureIo();

    const code = await executeKnowledgeInit(options(), cap.io, {
      applyKnowledgeInit: async (plan) => {
        await writeRaw(repoRoot, KNOWLEDGE_INDEX_PATH, "concurrent: writer\n");
        return applyKnowledgeInit(plan);
      },
    });

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.unexpected);
    expect(cap.err()).toContain("KNOWLEDGE_INIT_PARTIAL_WRITE");
    expect(cap.err()).toContain(KNOWLEDGE_OVERVIEW_PATH);
    expect(cap.err()).toContain("Failed path to inspect");
    expect(cap.err()).toContain("EEXIST");
    expect(cap.err()).toContain("rm -f");
    const removeCommand = cap
      .err()
      .split("\n")
      .find((line) => line.includes("rm -f"));
    expect(removeCommand).not.toContain(KNOWLEDGE_INDEX_PATH);
    expect(await readFile(path.join(repoRoot, KNOWLEDGE_OVERVIEW_PATH), "utf8")).toContain(
      "Repo Knowledge",
    );
    expect(await readFile(path.join(repoRoot, KNOWLEDGE_INDEX_PATH), "utf8")).toBe(
      "concurrent: writer\n",
    );
  });

  it("部分生成I/O errorをJSONで復旧対象つきで報告してexit 3", async () => {
    await seedEnabledRepo();
    const cap = captureIo();

    const code = await executeKnowledgeInit(options({ json: true }), cap.io, {
      applyKnowledgeInit: async (plan) => {
        await writeRaw(repoRoot, KNOWLEDGE_INDEX_PATH, "concurrent: writer\n");
        return applyKnowledgeInit(plan);
      },
    });
    const parsed = JSON.parse(cap.err()) as {
      command: string;
      ok: boolean;
      error: {
        code: string;
        failedPath: string;
        createdPaths: string[];
        errno: string;
        failedPathMayBePartial: boolean;
      };
      recovery: { removePaths: string[]; inspectPaths: string[] };
    };

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.unexpected);
    expect(parsed.command).toBe("knowledge init");
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("KNOWLEDGE_INIT_PARTIAL_WRITE");
    expect(parsed.error.failedPath).toBe(KNOWLEDGE_INDEX_PATH);
    expect(parsed.error.createdPaths).toEqual([KNOWLEDGE_OVERVIEW_PATH]);
    expect(parsed.error.errno).toBe("EEXIST");
    expect(parsed.error.failedPathMayBePartial).toBe(false);
    expect(parsed.recovery.removePaths).toEqual([KNOWLEDGE_OVERVIEW_PATH]);
    expect(parsed.recovery.inspectPaths).toEqual([KNOWLEDGE_INDEX_PATH]);
  });

  it("ENOSPCの失敗pathをremove対象ではなくpossibly partialなinspect対象としてJSON報告する", async () => {
    await seedEnabledRepo();
    const cap = captureIo();
    const diskFull = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

    const code = await executeKnowledgeInit(options({ json: true }), cap.io, {
      applyKnowledgeInit: async () => {
        throw new KnowledgeInitPartialWriteError(
          KNOWLEDGE_INDEX_PATH,
          [KNOWLEDGE_OVERVIEW_PATH],
          diskFull,
        );
      },
    });
    const parsed = JSON.parse(cap.err()) as {
      error: {
        failedPath: string;
        errno: string;
        failedPathMayBePartial: boolean;
      };
      recovery: { removePaths: string[]; inspectPaths: string[] };
    };

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.unexpected);
    expect(parsed.error.failedPath).toBe(KNOWLEDGE_INDEX_PATH);
    expect(parsed.error.errno).toBe("ENOSPC");
    expect(parsed.error.failedPathMayBePartial).toBe(true);
    expect(parsed.recovery.removePaths).toEqual([KNOWLEDGE_OVERVIEW_PATH]);
    expect(parsed.recovery.inspectPaths).toEqual([KNOWLEDGE_INDEX_PATH]);
  });

  it("ENOSPCの失敗pathをhuman出力でpossibly partialなinspect対象として案内する", async () => {
    await seedEnabledRepo();
    const cap = captureIo();
    const diskFull = Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

    const code = await executeKnowledgeInit(options(), cap.io, {
      applyKnowledgeInit: async () => {
        throw new KnowledgeInitPartialWriteError(
          KNOWLEDGE_INDEX_PATH,
          [KNOWLEDGE_OVERVIEW_PATH],
          diskFull,
        );
      },
    });

    expect(code).toBe(KNOWLEDGE_INIT_EXIT.unexpected);
    expect(cap.err()).toContain("Failed path to inspect");
    expect(cap.err()).toContain(KNOWLEDGE_INDEX_PATH);
    expect(cap.err()).toContain("ENOSPC");
    expect(cap.err()).toContain("partial content");
    const removeCommand = cap
      .err()
      .split("\n")
      .find((line) => line.includes("rm -f"));
    expect(removeCommand).toContain(KNOWLEDGE_OVERVIEW_PATH);
    expect(removeCommand).not.toContain(KNOWLEDGE_INDEX_PATH);
  });

  it("applyの部分失敗は専用non-Aro errorに作成済みpathを保持する", async () => {
    await seedEnabledRepo();
    const configText = projectYaml(true);
    const plan = await prepareKnowledgeInit(repoRoot, parseProjectConfig(configText, "test config"));
    await writeRaw(repoRoot, KNOWLEDGE_INDEX_PATH, "concurrent: writer\n");

    const error = await applyKnowledgeInit(plan).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(KnowledgeInitPartialWriteError);
    expect(error).not.toBeInstanceOf(AroError);
    expect((error as KnowledgeInitPartialWriteError).createdPaths).toEqual([
      KNOWLEDGE_OVERVIEW_PATH,
    ]);
    expect((error as KnowledgeInitPartialWriteError).failedPath).toBe(KNOWLEDGE_INDEX_PATH);
    expect((error as KnowledgeInitPartialWriteError).errno).toBe("EEXIST");
    expect((error as KnowledgeInitPartialWriteError).failedPathMayBePartial).toBe(false);
  });

  it("実distributionのaro initからknowledge init・strict checkまで通る", async () => {
    await writeRaw(repoRoot, "README.md", "# Demo\n");
    const initIo: InitIo = {
      stdout: () => {},
      stderr: () => {},
      color: false,
      now: () => "2026-07-11T00:00:00.000Z",
    };
    const initCode = await executeInit(
      {
        repo: repoRoot,
        distribution: "base",
        source: SOURCE_ROOT,
        dryRun: false,
        json: false,
        verbose: false,
        color: false,
      },
      initIo,
    );
    expect(initCode).toBe(0);
    await gitCommitAll(repoRoot, "chore: initialize aro");

    const knowledgeInitCode = await executeKnowledgeInit(options(), captureIo().io);
    expect(knowledgeInitCode).toBe(KNOWLEDGE_INIT_EXIT.ok);

    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/overview.md`, "# Overview\n\nREADMEを根拠にした概要。\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: repository-overview
    document: overview.md
    verified_at_commit: ${verified}
    sources:
      - path: README.md
`,
    );

    const checkIo: KnowledgeCheckIo = {
      stdout: () => {},
      stderr: () => {},
      color: false,
    };
    const checkCode = await executeKnowledgeCheck(
      {
        repo: repoRoot,
        source: SOURCE_ROOT,
        strict: true,
        json: false,
        color: false,
      },
      checkIo,
    );
    expect(checkCode).toBe(KNOWLEDGE_CHECK_EXIT.ok);
  });
});

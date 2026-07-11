import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  executeKnowledgeCheck,
  KNOWLEDGE_CHECK_EXIT,
  type KnowledgeCheckIo,
  type KnowledgeCheckOptions,
} from "../knowledge-check.js";
import { KNOWLEDGE_INDEX_PATH, KNOWLEDGE_ROOT } from "../../core/knowledge-index.js";
import { makeTempDir, writeRaw } from "../../test-support/distribution.fixture.js";
import { gitCommitAll, gitRevParse, initRealGitRepo } from "../../test-support/git.fixture.js";

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
  repoRoot = await makeTempDir("aro-knowledge-check-cmd-");
  await initRealGitRepo(repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function options(overrides: Partial<KnowledgeCheckOptions> = {}): KnowledgeCheckOptions {
  return {
    repo: repoRoot,
    source: SOURCE_ROOT,
    strict: false,
    json: false,
    color: false,
    ...overrides,
  };
}

function captureIo(): { io: KnowledgeCheckIo; out: () => string; err: () => string } {
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

async function seedKnowledge(): Promise<void> {
  await writeRaw(repoRoot, "src/auth.ts", "v1\n");
  await gitCommitAll(repoRoot, "feat: source");
  const verified = await gitRevParse(repoRoot, "HEAD");
  await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/architecture.md`, "# Architecture\n");
  await writeRaw(
    repoRoot,
    KNOWLEDGE_INDEX_PATH,
    `schema_version: 1
entries:
  - id: architecture
    document: architecture.md
    verified_at_commit: ${verified}
    sources:
      - path: src/auth.ts
`,
  );
}

describe("executeKnowledgeCheck", () => {
  it("freshなknowledgeはexit 0とhuman PASSを返す", async () => {
    await seedKnowledge();
    const cap = captureIo();

    const code = await executeKnowledgeCheck(options(), cap.io);

    expect(code).toBe(KNOWLEDGE_CHECK_EXIT.ok);
    expect(cap.out()).toContain("ai-repo-ops knowledge check");
    expect(cap.out()).toContain("PASS");
    expect(cap.out()).toContain("0 warnings");
    expect(cap.err()).toBe("");
  });

  it("通常モードのstaleはWARNだがexit 0", async () => {
    await seedKnowledge();
    await writeRaw(repoRoot, "src/auth.ts", "v2\n");
    const cap = captureIo();

    const code = await executeKnowledgeCheck(options(), cap.io);

    expect(code).toBe(KNOWLEDGE_CHECK_EXIT.ok);
    expect(cap.out()).toContain("WARN");
  });

  it("strictモードのstaleはexit 1", async () => {
    await seedKnowledge();
    await writeRaw(repoRoot, "src/auth.ts", "v2\n");
    const cap = captureIo();

    const code = await executeKnowledgeCheck(options({ strict: true }), cap.io);

    expect(code).toBe(KNOWLEDGE_CHECK_EXIT.failures);
    expect(cap.out()).toContain("FAIL");
  });

  it("--jsonは安定したenvelopeをstdoutへ返す", async () => {
    await seedKnowledge();
    const cap = captureIo();

    const code = await executeKnowledgeCheck(options({ json: true }), cap.io);
    const parsed = JSON.parse(cap.out()) as {
      command: string;
      ok: boolean;
      strict: boolean;
      report: { summary: { entries: number } };
    };

    expect(code).toBe(KNOWLEDGE_CHECK_EXIT.ok);
    expect(parsed.command).toBe("knowledge check");
    expect(parsed.ok).toBe(true);
    expect(parsed.strict).toBe(false);
    expect(parsed.report.summary.entries).toBe(1);
  });

  it("index欠落はexit 1", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");
    const cap = captureIo();

    const code = await executeKnowledgeCheck(options(), cap.io);

    expect(code).toBe(KNOWLEDGE_CHECK_EXIT.failures);
    expect(cap.out()).toContain("FAIL");
  });

  it("source/schemaを解決できなければexit 3とJSON errorをstderrへ返す", async () => {
    const invalidSource = await makeTempDir("aro-knowledge-source-missing-");
    try {
      await writeRaw(invalidSource, "distribution/.keep", "");
      const cap = captureIo();
      const code = await executeKnowledgeCheck(options({ source: invalidSource, json: true }), cap.io);

      expect(code).toBe(KNOWLEDGE_CHECK_EXIT.unexpected);
      const parsed = JSON.parse(cap.err()) as { command: string; ok: boolean; error: { code: string } };
      expect(parsed.command).toBe("knowledge check");
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("KNOWLEDGE_SCHEMA_NOT_FOUND");
    } finally {
      await rm(invalidSource, { recursive: true, force: true });
    }
  });
});

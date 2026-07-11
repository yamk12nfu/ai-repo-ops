import { readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runKnowledgeCheck, type KnowledgeReport } from "../knowledge-check.js";
import { KNOWLEDGE_INDEX_PATH, KNOWLEDGE_ROOT } from "../knowledge-index.js";
import {
  makeTempDir,
  writeRaw,
  writeRawBytes,
} from "../../test-support/distribution.fixture.js";
import {
  gitCheckout,
  gitCheckoutNewBranch,
  gitCommitAll,
  gitRevParse,
  initRealGitRepo,
} from "../../test-support/git.fixture.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

let repoRoot: string;
let knowledgeSchema: unknown;

beforeAll(async () => {
  knowledgeSchema = JSON.parse(await readFile(path.join(REPO_ROOT, "schemas/knowledge.schema.json"), "utf8"));
});

beforeEach(async () => {
  repoRoot = await makeTempDir("aro-knowledge-check-");
  await initRealGitRepo(repoRoot);
});

afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function finding(report: KnowledgeReport, id: string) {
  return report.findings.find((candidate) => candidate.id === id);
}

async function seedValidKnowledge(): Promise<string> {
  await writeRaw(repoRoot, "src/auth.ts", "export const auth = true;\n");
  await gitCommitAll(repoRoot, "feat: add auth source");
  const verified = await gitRevParse(repoRoot, "HEAD");
  await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/architecture.md`, "# Architecture\n\nAuth lives in src/auth.ts.\n");
  await writeRaw(
    repoRoot,
    KNOWLEDGE_INDEX_PATH,
    `schema_version: 1
entries:
  - id: auth-architecture
    document: architecture.md
    verified_at_commit: ${verified}
    sources:
      - path: src/auth.ts
`,
  );
  return verified;
}

describe("runKnowledgeCheck", () => {
  it("根拠とdocumentが有効でfreshならFAIL/WARNなし", async () => {
    await seedValidKnowledge();

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(report.hasFailures).toBe(false);
    expect(report.hasWarnings).toBe(false);
    expect(report.summary.entries).toBe(1);
    expect(finding(report, "source.fresh")?.status).toBe("pass");
  });

  it("source変更は通常モードでWARNにする", async () => {
    await seedValidKnowledge();
    await writeRaw(repoRoot, "src/auth.ts", "export const auth = false;\n");

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(report.hasFailures).toBe(false);
    expect(report.hasWarnings).toBe(true);
    expect(finding(report, "source.stale")?.status).toBe("warn");
    expect(report.summary.stale).toBe(1);
  });

  it("source変更はstrictモードでFAILにする", async () => {
    await seedValidKnowledge();
    await writeRaw(repoRoot, "src/auth.ts", "export const auth = false;\n");

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: true });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "source.stale")?.status).toBe("fail");
  });

  it("indexが無ければreport内のFAILにする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "index.exists")?.status).toBe("fail");
    expect(finding(report, "index.exists")?.hint).toContain("--base");
  });

  it("authoritative schema違反をreport内のFAILにする", async () => {
    await writeRaw(repoRoot, KNOWLEDGE_INDEX_PATH, "schema_version: 1\nentries: []\nunexpected: true\n");

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "index.schema")?.status).toBe("fail");
  });

  it("空のentriesは非blockingのWARNにする", async () => {
    await writeRaw(repoRoot, KNOWLEDGE_INDEX_PATH, "schema_version: 1\nentries: []\n");

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: true });

    expect(report.hasFailures).toBe(false);
    expect(finding(report, "entries.empty")?.status).toBe("warn");
  });

  it("document欠落をFAILにする", async () => {
    await seedValidKnowledge();
    await rm(path.join(repoRoot, KNOWLEDGE_ROOT, "architecture.md"));

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "document.exists")?.status).toBe("fail");
  });

  it("symlinkのdocumentを追従せずFAILにする", async () => {
    await seedValidKnowledge();
    const documentPath = path.join(repoRoot, KNOWLEDGE_ROOT, "architecture.md");
    await rm(documentPath);
    await symlink(path.join(repoRoot, "src/auth.ts"), documentPath);

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "document.read")?.status).toBe("fail");
  });

  it("symlinkのsourceを追従せずFAILにする", async () => {
    await seedValidKnowledge();
    const sourcePath = path.join(repoRoot, "src/auth.ts");
    await rm(sourcePath);
    await symlink(path.join(repoRoot, "README.md"), sourcePath);

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "source.read")?.status).toBe("fail");
  });

  it("verification commitに存在しないsourceをFAILにする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, "src/later.ts", "export {};\n");
    await gitCommitAll(repoRoot, "feat: add source later");
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/later.md`, "# Later\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: later-source
    document: later.md
    verified_at_commit: ${verified}
    sources:
      - path: src/later.ts
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "provenance.source-at-commit")?.status).toBe("fail");
  });

  it("HEADと別系統のverification commitをprovenance FAILにする", async () => {
    await writeRaw(repoRoot, "src/auth.ts", "v1\n");
    await gitCommitAll(repoRoot, "feat: add auth");
    await gitCheckoutNewBranch(repoRoot, "side");
    await writeRaw(repoRoot, "side.txt", "side\n");
    await gitCommitAll(repoRoot, "chore: side commit");
    const sideCommit = await gitRevParse(repoRoot, "HEAD");
    await gitCheckout(repoRoot, "main");
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/architecture.md`, "# Architecture\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: auth-architecture
    document: architecture.md
    verified_at_commit: ${sideCommit}
    sources:
      - path: src/auth.ts
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(report.hasFailures).toBe(true);
    expect(finding(report, "provenance.ancestor")?.status).toBe("fail");
  });

  it.each([
    ".env",
    ".env.production",
    "secrets/token.txt",
    ".ai/local/notes.md",
    "apps/api/.env",
    "apps/api/.env.production",
    "apps/api/secrets/token.txt",
    "apps/api/.git/config",
    "apps/api/.ai/notes.md",
    "node_modules/pkg/index.js",
    "dist/app.js",
  ])(
    "禁止sourceを読む前にFAILにする: %s",
    async (sourcePath) => {
      await writeRaw(repoRoot, "README.md", "# Demo\n");
      await gitCommitAll(repoRoot, "chore: initial");
      const verified = await gitRevParse(repoRoot, "HEAD");
      await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/bad.md`, "# Bad\n");
      await writeRaw(
        repoRoot,
        KNOWLEDGE_INDEX_PATH,
        `schema_version: 1
entries:
  - id: forbidden-source
    document: bad.md
    verified_at_commit: ${verified}
    sources:
      - path: ${sourcePath}
`,
      );

      const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

      expect(finding(report, "source.forbidden")?.status).toBe("fail");
    },
  );

  it("HEADで未追跡のsourceをFAILにする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, "notes.txt", "untracked\n");
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/notes.md`, "# Notes\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: untracked-source
    document: notes.md
    verified_at_commit: ${verified}
    sources:
      - path: notes.txt
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "source.tracked")?.status).toBe("fail");
  });

  it("未追跡のbinary sourceは内容を読まずsource.trackedでFAILにする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRawBytes(repoRoot, "notes.bin", Buffer.from([0xff, 0xfe, 0xfd]));
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/notes.md`, "# Notes\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: untracked-binary
    document: notes.md
    verified_at_commit: ${verified}
    sources:
      - path: notes.bin
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "source.tracked")?.status).toBe("fail");
    expect(finding(report, "source.text")).toBeUndefined();
    expect(finding(report, "source.read")).toBeUndefined();
  });

  it("未追跡のsymlink sourceはsymlinkを調べずsource.trackedでFAILにする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await gitCommitAll(repoRoot, "chore: initial");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await symlink("README.md", path.join(repoRoot, "notes.txt"));
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/notes.md`, "# Notes\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: untracked-symlink
    document: notes.md
    verified_at_commit: ${verified}
    sources:
      - path: notes.txt
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "source.tracked")?.status).toBe("fail");
    expect(finding(report, "source.read")).toBeUndefined();
  });

  it("Git上のsymlink sourceを通常blobではないとしてFAILにする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await symlink("../README.md", path.join(repoRoot, "src-link"));
    await gitCommitAll(repoRoot, "chore: add symlink source");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/link.md`, "# Link\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: symlink-source
    document: link.md
    verified_at_commit: ${verified}
    sources:
      - path: src-link
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "source.git-object")?.status).toBe("fail");
    expect(finding(report, "source.read")).toBeUndefined();
  });

  it("Git上のtree sourceを通常blobではないとしてFAILにする", async () => {
    await writeRaw(repoRoot, "src/auth.ts", "export {};\n");
    await gitCommitAll(repoRoot, "feat: add source tree");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/tree.md`, "# Tree\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: tree-source
    document: tree.md
    verified_at_commit: ${verified}
    sources:
      - path: src
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "source.git-object")?.status).toBe("fail");
    expect(finding(report, "source.read")).toBeUndefined();
  });

  it("verification commit側のsymlink sourceを通常blobではないとしてFAILにする", async () => {
    await writeRaw(repoRoot, "README.md", "# demo\n");
    await symlink("../README.md", path.join(repoRoot, "src-link"));
    await gitCommitAll(repoRoot, "chore: add symlink source");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await rm(path.join(repoRoot, "src-link"));
    await writeRaw(repoRoot, "src-link", "regular source\n");
    await gitCommitAll(repoRoot, "fix: replace symlink with file");
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/link.md`, "# Link\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: historical-symlink
    document: link.md
    verified_at_commit: ${verified}
    sources:
      - path: src-link
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "provenance.source-git-object")?.status).toBe("fail");
    expect(finding(report, "source.read")).toBeUndefined();
  });

  it("UTF-8でないsourceをFAILにする", async () => {
    await writeRawBytes(repoRoot, "src/binary.bin", Buffer.from([0xff, 0xfe, 0xfd]));
    await gitCommitAll(repoRoot, "chore: add binary");
    const verified = await gitRevParse(repoRoot, "HEAD");
    await writeRaw(repoRoot, `${KNOWLEDGE_ROOT}/binary.md`, "# Binary\n");
    await writeRaw(
      repoRoot,
      KNOWLEDGE_INDEX_PATH,
      `schema_version: 1
entries:
  - id: binary-source
    document: binary.md
    verified_at_commit: ${verified}
    sources:
      - path: src/binary.bin
`,
    );

    const report = await runKnowledgeCheck({ repoRoot, knowledgeSchema, strict: false });

    expect(finding(report, "source.text")?.status).toBe("fail");
  });
});

import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeInit, INIT_EXIT, type InitIo, type InitOptions } from "../init.js";
import { executeDiff, type DiffOptions } from "../diff.js";
import { canonicalSha256OfString } from "../../core/checksum.js";
import { LOCKFILE_RELATIVE_PATH, parseLockFile } from "../../core/lockfile.js";
import { resolveSourceRoot } from "../../core/source.js";
import {
  initGitRepo,
  makeTempDir,
  REVIEW_CONTENT,
  setupBaseDistribution,
  writeRaw,
} from "../../test-support/distribution.fixture.js";

let sourceRoot: string;
let repoRoot: string;

const REVIEW_DEST = ".ai/managed/prompts/review.md";
const PROJECT_YAML = ".ai/project.yaml";
const WORKFLOW_DEST = ".github/workflows/ai-review.yml";
const NOW = "2026-07-01T12:00:00.000Z";

beforeEach(async () => {
  sourceRoot = await makeTempDir("aro-init-src-");
  repoRoot = await makeTempDir("aro-init-repo-");
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

function options(overrides: Partial<InitOptions> = {}): InitOptions {
  return {
    repo: repoRoot,
    distribution: "base",
    source: sourceRoot,
    dryRun: false,
    json: false,
    verbose: false,
    color: false,
    ...overrides,
  };
}

function captureIo(): { io: InitIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      stdout: (text) => outChunks.push(text),
      stderr: (text) => errChunks.push(text),
      color: false,
      now: () => NOW,
    },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

function diffOptions(): DiffOptions {
  return {
    repo: repoRoot,
    distribution: "base",
    source: sourceRoot,
    dryRun: false,
    json: false,
    verbose: false,
    color: false,
    detailedExitcode: false,
  };
}

async function exists(relPath: string): Promise<boolean> {
  try {
    await stat(path.join(repoRoot, relPath));
    return true;
  } catch {
    return false;
  }
}

async function read(relPath: string): Promise<string> {
  return readFile(path.join(repoRoot, relPath), "utf8");
}

describe("executeInit: 新規 repo（Scenario 1）", () => {
  it("期待ファイルを生成し exit 0、lock の checksum を記録する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);

    const cap = captureIo();
    const code = await executeInit(options(), cap.io);

    expect(code).toBe(INIT_EXIT.ok);
    // 期待ファイル一式。
    expect(await exists(PROJECT_YAML)).toBe(true);
    expect(await exists(REVIEW_DEST)).toBe(true);
    expect(await exists(WORKFLOW_DEST)).toBe(true);
    expect(await exists(".gitignore")).toBe(true);
    expect(await exists(".gitattributes")).toBe(true);
    expect(await exists(LOCKFILE_RELATIVE_PATH)).toBe(true);

    // managed file は source 内容。
    expect(await read(REVIEW_DEST)).toBe(REVIEW_CONTENT);
    // lock の installed_sha256 が canonical sha と一致。
    const lock = parseLockFile(await read(LOCKFILE_RELATIVE_PATH));
    const review = lock.managed_files.find((m) => m.path === REVIEW_DEST);
    expect(review?.installed_sha256).toBe(canonicalSha256OfString(REVIEW_CONTENT));
    expect(lock.created_at).toBe(NOW);
    expect(lock.source.distribution_content_sha256).toHaveLength(64);

    expect(cap.out()).toContain("Created:");
    expect(cap.out()).toContain("Done.");
  });

  it("project.yaml の {{ repo_name }} が repo 名へ置換される", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await executeInit(options(), captureIo().io);

    const projectYaml = await read(PROJECT_YAML);
    expect(projectYaml).toContain(path.basename(repoRoot));
    expect(projectYaml).not.toContain("{{");
  });

  it(".gitattributes / .gitignore に必要行が追記される", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await executeInit(options(), captureIo().io);

    expect(await read(".gitattributes")).toContain(".ai/managed/** text eol=lf");
    expect(await read(".gitignore")).toContain(".ai/runs/");
  });

  it("init 直後の diff は up to date（exit 0）", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    await executeInit(options(), captureIo().io);

    const diffCap = {
      out: [] as string[],
      err: [] as string[],
    };
    const code = await executeDiff(diffOptions(), {
      stdout: (t) => diffCap.out.push(t),
      stderr: (t) => diffCap.err.push(t),
      color: false,
    });
    expect(code).toBe(0);
    expect(diffCap.out.join("")).toContain("Up to date");
  });
});

describe("executeInit: blocked", () => {
  it("lock が既にあれば blocked(exit 2)・初期化済みを案内する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    // 1 回目で初期化。
    await executeInit(options(), captureIo().io);

    // 2 回目は blocked。
    const cap = captureIo();
    const code = await executeInit(options(), cap.io);
    expect(code).toBe(INIT_EXIT.blocked);
    expect(cap.err()).toContain("初期化済み");
  });

  it("既存ファイルが managed 対象と衝突すると blocked(exit 2)・conflict を表示する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);
    // managed_overwrite 対象に既存ファイルを置く（lock は無い）。
    await writeRaw(repoRoot, REVIEW_DEST, "pre-existing content\n");

    const cap = captureIo();
    const code = await executeInit(options(), cap.io);
    expect(code).toBe(INIT_EXIT.blocked);
    expect(cap.err()).toContain("Conflicting files:");
    expect(cap.err()).toContain(REVIEW_DEST);
    // 書き込みされていない（lock 未生成）。
    expect(await exists(LOCKFILE_RELATIVE_PATH)).toBe(false);
  });
});

describe("executeInit: validation error", () => {
  it("Git repo でなければ exit 1・git init を案内する", async () => {
    await setupBaseDistribution(sourceRoot);
    // initGitRepo を呼ばない（.git なし）。
    const cap = captureIo();
    const code = await executeInit(options(), cap.io);
    expect(code).toBe(INIT_EXIT.validation);
    expect(cap.err()).toContain("git init");
    expect(await exists(LOCKFILE_RELATIVE_PATH)).toBe(false);
  });
});

describe("executeInit: --dry-run", () => {
  it("ファイルを書かず exit 0、プレビューを表示する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);

    const cap = captureIo();
    const code = await executeInit(options({ dryRun: true }), cap.io);
    expect(code).toBe(INIT_EXIT.ok);
    expect(cap.out()).toContain("dry-run");
    // 何も書かれていない。
    expect(await exists(LOCKFILE_RELATIVE_PATH)).toBe(false);
    expect(await exists(PROJECT_YAML)).toBe(false);
    expect(await exists(REVIEW_DEST)).toBe(false);
  });
});

describe("executeInit: --json", () => {
  it("applied を JSON で出力する", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);

    const cap = captureIo();
    const code = await executeInit(options({ json: true }), cap.io);
    expect(code).toBe(INIT_EXIT.ok);

    const parsed = JSON.parse(cap.out()) as {
      command: string;
      ok: boolean;
      applied: { creates: string[]; lockWasCreated: boolean };
    };
    expect(parsed.command).toBe("init");
    expect(parsed.ok).toBe(true);
    expect(parsed.applied.creates).toContain(REVIEW_DEST);
    expect(parsed.applied.lockWasCreated).toBe(true);
  });
});

describe("executeInit: 実 distribution/base に対するエンドツーエンド（Scenario 1 / DoD）", () => {
  /** この test ファイルの位置から実 ai-repo-ops source root（distribution/ を持つ祖先）を解決する。 */
  async function realSourceRoot(): Promise<string> {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return resolveSourceRoot(undefined, here);
  }

  it("shipped manifest 全体を展開し、.prettierignore も含めて生成、diff は up to date", async () => {
    const source = await realSourceRoot();
    await initGitRepo(repoRoot);

    const realOptions = options({ source });
    const cap = captureIo();
    const code = await executeInit(realOptions, cap.io);
    expect(code).toBe(INIT_EXIT.ok);

    // 実 manifest が配布する代表ファイル一式。
    for (const rel of [
      ".ai/managed/prompts/review.md",
      ".ai/managed/prompts/improve.md",
      ".ai/managed/prompts/issue-fix.md",
      ".ai/managed/prompts/release-check.md",
      ".ai/managed/policies/default.yaml",
      ".ai/managed/policies/low-risk.yaml",
      ".ai/managed/policies/security.yaml",
      ".ai/managed/schemas/project.schema.json",
      ".ai/project.yaml",
      ".github/workflows/ai-review.yml",
      ".gitignore",
      ".gitattributes",
      ".prettierignore",
      LOCKFILE_RELATIVE_PATH,
    ]) {
      expect(await exists(rel), `${rel} should exist`).toBe(true);
    }

    // ai-improve は配布終了（計画 03 Stage 2-2）。新規 init では作成されない。
    expect(await exists(".github/workflows/ai-improve.yml")).toBe(false);

    // §0.2.3: managed file 保護行が .prettierignore に入る。
    expect(await read(".prettierignore")).toContain(".ai/managed/");
    expect(await read(".prettierignore")).toContain(".ai/ai-repo-ops.lock.yaml");

    // lock に 8 件の managed file が記録される。
    const lock = parseLockFile(await read(LOCKFILE_RELATIVE_PATH));
    expect(lock.managed_files).toHaveLength(8);

    // init 直後の diff は up to date。
    const diffCap = { out: [] as string[], err: [] as string[] };
    const diffCode = await executeDiff(
      { ...diffOptions(), source },
      {
        stdout: (t) => diffCap.out.push(t),
        stderr: (t) => diffCap.err.push(t),
        color: false,
      },
    );
    expect(diffCode).toBe(0);
    expect(diffCap.out.join("")).toContain("Up to date");
  });
});

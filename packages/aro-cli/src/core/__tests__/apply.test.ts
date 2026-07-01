import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ApplyIoError, applyPlan } from "../apply.js";
import { canonicalSha256OfString } from "../checksum.js";
import {
  buildLockFile,
  LOCKFILE_RELATIVE_PATH,
  parseLockFile,
  writeLockFile,
} from "../lockfile.js";
import { buildSyncPlan } from "../planner.js";
import { loadDistribution } from "../source.js";
import type { SyncPlan } from "../../types/plan.js";
import {
  FIXED_TS,
  makeTempDir,
  REVIEW_CONTENT,
  seedRepoAsSynced,
  setupBaseDistribution,
} from "../../test-support/distribution.fixture.js";

let sourceRoot: string;
let repoRoot: string;

const REVIEW_DEST = ".ai/managed/prompts/review.md";
const PROJECT_YAML = ".ai/project.yaml";

beforeEach(async () => {
  sourceRoot = await makeTempDir("aro-apply-src-");
  repoRoot = await makeTempDir("aro-apply-repo-");
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

async function read(relPath: string): Promise<string> {
  return readFile(path.join(repoRoot, relPath), "utf8");
}

describe("applyPlan: 新規 repo（init 相当）", () => {
  it("managed/seed/patch を作成し lock を新規生成する", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock: null });

    const result = await applyPlan({
      plan,
      distribution: dist,
      repoRoot,
      existingLock: null,
      now: FIXED_TS,
      repoName: "product-x",
    });

    // managed file が source 内容で書かれる。
    expect(await read(REVIEW_DEST)).toBe(REVIEW_CONTENT);
    // patch が作られる。
    expect(await read(".gitignore")).toContain(".ai/runs/");
    // lock が新規作成され、installed_sha256 が canonical sha と一致する。
    expect(result.lockWasCreated).toBe(true);
    const lock = parseLockFile(await read(LOCKFILE_RELATIVE_PATH));
    const review = lock.managed_files.find((m) => m.path === REVIEW_DEST);
    expect(review?.installed_sha256).toBe(canonicalSha256OfString(REVIEW_CONTENT));
    expect(review?.source).toBe(`distribution/base/files/${REVIEW_DEST}`);
    // result の creates / patches 分類。
    expect(result.creates).toContain(REVIEW_DEST);
    expect(result.creates).toContain(PROJECT_YAML);
    expect(result.patches.map((p) => p.path).sort()).toEqual([".gitattributes", ".gitignore"]);
    expect(result.patches.every((p) => p.created)).toBe(true);
  });

  it("template seed の {{ repo_name }} を repo 名へ置換する", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock: null });

    await applyPlan({
      plan,
      distribution: dist,
      repoRoot,
      existingLock: null,
      now: FIXED_TS,
      repoName: "my-repo",
    });

    const projectYaml = await read(PROJECT_YAML);
    expect(projectYaml).toContain("my-repo");
    expect(projectYaml).not.toContain("{{");
  });

  it("managed file は LF・BOM なしで書かれる", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock: null });
    await applyPlan({ plan, distribution: dist, repoRoot, existingLock: null, now: FIXED_TS });

    const bytes = await readFile(path.join(repoRoot, REVIEW_DEST));
    expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
    expect(bytes[0]).not.toBe(0xef); // UTF-8 BOM の先頭バイトでない
  });
});

describe("applyPlan: orphaned managed file", () => {
  it("lock にある orphan を新 lock からも削除しない（§16.4）", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);

    // 旧 lock に「manifest に無い managed file」を 1 件足して書き戻す。
    const orphanPath = ".ai/managed/prompts/old.md";
    const orphanLock = buildLockFile({
      distribution: "base",
      version: dist.manifest.version,
      distributionContentSha256: dist.contentSha256,
      managedFiles: [
        ...dist.managedFiles.map((m) => ({
          path: m.dest,
          source: `distribution/base/${m.src}`,
          installedSha256: m.sourceSha256,
        })),
        {
          path: orphanPath,
          source: `distribution/base/files/${orphanPath}`,
          installedSha256: "a".repeat(64),
        },
      ],
      seedFiles: dist.seedFiles.map((s) => ({ path: s.dest })),
      patches: dist.patches.map((p) => ({ path: p.path, lines: [...p.lines] })),
      createdAt: FIXED_TS,
      updatedAt: FIXED_TS,
    });
    await writeLockFile(path.join(repoRoot, LOCKFILE_RELATIVE_PATH), orphanLock);

    const { loadLockFile } = await import("../lockfile.js");
    const existingLock = await loadLockFile(repoRoot);
    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock: existingLock });
    expect(plan.hasConflicts).toBe(false);
    expect(plan.changes.some((c) => c.kind === "orphaned" && c.path === orphanPath)).toBe(true);

    const updatedAt = "2026-07-01T00:00:00.000Z";
    await applyPlan({ plan, distribution: dist, repoRoot, existingLock, now: updatedAt });

    const newLock = parseLockFile(await read(LOCKFILE_RELATIVE_PATH));
    // orphan は温存される。
    expect(newLock.managed_files.some((m) => m.path === orphanPath)).toBe(true);
    // created_at は引き継ぎ、updated_at は更新される。
    expect(newLock.created_at).toBe(FIXED_TS);
    expect(newLock.updated_at).toBe(updatedAt);
  });
});

describe("applyPlan: 防御", () => {
  it("conflict を含む plan は APPLY_HAS_CONFLICTS で throw する", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const conflictPlan: SyncPlan = {
      repoRoot,
      distribution: "base",
      currentVersion: null,
      targetVersion: "0.1.0",
      currentDistributionSha256: null,
      targetDistributionSha256: dist.contentSha256,
      versionUnchangedButContentChanged: false,
      changes: [],
      hasConflicts: true,
      warnings: [],
    };
    await expect(
      applyPlan({ plan: conflictPlan, distribution: dist, repoRoot, existingLock: null, now: FIXED_TS }),
    ).rejects.toMatchObject({ code: "APPLY_HAS_CONFLICTS" });
  });
});

describe("applyPlan: I/O 失敗（自動 rollback しない = §0.2.6/§17.3）", () => {
  it("lock 書き込み失敗時は ApplyIoError を投げ、先に書いた managed file は残る", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock: null });

    // lock file の path をディレクトリにして、最後の writeLockFile を EISDIR で確実に失敗させる。
    // permission に依存しないため root でも決定的に失敗する（前実装の chmod 依存 skip を排除）。
    await mkdir(path.join(repoRoot, LOCKFILE_RELATIVE_PATH), { recursive: true });

    let caught: unknown;
    try {
      await applyPlan({
        plan,
        distribution: dist,
        repoRoot,
        existingLock: null,
        now: FIXED_TS,
        repoName: "r",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApplyIoError);
    const ioError = caught as ApplyIoError;
    // 失敗したのは最後の lock 書き込み。
    expect(ioError.failedPath).toBe(LOCKFILE_RELATIVE_PATH);
    // 通常ファイルは lock より先に書かれるので touched / new に含まれ、実際にディスクへ書かれている。
    expect(ioError.touchedPaths).toContain(REVIEW_DEST);
    expect(ioError.newPaths).toContain(REVIEW_DEST);
    // 自動 rollback は行わないので、先に書かれた managed file は残る（手動復旧の対象）。
    expect(await read(REVIEW_DEST)).toBe(REVIEW_CONTENT);
  });
});

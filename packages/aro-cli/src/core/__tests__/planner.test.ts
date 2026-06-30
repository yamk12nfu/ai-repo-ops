import { rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalSha256OfString } from "../checksum.js";
import { buildSyncPlan, REASON_ORPHANED } from "../planner.js";
import { loadDistribution } from "../source.js";
import type { SyncChange } from "../../types/plan.js";
import {
  makeTempDir,
  REVIEW_REL,
  seedRepoAsSynced,
  setupBaseDistribution,
  WORKFLOW_REL,
  writeRaw,
  writeRawBytes,
} from "../../test-support/distribution.fixture.js";

let sourceRoot: string;
let repoRoot: string;

beforeEach(async () => {
  sourceRoot = await makeTempDir("aro-plan-src-");
  repoRoot = await makeTempDir("aro-plan-repo-");
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

/** changes から dest の change を1件取る。 */
function changeFor(changes: SyncChange[], dest: string): SyncChange | undefined {
  return changes.find((c) => c.path === dest);
}

const REVIEW_DEST = ".ai/managed/prompts/review.md";
const POLICY_DEST = ".ai/managed/policies/default.yaml";

describe("buildSyncPlan: 差分なし（synced repo）", () => {
  it("managed は noop、seed は preserve、conflict・orphaned なし", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock: await reloadLock() });

    expect(plan.hasConflicts).toBe(false);
    expect(changeFor(plan.changes, REVIEW_DEST)?.kind).toBe("noop");
    expect(changeFor(plan.changes, POLICY_DEST)?.kind).toBe("noop");
    expect(changeFor(plan.changes, ".ai/project.yaml")?.kind).toBe("preserve");
    expect(plan.changes.some((c) => c.kind === "orphaned")).toBe(false);
    expect(plan.versionUnchangedButContentChanged).toBe(false);
    // patch は適用済みなので noop
    expect(changeFor(plan.changes, ".gitignore")?.kind).toBe("noop");
    expect(changeFor(plan.changes, ".gitattributes")?.kind).toBe("noop");
  });

  /** 直前に seed した lock を再読み込みするヘルパ（seedRepoAsSynced が返す lock を使う方が速いが、明示再読込で round-trip も確かめる）。 */
  async function reloadLock() {
    const { loadLockFile } = await import("../lockfile.js");
    const lock = await loadLockFile(repoRoot);
    if (lock === null) throw new Error("lock should exist after seeding");
    return lock;
  }
});

describe("buildSyncPlan: 中央ファイルだけ更新", () => {
  it("source だけ新しいと update、version 同一なら content drift 警告", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist1 = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist1);

    // source の review.md だけ変更（version は 0.1.0 のまま）。
    await writeRaw(sourceRoot, REVIEW_REL, "# Review prompt CHANGED\n");
    const dist2 = await loadDistribution(sourceRoot, "base");

    const plan = await buildSyncPlan({ repoRoot, distribution: dist2, lock });

    const review = changeFor(plan.changes, REVIEW_DEST);
    expect(review?.kind).toBe("update");
    expect(review?.afterSha256).toBe(canonicalSha256OfString("# Review prompt CHANGED\n"));
    expect(changeFor(plan.changes, POLICY_DEST)?.kind).toBe("noop");
    expect(plan.hasConflicts).toBe(false);
    expect(plan.versionUnchangedButContentChanged).toBe(true);
    expect(plan.warnings.join("\n")).toMatch(/version is unchanged/);
  });
});

describe("buildSyncPlan: 人間が managed file を編集（conflict）", () => {
  it("repo の内容が lock とずれていれば conflict（hasConflicts true）", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist);

    await writeRaw(repoRoot, REVIEW_DEST, "# Review prompt\nLOCAL EDIT\n");

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock });

    const review = changeFor(plan.changes, REVIEW_DEST);
    expect(review?.kind).toBe("conflict");
    expect(review?.reason).toMatch(/locally modified/);
    expect(plan.hasConflicts).toBe(true);
  });
});

describe("buildSyncPlan: 新しい managed file が source に追加", () => {
  it("repo にも lock にも無い managed file は create", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist1 = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist1);

    // manifest に improve.md を追加し、その src も作る。
    await writeRaw(
      sourceRoot,
      "distribution/base/files/.ai/managed/prompts/improve.md",
      "# Improve prompt\n",
    );
    await writeRaw(
      sourceRoot,
      "distribution/base/manifest.yaml",
      `schema_version: 1
name: base
version: 0.1.0
files:
  - src: files/.ai/managed/prompts/review.md
    dest: .ai/managed/prompts/review.md
    strategy: managed_overwrite
  - src: files/.ai/managed/policies/default.yaml
    dest: .ai/managed/policies/default.yaml
    strategy: managed_overwrite
  - src: files/.ai/managed/prompts/improve.md
    dest: .ai/managed/prompts/improve.md
    strategy: managed_overwrite
seed_files:
  - dest: .ai/project.yaml
    template: project.yaml.hbs
    strategy: create_only
  - src: files/.github/workflows/ai-review.yml
    dest: .github/workflows/ai-review.yml
    strategy: create_only
patches:
  - type: append_unique_lines
    path: .gitignore
    lines:
      - .ai/runs/
      - .ai/tmp/
      - .ai/logs/
  - type: append_unique_lines
    path: .gitattributes
    lines:
      - "# ai-repo-ops managed text files"
      - ".ai/managed/** text eol=lf"
preserve:
  - .ai/project.yaml
  - .ai/local/**
`,
    );
    const dist2 = await loadDistribution(sourceRoot, "base");

    const plan = await buildSyncPlan({ repoRoot, distribution: dist2, lock });

    const improve = changeFor(plan.changes, ".ai/managed/prompts/improve.md");
    expect(improve?.kind).toBe("create");
    expect(improve?.createsFile).toBe(true);
    expect(changeFor(plan.changes, REVIEW_DEST)?.kind).toBe("noop");
  });
});

describe("buildSyncPlan: patch 追記が必要", () => {
  it(".gitignore / .gitattributes が未適用なら append_unique_lines", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    // applyPatches=false なので repo に patch ファイルは無い。
    const lock = await seedRepoAsSynced(repoRoot, dist, { applyPatches: false });

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock });

    const gitignore = changeFor(plan.changes, ".gitignore");
    expect(gitignore?.kind).toBe("append_unique_lines");
    expect(gitignore?.createsFile).toBe(true);
    expect(gitignore?.lines).toEqual([".ai/runs/", ".ai/tmp/", ".ai/logs/"]);

    const gitattributes = changeFor(plan.changes, ".gitattributes");
    expect(gitattributes?.kind).toBe("append_unique_lines");
    expect(gitattributes?.lines).toContain(".ai/managed/** text eol=lf");
  });

  it("一部だけ既存なら未追記行だけを足す", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist, { applyPatches: false });
    // .gitignore に既に1行だけある状態にする。
    await writeRaw(repoRoot, ".gitignore", ".ai/runs/\n");

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock });

    const gitignore = changeFor(plan.changes, ".gitignore");
    expect(gitignore?.kind).toBe("append_unique_lines");
    expect(gitignore?.lines).toEqual([".ai/tmp/", ".ai/logs/"]);
    expect(gitignore?.createsFile).toBeUndefined();
  });
});

describe("buildSyncPlan: create_only", () => {
  it("seed が repo に無ければ create", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist);
    // project.yaml を消して未作成状態にする。
    await rm(`${repoRoot}/.ai/project.yaml`);

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock });

    expect(changeFor(plan.changes, ".ai/project.yaml")?.kind).toBe("create");
  });
});

describe("buildSyncPlan: 改行・BOM 差分だけでは conflict にならない（§6.6）", () => {
  it("CRLF 差分だけなら noop", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist);
    // repo の review.md を CRLF に変換（内容は同じ）。
    await writeRaw(repoRoot, REVIEW_DEST, "# Review prompt\r\n");

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock });

    expect(changeFor(plan.changes, REVIEW_DEST)?.kind).toBe("noop");
    expect(plan.hasConflicts).toBe(false);
  });

  it("先頭 UTF-8 BOM 差分だけなら noop", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist);
    // BOM(EF BB BF) + 同一内容。
    await writeRawBytes(
      repoRoot,
      REVIEW_DEST,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Review prompt\n", "utf8")]),
    );

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock });

    expect(changeFor(plan.changes, REVIEW_DEST)?.kind).toBe("noop");
    expect(plan.hasConflicts).toBe(false);
  });

  it("実内容が変わっていれば改行に関係なく conflict", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist);
    await writeRaw(repoRoot, REVIEW_DEST, "# Review prompt\r\nEXTRA\r\n");

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock });

    expect(changeFor(plan.changes, REVIEW_DEST)?.kind).toBe("conflict");
  });
});

describe("buildSyncPlan: orphaned managed file（§16.4）", () => {
  it("lock にあるが manifest に無い managed file は orphaned（削除しない）", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist);
    // lock に古い managed file を足す（manifest には無い）。
    lock.managed_files.push({
      path: ".ai/managed/prompts/old-review.md",
      source: "distribution/base/files/.ai/managed/prompts/old-review.md",
      installed_sha256: canonicalSha256OfString("# old\n"),
      strategy: "managed_overwrite",
    });

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock });

    const orphan = changeFor(plan.changes, ".ai/managed/prompts/old-review.md");
    expect(orphan?.kind).toBe("orphaned");
    expect(orphan?.reason).toBe(REASON_ORPHANED);
    // orphaned は conflict ではない。
    expect(plan.hasConflicts).toBe(false);
  });
});

describe("buildSyncPlan: seed の source だけ変わった（§10.6）", () => {
  it("managed は全 noop・seed は preserve・content drift・version 同一なら WARN", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist1 = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist1);
    // seed(workflow) の source 内容だけ変更（managed は不変）。template/seed も content hash に含まれる（§10.6）。
    await writeRaw(sourceRoot, WORKFLOW_REL, "name: AI Review v2\n");
    const dist2 = await loadDistribution(sourceRoot, "base");

    const plan = await buildSyncPlan({ repoRoot, distribution: dist2, lock });

    // managed は全 noop、seed は preserve（既存）。
    expect(changeFor(plan.changes, REVIEW_DEST)?.kind).toBe("noop");
    expect(changeFor(plan.changes, POLICY_DEST)?.kind).toBe("noop");
    expect(changeFor(plan.changes, ".github/workflows/ai-review.yml")?.kind).toBe("preserve");
    expect(changeFor(plan.changes, ".ai/project.yaml")?.kind).toBe("preserve");
    // 実ファイル書き込みは無いが content hash は drift し、version 同一なので WARN。
    expect(plan.changes.some((c) => ["create", "update", "append_unique_lines"].includes(c.kind))).toBe(
      false,
    );
    expect(plan.currentDistributionSha256).not.toBe(plan.targetDistributionSha256);
    expect(plan.versionUnchangedButContentChanged).toBe(true);
    expect(plan.hasConflicts).toBe(false);
  });
});

describe("buildSyncPlan: lock が null（未 init）", () => {
  it("既存ファイルは untracked conflict、未作成は create", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    // repo に review.md だけ存在させる（lock なし）。
    await writeRaw(repoRoot, REVIEW_DEST, "# pre-existing\n");

    const plan = await buildSyncPlan({ repoRoot, distribution: dist, lock: null });

    expect(changeFor(plan.changes, REVIEW_DEST)?.kind).toBe("conflict");
    expect(changeFor(plan.changes, POLICY_DEST)?.kind).toBe("create");
    expect(plan.currentVersion).toBeNull();
    expect(plan.currentDistributionSha256).toBeNull();
  });
});

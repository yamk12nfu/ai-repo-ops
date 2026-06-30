import { mkdir, rm } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeDiff, type DiffIo, type DiffOptions } from "../diff.js";
import { formatDiffHuman } from "../diff-format.js";
import { loadDistribution } from "../../core/source.js";
import type { SyncPlan } from "../../types/plan.js";
import {
  makeTempDir,
  REVIEW_REL,
  seedRepoAsSynced,
  setupBaseDistribution,
  WORKFLOW_REL,
  writeRaw,
} from "../../test-support/distribution.fixture.js";

let sourceRoot: string;
let repoRoot: string;

const REVIEW_DEST = ".ai/managed/prompts/review.md";

beforeEach(async () => {
  sourceRoot = await makeTempDir("aro-diff-src-");
  repoRoot = await makeTempDir("aro-diff-repo-");
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

/** テスト用 DiffOptions を作る。 */
function options(overrides: Partial<DiffOptions> = {}): DiffOptions {
  return {
    repo: repoRoot,
    distribution: "base",
    source: sourceRoot,
    dryRun: false,
    json: false,
    verbose: false,
    color: false,
    detailedExitcode: false,
    ...overrides,
  };
}

/** stdout/stderr を文字列配列にためる IO。 */
function captureIo(): { io: DiffIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      stdout: (text) => outChunks.push(text),
      stderr: (text) => errChunks.push(text),
      color: false,
    },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

describe("executeDiff: 差分なし", () => {
  it("synced repo は通常モードで exit 0・up to date を表示", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);

    const cap = captureIo();
    const code = await executeDiff(options(), cap.io);

    expect(code).toBe(0);
    expect(cap.out()).toContain("Up to date");
    expect(cap.out()).not.toContain("Will update");
    expect(cap.out()).not.toContain("Conflicts:");
  });

  it("synced repo は --detailed-exitcode でも exit 0", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);

    const cap = captureIo();
    const code = await executeDiff(options({ detailedExitcode: true }), cap.io);
    expect(code).toBe(0);
  });
});

describe("executeDiff: 中央更新あり（conflict なし）", () => {
  it("通常モードは exit 0、--detailed-exitcode は exit 2", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist1 = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist1);
    await writeRaw(sourceRoot, REVIEW_REL, "# Review prompt CHANGED\n");

    const normal = captureIo();
    expect(await executeDiff(options(), normal.io)).toBe(0);
    expect(normal.out()).toContain("Will update");
    expect(normal.out()).toContain(REVIEW_DEST);

    const detailed = captureIo();
    expect(await executeDiff(options({ detailedExitcode: true }), detailed.io)).toBe(2);
  });
});

describe("executeDiff: conflict", () => {
  it("通常モードは exit 2、--detailed-exitcode は exit 3", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);
    await writeRaw(repoRoot, REVIEW_DEST, "# Review prompt\nLOCAL\n");

    const normal = captureIo();
    expect(await executeDiff(options(), normal.io)).toBe(2);
    expect(normal.out()).toContain("Conflicts:");
    expect(normal.out()).toContain("git restore");

    const detailed = captureIo();
    expect(await executeDiff(options({ detailedExitcode: true }), detailed.io)).toBe(3);
  });
});

describe("executeDiff: validation error", () => {
  it("lock が無い repo は exit 1・init を案内する", async () => {
    await setupBaseDistribution(sourceRoot);
    // repo は seed しない（lock 無し）。
    const cap = captureIo();
    const code = await executeDiff(options(), cap.io);

    expect(code).toBe(1);
    expect(cap.err()).toContain("aro init");
  });

  it("存在しない distribution は exit 1", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);

    const cap = captureIo();
    const code = await executeDiff(options({ distribution: "nope" }), cap.io);
    expect(code).toBe(1);
  });

  it("--detailed-exitcode でも validation error は exit 1（unexpected の 4 ではない）", async () => {
    await setupBaseDistribution(sourceRoot);
    const cap = captureIo();
    const code = await executeDiff(options({ detailedExitcode: true }), cap.io);
    expect(code).toBe(1);
  });
});

describe("executeDiff: §10.6 seed だけ drift（create_only 温存）", () => {
  it("通常 exit 0 / detailed exit 2、drift メッセージは Preserved の直前に出る", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist1 = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist1);
    // seed(workflow) の source 内容だけ変更（managed は不変）。
    await writeRaw(sourceRoot, WORKFLOW_REL, "name: AI Review v2\n");

    const normal = captureIo();
    expect(await executeDiff(options(), normal.io)).toBe(0);
    const out = normal.out();
    expect(out).toContain(
      "Distribution content changed, but existing create_only files are preserved.",
    );
    expect(out).toContain("Preserved:");
    // §10.6 の表示順: drift メッセージが Preserved 節より前。
    expect(out.indexOf("Distribution content changed")).toBeLessThan(out.indexOf("Preserved:"));
    // content drift があるので「up to date」とは言わない。
    expect(out).not.toContain("Up to date");

    // sync 対象（lock の content sha 更新）があるので detailed は 2。
    const detailed = captureIo();
    expect(await executeDiff(options({ detailedExitcode: true }), detailed.io)).toBe(2);
  });
});

describe("executeDiff: unexpected error", () => {
  it("非 AroError は通常 exit 3 / detailed exit 4", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist);
    // lock file の位置をディレクトリにし、readFile を EISDIR（非 AroError）で失敗させる。
    await rm(`${repoRoot}/.ai/ai-repo-ops.lock.yaml`);
    await mkdir(`${repoRoot}/.ai/ai-repo-ops.lock.yaml`, { recursive: true });

    const normal = captureIo();
    expect(await executeDiff(options(), normal.io)).toBe(3);

    const detailed = captureIo();
    expect(await executeDiff(options({ detailedExitcode: true }), detailed.io)).toBe(4);
  });
});

describe("executeDiff: --json", () => {
  it("plan を JSON で出力する", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist1 = await loadDistribution(sourceRoot, "base");
    await seedRepoAsSynced(repoRoot, dist1);
    await writeRaw(sourceRoot, REVIEW_REL, "# Review prompt CHANGED\n");

    const cap = captureIo();
    const code = await executeDiff(options({ json: true, detailedExitcode: true }), cap.io);
    expect(code).toBe(2);

    const parsed = JSON.parse(cap.out()) as SyncPlan;
    expect(parsed.distribution).toBe("base");
    expect(parsed.hasConflicts).toBe(false);
    expect(parsed.versionUnchangedButContentChanged).toBe(true);
    const review = parsed.changes.find((c) => c.path === REVIEW_DEST);
    expect(review?.kind).toBe("update");
  });
});

describe("formatDiffHuman: 構造", () => {
  it("各節とサマリを含む（plain）", async () => {
    await setupBaseDistribution(sourceRoot);
    const dist1 = await loadDistribution(sourceRoot, "base");
    const lock = await seedRepoAsSynced(repoRoot, dist1);
    await writeRaw(sourceRoot, REVIEW_REL, "# Review prompt CHANGED\n");
    const dist2 = await loadDistribution(sourceRoot, "base");

    const { buildSyncPlan } = await import("../../core/planner.js");
    const plan = await buildSyncPlan({ repoRoot, distribution: dist2, lock });
    const text = formatDiffHuman(plan, { color: false });

    expect(text).toContain("ai-repo-ops diff");
    expect(text).toContain("Distribution: base");
    expect(text).toContain("Will update:");
    expect(text).toContain("Summary:");
    // plain なので ANSI エスケープは含まない。
    expect(text).not.toContain("\u001b[");
  });
});

describe("formatDiffHuman: 全節の描画（合成 plan）", () => {
  /** update/create/append/conflict/orphaned/preserve/WARN を1つずつ含む合成 plan。 */
  function allKindsPlan(): SyncPlan {
    return {
      repoRoot: "/repo",
      distribution: "base",
      currentVersion: "0.1.0",
      targetVersion: "0.1.0",
      currentDistributionSha256: "a".repeat(64),
      targetDistributionSha256: "b".repeat(64),
      versionUnchangedButContentChanged: true,
      hasConflicts: true,
      warnings: ["manifest version is unchanged, but distribution content changed."],
      changes: [
        { kind: "update", path: ".ai/managed/prompts/review.md", strategy: "managed_overwrite" },
        {
          kind: "create",
          path: ".ai/managed/prompts/new.md",
          strategy: "managed_overwrite",
          createsFile: true,
        },
        {
          kind: "append_unique_lines",
          path: ".gitignore",
          strategy: "append_unique_lines",
          lines: [".ai/runs/", ".ai/tmp/"],
          createsFile: true,
        },
        {
          kind: "conflict",
          path: ".ai/managed/policies/default.yaml",
          strategy: "managed_overwrite",
          reason: "locally modified since last sync",
        },
        {
          kind: "orphaned",
          path: ".ai/managed/prompts/old.md",
          strategy: "managed_overwrite",
          reason: "present in lock file but no longer present in source manifest",
        },
        { kind: "preserve", path: ".ai/project.yaml", strategy: "create_only" },
      ],
    };
  }

  it("全節と入れ子の追記行・orphaned action・WARN・Summary を描画する（plain）", () => {
    const text = formatDiffHuman(allKindsPlan(), { color: false });
    expect(text).toContain("WARN");
    expect(text).toContain("Will update:");
    expect(text).toContain("Will create:");
    expect(text).toContain("Will append lines:");
    expect(text).toContain("  + .gitignore");
    expect(text).toContain("    + .ai/runs/");
    expect(text).toContain("    + .ai/tmp/");
    expect(text).toContain("Conflicts:");
    expect(text).toContain("git restore -- .ai/managed/policies/default.yaml");
    expect(text).toContain("Orphaned managed files:");
    expect(text).toContain("action: not deleted in MVP");
    expect(text).toContain("Preserved:");
    expect(text).toContain("Summary:");
    expect(text).not.toContain("Up to date");
    // plain なので ANSI（[ を含む）は出ない。
    expect(text).not.toContain("[");
  });

  it("color=true なら ANSI（[）を含む", () => {
    const text = formatDiffHuman(allKindsPlan(), { color: true });
    expect(text).toContain("[");
  });

  it("content drift のみ・preserve 無し（seedless）でも『no changes』と言わず drift を明示する", () => {
    // §10.6 / 指摘#4: 実ファイル書き込みは無いが content sha drift で sync 対象あり。
    const plan: SyncPlan = {
      repoRoot: "/repo",
      distribution: "base",
      currentVersion: "0.1.0",
      targetVersion: "0.1.0",
      currentDistributionSha256: "a".repeat(64),
      targetDistributionSha256: "b".repeat(64),
      versionUnchangedButContentChanged: true,
      hasConflicts: false,
      warnings: ["manifest version is unchanged, but distribution content changed."],
      changes: [
        { kind: "noop", path: ".ai/managed/prompts/review.md", strategy: "managed_overwrite" },
      ],
    };
    const text = formatDiffHuman(plan, { color: false });
    expect(text).toContain("Distribution content changed; the lock file will be updated on sync.");
    // 出力と exit code（content drift → detailed 2）の矛盾を避けるため up-to-date / no changes と言わない。
    expect(text).not.toContain("Up to date");
    expect(text).not.toContain("no changes");
  });
});

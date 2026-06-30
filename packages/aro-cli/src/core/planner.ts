/**
 * sync planner。lock file と source distribution から {@link SyncPlan} を生成する。
 *
 * 計画 v3 §15 / §16 に対応する。init / diff / sync はすべてこの planner を経由する（§5.2）。
 * planner は対象 repo の現状（managed file の canonical sha・seed file の存在・patch 対象の内容）を
 * 読み取り、変更種別を判定するだけで、実ファイルの書き込みは一切行わない（読み取り専用）。
 *
 * 対象 repo 配下の読み取りはすべて {@link readFileWithinRoot} を通すため、path traversal と
 * symlink 追従（§20.1 / §20.2）を防げる。
 */
import { classifyCreateOnly, classifyManagedOverwrite } from "./conflict.js";
import { computeAppendUniqueLines } from "./append-unique-lines.js";
import { canonicalSha256 } from "./checksum.js";
import { readFileWithinRoot } from "./filesystem.js";
import type { LoadedDistribution } from "./source.js";
import type { LockFile } from "./lockfile.js";
import type { SyncChange, SyncPlan } from "../types/plan.js";

/** orphaned managed file の理由文（§16.4）。 */
export const REASON_ORPHANED =
  "present in lock file but no longer present in source manifest";

/** {@link buildSyncPlan} の入力。 */
export interface BuildSyncPlanInput {
  /** 対象 repo root（絶対 path 推奨。内部で resolve する）。 */
  repoRoot: string;
  /** 読み込み済み source distribution（{@link import("./source.js").loadDistribution}）。 */
  distribution: LoadedDistribution;
  /**
   * 対象 repo の lock file。未 init（lock が無い）なら null。
   * null の場合、既存 managed file は「lock に記録なし」として conflict 判定される（§16.1）。
   */
  lock: LockFile | null;
}

/**
 * target（repo 配下の相対 path）の現在 canonical sha256 を返す。存在しなければ null。
 * symlink 非追従・traversal 拒否を {@link readFileWithinRoot} が担保する。
 */
async function targetCanonicalSha(
  repoRoot: string,
  relativePath: string,
  label: string,
): Promise<string | null> {
  const buffer = await readFileWithinRoot(repoRoot, relativePath, label);
  return buffer === null ? null : canonicalSha256(buffer);
}

/** target（repo 配下の相対 path）の生テキストを返す。存在しなければ null。 */
async function targetText(
  repoRoot: string,
  relativePath: string,
  label: string,
): Promise<string | null> {
  const buffer = await readFileWithinRoot(repoRoot, relativePath, label);
  return buffer === null ? null : buffer.toString("utf8");
}

/** managed_overwrite ファイル群の変更を判定する。 */
async function planManagedFiles(
  input: BuildSyncPlanInput,
  lockByPath: Map<string, string>,
): Promise<SyncChange[]> {
  const changes: SyncChange[] = [];
  for (const file of input.distribution.managedFiles) {
    const targetSha256 = await targetCanonicalSha(input.repoRoot, file.dest, "files[].dest");
    const installedSha256 = lockByPath.get(file.dest) ?? null;
    const classification = classifyManagedOverwrite({
      targetSha256,
      installedSha256,
      sourceSha256: file.sourceSha256,
    });
    const willWrite = classification.kind === "create" || classification.kind === "update";
    changes.push({
      kind: classification.kind,
      path: file.dest,
      strategy: "managed_overwrite",
      reason: classification.reason,
      beforeSha256: targetSha256,
      installedSha256,
      afterSha256: willWrite ? file.sourceSha256 : undefined,
      sourcePath: file.src,
      createsFile: classification.kind === "create" ? true : undefined,
    });
  }
  return changes;
}

/** create_only seed file 群の変更を判定する。 */
async function planSeedFiles(input: BuildSyncPlanInput): Promise<SyncChange[]> {
  const changes: SyncChange[] = [];
  for (const seed of input.distribution.seedFiles) {
    const exists =
      (await readFileWithinRoot(input.repoRoot, seed.dest, "seed_files[].dest")) !== null;
    const { kind } = classifyCreateOnly(exists);
    changes.push({
      kind,
      path: seed.dest,
      strategy: "create_only",
      afterSha256: kind === "create" ? seed.sourceSha256 : undefined,
      sourcePath: seed.sourcePath,
      createsFile: kind === "create" ? true : undefined,
    });
  }
  return changes;
}

/** append_unique_lines patch 群の変更を判定する。 */
async function planPatches(input: BuildSyncPlanInput): Promise<SyncChange[]> {
  const changes: SyncChange[] = [];
  for (const patch of input.distribution.patches) {
    const existing = await targetText(input.repoRoot, patch.path, "patches[].path");
    const result = computeAppendUniqueLines(existing, patch.lines);
    changes.push({
      kind: result.changed ? "append_unique_lines" : "noop",
      path: patch.path,
      strategy: "append_unique_lines",
      lines: result.addedLines,
      createsFile: result.created ? true : undefined,
    });
  }
  return changes;
}

/**
 * orphaned managed file（lock にあるが現 manifest の dest に無い）を検出する（§16.4）。
 * MVP では削除も lock からの除去もしない。WARN として change に積むだけ。
 */
function planOrphans(input: BuildSyncPlanInput): SyncChange[] {
  if (input.lock === null) {
    return [];
  }
  const manifestDests = new Set(input.distribution.managedFiles.map((m) => m.dest));
  const changes: SyncChange[] = [];
  for (const entry of input.lock.managed_files) {
    if (!manifestDests.has(entry.path)) {
      changes.push({
        kind: "orphaned",
        path: entry.path,
        strategy: "managed_overwrite",
        reason: REASON_ORPHANED,
        installedSha256: entry.installed_sha256,
      });
    }
  }
  return changes;
}

/** change を (path, kind) 昇順で安定ソートする（diff / JSON 出力の決定性のため）。 */
function sortChanges(changes: SyncChange[]): SyncChange[] {
  return [...changes].sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });
}

/**
 * lock file と source distribution から sync plan を生成する。
 *
 * 手順（§16）:
 *   1. managed_overwrite: 各 dest の canonical sha と lock installed_sha・source sha を比較
 *   2. create_only seed: target 存在で create / preserve
 *   3. append_unique_lines patch: 未追記行を計算
 *   4. orphaned: lock にあるが manifest に無い managed file を WARN
 *   5. version / content hash を比較し versionUnchangedButContentChanged を判定（§10.5）
 *
 * @throws {import("./errors.js").PathSafetyError} 対象 repo 配下に symlink 構成要素がある場合など。
 */
export async function buildSyncPlan(input: BuildSyncPlanInput): Promise<SyncPlan> {
  const lockByPath = new Map<string, string>(
    (input.lock?.managed_files ?? []).map((m) => [m.path, m.installed_sha256]),
  );

  const managed = await planManagedFiles(input, lockByPath);
  const seeds = await planSeedFiles(input);
  const patches = await planPatches(input);
  const orphans = planOrphans(input);

  const changes = sortChanges([...managed, ...seeds, ...patches, ...orphans]);

  const currentVersion = input.lock?.source.version ?? null;
  const targetVersion = input.distribution.manifest.version;
  const currentDistributionSha256 = input.lock?.source.distribution_content_sha256 ?? null;
  const targetDistributionSha256 = input.distribution.contentSha256;

  const versionUnchangedButContentChanged =
    currentVersion !== null &&
    currentVersion === targetVersion &&
    currentDistributionSha256 !== null &&
    currentDistributionSha256 !== targetDistributionSha256;

  const hasConflicts = changes.some((c) => c.kind === "conflict");

  const warnings: string[] = [];
  if (versionUnchangedButContentChanged) {
    warnings.push(
      "manifest version is unchanged, but distribution content changed. " +
        "Consider bumping manifest.version before release.",
    );
  }

  return {
    repoRoot: input.repoRoot,
    distribution: input.distribution.location.distribution,
    currentVersion,
    targetVersion,
    currentDistributionSha256,
    targetDistributionSha256,
    versionUnchangedButContentChanged,
    changes,
    hasConflicts,
    warnings,
  };
}

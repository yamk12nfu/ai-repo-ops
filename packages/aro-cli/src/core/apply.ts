/**
 * sync plan の適用エンジン（計画 v3 §17.3 / §5.3 / §0.2.6）。
 *
 * init / sync はともにこの {@link applyPlan} を経由して実ファイルを書く。plan は「何をするか」を、
 * {@link import("./source.js").LoadedDistribution} は「書き込む内容」を持つので、両者を join して適用する。
 *
 * atomicity（MVP の 2 段保証。計画 §0.2.6 / §17.3）:
 *   1. conflict atomicity（必須）: conflict があれば呼び出し前に abort する。applyPlan は
 *      防御として `plan.hasConflicts` を検査し、true なら何も書かずに throw する。
 *   2. I/O failure recovery（手動復旧導線。**自動 rollback ではない**）: 全変更内容を
 *      **メモリ上で準備**（path 検証・symlink 検査・追記内容の確定）してから書き込みフェーズに入る。
 *      書き込み中に失敗しても aro は元 bytes を復元しない（自前 backup/restore 機構は持たない）。
 *      代わりに {@link ApplyIoError} に touched paths / new paths を載せて投げ、呼び出し側が
 *      「既存ファイル= git restore / 新規ファイル= 削除」の復旧手順を案内できるようにする。
 *
 * 書き込み順序（§17.3）: 通常ファイル（managed / seed）→ patch 対象 → lock file。lock は必ず最後。
 *
 * 対象 repo 配下の読み書きはすべて path 安全性検査（traversal / 絶対 path / 予約名）と symlink 非追従検査を
 * 通すため、symlink 経由の repo 外書き込みや path 脱出を防げる（§20.1 / §20.2）。
 */
import path from "node:path";

import { computeAppendUniqueLines } from "./append-unique-lines.js";
import { AroError } from "./errors.js";
import { assertNoSymlinkInPath, readFileWithinRoot, writeTextFileLf } from "./filesystem.js";
import {
  buildLockFile,
  LOCKFILE_RELATIVE_PATH,
  writeLockFile,
  type LockFile,
} from "./lockfile.js";
import { resolveWithinRoot } from "./paths.js";
import type { LoadedDistribution } from "./source.js";
import { deriveRepoName, renderTemplate } from "./template.js";
import type { SyncChange, SyncPlan } from "../types/plan.js";

/**
 * 書き込み中（書き込みフェーズ）の I/O 失敗を表すエラー（§17.3 の I/O failure rollback）。
 * すでに touch（書き込み試行）した path を保持し、呼び出し側が復旧導線を出せるようにする。
 *
 * 復旧導線は「既存ファイル（tracked）= git restore」「新規作成ファイル = 削除」で手段が異なるため（§17.3）、
 * touch した path を「新規作成だったか」で区別できるよう {@link newPaths} を併せて保持する。
 */
export class ApplyIoError extends AroError {
  /** 失敗時点までに書き込みを試みた repo 相対 path（失敗した path を含む。表示用の全件）。 */
  readonly touchedPaths: readonly string[];
  /** {@link touchedPaths} のうち「新規作成」だった path（復旧では git restore ではなく削除の対象）。 */
  readonly newPaths: readonly string[];
  /** 失敗した repo 相対 path。 */
  readonly failedPath: string;

  constructor(
    failedPath: string,
    touchedPaths: readonly string[],
    newPaths: readonly string[],
    cause: unknown,
  ) {
    super(
      "APPLY_IO_FAILED",
      `ファイル書き込み中にエラーが発生しました: ${failedPath}`,
      { cause },
    );
    this.failedPath = failedPath;
    this.touchedPaths = [...touchedPaths];
    this.newPaths = [...newPaths];
  }
}

/** 適用された 1 件の append_unique_lines patch の結果。 */
export interface AppliedPatch {
  /** repo 相対 path。 */
  path: string;
  /** 実際に追記された行。 */
  addedLines: string[];
  /** ファイルを新規作成したか。 */
  created: boolean;
}

/** {@link applyPlan} の結果サマリ。 */
export interface ApplyResult {
  /** 新規作成した managed / seed ファイルの repo 相対 path。 */
  creates: string[];
  /** 内容更新した managed ファイルの repo 相対 path。 */
  updates: string[];
  /** 追記を行った patch ファイル。 */
  patches: AppliedPatch[];
  /** lock file の repo 相対 path。 */
  lockPath: string;
  /** lock file を新規作成したか（true=作成 / false=更新）。 */
  lockWasCreated: boolean;
  /** 書き込みを試みた repo 相対 path（順序つき。成功時は全て書き込み済み）。 */
  touchedPaths: string[];
}

/** {@link applyPlan} の入力。 */
export interface ApplyPlanInput {
  /** conflict を含まない sync plan。 */
  plan: SyncPlan;
  /** plan の元になった source distribution（書き込む内容を持つ）。 */
  distribution: LoadedDistribution;
  /** 対象 repo root（絶対 path 推奨。内部で resolve する）。 */
  repoRoot: string;
  /** 既存 lock file（未 init なら null）。created_at の引き継ぎに使う。 */
  existingLock: LockFile | null;
  /** lock の created_at/updated_at に使う ISO 文字列（決定性のため呼び出し側が渡す）。 */
  now: string;
  /** seed template に渡す repo 名。省略時は repoRoot から導く。 */
  repoName?: string | undefined;
}

/** 準備済みの通常ファイル書き込み（managed / seed）。 */
interface PreparedFileWrite {
  relativePath: string;
  absolutePath: string;
  content: string;
  kind: "create" | "update";
}

/** 準備済みの patch 書き込み（append_unique_lines）。 */
interface PreparedPatchWrite {
  relativePath: string;
  absolutePath: string;
  content: string;
  addedLines: string[];
  created: boolean;
}

/** 準備フェーズの成果物（メモリ上に確定した全書き込み内容）。 */
interface PreparedWrites {
  fileWrites: PreparedFileWrite[];
  patchWrites: PreparedPatchWrite[];
  lock: LockFile;
  lockRelativePath: string;
  lockAbsolutePath: string;
  lockWasCreated: boolean;
}

/**
 * managed file の dest -> 配布内容のマップ。
 * planner の change は plan/source 双方で同じ dest を使うため、dest で join できる。
 */
function managedByDest(distribution: LoadedDistribution): Map<string, LoadedDistribution["managedFiles"][number]> {
  return new Map(distribution.managedFiles.map((m) => [m.dest, m]));
}

/** seed file の dest -> 配布内容のマップ。 */
function seedByDest(distribution: LoadedDistribution): Map<string, LoadedDistribution["seedFiles"][number]> {
  return new Map(distribution.seedFiles.map((s) => [s.dest, s]));
}

/** patch の path -> 配布内容のマップ。 */
function patchByPath(distribution: LoadedDistribution): Map<string, LoadedDistribution["patches"][number]> {
  return new Map(distribution.patches.map((p) => [p.path, p]));
}

/** distribution の managed dest 集合（orphan 判定に使う）。 */
function distributionDests(distribution: LoadedDistribution): Set<string> {
  return new Set(distribution.managedFiles.map((m) => m.dest));
}

/**
 * lock file の managed_files に記録する source ref（source repo root からの相対 path）を作る。
 * 例: distribution=base, src=files/.ai/managed/prompts/review.md
 *     -> distribution/base/files/.ai/managed/prompts/review.md
 */
function managedSourceRef(distributionName: string, src: string): string {
  return `distribution/${distributionName}/${src}`;
}

/**
 * 適用後の lock file を構築する。
 *
 * - managed_files: 現 distribution の全 managed file（installed_sha256 = source の canonical sha）。
 *   さらに、旧 lock にあるが現 manifest に無い orphaned エントリは「自動削除しない」（§16.4）ため、
 *   旧 lock の内容のまま温存して末尾に残す。
 * - seed_files / patches: 現 distribution の内容で全置換する。
 * - created_at: 既存 lock があれば引き継ぐ。無ければ now。updated_at は常に now。
 */
function buildAppliedLock(input: ApplyPlanInput): LockFile {
  const { distribution } = input;
  const distributionName = distribution.location.distribution;
  const dests = distributionDests(distribution);

  const managedFromDistribution = distribution.managedFiles.map((m) => ({
    path: m.dest,
    source: managedSourceRef(distributionName, m.src),
    installedSha256: m.sourceSha256,
  }));

  // §16.4: lock にあるが現 manifest に無い managed file（orphaned）は lock からも自動削除しない。
  const orphanedFromOldLock = (input.existingLock?.managed_files ?? [])
    .filter((entry) => !dests.has(entry.path))
    .map((entry) => ({
      path: entry.path,
      source: entry.source,
      installedSha256: entry.installed_sha256,
    }));

  const createdAt = input.existingLock?.created_at ?? input.now;

  return buildLockFile({
    repository: input.existingLock?.source.repository,
    distribution: distributionName,
    version: distribution.manifest.version,
    commit: input.existingLock?.source.commit ?? null,
    distributionContentSha256: distribution.contentSha256,
    managedFiles: [...managedFromDistribution, ...orphanedFromOldLock],
    seedFiles: distribution.seedFiles.map((s) => ({ path: s.dest })),
    patches: distribution.patches.map((p) => ({ path: p.path, lines: [...p.lines] })),
    createdAt,
    updatedAt: input.now,
  });
}

/**
 * 通常ファイル（managed create/update・seed create）1 件の書き込みを準備する。
 * path 検証・symlink 検査・内容確定をここで行い、書き込みフェーズには I/O だけを残す。
 */
async function prepareFileWrite(
  change: SyncChange,
  repoRoot: string,
  repoName: string,
  managed: ReturnType<typeof managedByDest>,
  seeds: ReturnType<typeof seedByDest>,
): Promise<PreparedFileWrite> {
  if (change.strategy === "managed_overwrite") {
    const source = managed.get(change.path);
    if (source === undefined) {
      throw new AroError(
        "APPLY_INTERNAL",
        `内部エラー: managed change の source が見つかりません: ${change.path}`,
      );
    }
    const absolutePath = resolveWithinRoot(repoRoot, change.path, "files[].dest");
    await assertNoSymlinkInPath(repoRoot, change.path, "files[].dest");
    return {
      relativePath: change.path,
      absolutePath,
      content: source.content,
      kind: change.kind === "update" ? "update" : "create",
    };
  }

  // create_only seed（kind は create のみがここに来る）。
  const seed = seeds.get(change.path);
  if (seed === undefined) {
    throw new AroError(
      "APPLY_INTERNAL",
      `内部エラー: seed change の source が見つかりません: ${change.path}`,
    );
  }
  const absolutePath = resolveWithinRoot(repoRoot, change.path, "seed_files[].dest");
  await assertNoSymlinkInPath(repoRoot, change.path, "seed_files[].dest");
  // template seed だけプレースホルダを置換する。src seed はそのまま書く。
  const content =
    seed.sourceKind === "template" ? renderTemplate(seed.content, { repo_name: repoName }) : seed.content;
  return { relativePath: change.path, absolutePath, content, kind: "create" };
}

/**
 * patch（append_unique_lines）1 件の書き込みを準備する。
 * 現在の対象ファイルを読み、追記後の内容をメモリ上で確定する。
 * apply 時の再読込で行が既に揃っていれば（並行編集など）書き込み不要なので null を返す。
 */
async function preparePatchWrite(
  change: SyncChange,
  repoRoot: string,
  patches: ReturnType<typeof patchByPath>,
): Promise<PreparedPatchWrite | null> {
  const patch = patches.get(change.path);
  if (patch === undefined) {
    throw new AroError(
      "APPLY_INTERNAL",
      `内部エラー: patch change の source が見つかりません: ${change.path}`,
    );
  }
  const absolutePath = resolveWithinRoot(repoRoot, change.path, "patches[].path");
  const existingBuffer = await readFileWithinRoot(repoRoot, change.path, "patches[].path");
  const existing = existingBuffer === null ? null : existingBuffer.toString("utf8");
  const result = computeAppendUniqueLines(existing, patch.lines);
  if (!result.changed) {
    return null;
  }
  return {
    relativePath: change.path,
    absolutePath,
    content: result.content,
    addedLines: result.addedLines,
    created: result.created,
  };
}

/**
 * plan の全変更内容をメモリ上に準備する（書き込みはしない）。
 * path 安全性・symlink 違反はここで throw されるため、不正な配布物では一切書き込まない。
 */
async function prepareWrites(input: ApplyPlanInput): Promise<PreparedWrites> {
  const repoRoot = path.resolve(input.repoRoot);
  const repoName = input.repoName ?? deriveRepoName(repoRoot);
  const managed = managedByDest(input.distribution);
  const seeds = seedByDest(input.distribution);
  const patches = patchByPath(input.distribution);

  const fileWrites: PreparedFileWrite[] = [];
  const patchWrites: PreparedPatchWrite[] = [];

  for (const change of input.plan.changes) {
    if (change.kind === "create" || change.kind === "update") {
      fileWrites.push(await prepareFileWrite(change, repoRoot, repoName, managed, seeds));
    } else if (change.kind === "append_unique_lines") {
      const prepared = await preparePatchWrite(change, repoRoot, patches);
      if (prepared !== null) {
        patchWrites.push(prepared);
      }
    }
    // preserve / noop / orphaned はファイルを書かない。conflict は applyPlan 入口で弾く。
  }

  const lockRelativePath = LOCKFILE_RELATIVE_PATH;
  const lockAbsolutePath = resolveWithinRoot(repoRoot, lockRelativePath, "lock file");
  await assertNoSymlinkInPath(repoRoot, lockRelativePath, "lock file");
  const lock = buildAppliedLock({ ...input, repoRoot });
  const lockWasCreated = input.existingLock === null;

  return { fileWrites, patchWrites, lock, lockRelativePath, lockAbsolutePath, lockWasCreated };
}

/**
 * sync plan を対象 repo へ適用する。
 *
 * 手順:
 *   1. conflict があれば防御的に throw（呼び出し側で先に検査・abort 済みのはず）。
 *   2. 全変更内容をメモリ上に準備（path 検証・symlink 検査・追記内容確定）。
 *   3. 通常ファイル → patch → lock の順で書き込む。失敗時は {@link ApplyIoError} を投げる。
 *
 * @throws {ApplyIoError} 書き込みフェーズでの I/O 失敗。
 * @throws {import("./errors.js").PathSafetyError} 準備フェーズでの path / symlink 違反（書き込み前）。
 * @throws {AroError} plan に conflict が含まれる場合（`APPLY_HAS_CONFLICTS`）。
 */
export async function applyPlan(input: ApplyPlanInput): Promise<ApplyResult> {
  if (input.plan.hasConflicts) {
    // 通常ここには到達しない（コマンド側が conflict を検出して abort する）。多重防御。
    throw new AroError(
      "APPLY_HAS_CONFLICTS",
      "内部エラー: conflict を含む plan を適用しようとしました。",
      { hint: "conflict 時は適用せず abort する必要があります（§5.3）。" },
    );
  }

  const prepared = await prepareWrites(input);

  const touchedPaths: string[] = [];
  const newPaths: string[] = [];
  let currentPath = "";
  // 書き込み試行を記録してから書く。新規作成（isNew）は復旧で削除対象、それ以外は git restore 対象。
  const recordTouch = (relativePath: string, isNew: boolean): void => {
    currentPath = relativePath;
    touchedPaths.push(relativePath);
    if (isNew) {
      newPaths.push(relativePath);
    }
  };
  try {
    // 書き込み順序（§17.3）: 通常ファイル → patch → lock。lock は必ず最後。
    for (const write of prepared.fileWrites) {
      recordTouch(write.relativePath, write.kind === "create");
      await writeTextFileLf(write.absolutePath, write.content);
    }
    for (const write of prepared.patchWrites) {
      recordTouch(write.relativePath, write.created);
      await writeTextFileLf(write.absolutePath, write.content);
    }
    recordTouch(prepared.lockRelativePath, prepared.lockWasCreated);
    await writeLockFile(prepared.lockAbsolutePath, prepared.lock);
  } catch (error) {
    throw new ApplyIoError(currentPath, touchedPaths, newPaths, error);
  }

  const creates = prepared.fileWrites.filter((w) => w.kind === "create").map((w) => w.relativePath);
  const updates = prepared.fileWrites.filter((w) => w.kind === "update").map((w) => w.relativePath);
  const patches: AppliedPatch[] = prepared.patchWrites.map((w) => ({
    path: w.relativePath,
    addedLines: w.addedLines,
    created: w.created,
  }));

  return {
    creates,
    updates,
    patches,
    lockPath: prepared.lockRelativePath,
    lockWasCreated: prepared.lockWasCreated,
    touchedPaths,
  };
}

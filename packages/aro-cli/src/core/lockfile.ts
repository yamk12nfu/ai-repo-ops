/**
 * lock file（.ai/ai-repo-ops.lock.yaml）の zod schema・read/write・構築。
 *
 * 計画 v3 §11 に対応する。lock file は aro が管理し人間は手編集しない（§11.3）。
 * 読み書きしても内容が維持されること（round-trip 同値）を保証する。
 * 改行は最終的に {@link import("./filesystem.js").writeTextFileLf} が LF・BOM なしに揃える。
 */
import { z } from "zod";

import { CHECKSUM_ALGORITHM, CHECKSUM_MODE } from "./checksum.js";
import { LockFileError } from "./errors.js";
import { assertNoSymlinkInPath, readFileIfExists, writeTextFileLf } from "./filesystem.js";
import { assertSafeRelativePath, resolveWithinRoot } from "./paths.js";
import { parseYaml, stringifyYaml } from "./yaml.js";

/** MVP がサポートする lock file schema version。 */
export const LOCKFILE_SCHEMA_VERSION = 1 as const;

/** lock file の既定の source repository（中央 ai-repo-ops）。 */
export const DEFAULT_SOURCE_REPOSITORY = "yamk12nfu/ai-repo-ops" as const;

/** lock file 名（repo root からの相対）。 */
export const LOCKFILE_RELATIVE_PATH = ".ai/ai-repo-ops.lock.yaml" as const;

/** sha256 hex（小文字 64 桁）。 */
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, "sha256 は小文字 hex 64 桁である必要があります。");

/** repo root からの相対 path（安全性検査つき）。 */
const relativePathSchema = z.string().superRefine((value, ctx) => {
  try {
    assertSafeRelativePath(value, "path");
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/** source path（source repo root からの相対。`distribution/...` 形式）。 */
const sourceRefSchema = z.string().superRefine((value, ctx) => {
  try {
    assertSafeRelativePath(value, "source");
  } catch (error) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const lockManagedFileSchema = z
  .object({
    path: relativePathSchema,
    source: sourceRefSchema,
    installed_sha256: sha256HexSchema,
    strategy: z.literal("managed_overwrite"),
  })
  .strict();

const lockSeedFileSchema = z
  .object({
    path: relativePathSchema,
    strategy: z.literal("create_only"),
  })
  .strict();

const lockPatchSchema = z
  .object({
    type: z.literal("append_unique_lines"),
    path: relativePathSchema,
    lines: z.array(z.string()).min(1),
  })
  .strict();

/** lock file 全体の zod schema。 */
export const lockFileSchema = z
  .object({
    schema_version: z.literal(LOCKFILE_SCHEMA_VERSION, {
      errorMap: () => ({
        message: `schema_version は ${LOCKFILE_SCHEMA_VERSION} である必要があります。`,
      }),
    }),
    source: z
      .object({
        repository: z.string().min(1),
        distribution: z.string().min(1),
        version: z.string().min(1),
        commit: z.string().nullable(),
        distribution_content_sha256: sha256HexSchema,
      })
      .strict(),
    checksum: z
      .object({
        algorithm: z.literal(CHECKSUM_ALGORITHM),
        mode: z.literal(CHECKSUM_MODE),
      })
      .strict(),
    managed_files: z.array(lockManagedFileSchema),
    seed_files: z.array(lockSeedFileSchema),
    patches: z.array(lockPatchSchema),
    created_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .strict();

/** 検証済み lock file の型。 */
export type LockFile = z.infer<typeof lockFileSchema>;
/** lock file 内 managed file エントリの型。 */
export type LockManagedFile = LockFile["managed_files"][number];
/** lock file 内 seed file エントリの型。 */
export type LockSeedFile = LockFile["seed_files"][number];
/** lock file 内 patch エントリの型。 */
export type LockPatch = LockFile["patches"][number];

/** zod の issue 配列を人間が読める 1 文字列にまとめる。 */
function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * すでに parse 済みの JS 値を lock file として検証する。
 * 失敗時は {@link LockFileError}（code: `LOCKFILE_INVALID`）を投げる。
 */
export function parseLockFileValue(value: unknown, sourceRef?: string): LockFile {
  const result = lockFileSchema.safeParse(value);
  if (!result.success) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new LockFileError(
      "LOCKFILE_INVALID",
      `${where}lock file の検証に失敗しました:\n${formatZodIssues(result.error.issues)}`,
      {
        hint: "lock file は aro が管理します。手編集した場合は git restore で戻すか aro sync で再生成してください。",
        cause: result.error,
      },
    );
  }
  return result.data;
}

/**
 * YAML テキストを lock file として parse・検証する。
 * YAML parse 失敗も {@link LockFileError}（code: `LOCKFILE_PARSE`）にラップする。
 */
export function parseLockFile(text: string, sourceRef?: string): LockFile {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new LockFileError("LOCKFILE_PARSE", `${where}lock file の YAML parse に失敗しました。`, {
      hint: "YAML として壊れています。git restore で戻すか aro sync で再生成してください。",
      cause: error,
    });
  }
  return parseLockFileValue(parsed, sourceRef);
}

/** lock file を YAML テキストへ serialize する（書き込みは LF・BOM なしで行う前提）。 */
export function stringifyLockFile(lock: LockFile): string {
  return stringifyYaml(lock);
}

/**
 * lock file を絶対 path へ書き込む（UTF-8 / LF / BOM なし）。
 * path 検証・symlink 検査は呼び出し側（apply 層）の責務。低レベル書き込みのみ行う。
 */
export async function writeLockFile(absolutePath: string, lock: LockFile): Promise<void> {
  await writeTextFileLf(absolutePath, stringifyLockFile(lock));
}

/**
 * 対象 repo の lock file（`.ai/ai-repo-ops.lock.yaml`）を読み込み検証する。
 * 存在しなければ null を返す（未 init の repo）。path 安全性・symlink 非追従も検査する。
 *
 * @param repoRoot 対象 repo の root（絶対 path 推奨）。
 */
export async function loadLockFile(repoRoot: string): Promise<LockFile | null> {
  const absolutePath = resolveWithinRoot(repoRoot, LOCKFILE_RELATIVE_PATH, "lock file");
  await assertNoSymlinkInPath(repoRoot, LOCKFILE_RELATIVE_PATH, "lock file");
  const buffer = await readFileIfExists(absolutePath);
  if (buffer === null) {
    return null;
  }
  return parseLockFile(buffer.toString("utf8"), LOCKFILE_RELATIVE_PATH);
}

/** {@link buildLockFile} の入力。LoadedDistribution に依存させず、primitive で受ける。 */
export interface BuildLockFileInput {
  /** source repository（省略時は {@link DEFAULT_SOURCE_REPOSITORY}）。 */
  repository?: string | undefined;
  /** distribution 名。 */
  distribution: string;
  /** manifest.version（人間向け表示）。 */
  version: string;
  /** source の git commit。MVP では基本 null。 */
  commit?: string | null | undefined;
  /** distribution content sha256。 */
  distributionContentSha256: string;
  /** managed file 群（path=dest, source=source repo root からの相対, installedSha256=canonical sha256）。 */
  managedFiles: ReadonlyArray<{ path: string; source: string; installedSha256: string }>;
  /** seed file 群（path=dest）。 */
  seedFiles: ReadonlyArray<{ path: string }>;
  /** patch 群（path, lines）。 */
  patches: ReadonlyArray<{ path: string; lines: readonly string[] }>;
  /** 作成時刻（ISO 文字列）。新規作成時に設定し、更新時は既存値を引き継ぐ。 */
  createdAt: string;
  /** 更新時刻（ISO 文字列）。 */
  updatedAt: string;
}

/**
 * 同期結果から lock file オブジェクトを構築する。
 * 時刻は呼び出し側が渡す（テストの決定性のため、ここでは `new Date()` を呼ばない）。
 */
export function buildLockFile(input: BuildLockFileInput): LockFile {
  return {
    schema_version: LOCKFILE_SCHEMA_VERSION,
    source: {
      repository: input.repository ?? DEFAULT_SOURCE_REPOSITORY,
      distribution: input.distribution,
      version: input.version,
      commit: input.commit ?? null,
      distribution_content_sha256: input.distributionContentSha256,
    },
    checksum: {
      algorithm: CHECKSUM_ALGORITHM,
      mode: CHECKSUM_MODE,
    },
    managed_files: input.managedFiles.map((m) => ({
      path: m.path,
      source: m.source,
      installed_sha256: m.installedSha256,
      strategy: "managed_overwrite" as const,
    })),
    seed_files: input.seedFiles.map((s) => ({
      path: s.path,
      strategy: "create_only" as const,
    })),
    patches: input.patches.map((p) => ({
      type: "append_unique_lines" as const,
      path: p.path,
      lines: [...p.lines],
    })),
    created_at: input.createdAt,
    updated_at: input.updatedAt,
  };
}

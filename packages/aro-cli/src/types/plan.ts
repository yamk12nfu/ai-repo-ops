/**
 * sync plan の内部表現。
 *
 * 計画 v3 §15 に対応する。init / diff / sync はすべてこの plan を経由して動く（§5.2）。
 * plan は「対象 repo に何が起きるか」を記述する純粋なデータで、実 I/O は apply 層（Phase 5）が行う。
 *
 * exactOptionalPropertyTypes 下で optional フィールドは `?: T | undefined` を明示する
 * （既存 core モジュールの規約に合わせる）。
 */

/**
 * 1 ファイル（または patch 対象）に対する変更種別。
 *
 * - `create`              : 新規作成（managed file / seed file の初回配置）。
 * - `update`             : managed_overwrite の内容更新（lock と target が一致し、source だけ新しい）。
 * - `append_unique_lines`: patch 対象に未追記行を足す（新規作成を含む。`createsFile` で区別）。
 * - `preserve`           : create_only で既存のため温存（何もしない）。
 * - `orphaned`           : lock にあるが現 manifest に無い managed file（§16.4。MVP では削除しない）。
 * - `conflict`           : 人間が編集した可能性があり安全に上書きできない（§16.1）。
 * - `noop`               : 変更なし（source・target・lock がすべて一致）。
 */
export type ChangeKind =
  | "create"
  | "update"
  | "append_unique_lines"
  | "preserve"
  | "orphaned"
  | "conflict"
  | "noop";

/** 配布 strategy（§9.2）。MVP では 3 種類のみ。 */
export type ChangeStrategy = "managed_overwrite" | "create_only" | "append_unique_lines";

/** plan 内の 1 変更。`path` は repo root からの相対 path。 */
export interface SyncChange {
  /** 変更種別。 */
  kind: ChangeKind;
  /** repo root からの相対 path（dest / patch path）。 */
  path: string;
  /** この変更を生む strategy。 */
  strategy?: ChangeStrategy | undefined;
  /** conflict / orphaned 等の理由（人間向け）。 */
  reason?: string | undefined;
  /** target の現在 canonical sha256（存在しなければ null）。managed file で使う。 */
  beforeSha256?: string | null | undefined;
  /** lock に記録された installed_sha256（無ければ null）。managed file で使う。 */
  installedSha256?: string | null | undefined;
  /** 適用後の canonical sha256（create / update で source の sha）。 */
  afterSha256?: string | null | undefined;
  /** distribution root からの相対 src/template path（create / update のソース）。 */
  sourcePath?: string | undefined;
  /** append_unique_lines で実際に追記される行（順序保持・重複除去済み）。 */
  lines?: string[] | undefined;
  /** append_unique_lines / create で対象ファイルを新規作成する場合 true。 */
  createsFile?: boolean | undefined;
}

/** sync plan 全体。diff / sync の出力と exit code 判定はこの構造から導く。 */
export interface SyncPlan {
  /** 対象 repo root（絶対 path）。 */
  repoRoot: string;
  /** distribution 名。 */
  distribution: string;
  /** lock に記録された現在の manifest version（未 init なら null）。 */
  currentVersion: string | null;
  /** source manifest の version。 */
  targetVersion: string;
  /** lock に記録された distribution content sha256（未 init なら null）。 */
  currentDistributionSha256: string | null;
  /** source distribution の content sha256。 */
  targetDistributionSha256: string;
  /** version は同じだが content hash が変わっている（§10.5 の WARN 条件）。 */
  versionUnchangedButContentChanged: boolean;
  /** 全変更（path, kind 昇順で安定ソート済み）。 */
  changes: SyncChange[];
  /** conflict が 1 件でもあるか（§5.3 atomic abort の判定）。 */
  hasConflicts: boolean;
  /** ファイル単位ではない警告（version drift など。人間向け文字列）。 */
  warnings: string[];
}

/**
 * conflict 判定アルゴリズム（純粋関数。FS には触れない）。
 *
 * 計画 v3 §16 に対応する。canonical sha256 の比較だけで managed_overwrite / create_only の
 * 変更種別を決める。append_unique_lines は {@link import("./append-unique-lines.js")} 側の
 * computeAppendUniqueLines が判定するため、ここでは扱わない。
 *
 * 更新判定は version ではなく checksum を正とする（§4.4）。CRLF/CR/LF・先頭 BOM の違いは
 * canonical 化で吸収済みの sha を渡す前提なので、改行・BOM だけの差では conflict にならない。
 */
import type { ChangeKind } from "../types/plan.js";

/** managed_overwrite の判定結果。 */
export interface ManagedClassification {
  /** create / update / noop / conflict のいずれか。 */
  kind: Extract<ChangeKind, "create" | "update" | "noop" | "conflict">;
  /** conflict の理由（人間向け）。conflict 以外では undefined。 */
  reason?: string | undefined;
}

/** {@link classifyManagedOverwrite} の入力。すべて canonical sha256（hex）または null。 */
export interface ManagedClassificationInput {
  /** target ファイルの現在 canonical sha256。存在しなければ null。 */
  targetSha256: string | null;
  /** lock に記録された installed_sha256。lock に該当エントリが無ければ null。 */
  installedSha256: string | null;
  /** source（配布物）の canonical sha256。 */
  sourceSha256: string;
}

/** conflict 理由: 既存だが lock に記録が無い（init 前から存在 / lock 破損など）。 */
export const REASON_UNTRACKED =
  "present in repo but not recorded in the lock file";
/** conflict 理由: 前回同期以降に人間が編集した可能性。 */
export const REASON_LOCALLY_MODIFIED = "locally modified since last sync";

/**
 * managed_overwrite ファイル 1 件の変更種別を判定する（§16.1）。
 *
 * 判定順:
 *   1. target が存在しない                       → create
 *   2. target あり & lock に記録なし             → conflict（{@link REASON_UNTRACKED}）
 *   3. target sha == lock installed_sha:
 *        - source sha == lock installed_sha       → noop
 *        - source sha != lock installed_sha       → update
 *   4. target sha != lock installed_sha          → conflict（{@link REASON_LOCALLY_MODIFIED}）
 */
export function classifyManagedOverwrite(
  input: ManagedClassificationInput,
): ManagedClassification {
  const { targetSha256, installedSha256, sourceSha256 } = input;

  if (targetSha256 === null) {
    return { kind: "create" };
  }
  if (installedSha256 === null) {
    return { kind: "conflict", reason: REASON_UNTRACKED };
  }
  if (targetSha256 === installedSha256) {
    return sourceSha256 === installedSha256 ? { kind: "noop" } : { kind: "update" };
  }
  return { kind: "conflict", reason: REASON_LOCALLY_MODIFIED };
}

/** create_only の判定結果。 */
export interface CreateOnlyClassification {
  /** target が無ければ create、あれば preserve。 */
  kind: Extract<ChangeKind, "create" | "preserve">;
}

/**
 * create_only ファイル 1 件の変更種別を判定する（§16.2）。
 * @param targetExists target ファイルが既に存在するか。
 */
export function classifyCreateOnly(targetExists: boolean): CreateOnlyClassification {
  return { kind: targetExists ? "preserve" : "create" };
}

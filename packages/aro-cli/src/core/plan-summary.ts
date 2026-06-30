/**
 * {@link SyncPlan} に対する「適用すべきものがあるか」の判定（純粋関数・単一の正）。
 *
 * diff の exit code 判定（diff.ts）と人間向け出力の up-to-date 判定（diff-format.ts）は
 * 同じ意味の「actionable」を使う必要がある。両者で別々に定義すると、orphaned や content drift の
 * 扱いがずれて「出力は変更あり・exit は差分なし」のような矛盾が起きる。
 * そこでこのモジュールに判定を集約し、両者から参照する。
 *
 * 区別する概念:
 *   - file change   : sync が実ファイルを書き換える変更（create / update / append_unique_lines）。
 *   - content drift : lock の distribution_content_sha256 と source の content hash がずれている（§10.5）。
 *                     create_only が温存されても sync は lock の content sha を更新するため「適用対象」(§10.6)。
 *   - requires sync : file change か content drift のいずれか = sync で何か書かれる = §17.2 detailed の「更新あり」。
 *
 * orphaned は §16.4 のとおり WARN であって適用対象ではない（MVP では削除しない）。よって requires sync には含めない。
 * conflict は適用対象ではなく abort 要因なので、exit code・出力とも別経路で扱う（ここには含めない）。
 */
import type { ChangeKind, SyncPlan } from "../types/plan.js";

/** sync が実ファイルを書き換える変更種別。 */
const FILE_CHANGE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  "create",
  "update",
  "append_unique_lines",
]);

/** plan に実ファイル書き込み（create / update / append）が含まれるか。 */
export function planHasFileChanges(plan: SyncPlan): boolean {
  return plan.changes.some((c) => FILE_CHANGE_KINDS.has(c.kind));
}

/** lock の content sha と source の content hash がずれているか（§10.5）。lock 無し（null）なら false。 */
export function planHasContentDrift(plan: SyncPlan): boolean {
  return (
    plan.currentDistributionSha256 !== null &&
    plan.currentDistributionSha256 !== plan.targetDistributionSha256
  );
}

/**
 * sync で何か書かれるか（実ファイル or lock の content sha）。
 * §17.2 の `--detailed-exitcode` における「更新あり（=2）」の判定に使う。conflict はここでは見ない。
 */
export function planRequiresSync(plan: SyncPlan): boolean {
  return planHasFileChanges(plan) || planHasContentDrift(plan);
}

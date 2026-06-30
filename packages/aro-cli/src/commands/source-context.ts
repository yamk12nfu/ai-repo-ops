/**
 * source root 上方探索の起点を共有する小さなヘルパー。
 *
 * init / diff / sync はいずれも `--source` 未指定時に「実行中モジュールの位置から上方へ
 * ai-repo-ops source root（distribution/ を持つ祖先）を辿る」ため、その起点計算を 1 箇所に集約する。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** source 上方探索の起点（実行中モジュールのディレクトリ）。 */
export function defaultSourceStartDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

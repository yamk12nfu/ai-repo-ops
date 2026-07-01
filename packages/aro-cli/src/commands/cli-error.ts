/**
 * CLI エラー出力の共通フォーマッタ。
 *
 * 計画 v3 §23.3「CLI エラーは人間が解決できるメッセージにする」に従い、{@link AroError} は
 * 復旧ヒント（hint）も添えて表示する。init / diff / sync / doctor で同じ整形を使い、出力を揃える。
 */
import { ApplyIoError } from "../core/apply.js";
import { AroError } from "../core/errors.js";

/** エラーを人間向けの 1 メッセージへ整形する（末尾改行なし）。AroError は hint も添える。 */
export function formatAroError(error: unknown): string {
  if (error instanceof AroError) {
    const head = `ERROR ${error.message}`;
    return error.hint !== undefined ? `${head}\n      ${error.hint}` : head;
  }
  return `ERROR ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * path を POSIX シェルで安全に 1 引数として扱えるよう single-quote で囲む。
 * 空白や特殊文字を含む path（assertSafeRelativePath は内部空白を許容する）でも、
 * 案内する復旧コマンドが正しく動くようにする。内部の `'` は `'\''` でエスケープする。
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 書き込みフェーズの I/O 失敗（{@link ApplyIoError}）を、touched paths と復旧導線つきで整形する（§17.3）。
 *
 * §17.3 の復旧モデルに合わせ、tracked file（=既存ファイルへの更新/追記）は `git restore`、
 * 新規作成ファイルは削除で戻すよう、2 つのコマンドに分けて案内する。両者を 1 つの `git restore` に
 * まとめると、未追跡 path で git 全体が abort し tracked file も戻らない（復旧不能になる）ため分離する。
 * path は {@link shellQuote} で囲み、空白を含む path でもコマンドが壊れないようにする。自前 backup は持たない。
 */
export function formatApplyIoError(error: ApplyIoError): string {
  const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
  const newSet = new Set(error.newPaths);
  const modified = error.touchedPaths.filter((p) => !newSet.has(p));
  const created = error.touchedPaths.filter((p) => newSet.has(p));

  const lines: string[] = [];
  lines.push(`ERROR apply failed while writing ${error.failedPath}`);
  lines.push(`      ${cause}`);
  lines.push("");
  lines.push("Touched paths (may be partially written):");
  for (const p of error.touchedPaths) {
    lines.push(`  ${p}`);
  }
  lines.push("");
  lines.push("Suggested recovery:");
  if (modified.length > 0) {
    lines.push(
      `  git restore -- ${modified.map(shellQuote).join(" ")}   # 既存（tracked）ファイルを元に戻す`,
    );
  }
  if (created.length > 0) {
    lines.push(
      `  rm -f ${created.map(shellQuote).join(" ")}   # 新規作成された未追跡ファイルを削除する`,
    );
  }
  if (modified.length === 0 && created.length === 0) {
    lines.push("  （復旧対象の path はありません）");
  }
  return lines.join("\n");
}

/** JSON 出力用のエラー表現。 */
export interface ErrorJson {
  code: string;
  message: string;
  hint?: string;
  /** {@link ApplyIoError} の場合のみ。書き込みを試みた path。 */
  touchedPaths?: string[];
  /** {@link ApplyIoError} の場合のみ。touchedPaths のうち新規作成だった path。 */
  newPaths?: string[];
}

/** エラーを `--json` 出力用の plain object へ変換する。 */
export function errorToJson(error: unknown): ErrorJson {
  if (error instanceof ApplyIoError) {
    return {
      code: error.code,
      message: error.message,
      touchedPaths: [...error.touchedPaths],
      newPaths: [...error.newPaths],
    };
  }
  if (error instanceof AroError) {
    return error.hint !== undefined
      ? { code: error.code, message: error.message, hint: error.hint }
      : { code: error.code, message: error.message };
  }
  return { code: "UNEXPECTED", message: error instanceof Error ? error.message : String(error) };
}

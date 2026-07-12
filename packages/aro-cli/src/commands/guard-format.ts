/**
 * `aro guard` の人間向け出力フォーマッタ（純粋関数）。
 *
 * {@link GuardReport} を違反一覧（無ければ OK）と Summary へ整形する。doctor-format.ts と同様、
 * 色付けは diff-format.ts の {@link Palette} を再利用する（違反=conflict(赤) / 違反なし=add(緑)）。
 */
import type { GuardReport, GuardViolation } from "../core/guard.js";
import type { SyncAuthenticationReport } from "../core/sync-authentication.js";
import { paletteFor, type Palette } from "./diff-format.js";

/** {@link formatGuardHuman} のオプション。 */
export interface FormatGuardOptions {
  /** `--base` に指定した ref（見出しに表示する）。 */
  base: string;
  color: boolean;
  trustedSync?: SyncAuthenticationReport | undefined;
}

/** 1 件の違反を 1〜2 行に整形する（limit/actual があれば次行に添える）。 */
function formatViolation(violation: GuardViolation, p: Palette): string[] {
  const lines = [`${p.conflict("VIOLATION")}  [${violation.kind}] ${violation.message}`];
  if (violation.limit !== undefined && violation.actual !== undefined) {
    lines.push(`      limit=${violation.limit} actual=${violation.actual}`);
  }
  return lines;
}

/**
 * {@link GuardReport} を人間向けテキストへ整形する（末尾改行なし。呼び出し側で付与する）。
 */
export function formatGuardHuman(report: GuardReport, options: FormatGuardOptions): string {
  const p = paletteFor(options.color);
  const lines: string[] = [];

  lines.push(p.heading("ai-repo-ops guard"));
  lines.push("");
  lines.push(`Base: ${options.base}`);
  lines.push("");

  if (options.trustedSync?.status === "authenticated") {
    lines.push(`Trusted sync: authenticated (${options.trustedSync.paths.length} paths)`);
    lines.push("");
  } else if (options.trustedSync?.status === "rejected") {
    lines.push(`Trusted sync: rejected (${options.trustedSync.reason})`);
    lines.push("");
  }

  if (report.violations.length === 0) {
    lines.push(`${p.add("OK")}  no policy violations detected`);
  } else {
    for (const violation of report.violations) {
      lines.push(...formatViolation(violation, p));
    }
  }

  lines.push("");
  lines.push(p.heading("Summary:"));
  lines.push(`  ${report.summary.checkedFiles} files checked`);
  lines.push(`  ${report.summary.addedLines} lines added`);
  lines.push(`  ${report.summary.violationCount} violations`);

  return lines.join("\n");
}

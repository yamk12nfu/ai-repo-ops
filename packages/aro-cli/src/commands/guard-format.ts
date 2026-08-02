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

/**
 * 1 件の違反を 1〜2 行に整形する（limit/actual があれば次行に添える）。
 * severity=warn は WARN ラベルで表示し、報告はするが exit code には影響しないことを示す。
 */
function formatViolation(violation: GuardViolation, p: Palette): string[] {
  const label =
    violation.severity === "warn" ? `${p.warn("WARN")}       ` : `${p.conflict("VIOLATION")}  `;
  const lines = [`${label}[${violation.kind}] ${violation.message}`];
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
    // fail を先に出す（warn だけの場合との区別を目立たせる）。
    const ordered = [
      ...report.violations.filter((violation) => violation.severity === "fail"),
      ...report.violations.filter((violation) => violation.severity === "warn"),
    ];
    for (const violation of ordered) {
      lines.push(...formatViolation(violation, p));
    }
    if (!report.hasFailures) {
      lines.push("");
      lines.push(`${p.add("OK")}  警告のみです（severity=fail の違反はありません）。`);
    }
  }

  lines.push("");
  lines.push(p.heading("Summary:"));
  lines.push(`  ${report.summary.checkedFiles} files checked`);
  lines.push(`  ${report.summary.addedLines} lines added`);
  lines.push(`  ${report.summary.failCount} violations (fail)`);
  lines.push(`  ${report.summary.warnCount} warnings`);

  return lines.join("\n");
}

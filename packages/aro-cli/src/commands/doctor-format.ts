/**
 * `aro doctor` の人間向け出力フォーマッタ（純粋関数）。
 *
 * 計画 v3 §17.4 の期待出力に対応する。{@link DoctorReport} を PASS/WARN/FAIL の行と Summary へ整形する。
 * 色付けは diff-format.ts の {@link Palette} を再利用する（PASS=add(緑) / WARN=warn(黄) / FAIL=conflict(赤)）。
 */
import type { DoctorCheck, DoctorReport, DoctorStatus } from "../core/doctor.js";
import { paletteFor, type Palette } from "./diff-format.js";

/** {@link formatDoctorHuman} のオプション。 */
export interface FormatDoctorOptions {
  color: boolean;
}

/** status を表示ラベルへ変換する（PASS/WARN/FAIL、すべて 4 文字で桁が揃う）。 */
function statusLabel(status: DoctorStatus, p: Palette): string {
  switch (status) {
    case "pass":
      return p.add("PASS");
    case "warn":
      return p.warn("WARN");
    case "fail":
      return p.conflict("FAIL");
  }
}

/** 1 件の check を 1〜2 行に整形する（hint があれば次行に 6 スペースインデントで添える）。 */
function formatCheck(check: DoctorCheck, p: Palette): string[] {
  const lines = [`${statusLabel(check.status, p)}  ${check.message}`];
  if (check.hint !== undefined) {
    lines.push(`      ${p.dim(check.hint)}`);
  }
  return lines;
}

/**
 * {@link DoctorReport} を人間向けテキストへ整形する（末尾改行なし。呼び出し側で付与する）。
 */
export function formatDoctorHuman(report: DoctorReport, options: FormatDoctorOptions): string {
  const p = paletteFor(options.color);
  const lines: string[] = [];

  lines.push(p.heading("ai-repo-ops doctor"));
  lines.push("");
  lines.push(`Repo: ${report.repoRoot}`);
  lines.push("");

  for (const check of report.checks) {
    lines.push(...formatCheck(check, p));
  }

  lines.push("");
  lines.push(p.heading("Summary:"));
  lines.push(`  ${report.summary.passed} passed`);
  lines.push(`  ${report.summary.warned} warning`);
  lines.push(`  ${report.summary.failed} failed`);

  return lines.join("\n");
}

import type {
  KnowledgeFinding,
  KnowledgeFindingStatus,
  KnowledgeReport,
} from "../core/knowledge-check.js";
import { paletteFor, type Palette } from "./diff-format.js";

function statusLabel(status: KnowledgeFindingStatus, palette: Palette): string {
  switch (status) {
    case "pass":
      return palette.add("PASS");
    case "warn":
      return palette.warn("WARN");
    case "fail":
      return palette.conflict("FAIL");
  }
}

function formatFinding(finding: KnowledgeFinding, palette: Palette): string[] {
  const lines = [`${statusLabel(finding.status, palette)}  ${finding.message}`];
  if (finding.hint !== undefined) lines.push(`      ${palette.dim(finding.hint)}`);
  return lines;
}

/** knowledge check reportを人間向けに整形する。 */
export function formatKnowledgeCheckHuman(
  report: KnowledgeReport,
  options: { color: boolean },
): string {
  const palette = paletteFor(options.color);
  const lines: string[] = [
    palette.heading("ai-repo-ops knowledge check"),
    "",
    `Repo:   ${report.repoRoot}`,
    `Strict: ${report.strict ? "yes" : "no"}`,
    "",
  ];
  for (const finding of report.findings) lines.push(...formatFinding(finding, palette));
  lines.push("");
  lines.push(palette.heading("Summary:"));
  lines.push(`  ${report.summary.entries} entries`);
  lines.push(`  ${report.summary.passed} passed`);
  lines.push(`  ${report.summary.warned} warning`);
  lines.push(`  ${report.summary.failed} failed`);
  lines.push(`  ${report.summary.stale} stale`);
  return lines.join("\n");
}

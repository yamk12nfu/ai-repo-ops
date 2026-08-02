import type {
  ProposalFinding,
  ProposalFindingStatus,
  ProposalsReport,
} from "../core/proposals-check.js";
import { paletteFor, type Palette } from "./diff-format.js";

function statusLabel(status: ProposalFindingStatus, palette: Palette): string {
  switch (status) {
    case "pass":
      return palette.add("PASS");
    case "warn":
      return palette.warn("WARN");
    case "fail":
      return palette.conflict("FAIL");
  }
}

function formatFinding(finding: ProposalFinding, palette: Palette): string[] {
  const lines = [`${statusLabel(finding.status, palette)}  ${finding.message}`];
  if (finding.hint !== undefined) lines.push(`      ${palette.dim(finding.hint)}`);
  return lines;
}

/** proposals check reportを人間向けに整形する（knowledge checkと同じ書式）。 */
export function formatProposalsCheckHuman(
  report: ProposalsReport,
  options: { color: boolean },
): string {
  const palette = paletteFor(options.color);
  const lines: string[] = [
    palette.heading("ai-repo-ops proposals check"),
    "",
    `Repo:   ${report.repoRoot}`,
    `Strict: ${report.strict ? "yes" : "no"}`,
    "",
  ];
  for (const finding of report.findings) lines.push(...formatFinding(finding, palette));
  lines.push("");
  lines.push(palette.heading("Summary:"));
  lines.push(`  ${report.summary.entries} proposals`);
  lines.push(`  ${report.summary.passed} passed`);
  lines.push(`  ${report.summary.warned} warnings`);
  lines.push(`  ${report.summary.failed} failed`);
  lines.push(`  ${report.summary.stale} stale`);
  return lines.join("\n");
}

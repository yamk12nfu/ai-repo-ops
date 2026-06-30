/**
 * `aro diff` の人間向け出力フォーマッタ（純粋関数）。
 *
 * 計画 v3 §17.2 の期待出力に対応する。{@link SyncPlan} を受け取り、変更種別ごとに節へ分けて整形する。
 * 色付けは {@link Palette} を差し替えることで制御し、テストでは plain palette を渡して
 * ANSI エスケープ無しの決定的な文字列を検証できるようにする。
 */
import type { SyncChange, SyncPlan } from "../types/plan.js";
import { planHasContentDrift, planHasFileChanges, planRequiresSync } from "../core/plan-summary.js";

/** 出力の色付け関数群。plain では恒等関数になる。 */
export interface Palette {
  /** 追加（create / append 行）。 */
  add: (s: string) => string;
  /** 更新（managed update）。 */
  update: (s: string) => string;
  /** conflict。 */
  conflict: (s: string) => string;
  /** 保持（preserve / 一致）。 */
  preserve: (s: string) => string;
  /** orphaned。 */
  orphan: (s: string) => string;
  /** WARN ラベル。 */
  warn: (s: string) => string;
  /** 見出し（bold）。 */
  heading: (s: string) => string;
  /** 補足（dim）。 */
  dim: (s: string) => string;
}

const IDENTITY = (s: string): string => s;

/** 全て恒等関数の plain palette（色なし出力・テスト用）。 */
export const PLAIN_PALETTE: Palette = {
  add: IDENTITY,
  update: IDENTITY,
  conflict: IDENTITY,
  preserve: IDENTITY,
  orphan: IDENTITY,
  warn: IDENTITY,
  heading: IDENTITY,
  dim: IDENTITY,
};

/** ANSI SGR エスケープ。ESC() を明示し、出力に生 ESC が確実に入るようにする。 */
const ANSI = {
  reset: "[0m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
  cyan: "[36m",
  bold: "[1m",
  dim: "[2m",
} as const;

/** ANSI 色付き palette。 */
export const COLOR_PALETTE: Palette = {
  add: (s) => `${ANSI.green}${s}${ANSI.reset}`,
  update: (s) => `${ANSI.cyan}${s}${ANSI.reset}`,
  conflict: (s) => `${ANSI.red}${s}${ANSI.reset}`,
  preserve: (s) => `${ANSI.dim}${s}${ANSI.reset}`,
  orphan: (s) => `${ANSI.yellow}${s}${ANSI.reset}`,
  warn: (s) => `${ANSI.yellow}${s}${ANSI.reset}`,
  heading: (s) => `${ANSI.bold}${s}${ANSI.reset}`,
  dim: (s) => `${ANSI.dim}${s}${ANSI.reset}`,
};

/** color フラグから palette を選ぶ。 */
export function paletteFor(color: boolean): Palette {
  return color ? COLOR_PALETTE : PLAIN_PALETTE;
}

/** sha256 を表示用に短縮する。null は "(none)"。 */
function shortSha(sha: string | null): string {
  return sha === null ? "(none)" : `${sha.slice(0, 12)}...`;
}

/** changes を kind で抽出する。 */
function byKind(changes: readonly SyncChange[], kind: SyncChange["kind"]): SyncChange[] {
  return changes.filter((c) => c.kind === kind);
}

/** {@link formatDiffHuman} のオプション。 */
export interface FormatDiffOptions {
  /** 色付けするか。 */
  color: boolean;
}

/**
 * sync plan を人間向けテキストへ整形する（末尾改行なし。呼び出し側で付与する）。
 */
export function formatDiffHuman(plan: SyncPlan, options: FormatDiffOptions): string {
  const p = paletteFor(options.color);
  const lines: string[] = [];

  lines.push(p.heading("ai-repo-ops diff"));
  lines.push("");
  lines.push(`Repo:         ${plan.repoRoot}`);
  lines.push(`Distribution: ${plan.distribution}`);
  lines.push(
    `Current:      version=${plan.currentVersion ?? "(none)"} content=${shortSha(plan.currentDistributionSha256)}`,
  );
  lines.push(
    `Target:       version=${plan.targetVersion} content=${shortSha(plan.targetDistributionSha256)}`,
  );

  for (const warning of plan.warnings) {
    lines.push("");
    lines.push(`${p.warn("WARN")}  ${warning}`);
  }

  const updates = byKind(plan.changes, "update");
  const creates = byKind(plan.changes, "create");
  const appends = byKind(plan.changes, "append_unique_lines");
  const conflicts = byKind(plan.changes, "conflict");
  const orphaned = byKind(plan.changes, "orphaned");
  const preserved = byKind(plan.changes, "preserve");

  if (updates.length > 0) {
    lines.push("");
    lines.push("Will update:");
    for (const c of updates) {
      lines.push(`  ${p.update("M")} ${c.path}`);
    }
  }

  if (creates.length > 0) {
    lines.push("");
    lines.push("Will create:");
    for (const c of creates) {
      lines.push(`  ${p.add("+")} ${c.path}`);
    }
  }

  if (appends.length > 0) {
    lines.push("");
    lines.push("Will append lines:");
    for (const c of appends) {
      const marker = c.createsFile === true ? p.add("+") : p.update("M");
      lines.push(`  ${marker} ${c.path}`);
      for (const line of c.lines ?? []) {
        lines.push(`    ${p.add("+")} ${line}`);
      }
    }
  }

  if (conflicts.length > 0) {
    lines.push("");
    lines.push("Conflicts:");
    for (const c of conflicts) {
      lines.push(`  ${p.conflict("!")} ${c.path}`);
      if (c.reason !== undefined) {
        lines.push(`    reason: ${c.reason}`);
      }
      // §0.2.3 / §17.3: managed file 誤編集からの復旧導線を出す。
      lines.push(p.dim(`    recover: git restore -- ${c.path} && aro sync --repo .`));
    }
  }

  if (orphaned.length > 0) {
    lines.push("");
    lines.push("Orphaned managed files:");
    for (const c of orphaned) {
      lines.push(`  ${p.orphan("?")} ${c.path}`);
      if (c.reason !== undefined) {
        lines.push(`    reason: ${c.reason}`);
      }
      lines.push("    action: not deleted in MVP");
    }
  }

  // §10.6 / drift note。content drift があり実ファイル書き込みが無い場合、Preserved 節の直前に出す
  // （仕様 §10.6 の表示順は message → Preserved）。preserve が無い seedless distribution でも
  // 「lock の content sha だけ更新される」ことを明示し、最終行の Summary と矛盾させない。
  const contentDrift = planHasContentDrift(plan);
  const hasFileWrites = planHasFileChanges(plan);
  if (contentDrift && !hasFileWrites) {
    lines.push("");
    lines.push(
      preserved.length > 0
        ? "Distribution content changed, but existing create_only files are preserved."
        : "Distribution content changed; the lock file will be updated on sync.",
    );
  }

  if (preserved.length > 0) {
    lines.push("");
    lines.push("Preserved:");
    for (const c of preserved) {
      lines.push(`  ${p.preserve("=")} ${c.path}`);
    }
  }

  // 最終行。up-to-date 判定は exit code と同じ planRequiresSync を使い、出力と exit の不一致を防ぐ。
  // orphaned / preserve は「適用対象」ではないので up-to-date を妨げない（§16.4）。conflict は別扱い。
  lines.push("");
  if (!plan.hasConflicts && !planRequiresSync(plan)) {
    lines.push("Up to date. No changes to apply.");
  } else {
    const parts = summaryParts({ updates, creates, appends, conflicts, orphaned, preserved });
    lines.push(
      parts.length > 0
        ? `Summary: ${parts.join(", ")}`
        : "Summary: distribution content changed (lock will be updated on sync)",
    );
  }

  return lines.join("\n");
}

/** サマリの件数 part 配列を作る（0 件の種別は省く）。 */
function summaryParts(groups: {
  updates: SyncChange[];
  creates: SyncChange[];
  appends: SyncChange[];
  conflicts: SyncChange[];
  orphaned: SyncChange[];
  preserved: SyncChange[];
}): string[] {
  const parts: string[] = [];
  if (groups.updates.length > 0) parts.push(`${groups.updates.length} update`);
  if (groups.creates.length > 0) parts.push(`${groups.creates.length} create`);
  if (groups.appends.length > 0) parts.push(`${groups.appends.length} append`);
  if (groups.conflicts.length > 0) parts.push(`${groups.conflicts.length} conflict`);
  if (groups.orphaned.length > 0) parts.push(`${groups.orphaned.length} orphaned`);
  if (groups.preserved.length > 0) parts.push(`${groups.preserved.length} preserved`);
  return parts;
}

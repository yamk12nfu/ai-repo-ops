/**
 * `aro init` / `aro sync` の人間向け出力フォーマッタ（純粋関数）。
 *
 * 計画 v3 §17.1 / §17.3 の期待出力に対応する。diff の {@link import("./diff-format.js").formatDiffHuman} が
 * 「これから何が起きるか（Will ...）」を表すのに対し、ここでは「何が起きたか（Created / Applied）」を表す。
 * 色付けは {@link Palette} を差し替えて制御し、テストでは plain palette で ANSI なしの決定的文字列を検証できる。
 */
import type { ApplyResult } from "../core/apply.js";
import { paletteFor, type Palette } from "./diff-format.js";

/** sha256 を表示用に短縮する。null は "(none)"。 */
function shortSha(sha: string | null): string {
  return sha === null ? "(none)" : `${sha.slice(0, 12)}...`;
}

/** init 出力のメタ情報。 */
export interface InitMeta {
  repoRoot: string;
  distribution: string;
  version: string;
  targetContentSha256: string;
}

/** sync 出力のメタ情報。 */
export interface SyncMeta {
  repoRoot: string;
  distribution: string;
  currentVersion: string | null;
  targetVersion: string;
  currentContentSha256: string | null;
  targetContentSha256: string;
}

/**
 * init の適用結果を整形する（末尾改行なし）。
 * Created（新規 managed/seed/patch）/ Patched（既存 patch への追記）/ lock を節に分ける。
 */
export function formatInitApplied(result: ApplyResult, meta: InitMeta, color: boolean): string {
  const p = paletteFor(color);
  const lines: string[] = [];

  lines.push(p.heading("ai-repo-ops init"));
  lines.push("");
  lines.push(`Repo:         ${meta.repoRoot}`);
  lines.push(`Distribution: ${meta.distribution}`);
  lines.push(`Version:      ${meta.version} content=${shortSha(meta.targetContentSha256)}`);

  const createdPatches = result.patches.filter((patch) => patch.created);
  const appendedPatches = result.patches.filter((patch) => !patch.created);
  const created = [...result.creates, ...createdPatches.map((patch) => patch.path)].sort();

  if (created.length > 0) {
    lines.push("");
    lines.push("Created:");
    for (const path of created) {
      lines.push(`  ${p.add("+")} ${path}`);
    }
  }

  if (result.updates.length > 0) {
    lines.push("");
    lines.push("Updated:");
    for (const path of result.updates) {
      lines.push(`  ${p.update("M")} ${path}`);
    }
  }

  if (appendedPatches.length > 0) {
    lines.push("");
    lines.push("Patched:");
    for (const patch of appendedPatches) {
      lines.push(`  ${p.update("M")} ${patch.path}`);
    }
  }

  lines.push("");
  lines.push("Created lock file:");
  lines.push(`  ${p.add("+")} ${result.lockPath}`);

  lines.push("");
  lines.push(p.heading("Done."));
  return lines.join("\n");
}

/**
 * sync の適用結果を整形する（末尾改行なし、§17.3）。
 * Applied（create=+ / update=M / append=M）/ lock を節に分ける。
 */
export function formatSyncApplied(result: ApplyResult, meta: SyncMeta, color: boolean): string {
  const p = paletteFor(color);
  const lines: string[] = [];

  lines.push(p.heading("ai-repo-ops sync"));
  lines.push("");
  lines.push(`Repo:         ${meta.repoRoot}`);
  lines.push(`Distribution: ${meta.distribution}`);
  lines.push(
    `From:         version=${meta.currentVersion ?? "(none)"} content=${shortSha(meta.currentContentSha256)}`,
  );
  lines.push(
    `To:           version=${meta.targetVersion} content=${shortSha(meta.targetContentSha256)}`,
  );

  const applied: Array<{ marker: string; path: string }> = [
    ...result.creates.map((path) => ({ marker: p.add("+"), path })),
    ...result.updates.map((path) => ({ marker: p.update("M"), path })),
    ...result.patches.map((patch) => ({ marker: patch.created ? p.add("+") : p.update("M"), path: patch.path })),
  ];

  if (applied.length > 0) {
    lines.push("");
    lines.push("Applied:");
    for (const entry of applied) {
      lines.push(`  ${entry.marker} ${entry.path}`);
    }
  } else {
    // file change は無いが content drift で lock だけ更新するケース（§10.6）。
    lines.push("");
    lines.push("No file changes; distribution content hash updated.");
  }

  lines.push("");
  lines.push(`${result.lockWasCreated ? "Created" : "Updated"} lock file:`);
  lines.push(`  ${result.lockWasCreated ? p.add("+") : p.update("M")} ${result.lockPath}`);

  lines.push("");
  lines.push(p.heading("Done."));
  return lines.join("\n");
}

/** sync が「適用対象なし（up to date）」のときのメッセージ。 */
export function formatSyncUpToDate(meta: SyncMeta, color: boolean): string {
  const p = paletteFor(color);
  const lines: string[] = [];
  lines.push(p.heading("ai-repo-ops sync"));
  lines.push("");
  lines.push(`Repo:         ${meta.repoRoot}`);
  lines.push(`Distribution: ${meta.distribution}`);
  lines.push("");
  lines.push("Already up to date. Nothing to apply.");
  return lines.join("\n");
}

/** Palette を re-export（テストや呼び出し側の利便のため）。 */
export type { Palette };

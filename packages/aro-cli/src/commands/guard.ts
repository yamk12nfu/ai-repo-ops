/**
 * `aro guard` コマンド。`<base>...HEAD`（merge-base 比較）の diff を policies に照らして検証する
 * （docs/plans/03-guard-and-improve-loop.md Stage 1-1。未 merge の場合はこのファイルと呼び出し元の
 * 指示を仕様の正とする）。
 *
 * 処理: repo/git 確認 → merge-base 解決 → merge-base 側の project.yaml / risk_level 対応 policy の
 * 読込 → git diff 取得 → {@link runGuard}（読み取り専用）→ human/JSON 出力 → 終了コード。
 *
 * **検証ルール（project.yaml / policy）は PR HEAD（working tree）ではなく merge-base から読む。**
 * PR HEAD から読むと、PR 自身が `.ai/project.yaml` の `risk_level` を下げたり `allowed_paths` を
 * `["**"]` に広げたり `forbidden_paths` を空にしたりして、その PR 自身の検証を骨抜きにできてしまう
 * （self-modification bypass）。merge-base は「PR が分岐した時点」で固定され PR からは書き換えられない
 * ため、これを検証の信頼できる読み取り元にする。diff の取得自体も同じ merge-base SHA を使うことで、
 * 「ルールを読んだ時点」と「diff を計算した時点」の対象を一致させる（TOCTOU を避ける）。
 *
 * 読み取り専用（diff・merge-base 側ファイルを読むだけ。doctor と同じ思想）。改善ループ（Stage 2）が
 * abort 判定に使う前提のコマンドのため、実ファイルは一切変更しない。
 *
 * 終了コード（`GUARD_EXIT`。doctor と同型）:
 *   0: 違反なし
 *   1: 違反あり
 *   3: unexpected error（merge-base が解決できない・merge-base に project.yaml/policy が無い/読めない・
 *      git repo でない等、検証に必要な入力が揃わず判定不能な場合）
 *
 * 違反判定そのものは例外を投げず {@link runGuard} の戻り値で返るため、catch に落ちるのは
 * 「判定不能」な入力エラーのみになる（doctor と同じ思想。設定の妥当性検証自体は doctor の仕事）。
 */
import type { Command } from "commander";

import { addCommonOptions, type CommonOptions } from "../common-options.js";
import { ProjectConfigError, PolicyError } from "../core/errors.js";
import { assertGitRepo } from "../core/git.js";
import { getChangedFiles, getMergeBase, readFileAtRevision } from "../core/git-diff.js";
import { runGuard, type GuardReport } from "../core/guard.js";
import { LOCKFILE_RELATIVE_PATH, parseLockFile } from "../core/lockfile.js";
import { PROJECT_YAML_PATH } from "../core/manifest.js";
import { parsePolicy, policyPathForRiskLevel, type Policy } from "../core/policy.js";
import { parseProjectConfig, type ProjectConfig, type RiskLevel } from "../core/project-config.js";
import { loadDistribution, resolveSourceRoot } from "../core/source.js";
import {
  authenticateSyncChange,
  createNotApplicableSyncAuthenticationReport,
  type SyncAuthenticationReport,
} from "../core/sync-authentication.js";
import { resolveTemplateRepoName } from "../core/template.js";
import { errorToJson, formatAroError } from "./cli-error.js";
import { formatGuardHuman } from "./guard-format.js";
import { defaultSourceStartDir } from "./source-context.js";

/** guard の終了コード（doctor と同型）。 */
export const GUARD_EXIT = {
  /** 違反なし。 */
  ok: 0,
  /** 違反が 1 件以上ある。 */
  violations: 1,
  /** unexpected error（判定に必要な入力が読めず、検証自体を実行できなかった）。 */
  unexpected: 3,
} as const;

/** guard コマンドのオプション（共通オプション + 必須の `--base`）。 */
export interface GuardOptions extends CommonOptions {
  /** 比較対象の base ref（`<base>...HEAD` の merge-base 比較）。 */
  base: string;
}

/** executeGuard が出力に使う I/O。テストでは writer を差し替えて検証する。 */
export interface GuardIo {
  /** 標準出力への書き込み。 */
  stdout: (text: string) => void;
  /** 標準エラーへの書き込み。 */
  stderr: (text: string) => void;
  /** 色付けするか。 */
  color: boolean;
}

/**
 * merge-base 側の `.ai/project.yaml` を読み検証する。存在しなければ {@link ProjectConfigError} を投げる
 * （working tree ではなく merge-base を読む理由はこのファイル冒頭のコメント参照）。
 *
 * merge-base に project.yaml が無いケースは、典型的には ai-repo-ops をまだ導入していない repo への
 * 導入 PR そのもの（`aro init` を含む最初の PR）。導入 PR は「検証ルールを持ち込む」PR であり、
 * 検証対象にできない（読むべきルールがまだ存在しない）ため、hint でその旨を案内する。
 */
async function loadProjectConfigAtRevision(repoRoot: string, revision: string): Promise<ProjectConfig> {
  const text = await readFileAtRevision(repoRoot, revision, PROJECT_YAML_PATH);
  if (text === null) {
    throw new ProjectConfigError(
      "PROJECT_CONFIG_NOT_FOUND",
      `base（merge-base: ${revision}）に ${PROJECT_YAML_PATH} が存在しません。`,
      {
        hint:
          "guard は自己改変・迂回を防ぐため base 側（merge-base）の project.yaml を読みます。" +
          "base に project.yaml が無い場合、guard は検証ルールを読めず判定できません。" +
          "ai-repo-ops 導入 PR（`aro init` を含む最初の PR）自体は guard の対象にできないため、" +
          "導入 PR を merge した後の PR から guard 対象にしてください。",
      },
    );
  }
  return parseProjectConfig(text, `${revision}:${PROJECT_YAML_PATH}`);
}

/**
 * merge-base 側の risk_level 対応 policy（`.ai/managed/policies/<name>.yaml`）を読み検証する。
 * 存在しなければ {@link PolicyError} を投げる。
 */
async function loadPolicyAtRevision(
  repoRoot: string,
  revision: string,
  riskLevel: RiskLevel,
): Promise<Policy> {
  const relPath = policyPathForRiskLevel(riskLevel);
  const text = await readFileAtRevision(repoRoot, revision, relPath);
  if (text === null) {
    throw new PolicyError(
      "POLICY_NOT_FOUND",
      `base（merge-base: ${revision}）に policy ファイルが存在しません: ${relPath}（risk_level=${riskLevel}）`,
      { hint: "base 側で `aro sync` を実行し、managed policy を配布した状態にしてください。" },
    );
  }
  return parsePolicy(text, `${revision}:${relPath}`);
}

/**
 * guard を実行し終了コードを返す（process.exit には触れない）。
 * 出力は {@link GuardIo} 経由で行うため、テストから writer を差し替えて検証できる。
 */
export async function executeGuard(options: GuardOptions, io: GuardIo): Promise<number> {
  try {
    const repoRoot = await assertGitRepo(options.repo);
    const mergeBaseSha = await getMergeBase(repoRoot, options.base);

    const projectConfig = await loadProjectConfigAtRevision(repoRoot, mergeBaseSha);
    const policy = await loadPolicyAtRevision(repoRoot, mergeBaseSha, projectConfig.project.risk_level);
    // diff も同じ merge-base SHA で取る（project.yaml/policy を読んだ時点と diff の対象を一致させる）。
    const changedFiles = await getChangedFiles(repoRoot, mergeBaseSha);

    let trustedSync: SyncAuthenticationReport =
      createNotApplicableSyncAuthenticationReport("lock_unchanged");
    if (changedFiles.some((file) => file.path === LOCKFILE_RELATIVE_PATH)) {
      const baseLockText = await readFileAtRevision(
        repoRoot,
        mergeBaseSha,
        LOCKFILE_RELATIVE_PATH,
      );
      if (baseLockText === null) {
        trustedSync = createNotApplicableSyncAuthenticationReport("base_lock_missing");
      } else {
        const baseLock = parseLockFile(
          baseLockText,
          `${mergeBaseSha}:${LOCKFILE_RELATIVE_PATH}`,
        );
        const sourceRoot = await resolveSourceRoot(options.source, defaultSourceStartDir());
        const distribution = await loadDistribution(sourceRoot, baseLock.source.distribution);
        trustedSync = await authenticateSyncChange({
          repoRoot,
          repoName: resolveTemplateRepoName(repoRoot, projectConfig.project.name),
          mergeBaseSha,
          changedFiles,
          distribution,
        });
      }
    }

    const report: GuardReport = runGuard({
      changedFiles,
      projectConfig,
      policy,
      trustedSyncPaths: new Set(
        trustedSync.status === "authenticated" ? trustedSync.paths : [],
      ),
    });

    if (options.json) {
      io.stdout(
        `${JSON.stringify({ command: "guard", ok: !report.hasViolations, base: options.base, trustedSync, report }, null, 2)}\n`,
      );
    } else {
      io.stdout(
        `${formatGuardHuman(report, { base: options.base, color: io.color, trustedSync })}\n`,
      );
    }
    return report.hasViolations ? GUARD_EXIT.violations : GUARD_EXIT.ok;
  } catch (error) {
    if (options.json) {
      io.stderr(`${JSON.stringify({ command: "guard", ok: false, error: errorToJson(error) }, null, 2)}\n`);
    } else {
      io.stderr(`${formatAroError(error)}\n`);
    }
    return GUARD_EXIT.unexpected;
  }
}

/** options.color / TTY / NO_COLOR から実際の色付け可否を決める。 */
function resolveColor(color: boolean): boolean {
  return color && process.stdout.isTTY === true && process.env["NO_COLOR"] === undefined;
}

/** `aro guard` を登録する。 */
export function registerGuard(program: Command): void {
  const command = program
    .command("guard")
    .summary("PR由来の変更がpoliciesに違反していないかを検証する")
    .description(
      "<base>...HEAD（merge-base比較）のdiffを検証し、forbidden_paths / allowed_paths / change_limits等のpolicies違反を検出する。読み取り専用。",
    )
    .requiredOption("--base <ref>", "比較対象のbase ref（<base>...HEADのmerge-base比較）。");

  addCommonOptions(command).action(async (options: GuardOptions) => {
    const code = await executeGuard(options, {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
      color: resolveColor(options.color),
    });
    process.exitCode = code;
  });
}

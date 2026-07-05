/**
 * `aro guard` が読む policy（`.ai/managed/policies/*.yaml`）の zod schema・risk_level → path 解決・parse。
 *
 * docs/plans/03-guard-and-improve-loop.md Stage 1-1 に対応する（未 merge の場合はこのモジュールと
 * 呼び出し元 commands/guard.ts の実装を仕様の正とする）。
 *
 * policy ファイルは managed file として配布される（distribution/base/files/.ai/managed/policies/*.yaml、
 * manifest 上は managed_overwrite）ため、対象 repo 側では `.ai/managed/policies/<name>.yaml` を直接
 * 読む。project.yaml の `project.risk_level` → policy ファイル名の対応規則は、これまで shell（計画書の
 * 記述）にしかなかったものを、guard 実装にあわせてここで初めて TypeScript の正として実装する
 * （{@link policyPathForRiskLevel}）。
 *
 * project-config.ts と同様、guard が使うフィールド（`change_limits.*` / `forbidden_paths`）だけを
 * zod で検証し、他のフィールド（schema_version / name / review / allowed_actions / quality_gates 等）は
 * `.passthrough()` でそのまま通す。
 *
 * working tree（PR HEAD）から読み込む loader（旧 `loadPolicy`）は project-config.ts と同じ理由
 * （PR 自身が policy を書き換えて自己検証を骨抜きにできてしまう）で削除した。commands/guard.ts は
 * {@link policyPathForRiskLevel} で決めた path を merge-base から
 * {@link import("./git-diff.js").readFileAtRevision} で読み、{@link parsePolicy} に渡す。
 */
import { z } from "zod";

import { PolicyError } from "./errors.js";
import type { RiskLevel } from "./project-config.js";
import { parseYaml } from "./yaml.js";

/** `change_limits` セクション。すべて optional（未設定なら guard 側で「制限なし」として扱う）。 */
const changeLimitsSchema = z
  .object({
    max_changed_files: z.number().int().min(1).optional(),
    max_added_lines: z.number().int().min(0).optional(),
  })
  .passthrough();

/**
 * guard が使う policy の最小 schema。
 * `change_limits` / `forbidden_paths` のみ検証し、他は通す。
 */
export const policySchema = z
  .object({
    change_limits: changeLimitsSchema.optional(),
    forbidden_paths: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

/** 検証済み policy（guard 用最小 schema）の型。 */
export type Policy = z.infer<typeof policySchema>;

/**
 * `project.risk_level` → policy ファイル（対象 repo root からの相対 path）の対応表。
 * `.ai/managed/policies/*.yaml` は distribution/base/files/.ai/managed/policies/ の内容そのもの。
 */
const POLICY_PATH_BY_RISK_LEVEL: Record<RiskLevel, string> = {
  low: ".ai/managed/policies/low-risk.yaml",
  medium: ".ai/managed/policies/default.yaml",
  high: ".ai/managed/policies/security.yaml",
};

/** `project.risk_level` から適用する policy ファイルの相対 path を決める。 */
export function policyPathForRiskLevel(riskLevel: RiskLevel): string {
  return POLICY_PATH_BY_RISK_LEVEL[riskLevel];
}

/** zod の issue 配列を人間が読める 1 文字列にまとめる。 */
function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}

/**
 * すでに parse 済みの JS 値を policy（guard 用最小 schema）として検証する。
 * 失敗時は {@link PolicyError}（code: `POLICY_INVALID`）を投げる。
 */
export function parsePolicyValue(value: unknown, sourceRef?: string): Policy {
  const result = policySchema.safeParse(value);
  if (!result.success) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new PolicyError(
      "POLICY_INVALID",
      `${where}policy の検証に失敗しました（guard に必要な change_limits.* / forbidden_paths の schema）:\n${formatZodIssues(result.error.issues)}`,
      { hint: "change_limits.max_changed_files / change_limits.max_added_lines / forbidden_paths を確認してください。", cause: result.error },
    );
  }
  return result.data;
}

/**
 * YAML テキストを policy（guard 用最小 schema）として parse・検証する。
 * YAML parse 失敗も {@link PolicyError}（code: `POLICY_PARSE`）にラップする。
 */
export function parsePolicy(text: string, sourceRef?: string): Policy {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new PolicyError("POLICY_PARSE", `${where}policy の YAML parse に失敗しました。`, {
      hint: "YAML 構文を確認してください。",
      cause: error,
    });
  }
  return parsePolicyValue(parsed, sourceRef);
}

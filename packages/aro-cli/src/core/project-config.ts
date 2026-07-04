/**
 * `aro guard` が読む project.yaml（`.ai/project.yaml`）の zod schema と parse/load。
 *
 * docs/plans/03-guard-and-improve-loop.md Stage 1-1 に対応する（未 merge の場合はこのモジュールと
 * 呼び出し元 commands/guard.ts の実装を仕様の正とする）。
 *
 * project.yaml 全体の妥当性検証は `aro doctor` が authoritative schema（schemas/project.schema.json）で
 * 行う（core/doctor.ts の {@link import("./json-schema.js").validateJsonSchema}）。guard はその結果に
 * 依存せず単独で動く必要がある（doctor を経由しない CI 呼び出しもあるため）ため、guard の判定に
 * 実際に使うフィールド（`project.risk_level` と `ai.*`）だけを zod で厳密に検証し、他のフィールドは
 * `.passthrough()` でそのまま通す。authoritative schema 側で `project.risk_level` は必須（enum）なので、
 * ここでも必須にして整合を取る。
 */
import { z } from "zod";

import { ProjectConfigError } from "./errors.js";
import { readFileWithinRoot } from "./filesystem.js";
import { PROJECT_YAML_PATH } from "./manifest.js";
import { parseYaml } from "./yaml.js";

/** project.yaml の `project.risk_level`（AI ハーネスの慎重さ・guard の policy 選択に使う）。 */
export const RISK_LEVELS = ["low", "medium", "high"] as const;
/** {@link RISK_LEVELS} の値ユニオン。 */
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** `project` セクション。`risk_level` のみ guard に必要なため必須にし、他は通す。 */
const projectSectionSchema = z
  .object({
    risk_level: z.enum(RISK_LEVELS),
  })
  .passthrough();

/** `ai` セクション。すべて optional（未設定なら guard 側で「制限なし」として扱う）。 */
const aiSectionSchema = z
  .object({
    max_changed_files: z.number().int().min(1).optional(),
    allowed_paths: z.array(z.string().min(1)).optional(),
    forbidden_paths: z.array(z.string().min(1)).optional(),
  })
  .passthrough();

/**
 * guard が使う project.yaml の最小 schema。
 * `project.risk_level` のみ必須。`ai` セクション自体も未設定を許容する（guard は「制限なし」として扱う）。
 * schema_version / commands / quality_gates 等 guard が使わないフィールドは検証せず通す。
 */
export const projectConfigSchema = z
  .object({
    project: projectSectionSchema,
    ai: aiSectionSchema.optional(),
  })
  .passthrough();

/** 検証済み project.yaml（guard 用最小 schema）の型。 */
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

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
 * すでに parse 済みの JS 値を project.yaml（guard 用最小 schema）として検証する。
 * 失敗時は {@link ProjectConfigError}（code: `PROJECT_CONFIG_INVALID`）を投げる。
 */
export function parseProjectConfigValue(value: unknown, sourceRef?: string): ProjectConfig {
  const result = projectConfigSchema.safeParse(value);
  if (!result.success) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new ProjectConfigError(
      "PROJECT_CONFIG_INVALID",
      `${where}project.yaml の検証に失敗しました（guard に必要な project.risk_level / ai.* の schema）:\n${formatZodIssues(result.error.issues)}`,
      {
        hint: "project.risk_level（low/medium/high）と ai.max_changed_files / ai.allowed_paths / ai.forbidden_paths を確認してください。",
        cause: result.error,
      },
    );
  }
  return result.data;
}

/**
 * YAML テキストを project.yaml（guard 用最小 schema）として parse・検証する。
 * YAML parse 失敗も {@link ProjectConfigError}（code: `PROJECT_CONFIG_PARSE`）にラップする。
 */
export function parseProjectConfig(text: string, sourceRef?: string): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new ProjectConfigError("PROJECT_CONFIG_PARSE", `${where}project.yaml の YAML parse に失敗しました。`, {
      hint: "YAML 構文を確認してください。",
      cause: error,
    });
  }
  return parseProjectConfigValue(parsed, sourceRef);
}

/**
 * 対象 repo の project.yaml（`.ai/project.yaml`）を読み込み、guard 用最小 schema で検証する。
 *
 * doctor と異なり存在しない場合も null を返さず {@link ProjectConfigError} を投げる。guard は
 * 「検証に必要な入力が読めない」ことを unexpected（exit 3）として扱う設計のため（doctor は
 * 診断項目の 1 つとして FAIL 扱いするが、guard には「診断」の概念がない）。
 *
 * @param repoRoot 対象 repo の root（絶対 path 推奨）。
 * @throws {ProjectConfigError} project.yaml が存在しない/parse 不能/schema 不一致の場合。
 */
export async function loadProjectConfig(repoRoot: string): Promise<ProjectConfig> {
  const buffer = await readFileWithinRoot(repoRoot, PROJECT_YAML_PATH, "project.yaml");
  if (buffer === null) {
    throw new ProjectConfigError(
      "PROJECT_CONFIG_NOT_FOUND",
      `${PROJECT_YAML_PATH} が見つかりません: ${repoRoot}`,
      { hint: "`aro init --repo .` を実行してください。" },
    );
  }
  return parseProjectConfig(buffer.toString("utf8"), PROJECT_YAML_PATH);
}

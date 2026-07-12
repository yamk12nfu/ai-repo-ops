/**
 * `aro guard` が読む project.yaml（`.ai/project.yaml`）の zod schema と parse。
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
 *
 * `ai` セクション（`allowed_paths` / `forbidden_paths` / `max_changed_files`）を optional にできるのは、
 * commands/guard.ts がこの値を PR HEAD（working tree）からではなく merge-base（PR からは書き換えられない
 * revision）から読む前提だから。PR 自身が改変できる内容であれば、この schema を緩めても guard の
 * 自己検証を骨抜きにできてしまう（詳細は commands/guard.ts と core/git-diff.ts の
 * {@link import("./git-diff.js").readFileAtRevision} を参照）。working tree を読み込む
 * loader（旧 `loadProjectConfig`）は自己改変・迂回を許してしまうため削除した。
 *
 * このモジュール自身は revision を意識しない（テキスト → 検証済み値、の純粋変換のみ）。
 * どの revision から読むかは呼び出し側（commands/guard.ts）の責務。
 */
import { z } from "zod";

import { ProjectConfigError } from "./errors.js";
import { parseYaml } from "./yaml.js";

/** project.yaml の `project.risk_level`（AI ハーネスの慎重さ・guard の policy 選択に使う）。 */
export const RISK_LEVELS = ["low", "medium", "high"] as const;
/** {@link RISK_LEVELS} の値ユニオン。 */
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** `project` セクション。`risk_level` のみ guard に必要なため必須にし、他は通す。 */
const projectSectionSchema = z
  .object({
    name: z.string().min(1).optional(),
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
 * syncのtemplate context向けにproject.nameをbest-effortで読む。
 * YAMLまたはguard用最小schemaが不正なら例外にせずundefinedを返し、callerが従来のdirectory名へ
 * fallbackできるようにする。
 */
export function tryParseProjectName(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return undefined;
  }
  const result = projectConfigSchema.safeParse(parsed);
  return result.success ? result.data.project.name : undefined;
}

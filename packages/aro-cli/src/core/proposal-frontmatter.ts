/**
 * proposal（.ai/local/proposals/*.md）のfrontmatter読み込みと検証（計画 06 Stage 1-1）。
 *
 * 1 提案 = 1 Markdownファイルで、`---` で挟まれたYAML frontmatterが状態（採否）と根拠を持つ。
 * proposalsはknowledgeと違いindex.yamlを持たず、ファイルシステム自体をindexとして扱うため、
 * ここでの検証は**ファイル単体**で閉じる（`id` のrepo横断の一意性検証はStage 1-2の
 * `aro proposals check` の責務。並行PRで重複が混入しうる点は計画のリスク欄を参照）。
 *
 * YAML parse（yaml.ts）・path安全境界とSHA検証（knowledge-index.ts のzod部品）は既存を再利用し、
 * 新規実装はfrontmatterと本文の分離だけに留める。
 */
import { z } from "zod";

import { ProposalError } from "./errors.js";
import { exactSafePathSchema, FULL_GIT_SHA_RE } from "./knowledge-index.js";
import { parseYaml } from "./yaml.js";

/** repo 固有 proposal の固定root。中央distributionはこの領域へ書き込まない。 */
export const PROPOSALS_ROOT = ".ai/local/proposals";
/** MVPで扱うproposal frontmatter schema version。 */
export const PROPOSAL_SCHEMA_VERSION = 1 as const;

/** 提案の状態。open以外への遷移は人間のみが行う（計画 06「状態遷移」節）。 */
export const PROPOSAL_STATUSES = ["open", "accepted", "rejected", "done", "superseded"] as const;

const PROPOSAL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const proposalSourceSchema = z
  .object({
    path: exactSafePathSchema("source path"),
  })
  .strict();

const proposalBudgetSchema = z
  .object({
    max_changed_files: z.number().int().min(1).optional(),
    max_added_lines: z.number().int().min(0).optional(),
    reason: z.string().refine((value) => value.trim().length > 0, "reasonは空白以外を含む必要があります。"),
  })
  .strict()
  .refine(
    (budget) => budget.max_changed_files !== undefined || budget.max_added_lines !== undefined,
    "max_changed_filesまたはmax_added_linesの少なくとも一方が必要です。",
  );

const proposalDecisionSchema = z
  .object({
    by: z.string().default(""),
    reason: z.string().default(""),
    budget: proposalBudgetSchema.optional(),
  })
  .strict();

export const proposalFrontmatterSchema = z
  .object({
    schema_version: z.literal(PROPOSAL_SCHEMA_VERSION, {
      errorMap: () => ({
        message: `schema_versionは${PROPOSAL_SCHEMA_VERSION}である必要があります。`,
      }),
    }),
    id: z.string().regex(PROPOSAL_ID_RE, "IDは小文字英数字のkebab-caseで指定してください。"),
    status: z.enum(PROPOSAL_STATUSES, {
      errorMap: () => ({
        message: `statusは ${PROPOSAL_STATUSES.join(" / ")} のいずれかである必要があります。`,
      }),
    }),
    proposed_at_commit: z
      .string()
      .regex(FULL_GIT_SHA_RE, "proposed_at_commitは完全なlowercase Git SHAで指定してください。"),
    sources: z.array(proposalSourceSchema).min(1, "sourcesは1件以上必要です。"),
    decision: proposalDecisionSchema.default({ by: "", reason: "" }),
  })
  .strict()
  .superRefine((frontmatter, ctx) => {
    const seenSources = new Set<string>();
    for (const source of frontmatter.sources) {
      const key = source.path.toLowerCase();
      if (seenSources.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sources"],
          message: `source pathが重複しています（大文字小文字は区別しません）: ${source.path}`,
        });
      }
      seenSources.add(key);
    }

    // 採否の記録は人間の判断の痕跡そのもの。open以外で判断者が空の提案は機械的に弾く。
    if (frontmatter.status !== "open" && frontmatter.decision.by.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "by"],
        message: `statusが${frontmatter.status}の提案ではdecision.by（判断した人間）が必須です。`,
      });
    }
    if (
      (frontmatter.status === "rejected" || frontmatter.status === "superseded") &&
      frontmatter.decision.reason.trim().length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "reason"],
        message: `statusが${frontmatter.status}の提案ではdecision.reason（判断の理由）が必須です。`,
      });
    }
    if (
      frontmatter.decision.budget !== undefined &&
      frontmatter.status !== "accepted" &&
      frontmatter.status !== "done"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["decision", "budget"],
        message: "decision.budgetはstatusがacceptedまたはdoneの提案でのみ指定できます。",
      });
    }
  });

export type ProposalFrontmatter = z.infer<typeof proposalFrontmatterSchema>;
export type ProposalBudget = NonNullable<ProposalFrontmatter["decision"]["budget"]>;
export type ProposalStatus = ProposalFrontmatter["status"];
export type ProposalSource = ProposalFrontmatter["sources"][number];

/** frontmatterと本文へ分離済みのproposal document。 */
export interface ProposalDocument {
  /** 検証済みのfrontmatter。 */
  frontmatter: ProposalFrontmatter;
  /** 閉じ `---` より後のMarkdown本文（先頭・末尾の改行はそのまま保持する）。 */
  body: string;
}

/** frontmatter delimiter（`---` 単独行。CRLF由来の末尾 `\r` は許容する）。 */
const FRONTMATTER_DELIMITER_RE = /^---\r?$/u;

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}

function withSourceRef(sourceRef: string | undefined, message: string): string {
  return sourceRef ? `${sourceRef}: ${message}` : message;
}

/**
 * Markdownテキストを「YAML frontmatter」と「本文」へ分離する。
 *
 * 先頭行（BOMは無視する）が `---` でなければfrontmatter無しとしてエラー、
 * 閉じ `---` が見つからなければ未終端としてエラーにする。YAML parse・検証は行わない。
 */
export function splitProposalFrontmatter(
  text: string,
  sourceRef?: string,
): { frontmatterYaml: string; body: string } {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = withoutBom.split("\n");
  if (lines.length === 0 || !FRONTMATTER_DELIMITER_RE.test(lines[0] ?? "")) {
    throw new ProposalError(
      "PROPOSAL_FRONTMATTER_MISSING",
      withSourceRef(sourceRef, "先頭に `---` で始まるYAML frontmatterがありません。"),
      { hint: "提案ファイルは1行目を `---` にし、frontmatterを `---` で閉じてください。" },
    );
  }
  const closingIndex = lines.findIndex(
    (line, index) => index > 0 && FRONTMATTER_DELIMITER_RE.test(line),
  );
  if (closingIndex === -1) {
    throw new ProposalError(
      "PROPOSAL_FRONTMATTER_UNTERMINATED",
      withSourceRef(sourceRef, "YAML frontmatterを閉じる `---` がありません。"),
      { hint: "frontmatterの末尾に `---` の行を追加してください。" },
    );
  }
  return {
    frontmatterYaml: lines.slice(1, closingIndex).join("\n"),
    body: lines.slice(closingIndex + 1).join("\n"),
  };
}

/** parse済みの値を検証済みproposal frontmatterへ変換する。 */
export function parseProposalFrontmatterValue(
  value: unknown,
  sourceRef?: string,
): ProposalFrontmatter {
  const result = proposalFrontmatterSchema.safeParse(value);
  if (!result.success) {
    throw new ProposalError(
      "PROPOSAL_FRONTMATTER_INVALID",
      withSourceRef(
        sourceRef,
        `proposal frontmatterの検証に失敗しました:\n${formatZodIssues(result.error.issues)}`,
      ),
      { hint: "proposal schemaに合わせて修正してください。", cause: result.error },
    );
  }
  return result.data;
}

/**
 * Markdownテキストを検証済みfrontmatterと本文へ変換する。
 * frontmatterの分離 → YAML parse → zod検証の順で行い、失敗はすべて {@link ProposalError} にする。
 */
export function parseProposalDocument(text: string, sourceRef?: string): ProposalDocument {
  const { frontmatterYaml, body } = splitProposalFrontmatter(text, sourceRef);
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterYaml);
  } catch (error) {
    throw new ProposalError(
      "PROPOSAL_FRONTMATTER_PARSE",
      withSourceRef(sourceRef, "proposal frontmatterのYAML parseに失敗しました。"),
      { hint: "frontmatterのYAML構文を確認してください。", cause: error },
    );
  }
  return { frontmatter: parseProposalFrontmatterValue(parsed, sourceRef), body };
}

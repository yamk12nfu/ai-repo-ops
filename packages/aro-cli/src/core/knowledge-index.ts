import { z } from "zod";

import { KnowledgeError } from "./errors.js";
import { assertSafeRelativePath } from "./paths.js";
import { parseYaml } from "./yaml.js";

/** repo 固有 knowledge の固定root。中央distributionはこの領域へ書き込まない。 */
export const KNOWLEDGE_ROOT = ".ai/local/knowledge";
/** knowledge index のrepo rootからの相対path。 */
export const KNOWLEDGE_INDEX_PATH = `${KNOWLEDGE_ROOT}/index.yaml`;
/** MVPで扱うknowledge index schema version。 */
export const KNOWLEDGE_INDEX_SCHEMA_VERSION = 1 as const;

/** 完全なlowercase Git SHA（SHA-1: 40桁 / SHA-256: 64桁）。knowledgeとproposalsで共有する。 */
export const FULL_GIT_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const KNOWLEDGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
/**
 * index内のpathはexact file pathのみ。glob展開はローカルAI側の責務。
 * 素の `()` はglobメタ文字ではなく実在path（例: Next.js route groupの `app/(app)/...`）に
 * 現れるため許可し、extglobの `+(` `@(` だけを拒否する（`!(` `*(` `?(` は `!` `*` `?` で拒否済み）。
 */
const GLOB_META_RE = /[*?\[\]{}!]|[+@]\(/u;

/**
 * 「安全な相対path・globなし（任意で.md必須）」を検証するzod schema。
 * knowledge indexとproposal frontmatterのsource path検証で共有する。
 */
export function exactSafePathSchema(label: string, options: { markdown?: boolean } = {}): z.ZodType<string> {
  return z.string().transform((value, ctx) => {
    // fatal: true が無いとparse全体は「dirty」のまま続行され、object側のsuperRefineが
    // 検証失敗済みの値（string以外）で実行されてTypeErrorになり、本来のメッセージが失われる。
    let normalized: string;
    try {
      normalized = assertSafeRelativePath(value, label);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
        fatal: true,
      });
      return z.NEVER;
    }
    if (GLOB_META_RE.test(normalized)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} にglobは使えません。正確なファイルpathを指定してください: ${value}`,
        fatal: true,
      });
      return z.NEVER;
    }
    if (options.markdown === true && !normalized.toLowerCase().endsWith(".md")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} はMarkdownファイル（.md）である必要があります: ${value}`,
        fatal: true,
      });
      return z.NEVER;
    }
    return normalized;
  });
}

const knowledgeSourceSchema = z
  .object({
    path: exactSafePathSchema("source path"),
  })
  .strict();

const knowledgeEntrySchema = z
  .object({
    id: z
      .string()
      .regex(KNOWLEDGE_ID_RE, "IDは小文字英数字のkebab-caseで指定してください。"),
    document: exactSafePathSchema("document path", { markdown: true }),
    verified_at_commit: z
      .string()
      .regex(FULL_GIT_SHA_RE, "verified_at_commitは完全なlowercase Git SHAで指定してください。"),
    sources: z.array(knowledgeSourceSchema).min(1, "sourcesは1件以上必要です。"),
  })
  .strict()
  .superRefine((entry, ctx) => {
    const seenSources = new Set<string>();
    for (const source of entry.sources) {
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
  });

export const knowledgeIndexSchema = z
  .object({
    schema_version: z.literal(KNOWLEDGE_INDEX_SCHEMA_VERSION, {
      errorMap: () => ({
        message: `schema_versionは${KNOWLEDGE_INDEX_SCHEMA_VERSION}である必要があります。`,
      }),
    }),
    entries: z.array(knowledgeEntrySchema),
  })
  .strict()
  .superRefine((index, ctx) => {
    const ids = new Set<string>();
    const documents = new Set<string>();
    index.entries.forEach((entry, indexPosition) => {
      const idKey = entry.id.toLowerCase();
      if (ids.has(idKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", indexPosition, "id"],
          message: `IDが重複しています（大文字小文字は区別しません）: ${entry.id}`,
        });
      }
      ids.add(idKey);

      const documentKey = entry.document.toLowerCase();
      if (documents.has(documentKey)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", indexPosition, "document"],
          message: `document pathが重複しています（大文字小文字は区別しません）: ${entry.document}`,
        });
      }
      documents.add(documentKey);
    });
  });

export type KnowledgeIndex = z.infer<typeof knowledgeIndexSchema>;
export type KnowledgeEntry = KnowledgeIndex["entries"][number];
export type KnowledgeSource = KnowledgeEntry["sources"][number];

function formatZodIssues(issues: z.ZodIssue[]): string {
  return issues
    .map((issue) => {
      const where = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `  - ${where}: ${issue.message}`;
    })
    .join("\n");
}

/** parse済みの値を検証済みknowledge indexへ変換する。 */
export function parseKnowledgeIndexValue(value: unknown, sourceRef?: string): KnowledgeIndex {
  const result = knowledgeIndexSchema.safeParse(value);
  if (!result.success) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new KnowledgeError(
      "KNOWLEDGE_INDEX_INVALID",
      `${where}knowledge indexの検証に失敗しました:\n${formatZodIssues(result.error.issues)}`,
      { hint: "knowledge index schemaに合わせて修正してください。", cause: result.error },
    );
  }
  return result.data;
}

/** YAML文字列を検証済みknowledge indexへ変換する。 */
export function parseKnowledgeIndex(text: string, sourceRef?: string): KnowledgeIndex {
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new KnowledgeError("KNOWLEDGE_INDEX_PARSE", `${where}knowledge indexのYAML parseに失敗しました。`, {
      hint: "index.yamlのYAML構文を確認してください。",
      cause: error,
    });
  }
  return parseKnowledgeIndexValue(parsed, sourceRef);
}

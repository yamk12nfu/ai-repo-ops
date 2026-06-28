/**
 * manifest（distribution/<name>/manifest.yaml）の zod schema と検証。
 *
 * 計画 v3 §9 に対応する。schema 検証（型・必須・strategy・semver）と
 * path safety（絶対 path / `..` traversal / 予約名の拒否）、および
 * §0.2.8 の seed_files src/template 排他、§9.4 の preserve × managed_overwrite 衝突を
 * このモジュールで一括して検証する。
 *
 * ここでの検証は「manifest 構造の妥当性」までで、src/template ファイルの存在確認や
 * 内容読み込みは FS アクセスを伴うため source.ts（distribution loader）側で行う。
 */
import picomatch from "picomatch";
import { z } from "zod";

import { ManifestError } from "./errors.js";
import { assertSafeRelativePath } from "./paths.js";

/** MVP がサポートする manifest schema version。 */
export const MANIFEST_SCHEMA_VERSION = 1 as const;

/** semver（major.minor.patch[-prerelease][+build]）の簡易判定。MVP では `semver` パッケージは使わない。 */
const SEMVER_RE =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * 計画 §20.3 の固定保護 path。manifest の preserve 指定の有無に関係なく常に保護する。
 * これらは sync 対象（managed_overwrite / patch）にできない。
 * `.ai/project.yaml` だけは {@link PROJECT_YAML_PATH} として別扱いし、create_only seed のときだけ許可する。
 *
 * preserve は manifest 作者が任意に書ける一方、これは「漏れても安全」を保証する defense in depth。
 */
export const ALWAYS_PRESERVED_PATTERNS = [".env", ".env.*", "secrets/**", ".ai/local/**"] as const;

/** create_only seed としてのみ許可される path（managed_overwrite / patch では保護される、§20.3）。 */
export const PROJECT_YAML_PATH = ".ai/project.yaml";

/** path 1 件を判定する picomatch matcher（dot:true で先頭ドットの path も対象にする）。 */
interface ProtectedMatcher {
  pattern: string;
  isMatch: (target: string) => boolean;
}

/** glob pattern から {@link ProtectedMatcher} を作る。 */
function protectedMatcher(pattern: string): ProtectedMatcher {
  return { pattern, isMatch: picomatch(pattern, { dot: true }) };
}

/** create_only で許可する path（= ALWAYS_PRESERVED のみ。project.yaml は含めない）。 */
const ALWAYS_PRESERVED_MATCHERS: ProtectedMatcher[] = ALWAYS_PRESERVED_PATTERNS.map(protectedMatcher);

/** managed_overwrite / patch で禁止する path（ALWAYS_PRESERVED + project.yaml）。 */
const FULLY_PROTECTED_MATCHERS: ProtectedMatcher[] = [
  ...ALWAYS_PRESERVED_MATCHERS,
  protectedMatcher(PROJECT_YAML_PATH),
];

/** matchers のうち target に最初に一致した pattern を返す。無ければ undefined。 */
function firstProtectedMatch(
  matchers: readonly ProtectedMatcher[],
  target: string,
): string | undefined {
  return matchers.find((m) => m.isMatch(target))?.pattern;
}

/**
 * 相対 path 文字列を検証し、POSIX 正規化した値へ変換する zod スキーマを作る。
 * {@link assertSafeRelativePath} を superRefine で呼び、絶対 path / traversal / 予約名を弾く。
 *
 * @param label エラー文言用のフィールド名（"src" / "dest" / "path" など）。
 */
function safeRelativePathSchema(label: string): z.ZodType<string> {
  return z.string().transform((value, ctx) => {
    try {
      return assertSafeRelativePath(value, label);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });
}

/**
 * glob を許容する相対 path（preserve 用）。`**` / `*` はリテラルセグメントとして安全性検査を通過し、
 * POSIX 正規化した値を返す。
 *
 * 正規化して返すのが重要: 正規化しないと `./.ai/local/**` のような表記ゆれが、
 * 正規化済みの dest（`.ai/local/keep.md`）と picomatch で一致せず、保護判定をすり抜けてしまう。
 */
function safeRelativeGlobSchema(label: string): z.ZodType<string> {
  return z.string().transform((value, ctx) => {
    try {
      return assertSafeRelativePath(value, label);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : String(error),
      });
      return z.NEVER;
    }
  });
}

/** files[]（managed_overwrite）エントリ。 */
const managedFileEntrySchema = z
  .object({
    src: safeRelativePathSchema("files[].src"),
    dest: safeRelativePathSchema("files[].dest"),
    strategy: z.literal("managed_overwrite"),
  })
  .strict();

/** seed_files[]（create_only）エントリ。src / template はどちらか一方だけ必須（§0.2.8 / §9.4）。 */
const seedFileEntrySchema = z
  .object({
    dest: safeRelativePathSchema("seed_files[].dest"),
    strategy: z.literal("create_only"),
    src: safeRelativePathSchema("seed_files[].src").optional(),
    template: safeRelativePathSchema("seed_files[].template").optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasSrc = value.src !== undefined;
    const hasTemplate = value.template !== undefined;
    if (hasSrc === hasTemplate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "seed_files[] は src または template のどちらか一方だけを持つ必要があります（両方あり/両方なしは禁止）。",
        path: ["src"],
      });
    }
  });

/** patches[]（append_unique_lines）エントリ。 */
const patchEntrySchema = z
  .object({
    type: z.literal("append_unique_lines"),
    path: safeRelativePathSchema("patches[].path"),
    lines: z.array(z.string()).min(1, "patches[].lines は 1 行以上必要です。"),
  })
  .strict();

/**
 * manifest 全体の zod schema。
 * 各リストは省略時 `[]`。schema_version / name / version は必須。
 */
export const manifestSchema = z
  .object({
    schema_version: z.literal(MANIFEST_SCHEMA_VERSION, {
      errorMap: () => ({ message: `schema_version は ${MANIFEST_SCHEMA_VERSION} である必要があります。` }),
    }),
    name: z.string().min(1, "name は必須です。"),
    version: z.string().regex(SEMVER_RE, "version は semver 文字列（例: 0.1.0）である必要があります。"),
    files: z.array(managedFileEntrySchema).default([]),
    seed_files: z.array(seedFileEntrySchema).default([]),
    patches: z.array(patchEntrySchema).default([]),
    preserve: z.array(safeRelativeGlobSchema("preserve[]")).default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    // path transform が先に失敗していると値が string でないことがあるため、string のものだけを対象にする
    // （個別の path issue はすでに報告済み）。

    // §20.3: 固定保護 path は manifest の preserve 指定に関係なく常に強制する（defense in depth）。
    //   - managed_overwrite / patch: .env / .env.* / secrets/** / .ai/local/** / .ai/project.yaml を禁止
    //   - create_only seed: 上記のうち .ai/project.yaml だけは許可（それ以外は禁止）
    for (const file of value.files) {
      if (typeof file.dest !== "string") continue;
      const hit = firstProtectedMatch(FULLY_PROTECTED_MATCHERS, file.dest);
      if (hit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `files[].dest "${file.dest}" は固定保護 path（§20.3: "${hit}"）のため managed_overwrite 対象にできません。`,
          path: ["files"],
        });
      }
    }
    for (const seed of value.seed_files) {
      if (typeof seed.dest !== "string") continue;
      const hit = firstProtectedMatch(ALWAYS_PRESERVED_MATCHERS, seed.dest);
      if (hit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `seed_files[].dest "${seed.dest}" は固定保護 path（§20.3: "${hit}"）のため create_only でも配布できません。`,
          path: ["seed_files"],
        });
      }
    }
    for (const patch of value.patches) {
      if (typeof patch.path !== "string") continue;
      const hit = firstProtectedMatch(FULLY_PROTECTED_MATCHERS, patch.path);
      if (hit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `patches[].path "${patch.path}" は固定保護 path（§20.3: "${hit}"）のため patch 対象にできません。`,
          path: ["patches"],
        });
      }
    }

    // §9.4: manifest の preserve に該当する path は managed_overwrite（files[].dest）対象にできない。
    // preserve は transform 済みで正規化されているため、表記ゆれでも dest と正しく突き合わせられる。
    const preserveMatchers = value.preserve
      .filter((pattern): pattern is string => typeof pattern === "string")
      .map(protectedMatcher);
    for (const file of value.files) {
      if (typeof file.dest !== "string") continue;
      const hit = firstProtectedMatch(preserveMatchers, file.dest);
      if (hit) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `files[].dest "${file.dest}" は preserve パターン "${hit}" に一致するため managed_overwrite 対象にできません。`,
          path: ["files"],
        });
      }
    }
  });

/** 検証済み manifest の型（zod から推論）。 */
export type Manifest = z.infer<typeof manifestSchema>;
/** managed file（files[]）エントリの型。 */
export type ManifestManagedFile = Manifest["files"][number];
/** seed file（seed_files[]）エントリの型。 */
export type ManifestSeedFile = Manifest["seed_files"][number];
/** patch（patches[]）エントリの型。 */
export type ManifestPatch = Manifest["patches"][number];

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
 * すでに parse 済みの JS 値（YAML parse 結果など）を manifest として検証する。
 * 失敗時は {@link ManifestError}（code: `MANIFEST_INVALID`）を投げる。
 *
 * @param value     検証対象の値（`unknown`）。
 * @param sourceRef エラー文言に添える出典（例: manifest.yaml の path）。
 */
export function parseManifest(value: unknown, sourceRef?: string): Manifest {
  const result = manifestSchema.safeParse(value);
  if (!result.success) {
    const where = sourceRef ? `${sourceRef}: ` : "";
    throw new ManifestError(
      "MANIFEST_INVALID",
      `${where}manifest の検証に失敗しました:\n${formatZodIssues(result.error.issues)}`,
      { hint: "計画 §9 の manifest 仕様に合わせて修正してください。", cause: result.error },
    );
  }
  return result.data;
}

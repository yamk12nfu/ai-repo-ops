/**
 * seed template の最小レンダラ（計画 v3 §12）。
 *
 * `seed_files[].template`（例: `project.yaml.hbs`）は `{{ repo_name }}` のような
 * mustache 風プレースホルダを含む。MVP では Handlebars 等の本格的なテンプレートエンジンは導入せず、
 * 既知の変数名だけを単純置換する薄い実装にする（§7「標準APIで十分な箇所は標準API優先」）。
 *
 * 方針:
 *   - `{{ name }}` / `{{name}}`（前後空白は任意）の形だけを対象にする。
 *   - 既知の変数（{@link TemplateContext} のキー）はその値へ置換する。
 *   - 未知の変数はそのまま（リテラル）残す。テンプレート側のミスで内容を破壊しないため。
 *   - レンダリングは「書き込むバイト列」だけに影響する。seed file は create_only で checksum 追跡しないため、
 *     distribution content hash や conflict 判定には一切関与しない。
 */
import path from "node:path";

/** テンプレートに渡す変数。MVP では repo 名のみ。 */
export interface TemplateContext {
  /** 対象 repo の名前（init時はdirectory名、既存repoではproject.name）。 */
  repo_name: string;
}

/** `{{ var }}` プレースホルダ。変数名は英字・アンダースコア始まりの識別子に限定する。 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/**
 * テンプレート文字列中の既知プレースホルダを context の値へ置換する。
 * 未知のプレースホルダは元の文字列のまま残す。
 *
 * @param template レンダリング対象（canonical text 済みでよい）。
 * @param context  置換に使う変数。
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  const values: Record<string, string> = { repo_name: context.repo_name };
  return template.replace(PLACEHOLDER_RE, (match, name: string) => {
    // Object.hasOwn で「自前で定義した変数」だけを対象にする。これをしないと
    // `{{ constructor }}` や `{{ __proto__ }}` が Object.prototype のメンバを拾って
    // 置換されてしまう（prototype 汚染的な誤置換）。未知の変数はリテラルのまま残す。
    if (Object.hasOwn(values, name)) {
      return values[name] ?? match;
    }
    return match;
  });
}

/**
 * repo root の絶対 path から repo 名（テンプレート変数 `repo_name`）を導く。
 * 末尾区切りや root（`/`）で basename が空になる場合は `"repo"` にフォールバックする。
 *
 * @param repoRoot 対象 repo の絶対 path。
 */
export function deriveRepoName(repoRoot: string): string {
  const base = path.basename(repoRoot);
  return base.length > 0 ? base : "repo";
}

/** project.nameが使える場合は優先し、旧repoではdirectory名へfallbackする。 */
export function resolveTemplateRepoName(repoRoot: string, projectName?: string): string {
  return projectName === undefined || projectName.length === 0
    ? deriveRepoName(repoRoot)
    : projectName;
}

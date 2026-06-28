/**
 * aro 共通のエラー型。
 *
 * 計画 v3 §23.3「例外は握りつぶさない」「CLIエラーは人間が解決できるメッセージにする」に従い、
 * 機械判定用の `code` と人間向けの復旧ヒント `hint` を持たせる。
 * Phase 1 では path safety だけが使うが、後続フェーズ（manifest / lockfile / planner / apply）でも
 * この基底クラスを継承して使う前提で最小限かつ拡張可能にしておく。
 */

/** {@link AroError} 生成時の追加情報。 */
export interface AroErrorOptions {
  /** 人間向けの復旧ヒント。CLI 出力やログに添える。 */
  hint?: string | undefined;
  /** 元になった例外（ラップ時に渡す）。 */
  cause?: unknown;
}

/**
 * aro が投げるエラーの基底クラス。
 * `code` は安定した機械判定用識別子、`message` は人間向け説明、`hint` は復旧手順。
 */
export class AroError extends Error {
  /** 安定した機械判定用のエラーコード。 */
  readonly code: string;
  /** 人間向けの復旧ヒント（無い場合は undefined）。 */
  readonly hint: string | undefined;

  constructor(code: string, message: string, options: AroErrorOptions = {}) {
    // exactOptionalPropertyTypes 下では cause を未指定時に渡さない。
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    // サブクラスでも正しいクラス名が出るよう new.target を使う。
    this.name = new.target.name;
    this.code = code;
    this.hint = options.hint;
  }
}

/** path safety 違反のエラーコード。 */
export const PATH_SAFETY_CODES = {
  /** 空文字、または実体のある相対 path になっていない。 */
  empty: "PATH_EMPTY",
  /** NUL 文字を含む。 */
  nul: "PATH_NUL",
  /** 絶対 path（POSIX ルート / Windows ドライブ / UNC）。 */
  absolute: "PATH_ABSOLUTE",
  /** `..` による親ディレクトリ参照を含む。 */
  traversal: "PATH_TRAVERSAL",
  /** 正規化の結果 repo root の外を指している。 */
  escape: "PATH_ESCAPE",
  /** Windows 予約デバイス名や NTFS 代替データストリーム等、書き込み先として危険な名前。 */
  reserved: "PATH_RESERVED",
  /** path の構成要素に symlink が含まれている。 */
  symlink: "PATH_SYMLINK",
} as const;

/** {@link PATH_SAFETY_CODES} の値ユニオン。 */
export type PathSafetyCode = (typeof PATH_SAFETY_CODES)[keyof typeof PATH_SAFETY_CODES];

/**
 * path traversal / symlink など、配布 path の安全性検証に失敗したときのエラー。
 * 計画 §20.1 / §20.2 のセキュリティ要件に対応する。
 */
export class PathSafetyError extends AroError {
  /** 問題となった元の path 文字列。 */
  readonly offendingPath: string;

  constructor(
    code: PathSafetyCode,
    message: string,
    offendingPath: string,
    options: AroErrorOptions = {},
  ) {
    super(code, message, options);
    this.offendingPath = offendingPath;
  }
}

/**
 * manifest（distribution/<name>/manifest.yaml）の読み込み・検証に失敗したときのエラー。
 * 計画 §9.4 の validation rules・§17.2 の「validation error は exit code 1」に対応する。
 * zod の検証失敗・YAML parse 失敗・path safety 違反をすべてこのクラスに集約する。
 */
export class ManifestError extends AroError {
  constructor(code: string, message: string, options: AroErrorOptions = {}) {
    super(code, message, options);
  }
}

/**
 * lock file（.ai/ai-repo-ops.lock.yaml）の読み込み・検証に失敗したときのエラー。
 * 計画 §11 の lock file 仕様・doctor の lock schema 検証に対応する。
 */
export class LockFileError extends AroError {
  constructor(code: string, message: string, options: AroErrorOptions = {}) {
    super(code, message, options);
  }
}

/**
 * ai-repo-ops source / distribution の解決・読み込みに失敗したときのエラー。
 * source root が見つからない、distribution ディレクトリや manifest が無い、
 * manifest が参照する src/template ファイルが存在しない、などに対応する（計画 §17.1 step 3-6）。
 */
export class SourceError extends AroError {
  constructor(code: string, message: string, options: AroErrorOptions = {}) {
    super(code, message, options);
  }
}

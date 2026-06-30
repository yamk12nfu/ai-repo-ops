/**
 * source path resolver と distribution loader。
 *
 * 計画 v3 §17.1 step 3-6 / §10 に対応する。
 *   - source root を解決する（`--source` 指定、または上方探索）。
 *   - distribution/<name>/manifest.yaml を読み、zod で検証する。
 *   - manifest が参照する src/template ファイルの存在を確認し、canonical 内容と sha256 を読む。
 *   - distribution content sha256 を計算する。
 *
 * これにより「manifest 内の全 src 存在を検証できる」「version 同一でも content hash 差分を検出できる」を満たす。
 */
import { stat } from "node:fs/promises";
import path from "node:path";

import { canonicalizeTextString } from "./canonical-text.js";
import { canonicalSha256 } from "./checksum.js";
import {
  buildDistributionHashPayload,
  computeDistributionContentSha256,
} from "./distribution-hash.js";
import { SourceError } from "./errors.js";
import { readFileWithinRoot } from "./filesystem.js";
import { parseManifest, type Manifest } from "./manifest.js";
import { parseYaml } from "./yaml.js";

/** distribution ディレクトリの親（source root 直下）。 */
const DISTRIBUTION_DIR = "distribution";
/** manifest ファイル名。 */
const MANIFEST_FILENAME = "manifest.yaml";

/**
 * distribution 名として許可するパターン（単一 path セグメント）。
 *
 * `--distribution` は CLI オプション由来の untrusted な値で、そのまま `path.join` に渡ると
 * `../...` で `distribution/` の外側を指せてしまう。assertSafeRelativePath は複数セグメントや
 * `.`/`..` を弾くが「単一セグメント」までは強制しないため、ここで明示的に 1 セグメントに限定する。
 * 英数字・ドット・アンダースコア・ハイフンのみ、先頭ドットは禁止（`.`/`..` や隠しディレクトリを除外）。
 */
const DISTRIBUTION_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * distribution 名を検証する。単一セグメントでない、または path 区切り・traversal を含む値は拒否する。
 * @throws {SourceError} 不正な distribution 名の場合（code: `DISTRIBUTION_NAME_INVALID`）。
 */
function assertValidDistributionName(distribution: string): void {
  if (!DISTRIBUTION_NAME_RE.test(distribution)) {
    throw new SourceError(
      "DISTRIBUTION_NAME_INVALID",
      `distribution 名が不正です: ${JSON.stringify(distribution)}`,
      {
        hint: "distribution 名は単一セグメント（英数字・. _ -、先頭ドット不可。path 区切りや .. は不可）にしてください。",
      },
    );
  }
}

/** source / distribution の位置情報。 */
export interface SourceLocation {
  /** ai-repo-ops source root（絶対 path）。 */
  sourceRoot: string;
  /** distribution 名。 */
  distribution: string;
  /** distribution root = sourceRoot/distribution/<name>（絶対 path）。 */
  distributionRoot: string;
  /** manifest.yaml の絶対 path。 */
  manifestPath: string;
}

/** 読み込み済み managed file（files[]）。 */
export interface LoadedManagedFile {
  /** repo root からの相対 dest。 */
  dest: string;
  strategy: "managed_overwrite";
  /** distribution root からの相対 src。 */
  src: string;
  /** source 内容の canonical sha256。 */
  sourceSha256: string;
  /** source の canonical 内容（apply 時に書き込む本体）。 */
  content: string;
}

/** 読み込み済み seed file（seed_files[]）。 */
export interface LoadedSeedFile {
  dest: string;
  strategy: "create_only";
  /** src 由来か template 由来か。 */
  sourceKind: "src" | "template";
  /** distribution root からの相対 src/template path。 */
  sourcePath: string;
  sourceSha256: string;
  content: string;
}

/** 読み込み済み patch（patches[]）。 */
export interface LoadedPatch {
  type: "append_unique_lines";
  /** repo root からの相対 path。 */
  path: string;
  lines: string[];
}

/** distribution 全体を読み込み・検証した結果。 */
export interface LoadedDistribution {
  location: SourceLocation;
  manifest: Manifest;
  managedFiles: LoadedManagedFile[];
  seedFiles: LoadedSeedFile[];
  patches: LoadedPatch[];
  /** preserve glob（manifest 由来）。 */
  preserve: string[];
  /** distribution content sha256（§10）。 */
  contentSha256: string;
}

/** path が存在するディレクトリかどうかを返す（存在しなければ false）。 */
async function isDirectory(absolutePath: string): Promise<boolean> {
  try {
    const stats = await stat(absolutePath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

/** path が存在するファイルかどうかを返す（存在しなければ false）。 */
async function isFile(absolutePath: string): Promise<boolean> {
  try {
    const stats = await stat(absolutePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * source root を解決する。
 *
 * - `source` が与えられた場合: 絶対 path に解決し、`distribution/` を持つことを確認する。
 * - 与えられない場合: `startDir` から上方へ祖先を辿り、`distribution/` を持つ最初のディレクトリを採用する。
 *
 * @param source   `--source` 指定値（絶対/相対どちらでも可）。未指定なら undefined。
 * @param startDir 上方探索の起点（通常は CLI の実行モジュール位置や cwd）。
 * @throws {SourceError} source root が見つからない / distribution ディレクトリが無い場合。
 */
export async function resolveSourceRoot(
  source: string | undefined,
  startDir: string,
): Promise<string> {
  if (source !== undefined) {
    const resolved = path.resolve(source);
    if (!(await isDirectory(resolved))) {
      throw new SourceError("SOURCE_NOT_FOUND", `--source のディレクトリが存在しません: ${resolved}`, {
        hint: "ai-repo-ops source repo の root を指定してください。",
      });
    }
    if (!(await isDirectory(path.join(resolved, DISTRIBUTION_DIR)))) {
      throw new SourceError(
        "SOURCE_NO_DISTRIBUTION",
        `--source に ${DISTRIBUTION_DIR}/ ディレクトリがありません: ${resolved}`,
        { hint: "ai-repo-ops source repo の root（distribution/ を含む）を指定してください。" },
      );
    }
    return resolved;
  }

  let current = path.resolve(startDir);
  // ルートに到達するまで上方探索する。
  for (;;) {
    if (await isDirectory(path.join(current, DISTRIBUTION_DIR))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new SourceError(
        "SOURCE_NOT_FOUND",
        `ai-repo-ops source root が見つかりません（${DISTRIBUTION_DIR}/ を持つ祖先がありません）。起点: ${startDir}`,
        { hint: "--source で ai-repo-ops source repo の root を明示してください。" },
      );
    }
    current = parent;
  }
}

/**
 * source root / distribution 名から {@link SourceLocation} を構築する。
 * distribution ディレクトリと manifest.yaml の存在を確認する。
 *
 * @throws {SourceError} distribution ディレクトリ / manifest.yaml が無い場合。
 */
export async function resolveSourceLocation(
  sourceRoot: string,
  distribution: string,
): Promise<SourceLocation> {
  // path.join に渡す前に単一セグメントであることを強制する（distribution/ 外への traversal を防ぐ）。
  assertValidDistributionName(distribution);
  const resolvedRoot = path.resolve(sourceRoot);
  const distributionRoot = path.join(resolvedRoot, DISTRIBUTION_DIR, distribution);
  if (!(await isDirectory(distributionRoot))) {
    throw new SourceError(
      "DISTRIBUTION_NOT_FOUND",
      `distribution が見つかりません: ${distributionRoot}`,
      { hint: `distribution/${distribution}/ が存在するか確認してください。` },
    );
  }
  const manifestPath = path.join(distributionRoot, MANIFEST_FILENAME);
  if (!(await isFile(manifestPath))) {
    throw new SourceError("MANIFEST_NOT_FOUND", `manifest が見つかりません: ${manifestPath}`, {
      hint: `distribution/${distribution}/${MANIFEST_FILENAME} を作成してください。`,
    });
  }
  return { sourceRoot: resolvedRoot, distribution, distributionRoot, manifestPath };
}

/**
 * Buffer を UTF-8 テキストとして厳密に decode する（§9.4「src/template は UTF-8 text として読める必要がある」）。
 *
 * `Buffer.prototype.toString("utf8")` は不正バイト列を置換文字（U+FFFD）に握りつぶすため、
 * 壊れた配布ファイルを検出できない。`TextDecoder(..., { fatal: true })` を使い、
 * 不正バイト列なら {@link SourceError}（code: `SOURCE_FILE_NOT_UTF8`）を投げる。
 * 戻り値は使わず妥当性ゲートとしてだけ使う（content/sha256 は既存の canonical 化経路で計算する）。
 *
 * @param buffer      検証対象の bytes。
 * @param label       エラー文言用ラベル。
 * @param displayPath エラー文言に添える path。
 */
function assertUtf8Text(buffer: Buffer, label: string, displayPath: string): void {
  try {
    // ignoreBOM の既定(false)で先頭 BOM は出力から除去されるが、妥当性判定には影響しない。
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new SourceError(
      "SOURCE_FILE_NOT_UTF8",
      `${label} が UTF-8 テキストとして読めません（不正なバイト列が含まれています）: ${displayPath}`,
      { hint: "配布ファイルは UTF-8 テキストである必要があります（binary は MVP 非対応）。" },
    );
  }
}

/**
 * distribution root からの相対 src/template を読み、canonical 内容と sha256 を返す。
 * 存在しなければ {@link SourceError}（code: `SOURCE_FILE_MISSING`）を投げる（全 src 存在検証）。
 * 不正な UTF-8 なら {@link SourceError}（code: `SOURCE_FILE_NOT_UTF8`）を投げる。
 *
 * @param location distribution の位置情報。
 * @param relPath  distribution root からの相対 path。
 * @param label    エラー文言用ラベル。
 */
async function readSourceFile(
  location: SourceLocation,
  relPath: string,
  label: string,
): Promise<{ content: string; sha256: string }> {
  const buffer = await readFileWithinRoot(location.distributionRoot, relPath, label);
  if (buffer === null) {
    throw new SourceError(
      "SOURCE_FILE_MISSING",
      `manifest が参照する ${label} が distribution 内に存在しません: ${relPath}`,
      {
        hint: `distribution/${location.distribution}/${relPath} を作成するか manifest を修正してください。`,
      },
    );
  }
  // UTF-8 妥当性を先に検証する（置換文字での静かな破損を防ぐ）。
  assertUtf8Text(buffer, label, relPath);
  // 配布時は LF・BOM なしに正規化した内容を書くため、content も canonical 化して保持する。
  const content = canonicalizeTextString(buffer.toString("utf8"));
  // sha256 は canonical 化した bytes に対して計算する（lock の installed_sha256 と同一定義）。
  const sha256 = canonicalSha256(buffer);
  return { content, sha256 };
}

/**
 * source root と distribution 名から distribution を読み込み・検証する。
 *
 * 手順（§17.1 step 4-6 / §10）:
 *   1. {@link resolveSourceLocation} で位置確定（distribution・manifest 存在確認）
 *   2. manifest.yaml を読み YAML parse → {@link parseManifest} で zod 検証
 *   3. files[] / seed_files[] の src/template を読み（存在検証）、canonical 内容と sha256 を取得
 *   4. distribution content sha256 を計算
 *
 * @param sourceRoot   source root（絶対 path 推奨）。
 * @param distribution distribution 名。
 * @throws {SourceError | ManifestError} 位置解決・検証・src 不在時。
 */
export async function loadDistribution(
  sourceRoot: string,
  distribution: string,
): Promise<LoadedDistribution> {
  const location = await resolveSourceLocation(sourceRoot, distribution);

  const buffer = await readFileWithinRoot(location.sourceRoot, manifestRelative(distribution), "manifest");
  if (buffer === null) {
    // resolveSourceLocation で存在確認済みだが、競合状態の保険として明示エラーにする。
    throw new SourceError("MANIFEST_NOT_FOUND", `manifest が見つかりません: ${location.manifestPath}`);
  }
  // manifest も UTF-8 妥当性を検証してから parse する（置換文字での静かな破損を防ぐ）。
  assertUtf8Text(buffer, "manifest", location.manifestPath);
  let manifestValue: unknown;
  try {
    manifestValue = parseYaml(buffer.toString("utf8"));
  } catch (error) {
    throw new SourceError("MANIFEST_PARSE", `manifest の YAML parse に失敗しました: ${location.manifestPath}`, {
      hint: "YAML 構文を確認してください。",
      cause: error,
    });
  }
  const manifest = parseManifest(manifestValue, location.manifestPath);

  const managedFiles: LoadedManagedFile[] = [];
  for (const file of manifest.files) {
    const { content, sha256 } = await readSourceFile(location, file.src, "files[].src");
    managedFiles.push({
      dest: file.dest,
      strategy: "managed_overwrite",
      src: file.src,
      sourceSha256: sha256,
      content,
    });
  }

  const seedFiles: LoadedSeedFile[] = [];
  for (const seed of manifest.seed_files) {
    // schema 上 src/template は排他必須。どちらが指定されているかで sourceKind を決める。
    const sourceKind: "src" | "template" = seed.src !== undefined ? "src" : "template";
    const sourcePath = seed.src ?? seed.template;
    if (sourcePath === undefined) {
      // parseManifest の superRefine で排他必須を保証しているため通常到達しない。
      throw new SourceError(
        "SEED_SOURCE_MISSING",
        `seed_files[] に src/template がありません: ${seed.dest}`,
      );
    }
    const label = sourceKind === "src" ? "seed_files[].src" : "seed_files[].template";
    const { content, sha256 } = await readSourceFile(location, sourcePath, label);
    seedFiles.push({
      dest: seed.dest,
      strategy: "create_only",
      sourceKind,
      sourcePath,
      sourceSha256: sha256,
      content,
    });
  }

  const patches: LoadedPatch[] = manifest.patches.map((p) => ({
    type: "append_unique_lines",
    path: p.path,
    lines: [...p.lines],
  }));

  const payload = buildDistributionHashPayload({
    schema_version: manifest.schema_version,
    distribution: manifest.name,
    managed_files: managedFiles.map((m) => ({ dest: m.dest, sha256: m.sourceSha256 })),
    seed_files: seedFiles.map((s) => ({
      dest: s.dest,
      source_kind: s.sourceKind,
      sha256: s.sourceSha256,
    })),
    patches: patches.map((p) => ({ path: p.path, lines: p.lines })),
  });
  const contentSha256 = computeDistributionContentSha256(payload);

  return {
    location,
    manifest,
    managedFiles,
    seedFiles,
    patches,
    preserve: [...manifest.preserve],
    contentSha256,
  };
}

/** source root からの相対 manifest path（`distribution/<name>/manifest.yaml`）。 */
function manifestRelative(distribution: string): string {
  return `${DISTRIBUTION_DIR}/${distribution}/${MANIFEST_FILENAME}`;
}

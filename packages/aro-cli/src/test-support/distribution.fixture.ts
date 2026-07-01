/**
 * Phase 4 テスト用の共有フィクスチャ（`.fixture.ts` はビルド対象外）。
 *
 * source.test.ts の手法を踏襲し、一時ディレクトリに base distribution と
 * 「同期済み対象 repo」を組み立てる。planner / diff 双方のテストから使う。
 */
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { computeAppendUniqueLines } from "../core/append-unique-lines.js";
import { buildLockFile, LOCKFILE_RELATIVE_PATH, writeLockFile } from "../core/lockfile.js";
import type { LockFile } from "../core/lockfile.js";
import type { LoadedDistribution } from "../core/source.js";

/** distribution root からの相対 src（テストで内容差し替えに使う）。 */
export const REVIEW_REL = "distribution/base/files/.ai/managed/prompts/review.md";
/** distribution root からの相対 src。 */
export const POLICY_REL = "distribution/base/files/.ai/managed/policies/default.yaml";
/** project.yaml の seed template。 */
export const TEMPLATE_REL = "distribution/base/project.yaml.hbs";
/** workflow stub（create_only seed）。 */
export const WORKFLOW_REL = "distribution/base/files/.github/workflows/ai-review.yml";

/** 既定の review.md 内容。 */
export const REVIEW_CONTENT = "# Review prompt\n";

/** 一時ディレクトリを作る（呼び出し側で rm する）。 */
export async function makeTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

/**
 * 対象 repo を「Git repo の root」に見せかける（`.git` ディレクトリを作る）。
 * init / sync は {@link import("../core/git.js").assertGitRepo} で `.git` の存在を要求するため、
 * これらのテストでは事前にこのヘルパーを呼ぶ。`git` コマンドは実行しない。
 */
export async function initGitRepo(repoRoot: string): Promise<void> {
  await mkdir(path.join(repoRoot, ".git"), { recursive: true });
}

/** root 配下にファイルを書く（親ディレクトリは作成。内容はそのまま=正規化しない）。 */
export async function writeRaw(root: string, relPath: string, content: string): Promise<void> {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** root 配下に生バイトを書く（CRLF/BOM などの検証用）。 */
export async function writeRawBytes(root: string, relPath: string, bytes: Buffer): Promise<void> {
  const abs = path.join(root, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

/** 既定の base manifest。 */
export const DEFAULT_MANIFEST = `schema_version: 1
name: base
version: 0.1.0
files:
  - src: files/.ai/managed/prompts/review.md
    dest: .ai/managed/prompts/review.md
    strategy: managed_overwrite
  - src: files/.ai/managed/policies/default.yaml
    dest: .ai/managed/policies/default.yaml
    strategy: managed_overwrite
seed_files:
  - dest: .ai/project.yaml
    template: project.yaml.hbs
    strategy: create_only
  - src: files/.github/workflows/ai-review.yml
    dest: .github/workflows/ai-review.yml
    strategy: create_only
patches:
  - type: append_unique_lines
    path: .gitignore
    lines:
      - .ai/runs/
      - .ai/tmp/
      - .ai/logs/
  - type: append_unique_lines
    path: .gitattributes
    lines:
      - "# ai-repo-ops managed text files"
      - ".ai/managed/** text eol=lf"
preserve:
  - .ai/project.yaml
  - .ai/local/**
`;

/** sourceRoot に base distribution を作る。manifest は差し替え可能。 */
export async function setupBaseDistribution(
  sourceRoot: string,
  options: { manifestYaml?: string; reviewContent?: string } = {},
): Promise<void> {
  await writeRaw(sourceRoot, REVIEW_REL, options.reviewContent ?? REVIEW_CONTENT);
  await writeRaw(sourceRoot, POLICY_REL, "risk: low\n");
  await writeRaw(sourceRoot, TEMPLATE_REL, "name: {{ repo_name }}\n");
  await writeRaw(sourceRoot, WORKFLOW_REL, "name: AI Review\n");
  await writeRaw(
    sourceRoot,
    "distribution/base/manifest.yaml",
    options.manifestYaml ?? DEFAULT_MANIFEST,
  );
}

/** 固定タイムスタンプ（lock の created_at/updated_at）。 */
export const FIXED_TS = "2026-06-28T00:00:00.000Z";

/**
 * 対象 repo を dist と完全同期した状態にし、対応する lock を書いて返す。
 *
 * - managed files / seed files を canonical 内容で書く（target sha == source sha）。
 * - applyPatches=true なら patch 行も書く（patch noop 状態にする）。
 * - lock の installed_sha256 は source sha、content sha・version も dist 由来にする。
 */
export async function seedRepoAsSynced(
  repoRoot: string,
  dist: LoadedDistribution,
  options: { applyPatches?: boolean } = {},
): Promise<LockFile> {
  const applyPatches = options.applyPatches ?? true;

  for (const m of dist.managedFiles) {
    await writeRaw(repoRoot, m.dest, m.content);
  }
  for (const s of dist.seedFiles) {
    await writeRaw(repoRoot, s.dest, s.content);
  }
  if (applyPatches) {
    for (const p of dist.patches) {
      const result = computeAppendUniqueLines(null, p.lines);
      await writeRaw(repoRoot, p.path, result.content);
    }
  }

  const lock = buildLockFile({
    distribution: dist.location.distribution,
    version: dist.manifest.version,
    distributionContentSha256: dist.contentSha256,
    managedFiles: dist.managedFiles.map((m) => ({
      path: m.dest,
      source: `distribution/${dist.location.distribution}/${m.src}`,
      installedSha256: m.sourceSha256,
    })),
    seedFiles: dist.seedFiles.map((s) => ({ path: s.dest })),
    patches: dist.patches.map((p) => ({ path: p.path, lines: [...p.lines] })),
    createdAt: FIXED_TS,
    updatedAt: FIXED_TS,
  });
  await writeLockFile(path.join(repoRoot, LOCKFILE_RELATIVE_PATH), lock);
  return lock;
}

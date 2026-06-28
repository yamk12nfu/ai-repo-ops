import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHECKSUM_ALGORITHM, CHECKSUM_MODE } from "../checksum.js";
import { LockFileError, PathSafetyError } from "../errors.js";
import {
  DEFAULT_SOURCE_REPOSITORY,
  LOCKFILE_RELATIVE_PATH,
  buildLockFile,
  loadLockFile,
  parseLockFile,
  stringifyLockFile,
  type LockFile,
} from "../lockfile.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const CONTENT_SHA = "c".repeat(64);

/** テスト用の有効な lock file を組み立てる。 */
function sampleLock(): LockFile {
  return buildLockFile({
    distribution: "base",
    version: "0.1.0",
    distributionContentSha256: CONTENT_SHA,
    managedFiles: [
      {
        path: ".ai/managed/prompts/review.md",
        source: "distribution/base/files/.ai/managed/prompts/review.md",
        installedSha256: SHA_A,
      },
      {
        path: ".ai/managed/policies/default.yaml",
        source: "distribution/base/files/.ai/managed/policies/default.yaml",
        installedSha256: SHA_B,
      },
    ],
    seedFiles: [{ path: ".ai/project.yaml" }, { path: ".github/workflows/ai-review.yml" }],
    patches: [{ path: ".gitignore", lines: [".ai/runs/", ".ai/tmp/", ".ai/logs/"] }],
    createdAt: "2026-06-28T00:00:00.000Z",
    updatedAt: "2026-06-28T00:00:00.000Z",
  });
}

describe("buildLockFile", () => {
  it("固定値（schema_version / checksum / strategy）を埋める", () => {
    const lock = sampleLock();
    expect(lock.schema_version).toBe(1);
    expect(lock.checksum).toEqual({ algorithm: CHECKSUM_ALGORITHM, mode: CHECKSUM_MODE });
    expect(lock.source.repository).toBe(DEFAULT_SOURCE_REPOSITORY);
    expect(lock.managed_files.every((m) => m.strategy === "managed_overwrite")).toBe(true);
    expect(lock.seed_files.every((s) => s.strategy === "create_only")).toBe(true);
  });

  it("repository / commit を上書きできる", () => {
    const lock = buildLockFile({
      repository: "acme/ops",
      distribution: "base",
      version: "0.1.0",
      commit: "abc1234",
      distributionContentSha256: CONTENT_SHA,
      managedFiles: [],
      seedFiles: [],
      patches: [],
      createdAt: "2026-06-28T00:00:00.000Z",
      updatedAt: "2026-06-28T00:00:00.000Z",
    });
    expect(lock.source.repository).toBe("acme/ops");
    expect(lock.source.commit).toBe("abc1234");
  });
});

describe("parseLockFile / stringifyLockFile（round-trip）", () => {
  it("読み書きしても内容が維持される", () => {
    const lock = sampleLock();
    const text = stringifyLockFile(lock);
    const reparsed = parseLockFile(text);
    expect(reparsed).toEqual(lock);
  });

  it("壊れた YAML は LockFileError（LOCKFILE_PARSE）", () => {
    expect(() => parseLockFile("こわれた: [\n")).toThrowError(LockFileError);
  });

  it("schema 不一致（installed_sha256 が hex でない）は LockFileError", () => {
    const lock = sampleLock();
    const broken = stringifyLockFile(lock).replace(SHA_A, "not-a-hash");
    expect(() => parseLockFile(broken)).toThrowError(LockFileError);
  });

  it("未知の key を拒否する（strict）", () => {
    const text = stringifyLockFile(sampleLock()).replace("schema_version: 1", "schema_version: 1\nextra: true");
    expect(() => parseLockFile(text)).toThrowError(LockFileError);
  });
});

describe("loadLockFile", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await mkdtemp(path.join(tmpdir(), "aro-lock-"));
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("lock file が無ければ null を返す", async () => {
    expect(await loadLockFile(repoRoot)).toBeNull();
  });

  it("存在する lock file を読み込み検証する", async () => {
    const lock = sampleLock();
    const lockPath = path.join(repoRoot, LOCKFILE_RELATIVE_PATH);
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(lockPath, stringifyLockFile(lock), "utf8");
    expect(await loadLockFile(repoRoot)).toEqual(lock);
  });

  it(".ai が symlink の場合は PathSafetyError", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "aro-out-"));
    await symlink(outside, path.join(repoRoot, ".ai"));
    await expect(loadLockFile(repoRoot)).rejects.toBeInstanceOf(PathSafetyError);
    await rm(outside, { recursive: true, force: true });
  });
});

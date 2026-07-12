import { chmod, readFile, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { canonicalSha256OfString } from "../checksum.js";
import { readFileAtRevision } from "../git-diff.js";
import {
  LOCKFILE_RELATIVE_PATH,
  parseLockFile,
  stringifyLockFile,
} from "../lockfile.js";
import {
  authenticateSyncChange,
  type SyncAuthenticationReport,
} from "../sync-authentication.js";
import {
  addRepoNameTemplateSeed,
  DEFAULT_MANIFEST,
  makeTempDir,
  POLICY_REL,
  REVIEW_REL,
  REPO_NAME_TEMPLATE_DEST,
  setupBaseDistribution,
  TEMPLATE_REL,
  WORKFLOW_REL,
  writeRaw,
} from "../../test-support/distribution.fixture.js";
import {
  createSyncAuthenticationFixture,
  SYNC_FIXTURE_POLICY_DEFAULT,
  SYNC_FIXTURE_PROJECT_YAML,
  SYNC_FIXTURE_REVIEW_DEST,
  type SyncAuthenticationFixture,
} from "../../test-support/sync-authentication.fixture.js";

const fixtures: SyncAuthenticationFixture[] = [];
const extraSourceRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
  await Promise.all(
    extraSourceRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<SyncAuthenticationFixture> {
  const value = await createSyncAuthenticationFixture();
  fixtures.push(value);
  return value;
}

async function authenticate(
  value: SyncAuthenticationFixture,
  authoritativeSourceRoot?: string,
) {
  return authenticateSyncChange(
    await value.authenticationInput(authoritativeSourceRoot),
  );
}

async function prepareCommittedManagedSync(): Promise<SyncAuthenticationFixture> {
  const value = await fixture();
  await value.prepareManagedSync();
  await value.commit();
  return value;
}

function trustedPathsFrom(report: SyncAuthenticationReport): readonly string[] {
  return report.status === "authenticated" ? report.paths : [];
}

const invalidRejectedReport = {
  status: "rejected",
  reason: "content_mismatch",
  expectedPaths: [SYNC_FIXTURE_REVIEW_DEST],
  // @ts-expect-error rejected reportはtrusted pathを保持できない
  trustedPaths: [SYNC_FIXTURE_REVIEW_DEST],
  authority: {
    distribution: "base",
    version: "1.0.0",
    contentSha256: "a".repeat(64),
  },
} satisfies SyncAuthenticationReport;
void invalidRejectedReport;

const invalidRejectedPaths = {
  status: "rejected",
  reason: "content_mismatch",
  expectedPaths: [SYNC_FIXTURE_REVIEW_DEST],
  // @ts-expect-error authenticated以外のreportは信頼済みpathsを保持できない
  paths: [SYNC_FIXTURE_REVIEW_DEST],
  authority: {
    distribution: "base",
    version: "1.0.0",
    contentSha256: "a".repeat(64),
  },
} satisfies SyncAuthenticationReport;
void invalidRejectedPaths;

describe("authenticateSyncChange", () => {
  it("authenticated reportだけからtrusted pathを導出する", async () => {
    const authenticated = await prepareCommittedManagedSync().then(authenticate);
    expect(authenticated.status).toBe("authenticated");
    expect(trustedPathsFrom(authenticated)).toEqual([
      SYNC_FIXTURE_REVIEW_DEST,
      LOCKFILE_RELATIVE_PATH,
    ]);

    if (authenticated.status !== "authenticated") {
      throw new Error("expected authenticated report");
    }
    const rejected: SyncAuthenticationReport = {
      status: "rejected",
      reason: "content_mismatch",
      expectedPaths: [SYNC_FIXTURE_REVIEW_DEST],
      authority: authenticated.authority,
    };
    expect(trustedPathsFrom(rejected)).toEqual([]);
  });

  it("authoritative managed update + lockの完全一致bundleを認証する", async () => {
    const value = await prepareCommittedManagedSync();

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "authenticated",
      reason: "exact_match",
      paths: [SYNC_FIXTURE_REVIEW_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("HEAD lockが構文的に壊れていれば認証を拒否する", async () => {
    const value = await fixture();
    await value.prepareManagedSync();
    await writeRaw(value.repoRoot, LOCKFILE_RELATIVE_PATH, "broken: [\n");
    await value.commit("chore: tamper aro sync lock");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "head_lock_invalid",
      expectedPaths: [],
    });
  });

  it("create_only seedのsource driftによるlock-only syncを認証する", async () => {
    const value = await fixture();
    await writeRaw(value.sourceRoot, WORKFLOW_REL, "name: AI Review v2\n");
    await value.sync();
    await value.commit("chore: aro lock-only sync");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "authenticated",
      reason: "exact_match",
      paths: [LOCKFILE_RELATIVE_PATH],
    });
  });

  it("project.nameでrenderした新規template seedをcheckout directory名に依存せず認証する", async () => {
    const value = await fixture();
    await addRepoNameTemplateSeed(value.sourceRoot);
    await value.sync();
    await value.commit("chore: sync stable repo-name template");

    expect(
      await readFile(path.join(value.repoRoot, REPO_NAME_TEMPLATE_DEST), "utf8"),
    ).toBe("demo\n");
    await expect(authenticate(value)).resolves.toMatchObject({
      status: "authenticated",
      reason: "exact_match",
      paths: [REPO_NAME_TEMPLATE_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("HEADでproject.nameを変更してrenderしたtemplate seedをbase nameで自己認証しない", async () => {
    const value = await fixture();
    await writeRaw(
      value.repoRoot,
      ".ai/project.yaml",
      SYNC_FIXTURE_PROJECT_YAML.replace("name: demo", "name: attacker"),
    );
    await addRepoNameTemplateSeed(value.sourceRoot);
    await value.sync();
    await value.commit("chore: try to self-authenticate changed project name");

    expect(
      await readFile(path.join(value.repoRoot, REPO_NAME_TEMPLATE_DEST), "utf8"),
    ).toBe("attacker\n");
    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "content_mismatch",
      expectedPaths: [REPO_NAME_TEMPLATE_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("managed内容とinstalled_sha256を一緒に偽造しても自己署名として認証しない", async () => {
    const value = await fixture();
    await value.prepareManagedSync();
    const malicious = "# forged managed prompt\n";
    await writeRaw(value.repoRoot, SYNC_FIXTURE_REVIEW_DEST, malicious);

    const lockPath = path.join(value.repoRoot, LOCKFILE_RELATIVE_PATH);
    const lock = parseLockFile(await readFile(lockPath, "utf8"));
    await writeRaw(
      value.repoRoot,
      LOCKFILE_RELATIVE_PATH,
      stringifyLockFile({
        ...lock,
        managed_files: lock.managed_files.map((entry) =>
          entry.path === SYNC_FIXTURE_REVIEW_DEST
            ? { ...entry, installed_sha256: canonicalSha256OfString(malicious) }
            : entry,
        ),
      }),
    );
    await value.commit("chore: forge managed prompt and lock");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "content_mismatch",
      expectedPaths: [SYNC_FIXTURE_REVIEW_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("期待bundleからlock変更が欠けたpartial syncを認証しない", async () => {
    const value = await fixture();
    await value.prepareManagedSync();
    const baseLock = await readFileAtRevision(
      value.repoRoot,
      value.mergeBaseSha,
      LOCKFILE_RELATIVE_PATH,
    );
    expect(baseLock).not.toBeNull();
    await writeRaw(value.repoRoot, LOCKFILE_RELATIVE_PATH, baseLock ?? "");
    await value.commit("chore: commit partial aro sync");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "missing_expected_change",
      expectedPaths: [SYNC_FIXTURE_REVIEW_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("正規patchへ余分な行を混ぜたらbundle全体を認証しない", async () => {
    const value = await fixture();
    const manifestWithNewPatchLine = DEFAULT_MANIFEST.replace(
      "      - .ai/logs/\n",
      "      - .ai/logs/\n      - .trusted-sync-line\n",
    );
    await writeRaw(
      value.sourceRoot,
      "distribution/base/manifest.yaml",
      manifestWithNewPatchLine,
    );
    await value.sync();
    const gitignore = await readFile(path.join(value.repoRoot, ".gitignore"), "utf8");
    await writeRaw(value.repoRoot, ".gitignore", `${gitignore}MALICIOUS_EXTRA_LINE\n`);
    await value.commit("chore: smuggle extra patch content");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "content_mismatch",
      expectedPaths: [".gitignore", LOCKFILE_RELATIVE_PATH],
    });
  });

  it("sync対象managed fileをsymlinkへ置換したらGit type差で認証しない", async () => {
    const value = await fixture();
    await value.prepareManagedSync();
    const reviewPath = path.join(value.repoRoot, SYNC_FIXTURE_REVIEW_DEST);
    await rm(reviewPath);
    await symlink("../../../README.md", reviewPath);
    await value.commit("chore: replace managed prompt with symlink");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "mode_or_type_mismatch",
      expectedPaths: [SYNC_FIXTURE_REVIEW_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("sync対象managed fileの実行modeを変えたらGit mode差で認証しない", async () => {
    const value = await fixture();
    await value.prepareManagedSync();
    await chmod(path.join(value.repoRoot, SYNC_FIXTURE_REVIEW_DEST), 0o755);
    await value.commit("chore: change managed prompt mode");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "mode_or_type_mismatch",
      expectedPaths: [SYNC_FIXTURE_REVIEW_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("正規sync bundleからmanaged fileを削除したら認証しない", async () => {
    const value = await fixture();
    await value.prepareManagedSync();
    await rm(path.join(value.repoRoot, SYNC_FIXTURE_REVIEW_DEST));
    await value.commit("chore: delete managed file after sync");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "mode_or_type_mismatch",
      expectedPaths: [SYNC_FIXTURE_REVIEW_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("HEAD lockへduplicate managed entryを足しても認証しない", async () => {
    const value = await fixture();
    await value.prepareManagedSync();
    const lockPath = path.join(value.repoRoot, LOCKFILE_RELATIVE_PATH);
    const lock = parseLockFile(await readFile(lockPath, "utf8"));
    const firstManaged = lock.managed_files[0];
    expect(firstManaged).toBeDefined();
    await writeRaw(
      value.repoRoot,
      LOCKFILE_RELATIVE_PATH,
      stringifyLockFile({
        ...lock,
        managed_files:
          firstManaged === undefined
            ? lock.managed_files
            : [...lock.managed_files, { ...firstManaged }],
      }),
    );
    await value.commit("chore: duplicate managed lock entry");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "content_mismatch",
      expectedPaths: [SYNC_FIXTURE_REVIEW_DEST, LOCKFILE_RELATIVE_PATH],
    });
  });

  it("HEAD lockのupdated_atがcanonical ISO UTCでなければclock witnessに使わない", async () => {
    const value = await fixture();
    await value.prepareManagedSync();
    const lockPath = path.join(value.repoRoot, LOCKFILE_RELATIVE_PATH);
    const lock = parseLockFile(await readFile(lockPath, "utf8"));
    await writeRaw(
      value.repoRoot,
      LOCKFILE_RELATIVE_PATH,
      stringifyLockFile({ ...lock, updated_at: "2026-07-02 12:00:00Z" }),
    );
    await value.commit("chore: use non-canonical lock timestamp");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "head_lock_invalid",
      expectedPaths: [],
    });
  });

  it("別sourceで生成した内部整合済みsyncをauthoritative sourceとして認証しない", async () => {
    const value = await fixture();
    const untrustedSourceRoot = await makeTempDir("aro-sync-auth-untrusted-src-");
    extraSourceRoots.push(untrustedSourceRoot);
    await setupBaseDistribution(untrustedSourceRoot);
    await writeRaw(untrustedSourceRoot, POLICY_REL, SYNC_FIXTURE_POLICY_DEFAULT);
    await writeRaw(untrustedSourceRoot, TEMPLATE_REL, SYNC_FIXTURE_PROJECT_YAML);
    await writeRaw(untrustedSourceRoot, REVIEW_REL, "# Untrusted source prompt\n");
    await value.sync({ sourceRoot: untrustedSourceRoot });
    await value.commit("chore: sync from untrusted source");

    await expect(authenticate(value)).resolves.toMatchObject({
      status: "rejected",
      reason: "sync_not_required",
      expectedPaths: [],
    });
  });
});

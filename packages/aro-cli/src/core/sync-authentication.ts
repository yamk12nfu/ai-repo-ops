/**
 * merge-baseの対象pathだけを一時snapshotへ復元し、authoritative distributionでsyncを再実行して
 * HEADの最終treeと完全一致するか検証する。PR側lockはclock witness以外の信頼入力にしない。
 */
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { applyPlan } from "./apply.js";
import { LockFileError } from "./errors.js";
import { readFileAtRevision } from "./git-diff.js";
import {
  isRegularGitTreeEntry,
  readBlobObject,
  readTreeEntryAtRevision,
} from "./git-tree.js";
import { LOCKFILE_RELATIVE_PATH, parseLockFile, type LockFile } from "./lockfile.js";
import { buildSyncPlan } from "./planner.js";
import { planRequiresSync } from "./plan-summary.js";
import type { LoadedDistribution } from "./source.js";

export interface SyncAuthenticationAuthority {
  distribution: string;
  version: string;
  contentSha256: string;
}

export type SyncAuthenticationRejectionReason =
  | "distribution_mismatch"
  | "head_lock_invalid"
  | "unsafe_base_entry"
  | "sync_conflict"
  | "sync_not_required"
  | "missing_expected_change"
  | "mode_or_type_mismatch"
  | "content_mismatch";

export type SyncAuthenticationNotApplicableReason = "lock_unchanged" | "base_lock_missing";

export type SyncAuthenticationReport =
  | {
      status: "authenticated";
      reason: "exact_match";
      paths: string[];
      authority: SyncAuthenticationAuthority;
    }
  | {
      status: "rejected";
      reason: SyncAuthenticationRejectionReason;
      expectedPaths: string[];
      authority: SyncAuthenticationAuthority;
    }
  | {
      status: "not_applicable";
      reason: SyncAuthenticationNotApplicableReason;
    };

export type SyncAuthenticationStatus = SyncAuthenticationReport["status"];

export interface AuthenticateSyncInput {
  repoRoot: string;
  /** merge-baseのproject.nameからcallerが解決したstable template context。 */
  repoName: string;
  mergeBaseSha: string;
  changedFiles: readonly { path: string }[];
  distribution: LoadedDistribution;
}

function authorityFrom(distribution: LoadedDistribution): SyncAuthenticationAuthority {
  return {
    distribution: distribution.location.distribution,
    version: distribution.manifest.version,
    contentSha256: distribution.contentSha256,
  };
}

export function createNotApplicableSyncAuthenticationReport(
  reason: SyncAuthenticationNotApplicableReason,
): SyncAuthenticationReport {
  return { status: "not_applicable", reason };
}

function rejectedReport(
  reason: SyncAuthenticationRejectionReason,
  distribution: LoadedDistribution,
  expectedPaths: readonly string[] = [],
): SyncAuthenticationReport {
  return {
    status: "rejected",
    reason,
    expectedPaths: [...expectedPaths],
    authority: authorityFrom(distribution),
  };
}

function authenticatedReport(
  paths: readonly string[],
  distribution: LoadedDistribution,
): SyncAuthenticationReport {
  return {
    status: "authenticated",
    reason: "exact_match",
    paths: [...paths],
    authority: authorityFrom(distribution),
  };
}

function canonicalIsoTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function targetPaths(distribution: LoadedDistribution): string[] {
  return [
    ...new Set([
      ...distribution.managedFiles.map((entry) => entry.dest),
      ...distribution.seedFiles.map((entry) => entry.dest),
      ...distribution.patches.map((entry) => entry.path),
      LOCKFILE_RELATIVE_PATH,
    ]),
  ];
}

async function hasUnsafeAncestor(
  repoRoot: string,
  revision: string,
  relativePath: string,
): Promise<boolean> {
  const segments = relativePath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const prefix = segments.slice(0, index).join("/");
    const entry = await readTreeEntryAtRevision(repoRoot, revision, prefix);
    if (entry !== null && entry.type !== "tree") return true;
  }
  return false;
}

/** merge-baseから通常fileだけをsnapshotへ復元する。symlink/gitlink/特殊modeならfalse。 */
async function materializeRevisionPaths(
  repoRoot: string,
  revision: string,
  snapshotRoot: string,
  relativePaths: readonly string[],
): Promise<boolean> {
  for (const relativePath of relativePaths) {
    if (await hasUnsafeAncestor(repoRoot, revision, relativePath)) return false;
    const entry = await readTreeEntryAtRevision(repoRoot, revision, relativePath);
    if (entry === null) continue;
    if (!isRegularGitTreeEntry(entry)) return false;
    const absolutePath = path.join(snapshotRoot, ...relativePath.split("/"));
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, await readBlobObject(repoRoot, entry.objectId));
    await chmod(absolutePath, entry.mode === "100755" ? 0o755 : 0o644);
  }
  return true;
}

async function loadLockAtRevision(
  repoRoot: string,
  revision: string,
): Promise<LockFile | null> {
  const text = await readFileAtRevision(repoRoot, revision, LOCKFILE_RELATIVE_PATH);
  return text === null ? null : parseLockFile(text, `${revision}:${LOCKFILE_RELATIVE_PATH}`);
}

function gitModeFromStats(mode: number): "100644" | "100755" {
  return (mode & 0o111) !== 0 ? "100755" : "100644";
}

/** authoritative syncの期待bundleとHEADをraw bytes + Git modeでall-or-nothing比較する。 */
export async function authenticateSyncChange(
  input: AuthenticateSyncInput,
): Promise<SyncAuthenticationReport> {
  const baseLock = await loadLockAtRevision(input.repoRoot, input.mergeBaseSha);
  if (baseLock === null) {
    return createNotApplicableSyncAuthenticationReport("base_lock_missing");
  }
  if (baseLock.source.distribution !== input.distribution.location.distribution) {
    return rejectedReport("distribution_mismatch", input.distribution);
  }

  let headLock: LockFile | null;
  try {
    headLock = await loadLockAtRevision(input.repoRoot, "HEAD");
  } catch (error) {
    if (error instanceof LockFileError) {
      return rejectedReport("head_lock_invalid", input.distribution);
    }
    throw error;
  }
  if (headLock === null || !canonicalIsoTimestamp(headLock.updated_at)) {
    return rejectedReport("head_lock_invalid", input.distribution);
  }

  const snapshotRoot = await mkdtemp(path.join(tmpdir(), "aro-sync-auth-"));
  try {
    if (
      !(await materializeRevisionPaths(
        input.repoRoot,
        input.mergeBaseSha,
        snapshotRoot,
        targetPaths(input.distribution),
      ))
    ) {
      return rejectedReport("unsafe_base_entry", input.distribution);
    }

    const plan = await buildSyncPlan({
      repoRoot: snapshotRoot,
      distribution: input.distribution,
      lock: baseLock,
    });
    if (plan.hasConflicts) {
      return rejectedReport("sync_conflict", input.distribution);
    }
    if (!planRequiresSync(plan)) {
      return rejectedReport("sync_not_required", input.distribution);
    }

    const applied = await applyPlan({
      plan,
      distribution: input.distribution,
      repoRoot: snapshotRoot,
      existingLock: baseLock,
      now: headLock.updated_at,
      repoName: input.repoName,
    });
    const expectedPaths = applied.touchedPaths;
    const changedPaths = new Set(input.changedFiles.map((file) => file.path));
    if (expectedPaths.some((expectedPath) => !changedPaths.has(expectedPath))) {
      return rejectedReport("missing_expected_change", input.distribution, expectedPaths);
    }

    for (const expectedPath of expectedPaths) {
      const expectedAbsolute = path.join(snapshotRoot, ...expectedPath.split("/"));
      const [expectedBytes, expectedStats, headEntry] = await Promise.all([
        readFile(expectedAbsolute),
        stat(expectedAbsolute),
        readTreeEntryAtRevision(input.repoRoot, "HEAD", expectedPath),
      ]);
      if (
        headEntry === null ||
        !isRegularGitTreeEntry(headEntry) ||
        headEntry.mode !== gitModeFromStats(expectedStats.mode)
      ) {
        return rejectedReport("mode_or_type_mismatch", input.distribution, expectedPaths);
      }
      const headBytes = await readBlobObject(input.repoRoot, headEntry.objectId);
      if (!expectedBytes.equals(headBytes)) {
        return rejectedReport("content_mismatch", input.distribution, expectedPaths);
      }
    }

    return authenticatedReport(expectedPaths, input.distribution);
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

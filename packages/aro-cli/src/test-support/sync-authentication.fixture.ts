/**
 * trusted sync / sync authentication tests shared fixture.
 *
 * It creates a real Git repository boundary: a valid distribution is installed and
 * committed on `main`, then the working tree is switched to `feature`.  Callers can
 * mutate the distribution, run the real `executeSync`, commit the result, and pass
 * the resulting diff directly to `authenticateSyncChange`.
 */
import { rm } from "node:fs/promises";

import { executeInit, INIT_EXIT, type InitIo } from "../commands/init.js";
import { executeSync, SYNC_EXIT, type SyncIo } from "../commands/sync.js";
import { getChangedFiles } from "../core/git-diff.js";
import { parseProjectConfig } from "../core/project-config.js";
import type { AuthenticateSyncInput } from "../core/sync-authentication.js";
import { resolveTemplateRepoName } from "../core/template.js";
import { loadDistribution } from "../core/source.js";
import {
  makeTempDir,
  POLICY_REL,
  REVIEW_REL,
  setupBaseDistribution,
  TEMPLATE_REL,
  writeRaw,
} from "./distribution.fixture.js";
import {
  gitCheckoutNewBranch,
  gitCommitAll,
  gitRevParse,
  initRealGitRepo,
} from "./git.fixture.js";

export const SYNC_FIXTURE_INIT_TIME = "2026-07-01T12:00:00.000Z";
export const SYNC_FIXTURE_UPDATE_TIME = "2026-07-02T12:00:00.000Z";
export const SYNC_FIXTURE_REVIEW_DEST = ".ai/managed/prompts/review.md";

/** medium risk config used by guard integration tests and the auth core fixture. */
export const SYNC_FIXTURE_PROJECT_YAML = `schema_version: 1
project:
  name: demo
  type: generic
  risk_level: medium
commands:
  lint: ""
quality_gates:
  required: []
ai:
  max_changed_files: 3
  allowed_paths:
    - "src/**"
review:
  require_human_review: true
evals: {}
`;

export const SYNC_FIXTURE_POLICY_DEFAULT = `schema_version: 1
name: default
change_limits:
  max_changed_files: 10
  max_added_lines: 5
forbidden_paths:
  - "secrets/**"
`;

export interface SyncAuthenticationFixture {
  repoRoot: string;
  sourceRoot: string;
  mergeBaseSha: string;
  /** Run the real sync command using this fixture's repo. */
  sync(options?: { sourceRoot?: string; now?: string }): Promise<void>;
  /** Apply the standard managed prompt drift and run sync. */
  prepareManagedSync(content?: string): Promise<void>;
  /** Commit every current working-tree change. */
  commit(message?: string): Promise<void>;
  /** Build the production authenticator input from the committed Git diff. */
  authenticationInput(authoritativeSourceRoot?: string): Promise<AuthenticateSyncInput>;
  /** Remove only temporary roots created by this fixture. */
  cleanup(): Promise<void>;
}

export interface CreateSyncAuthenticationFixtureOptions {
  /** Existing real Git repository. If omitted, the fixture creates and owns one. */
  repoRoot?: string;
  /** Existing source root. If omitted, the fixture creates and owns one. */
  sourceRoot?: string;
  projectYaml?: string;
  policyYaml?: string;
  initTime?: string;
  baseBranch?: string;
  featureBranch?: string;
}

const quietInitIo = (now: string): InitIo => ({
  stdout: () => {},
  stderr: () => {},
  color: false,
  now: () => now,
});

const quietSyncIo = (now: string): SyncIo => ({
  stdout: () => {},
  stderr: () => {},
  color: false,
  now: () => now,
});

export async function createSyncAuthenticationFixture(
  options: CreateSyncAuthenticationFixtureOptions = {},
): Promise<SyncAuthenticationFixture> {
  const ownsRepo = options.repoRoot === undefined;
  const ownsSource = options.sourceRoot === undefined;
  const repoRoot = options.repoRoot ?? (await makeTempDir("aro-sync-auth-repo-"));
  const sourceRoot = options.sourceRoot ?? (await makeTempDir("aro-sync-auth-src-"));
  const baseBranch = options.baseBranch ?? "main";
  const featureBranch = options.featureBranch ?? "feature";
  const projectYaml = options.projectYaml ?? SYNC_FIXTURE_PROJECT_YAML;

  try {
    if (ownsRepo) await initRealGitRepo(repoRoot);

    await setupBaseDistribution(sourceRoot);
    await writeRaw(
      sourceRoot,
      POLICY_REL,
      options.policyYaml ?? SYNC_FIXTURE_POLICY_DEFAULT,
    );
    await writeRaw(
      sourceRoot,
      TEMPLATE_REL,
      projectYaml,
    );

    const initCode = await executeInit(
      {
        repo: repoRoot,
        distribution: "base",
        source: sourceRoot,
        dryRun: false,
        json: false,
        verbose: false,
        color: false,
      },
      quietInitIo(options.initTime ?? SYNC_FIXTURE_INIT_TIME),
    );
    if (initCode !== INIT_EXIT.ok) {
      throw new Error(`sync authentication fixture init failed: exit ${initCode}`);
    }

    await gitCommitAll(repoRoot, "chore: aro init");
    await gitCheckoutNewBranch(repoRoot, featureBranch);
    const mergeBaseSha = await gitRevParse(repoRoot, baseBranch);

    const sync = async (syncOptions: { sourceRoot?: string; now?: string } = {}) => {
      const syncCode = await executeSync(
        {
          repo: repoRoot,
          distribution: "base",
          source: syncOptions.sourceRoot ?? sourceRoot,
          dryRun: false,
          json: false,
          verbose: false,
          color: false,
        },
        quietSyncIo(syncOptions.now ?? SYNC_FIXTURE_UPDATE_TIME),
      );
      if (syncCode !== SYNC_EXIT.ok) {
        throw new Error(`sync authentication fixture sync failed: exit ${syncCode}`);
      }
    };

    return {
      repoRoot,
      sourceRoot,
      mergeBaseSha,
      sync,
      async prepareManagedSync(content = "# Review prompt v2\n") {
        await writeRaw(sourceRoot, REVIEW_REL, content);
        await sync();
      },
      async commit(message = "chore: aro sync") {
        await gitCommitAll(repoRoot, message);
      },
      async authenticationInput(authoritativeSourceRoot = sourceRoot) {
        return {
          repoRoot,
          repoName: resolveTemplateRepoName(
            repoRoot,
            parseProjectConfig(projectYaml).project.name,
          ),
          mergeBaseSha,
          changedFiles: await getChangedFiles(repoRoot, mergeBaseSha),
          distribution: await loadDistribution(authoritativeSourceRoot, "base"),
        };
      },
      async cleanup() {
        if (ownsSource) await rm(sourceRoot, { recursive: true, force: true });
        if (ownsRepo) await rm(repoRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (ownsSource) await rm(sourceRoot, { recursive: true, force: true });
    if (ownsRepo) await rm(repoRoot, { recursive: true, force: true });
    throw error;
  }
}

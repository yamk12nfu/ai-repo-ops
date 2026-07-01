import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { executeSync, SYNC_EXIT, type SyncIo, type SyncOptions } from "../sync.js";
import { executeDiff, type DiffOptions } from "../diff.js";
import { canonicalSha256OfString } from "../../core/checksum.js";
import { LOCKFILE_RELATIVE_PATH, parseLockFile } from "../../core/lockfile.js";
import { loadDistribution } from "../../core/source.js";
import {
  FIXED_TS,
  initGitRepo,
  makeTempDir,
  REVIEW_CONTENT,
  REVIEW_REL,
  seedRepoAsSynced,
  setupBaseDistribution,
  WORKFLOW_REL,
  writeRaw,
  writeRawBytes,
} from "../../test-support/distribution.fixture.js";

let sourceRoot: string;
let repoRoot: string;

const REVIEW_DEST = ".ai/managed/prompts/review.md";
const PROJECT_YAML = ".ai/project.yaml";
const WORKFLOW_DEST = ".github/workflows/ai-review.yml";
const REVIEW_CHANGED = "# Review prompt CHANGED\n";
const NOW = "2026-07-01T12:00:00.000Z";

beforeEach(async () => {
  sourceRoot = await makeTempDir("aro-sync-src-");
  repoRoot = await makeTempDir("aro-sync-repo-");
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
  await rm(repoRoot, { recursive: true, force: true });
});

function options(overrides: Partial<SyncOptions> = {}): SyncOptions {
  return {
    repo: repoRoot,
    distribution: "base",
    source: sourceRoot,
    dryRun: false,
    json: false,
    verbose: false,
    color: false,
    ...overrides,
  };
}

function captureIo(): { io: SyncIo; out: () => string; err: () => string } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  return {
    io: {
      stdout: (text) => outChunks.push(text),
      stderr: (text) => errChunks.push(text),
      color: false,
      now: () => NOW,
    },
    out: () => outChunks.join(""),
    err: () => errChunks.join(""),
  };
}

function diffOptions(): DiffOptions {
  return {
    repo: repoRoot,
    distribution: "base",
    source: sourceRoot,
    dryRun: false,
    json: false,
    verbose: false,
    color: false,
    detailedExitcode: false,
  };
}

async function read(relPath: string): Promise<string> {
  return readFile(path.join(repoRoot, relPath), "utf8");
}

async function exists(relPath: string): Promise<boolean> {
  try {
    await stat(path.join(repoRoot, relPath));
    return true;
  } catch {
    return false;
  }
}

async function runDiff(): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await executeDiff(diffOptions(), {
    stdout: (t) => out.push(t),
    stderr: () => {},
    color: false,
  });
  return { code, out: out.join("") };
}

/** 同期済み repo を作る（git 化 + dist 内容 + lock）。 */
async function seedSynced(): Promise<void> {
  await initGitRepo(repoRoot);
  const dist = await loadDistribution(sourceRoot, "base");
  await seedRepoAsSynced(repoRoot, dist);
}

describe("executeSync: 中央更新の適用（Scenario 2）", () => {
  it("managed file を更新し lock を更新、その後の diff は up to date", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    await writeRaw(sourceRoot, REVIEW_REL, REVIEW_CHANGED);

    const cap = captureIo();
    const code = await executeSync(options(), cap.io);
    expect(code).toBe(SYNC_EXIT.ok);
    expect(cap.out()).toContain("Applied:");
    expect(cap.out()).toContain("Done.");

    // 内容が更新される。
    expect(await read(REVIEW_DEST)).toBe(REVIEW_CHANGED);
    // 更新後の managed file は LF・BOM なし。
    const bytes = await readFile(path.join(repoRoot, REVIEW_DEST));
    expect(bytes.includes(Buffer.from("\r\n"))).toBe(false);
    expect(bytes[0]).not.toBe(0xef);

    // lock の installed_sha256 / updated_at が更新され、created_at は保持される。
    const lock = parseLockFile(await read(LOCKFILE_RELATIVE_PATH));
    const review = lock.managed_files.find((m) => m.path === REVIEW_DEST);
    expect(review?.installed_sha256).toBe(canonicalSha256OfString(REVIEW_CHANGED));
    expect(lock.updated_at).toBe(NOW);
    expect(lock.created_at).toBe(FIXED_TS);

    // sync 後の diff は差分なし。
    const diff = await runDiff();
    expect(diff.code).toBe(0);
    expect(diff.out).toContain("Up to date");
  });
});

describe("executeSync: conflict abort（Scenario 3）", () => {
  it("人間が編集した managed file は conflict・abort し、ファイルも lock も変更しない", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    const localEdit = `${REVIEW_CONTENT}LOCAL EDIT\n`;
    await writeRaw(repoRoot, REVIEW_DEST, localEdit);
    const lockBefore = await read(LOCKFILE_RELATIVE_PATH);

    const cap = captureIo();
    const code = await executeSync(options(), cap.io);
    expect(code).toBe(SYNC_EXIT.conflict);
    expect(cap.err()).toContain("Sync aborted");
    expect(cap.out()).toContain("git restore");

    // ファイルは一切変更されない。
    expect(await read(REVIEW_DEST)).toBe(localEdit);
    expect(await read(LOCKFILE_RELATIVE_PATH)).toBe(lockBefore);
  });
});

describe("executeSync: preserve（Scenario 5 / 6）", () => {
  it("project.yaml / .ai/local/** / workflow stub を上書きしない", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    // repo 固有編集。
    await writeRaw(repoRoot, PROJECT_YAML, "custom: project\n");
    await writeRaw(repoRoot, ".ai/local/notes.md", "domain knowledge\n");
    await writeRaw(repoRoot, WORKFLOW_DEST, "name: customized workflow\n");
    // 中央側で managed を更新（sync が実際に何かする状況にする）。
    await writeRaw(sourceRoot, REVIEW_REL, REVIEW_CHANGED);

    const code = await executeSync(options(), captureIo().io);
    expect(code).toBe(SYNC_EXIT.ok);

    expect(await read(PROJECT_YAML)).toBe("custom: project\n");
    expect(await read(".ai/local/notes.md")).toBe("domain knowledge\n");
    expect(await read(WORKFLOW_DEST)).toBe("name: customized workflow\n");
    // managed は更新されている。
    expect(await read(REVIEW_DEST)).toBe(REVIEW_CHANGED);
  });
});

describe("executeSync: up to date", () => {
  it("適用対象が無ければ何も書かず exit 0、lock を書き換えない", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    const lockBefore = await read(LOCKFILE_RELATIVE_PATH);

    const cap = captureIo();
    const code = await executeSync(options(), cap.io);
    expect(code).toBe(SYNC_EXIT.ok);
    expect(cap.out()).toContain("Already up to date");
    // lock は書き換えられない（updated_at が NOW にならない）。
    expect(await read(LOCKFILE_RELATIVE_PATH)).toBe(lockBefore);
  });
});

describe("executeSync: 改行・BOM 差分（Scenario 4 / 8）", () => {
  it("CRLF 差分だけなら conflict にならず up to date", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    // 内容は同じだが CRLF に変換。
    await writeRawBytes(repoRoot, REVIEW_DEST, Buffer.from("# Review prompt\r\n"));

    const code = await executeSync(options(), captureIo().io);
    expect(code).toBe(SYNC_EXIT.ok);
  });

  it("先頭 BOM 差分だけなら conflict にならず up to date", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    await writeRawBytes(
      repoRoot,
      REVIEW_DEST,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("# Review prompt\n")]),
    );

    const code = await executeSync(options(), captureIo().io);
    expect(code).toBe(SYNC_EXIT.ok);
  });

  it("CRLF かつ内容変更なら conflict（abort）", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    await writeRawBytes(repoRoot, REVIEW_DEST, Buffer.from("# Review prompt\r\nLOCAL\r\n"));

    const code = await executeSync(options(), captureIo().io);
    expect(code).toBe(SYNC_EXIT.conflict);
  });
});

describe("executeSync: seed だけ drift（§10.6）", () => {
  it("file 書き込みは無いが lock の content sha を更新する", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    const lockBefore = parseLockFile(await read(LOCKFILE_RELATIVE_PATH));
    // seed（workflow）の source 内容だけ変更。managed は不変。
    await writeRaw(sourceRoot, WORKFLOW_REL, "name: AI Review v2\n");

    const cap = captureIo();
    const code = await executeSync(options(), cap.io);
    expect(code).toBe(SYNC_EXIT.ok);

    const lockAfter = parseLockFile(await read(LOCKFILE_RELATIVE_PATH));
    expect(lockAfter.source.distribution_content_sha256).not.toBe(
      lockBefore.source.distribution_content_sha256,
    );
    // create_only seed は温存される（上書きされない）。
    expect(await read(WORKFLOW_DEST)).toBe("name: AI Review\n");
    // diff は up to date。
    expect((await runDiff()).code).toBe(0);
  });
});

describe("executeSync: lock 無し repo（init 相当）", () => {
  it("lock も managed file も無ければ create して exit 0", async () => {
    await setupBaseDistribution(sourceRoot);
    await initGitRepo(repoRoot);

    const code = await executeSync(options(), captureIo().io);
    expect(code).toBe(SYNC_EXIT.ok);
    expect(await read(REVIEW_DEST)).toBe(REVIEW_CONTENT);
    expect(await exists(LOCKFILE_RELATIVE_PATH)).toBe(true);
  });
});

describe("executeSync: --dry-run", () => {
  it("ファイルを書かず exit 0、プレビューを表示する", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    await writeRaw(sourceRoot, REVIEW_REL, REVIEW_CHANGED);

    const cap = captureIo();
    const code = await executeSync(options({ dryRun: true }), cap.io);
    expect(code).toBe(SYNC_EXIT.ok);
    expect(cap.out()).toContain("dry-run");
    // 書き込まれていない。
    expect(await read(REVIEW_DEST)).toBe(REVIEW_CONTENT);
  });

  it("conflict があれば dry-run でも exit 2", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    await writeRaw(repoRoot, REVIEW_DEST, `${REVIEW_CONTENT}LOCAL\n`);

    const code = await executeSync(options({ dryRun: true }), captureIo().io);
    expect(code).toBe(SYNC_EXIT.conflict);
  });

  it("--json は ok を持つ（他の JSON 出力と一貫）。conflict なし=true / あり=false", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    await writeRaw(sourceRoot, REVIEW_REL, REVIEW_CHANGED);

    const okCap = captureIo();
    expect(await executeSync(options({ dryRun: true, json: true }), okCap.io)).toBe(SYNC_EXIT.ok);
    const okParsed = JSON.parse(okCap.out()) as { ok: boolean; dryRun: boolean };
    expect(okParsed.ok).toBe(true);
    expect(okParsed.dryRun).toBe(true);

    // conflict を作ると ok=false・exit 2。
    await writeRaw(repoRoot, REVIEW_DEST, `${REVIEW_CONTENT}LOCAL\n`);
    const conflictCap = captureIo();
    expect(await executeSync(options({ dryRun: true, json: true }), conflictCap.io)).toBe(
      SYNC_EXIT.conflict,
    );
    expect((JSON.parse(conflictCap.out()) as { ok: boolean }).ok).toBe(false);
  });
});

describe("executeSync: validation error", () => {
  it("Git repo でなければ exit 1", async () => {
    await setupBaseDistribution(sourceRoot);
    // initGitRepo を呼ばない。
    const cap = captureIo();
    const code = await executeSync(options(), cap.io);
    expect(code).toBe(SYNC_EXIT.validation);
    expect(cap.err()).toContain("git init");
  });
});

describe("executeSync: --json", () => {
  it("applied を JSON で出力する", async () => {
    await setupBaseDistribution(sourceRoot);
    await seedSynced();
    await writeRaw(sourceRoot, REVIEW_REL, REVIEW_CHANGED);

    const cap = captureIo();
    const code = await executeSync(options({ json: true }), cap.io);
    expect(code).toBe(SYNC_EXIT.ok);

    const parsed = JSON.parse(cap.out()) as {
      command: string;
      ok: boolean;
      applied: { updates: string[] };
    };
    expect(parsed.command).toBe("sync");
    expect(parsed.ok).toBe(true);
    expect(parsed.applied.updates).toContain(REVIEW_DEST);
  });
});

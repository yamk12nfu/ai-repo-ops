/**
 * `aro proposals check` の検証本体（計画 06 Stage 1-2）。
 *
 * `.ai/local/proposals/*.md` を読み取り専用で機械検証する。AI は関与しない。
 * ファイル単体の検証（frontmatter の分離・YAML parse・zod 検証）は Stage 1-1 の
 * `parseProposalDocument` に委ね、ここは knowledge check と同じ形の finding / report で
 * repo 横断の検証（`id` の一意性・source の Git provenance・鮮度）を担う。
 *
 * knowledge との違い:
 * - index.yaml を持たないため、ディレクトリ内の `*.md` の列挙そのものが入力になる。
 * - 提案 0 件（ディレクトリ不在を含む）は導入直後の正常な状態であり、WARN にせず PASS にする。
 * - stale 判定は `status` に依存する（`open` / `accepted` のみ対象。`rejected` / `done` /
 *   `superseded` は判断が終わった履歴であり、根拠が後から変わっても記録の価値は変わらない）。
 */
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";

import { PathSafetyError, ProposalError } from "./errors.js";
import { assertNoSymlinkInPath } from "./filesystem.js";
import {
  forbiddenSourcePattern,
  readUtf8TextWithinRoot,
  type KnowledgeFinding,
  type KnowledgeFindingStatus,
  type KnowledgeReport,
  type KnowledgeSummary,
} from "./knowledge-check.js";
import {
  inspectKnowledgeSourceGit,
  isRegularKnowledgeSourceEntry,
} from "./knowledge-git.js";
import {
  parseProposalDocument,
  PROPOSALS_ROOT,
  type ProposalFrontmatter,
  type ProposalStatus,
} from "./proposal-frontmatter.js";

/** proposals check の finding。knowledge check と同じ形（`entryId` は proposal の `id`）。 */
export type ProposalFinding = KnowledgeFinding;
export type ProposalFindingStatus = KnowledgeFindingStatus;
/** proposals check の summary。`entries` は proposal ファイル数。 */
export type ProposalsSummary = KnowledgeSummary;
/** proposals check の report。knowledge check と同じ形で CLI / JSON 出力に使う。 */
export type ProposalsReport = KnowledgeReport;

export interface RunProposalsCheckInput {
  repoRoot: string;
  strict: boolean;
}

/** stale 判定の対象になる status（計画 06 Stage 1-2 の項目 5・6）。 */
const STALE_ELIGIBLE_STATUSES: ReadonlySet<ProposalStatus> = new Set(["open", "accepted"]);

interface ParsedProposal {
  fileName: string;
  relativePath: string;
  frontmatter: ProposalFrontmatter;
}

function fail(
  id: string,
  message: string,
  context: { entryId?: string; path?: string; hint?: string } = {},
): ProposalFinding {
  return { id, status: "fail", message, ...context };
}

function pass(
  id: string,
  message: string,
  context: { entryId?: string; path?: string } = {},
): ProposalFinding {
  return { id, status: "pass", message, ...context };
}

function finalizeReport(
  repoRoot: string,
  strict: boolean,
  entries: number,
  findings: ProposalFinding[],
): ProposalsReport {
  const summary: ProposalsSummary = {
    entries,
    passed: findings.filter((finding) => finding.status === "pass").length,
    warned: findings.filter((finding) => finding.status === "warn").length,
    failed: findings.filter((finding) => finding.status === "fail").length,
    stale: findings.filter((finding) => finding.id === "source.stale").length,
  };
  return {
    repoRoot,
    strict,
    findings,
    summary,
    hasWarnings: summary.warned > 0,
    hasFailures: summary.failed > 0,
  };
}

function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

type ProposalsRootInspection =
  | { kind: "missing" }
  | { kind: "invalid"; hint: string }
  | { kind: "ok" };

/**
 * PROPOSALS_ROOT が「symlink を含まない実ディレクトリ」であることを検証する。
 *
 * `readdir` は最終要素の symlink を追従するため、検証せずに列挙すると
 * 「repo 外の空ディレクトリへの symlink」や「proposals の位置に置かれた通常ファイル」が
 * 提案 0 件（正常）へ黙って誤分類される。不在（ENOENT）だけを正常な導入前状態として扱う。
 */
async function inspectProposalsRoot(repoRoot: string): Promise<ProposalsRootInspection> {
  try {
    await assertNoSymlinkInPath(repoRoot, PROPOSALS_ROOT, "proposals root");
  } catch (error) {
    if (error instanceof PathSafetyError) return { kind: "invalid", hint: error.message };
    // 構成要素（例: .ai/local）が通常ファイルだと lstat が ENOTDIR で失敗する。
    if (errnoCode(error) === "ENOTDIR") {
      return { kind: "invalid", hint: "親pathの構成要素がディレクトリではありません。" };
    }
    throw error;
  }
  let stats;
  try {
    stats = await lstat(path.join(repoRoot, PROPOSALS_ROOT));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { kind: "missing" };
    if (errnoCode(error) === "ENOTDIR") {
      return { kind: "invalid", hint: "親pathの構成要素がディレクトリではありません。" };
    }
    throw error;
  }
  if (!stats.isDirectory()) {
    return { kind: "invalid", hint: "proposalsのpathがディレクトリではありません。" };
  }
  return { kind: "ok" };
}

/**
 * PROPOSALS_ROOT 直下の `*.md`（拡張子の大文字小文字は区別しない）を列挙する。
 * `*.md` の名前を持つディレクトリは提案として読めないため FAIL にし、
 * symlink 等の不正な entry は列挙に含めて後段の安全な読み込み（symlink 非追従）で
 * FAIL にする（どちらも黙って読み飛ばさない）。
 */
async function listProposalFileNames(
  repoRoot: string,
  findings: ProposalFinding[],
): Promise<string[]> {
  const dirents = await readdir(path.join(repoRoot, PROPOSALS_ROOT), { withFileTypes: true });
  const fileNames: string[] = [];
  for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!dirent.name.toLowerCase().endsWith(".md")) continue;
    if (dirent.isDirectory()) {
      findings.push(
        fail("document.file", `proposalはファイルである必要があります（ディレクトリ）: ${dirent.name}`, {
          path: `${PROPOSALS_ROOT}/${dirent.name}`,
        }),
      );
      continue;
    }
    fileNames.push(dirent.name);
  }
  return fileNames;
}

async function parseProposalFile(
  repoRoot: string,
  fileName: string,
  findings: ProposalFinding[],
): Promise<ParsedProposal | null> {
  const relativePath = `${PROPOSALS_ROOT}/${fileName}`;
  const result = await readUtf8TextWithinRoot(repoRoot, relativePath, "proposal document");
  if (result.kind === "read-error") {
    findings.push(
      fail("document.read", `proposalを安全に読めません: ${fileName}`, {
        path: relativePath,
        hint: result.error instanceof Error ? result.error.message : String(result.error),
      }),
    );
    return null;
  }
  if (result.kind === "missing") {
    findings.push(
      fail("document.exists", `proposalが存在しません: ${fileName}`, { path: relativePath }),
    );
    return null;
  }
  if (result.kind === "not-text") {
    findings.push(
      fail("document.text", `proposalがUTF-8テキストではありません: ${fileName}`, {
        path: relativePath,
      }),
    );
    return null;
  }

  let frontmatter: ProposalFrontmatter;
  try {
    frontmatter = parseProposalDocument(result.text, relativePath).frontmatter;
  } catch (error) {
    if (error instanceof ProposalError) {
      const findingId =
        error.code === "PROPOSAL_FRONTMATTER_INVALID" ? "frontmatter.schema" : "frontmatter.parse";
      findings.push(
        fail(findingId, error.message, {
          path: relativePath,
          ...(error.hint !== undefined ? { hint: error.hint } : {}),
        }),
      );
      return null;
    }
    throw error;
  }
  findings.push(
    pass("frontmatter.schema", `proposal frontmatterは有効です: ${fileName}`, {
      entryId: frontmatter.id,
      path: relativePath,
    }),
  );
  return { fileName, relativePath, frontmatter };
}

/**
 * `id` の repo 内一意性を検証する（大文字小文字は区別しない。knowledge の重複検出と同じ扱い）。
 * Stage 1-1 がファイル単体検証に留めた横断チェックはここが責務。
 */
function checkDuplicateIds(proposals: readonly ParsedProposal[], findings: ProposalFinding[]): void {
  const firstSeen = new Map<string, ParsedProposal>();
  for (const proposal of proposals) {
    const key = proposal.frontmatter.id.toLowerCase();
    const first = firstSeen.get(key);
    if (first === undefined) {
      firstSeen.set(key, proposal);
      continue;
    }
    findings.push(
      fail(
        "id.duplicate",
        `proposal IDが重複しています（大文字小文字は区別しません）: ${proposal.frontmatter.id}`,
        {
          entryId: proposal.frontmatter.id,
          path: proposal.relativePath,
          hint: `同じIDのproposal: ${first.relativePath}`,
        },
      ),
    );
  }
}

async function checkProposalSource(
  repoRoot: string,
  proposal: ParsedProposal,
  sourcePath: string,
  strict: boolean,
  findings: ProposalFinding[],
): Promise<void> {
  const { id, status, proposed_at_commit: proposedAtCommit } = proposal.frontmatter;
  const forbidden = forbiddenSourcePattern(sourcePath);
  if (forbidden !== undefined) {
    findings.push(
      fail("source.forbidden", `proposal sourceに禁止pathは使えません: ${sourcePath}`, {
        entryId: id,
        path: sourcePath,
        hint: `built-in forbidden pattern: ${forbidden}`,
      }),
    );
    return;
  }

  const state = await inspectKnowledgeSourceGit(repoRoot, sourcePath, proposedAtCommit);
  if (state.headEntry === null) {
    findings.push(
      fail("source.tracked", `proposal sourceがHEADでGit追跡されていません: ${sourcePath}`, {
        entryId: id,
        path: sourcePath,
      }),
    );
    return;
  }
  if (!isRegularKnowledgeSourceEntry(state.headEntry)) {
    findings.push(
      fail(
        "source.git-object",
        `proposal sourceはHEAD上の通常blobである必要があります: ${sourcePath}`,
        {
          entryId: id,
          path: sourcePath,
          hint: `Git tree entry: mode=${state.headEntry.mode}, type=${state.headEntry.type}`,
        },
      ),
    );
    return;
  }
  if (state.commitState === "missing") {
    findings.push(
      fail("provenance.commit", `proposed_at_commitが存在しません: ${proposedAtCommit}`, {
        entryId: id,
        path: sourcePath,
      }),
    );
    return;
  }
  if (state.commitState === "not-ancestor") {
    findings.push(
      fail(
        "provenance.ancestor",
        `proposed_at_commitがHEADの祖先ではありません: ${proposedAtCommit}`,
        {
          entryId: id,
          path: sourcePath,
          hint: "rebase後は現在の履歴で根拠を再確認し、proposed_at_commitを更新してください。",
        },
      ),
    );
    return;
  }
  if (state.verifiedEntry === null) {
    findings.push(
      fail("provenance.source-at-commit", `proposed_at_commitにsourceが存在しません: ${sourcePath}`, {
        entryId: id,
        path: sourcePath,
      }),
    );
    return;
  }
  if (!isRegularKnowledgeSourceEntry(state.verifiedEntry)) {
    findings.push(
      fail(
        "provenance.source-git-object",
        `proposed_at_commitのsourceは通常blobである必要があります: ${sourcePath}`,
        {
          entryId: id,
          path: sourcePath,
          hint: `Git tree entry: mode=${state.verifiedEntry.mode}, type=${state.verifiedEntry.type}`,
        },
      ),
    );
    return;
  }

  const read = await readUtf8TextWithinRoot(repoRoot, sourcePath, "proposal source");
  if (read.kind === "read-error") {
    findings.push(
      fail("source.read", `proposal sourceを安全に読めません: ${sourcePath}`, {
        entryId: id,
        path: sourcePath,
        hint: read.error instanceof Error ? read.error.message : String(read.error),
      }),
    );
    return;
  }
  if (read.kind === "missing") {
    findings.push(
      fail("source.exists", `proposal sourceが存在しません: ${sourcePath}`, {
        entryId: id,
        path: sourcePath,
      }),
    );
    return;
  }
  if (read.kind === "not-text") {
    findings.push(
      fail("source.text", `proposal sourceがUTF-8テキストではありません: ${sourcePath}`, {
        entryId: id,
        path: sourcePath,
      }),
    );
    return;
  }

  if (!STALE_ELIGIBLE_STATUSES.has(status)) {
    findings.push(
      pass(
        "source.stale-exempt",
        `statusが${status}のproposalはstale判定の対象外です: ${sourcePath}`,
        { entryId: id, path: sourcePath },
      ),
    );
    return;
  }
  if (state.stale === true) {
    findings.push({
      id: "source.stale",
      status: strict ? "fail" : "warn",
      entryId: id,
      path: sourcePath,
      message: `proposed_at_commit以降にproposal sourceが変更されています: ${sourcePath}`,
      hint: "根拠が変わっています。提案を再確認し、作り直すか人間が判断してください。",
    });
    return;
  }
  findings.push(
    pass("source.fresh", `proposal sourceはproposed_at_commitから変更されていません: ${sourcePath}`, {
      entryId: id,
      path: sourcePath,
    }),
  );
}

/** repo 固有proposalを決定的に検証する。読み取り専用でrepoへ一切書き込まない。 */
export async function runProposalsCheck(input: RunProposalsCheckInput): Promise<ProposalsReport> {
  const repoRoot = path.resolve(input.repoRoot);
  const findings: ProposalFinding[] = [];

  const rootState = await inspectProposalsRoot(repoRoot);
  if (rootState.kind === "invalid") {
    findings.push(
      fail("proposals.root", `proposalsのroot pathが不正です: ${PROPOSALS_ROOT}`, {
        path: PROPOSALS_ROOT,
        hint: rootState.hint,
      }),
    );
    return finalizeReport(repoRoot, input.strict, 0, findings);
  }
  const fileNames =
    rootState.kind === "missing" ? [] : await listProposalFileNames(repoRoot, findings);
  if (fileNames.length === 0) {
    if (findings.length === 0) {
      // 導入直後の正常な状態。knowledge の entries.empty（WARN）とは違い PASS にする。
      findings.push(pass("proposals.empty", `proposalはまだありません: ${PROPOSALS_ROOT}`));
    }
    return finalizeReport(repoRoot, input.strict, 0, findings);
  }

  const proposals: ParsedProposal[] = [];
  for (const fileName of fileNames) {
    const parsed = await parseProposalFile(repoRoot, fileName, findings);
    if (parsed !== null) proposals.push(parsed);
  }

  checkDuplicateIds(proposals, findings);

  for (const proposal of proposals) {
    for (const source of proposal.frontmatter.sources) {
      await checkProposalSource(repoRoot, proposal, source.path, input.strict, findings);
    }
  }

  return finalizeReport(repoRoot, input.strict, fileNames.length, findings);
}

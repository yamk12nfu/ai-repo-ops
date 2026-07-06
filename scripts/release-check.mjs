/**
 * リリース前後の整合性を検証する（[`RELEASE.md`](../RELEASE.md) §5 / §7 に対応）。
 *
 * 計画 01・RELEASE.md 末尾のリスク欄で約束していた自動化。moving tag（`v1`）の付け替え忘れは
 * 「vX.Y.Z を出したのに対象 repo は古い reusable workflow のまま」という静かなズレを生む
 * （対象 repo は `@v1` を解決するだけなので、中央側の tag 移動漏れに気づけない）。このスクリプトは
 * その事故を機械的に検出する。
 *
 * バージョンの契約は 2 層（RELEASE.md §0）。チェックもこれに合わせる。
 *   - `package.json`（root）と `packages/aro-cli/package.json` の `version` は**常に一致**させる
 *     （リリースバージョンそのもの）→ 完全一致を要求する。
 *   - `distribution/base/manifest.yaml` の `version` は別軸（distribution の内容が変わった
 *     リリースでのみ bump）→ root/aro-cli との一致は要求せず、semver として妥当かのみ確認する。
 *
 * チェック項目:
 *   a. root と packages/aro-cli の package.json `version` が一致すること
 *   b. distribution/base/manifest.yaml の `version` が semver 形式であること（等値は要求しない）
 *   c. CHANGELOG.md に `## [<version>]` セクションが存在すること
 *   d. タグ `v<version>` が origin に存在すること（`git ls-remote --tags origin` で確認。
 *      付け替え忘れという事故は origin 側で起きるため、ローカルタグではなく origin を正とする）
 *   e. origin の moving tag `v<major>` が、origin の `v<version>` と同じ commit を指すこと。
 *      `<major>` はリリース version の semver major **ではなく**、実際に配布されている
 *      `distribution/base/files/.github/workflows/ai-review.yml` が参照する
 *      reusable workflow の `@vN`（RELEASE.md §1 の compat line）から読み取る。
 *      両者は別軸（例: 本リポジトリは product version `0.1.0` の段階で moving tag は既に `v1`）
 *
 * d/e はタグ発行後（RELEASE.md §7 リリース後確認）の検証。§5（version bump 後・タグ発行前）の時点では
 * まだタグが存在せず当然 FAIL するため、`--pre-tag` を付けると d/e をスキップして a〜c のみ検証する。
 *
 * 使い方:
 *   node scripts/release-check.mjs             # フルチェック（§7: タグ発行 + v1 移動後に実行）
 *   node scripts/release-check.mjs --pre-tag    # a〜c のみ（§5: version bump 後・タグ発行前に実行）
 *
 * 修正アクションは行わない（チェックのみ）。FAIL があれば原因を確認し、該当する RELEASE.md の節の
 * 手順をやり直すこと。
 *
 * 実行系: plain ESM JavaScript。依存ゼロで Node.js >= 20（root engines）で動く
 * （scripts/sync-managed-schema.mjs と同じ流儀）。
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** repo root（このファイルは <root>/scripts/ にある）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ROOT_PKG = path.join(ROOT, "package.json");
const CLI_PKG = path.join(ROOT, "packages", "aro-cli", "package.json");
const MANIFEST = path.join(ROOT, "distribution", "base", "manifest.yaml");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");
const WORKFLOWS_DIR = path.join(ROOT, "distribution", "base", "files", ".github", "workflows");
const REVIEW_WORKFLOW = path.join(WORKFLOWS_DIR, "ai-review.yml");

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** repo root からの相対表示（ログ用）。 */
function rel(absolute) {
  return path.relative(ROOT, absolute);
}

async function readJson(absolute) {
  return JSON.parse(await readFile(absolute, "utf8"));
}

/**
 * manifest.yaml の trailing `version: X.Y.Z` を読む。
 * manifest.yaml は固定の単純な構造なので、外部依存を増やさず正規表現で十分（YAML full parser は不要）。
 */
async function readManifestVersion(absolute) {
  const text = await readFile(absolute, "utf8");
  const match = text.match(/^version:\s*(.+?)\s*$/m);
  if (!match) return null;
  return match[1].replace(/^["']|["']$/g, "");
}

/**
 * 配布用 workflow ファイル（ai-review.yml）が参照している reusable workflow の
 * moving tag（`uses: .../ai-review.reusable.yml@vN` の `vN`）を読む。
 */
async function readReferencedMovingTag(absolute) {
  const text = await readFile(absolute, "utf8");
  const match = text.match(/reusable\.yml@(v\d+)/);
  return match ? match[1] : null;
}

/**
 * `git ls-remote --tags origin` を tag 名 -> commit sha の Map にする。
 * annotated tag は `refs/tags/<tag>^{}` 行が実 commit を指すので、そちらを優先する。
 */
function readOriginTags() {
  const out = execFileSync("git", ["ls-remote", "--tags", "origin"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const map = new Map();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split(/\s+/);
    const refMatch = ref.match(/^refs\/tags\/(.+?)(\^\{\})?$/);
    if (!refMatch) continue;
    const [, tag, peeled] = refMatch;
    if (peeled || !map.has(tag)) {
      map.set(tag, sha);
    }
  }
  return map;
}

const results = [];

function record(name, pass, detail) {
  results.push(pass);
  const status = pass ? "PASS" : "FAIL";
  const line = `${status}: ${name}${detail ? ` (${detail})` : ""}`;
  // sync-managed-schema.mjs の流儀に合わせ、FAIL は console.error（stderr）、PASS は console.log（stdout）。
  if (pass) {
    console.log(line);
  } else {
    console.error(line);
  }
}

function printHelp() {
  console.log(
    [
      "使い方: node scripts/release-check.mjs [--pre-tag]",
      "",
      "  (フラグ無し)  a〜e すべてを検証する（RELEASE.md §7: タグ発行 + v1 移動後）。",
      "  --pre-tag     d/e（origin のタグ検証）をスキップし a〜c のみ検証する",
      "                （RELEASE.md §5: version bump 後・タグ発行前）。",
    ].join("\n"),
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }
  const preTag = args.includes("--pre-tag");

  const rootPkg = await readJson(ROOT_PKG);
  const cliPkg = await readJson(CLI_PKG);
  const version = rootPkg.version;

  // a. root と aro-cli の version は常に一致（リリースバージョンそのもの）
  record(
    "a. package.json version 一致 (root == packages/aro-cli)",
    rootPkg.version === cliPkg.version,
    `root=${rootPkg.version} aro-cli=${cliPkg.version}`,
  );

  // b. manifest.yaml の version は別軸。等値は要求せず semver 形式であることのみ確認する。
  const manifestVersion = await readManifestVersion(MANIFEST);
  record(
    `b. ${rel(MANIFEST)} の version が semver 形式`,
    manifestVersion !== null && SEMVER_RE.test(manifestVersion),
    `manifest.version=${manifestVersion ?? "(見つかりません)"}`,
  );

  // c. CHANGELOG.md に該当 version のセクションが存在
  const changelog = await readFile(CHANGELOG, "utf8");
  const changelogHeading = new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m");
  record(
    `c. CHANGELOG.md に [${version}] セクションが存在`,
    changelogHeading.test(changelog),
  );

  if (preTag) {
    console.log("--pre-tag: d/e（origin タグの検証。タグ発行後にのみ意味を持つ）はスキップしました。");
  } else {
    const releaseTag = `v${version}`;
    // origin へのアクセス（git ls-remote / workflow ファイル読み取り）はネットワーク不通・
    // remote 未設定・認証失敗などで例外を投げうる。ここで捕捉せず main().catch まで素通りさせると
    // d/e の PASS/FAIL 行が出力されないまま生の例外ダンプで落ちてしまう
    // （sync-managed-schema.mjs の「失敗は FAIL: 行 + 対処案内で報告する」流儀と不一致になる）ため、
    // このブロック全体を try/catch し、失敗時は d/e を明示的に FAIL として record する。
    try {
      const tags = readOriginTags();
      const releaseSha = tags.get(releaseTag);

      // d. タグ v<version> が origin に存在すること
      record(
        `d. タグ ${releaseTag} が origin に存在`,
        Boolean(releaseSha),
        releaseSha ? `sha=${releaseSha}` : "origin に見つかりません",
      );

      // e. origin の moving tag v<major> が origin の v<version> と同じ commit を指すこと。
      //    <major> は配布中の workflow ファイルが実際に参照している compat line から読む
      //    （リリース version の semver major とは別軸。RELEASE.md §0 / §1 参照）。
      const reviewTag = await readReferencedMovingTag(REVIEW_WORKFLOW);
      if (!reviewTag) {
        record(
          "e. moving tag が release タグと同じ commit を指す",
          false,
          "ai-review.yml から reusable workflow の @vN 参照を読み取れません",
        );
      } else {
        const movingTag = reviewTag;
        const movingSha = tags.get(movingTag);
        record(
          `e. moving tag ${movingTag} が ${releaseTag} と同じ commit を指す`,
          Boolean(releaseSha) && Boolean(movingSha) && movingSha === releaseSha,
          `${movingTag}=${movingSha ?? "(見つかりません)"} ${releaseTag}=${releaseSha ?? "(見つかりません)"}`,
        );
      }
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      const guidance = "ネットワーク接続や git remote 設定を確認してください。";
      record(
        `d. タグ ${releaseTag} が origin に存在`,
        false,
        `origin へのアクセスに失敗しました: ${message} — ${guidance}`,
      );
      record(
        "e. moving tag が release タグと同じ commit を指す",
        false,
        `origin へのアクセスに失敗したため検証できません: ${message} — ${guidance}`,
      );
    }
  }

  const failCount = results.filter((pass) => !pass).length;
  if (failCount > 0) {
    console.error(`\nFAIL ${failCount} 件。`);
    process.exitCode = 1;
    return;
  }
  if (preTag) {
    console.log("\na〜c が PASS しました（d/e は --pre-tag によりスキップ）。");
  } else {
    console.log("\nすべての検証項目が PASS しました。");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

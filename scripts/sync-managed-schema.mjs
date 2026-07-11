/**
 * authoritative schemas を distribution の managed copy へ同期する。
 *
 * 計画 v3 §0.2.5 / §4.1 に対応する。
 *   - `schemas/project.schema.json` を唯一の正とする。
 *   - `distribution/base/files/.ai/managed/schemas/project.schema.json` はこの script で生成し、
 *     人間が 2 箇所を手編集する運用を禁止する。
 *
 * 内容は §6.2 の canonical text（先頭 BOM strip / CRLF・CR → LF）に正規化して書く。
 * これにより source loader が計算する canonical sha256 と、checked-in の managed copy が一致する。
 *
 * 使い方:
 *   node scripts/sync-managed-schema.mjs          # 生成 / 上書き（managed copy を最新化）
 *   node scripts/sync-managed-schema.mjs --check   # 差分があれば exit 1（CI / pre-commit 向け）
 *
 * 実行系: plain ESM JavaScript。依存ゼロで Node.js >= 20（root engines）で動く。
 * （TypeScript runtime や tsx は不要。aro-cli core と同じ canonical 規則をここに複製している。）
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** repo root（このファイルは <root>/scripts/ にある）。 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** authoritative → managed copy の同期対象。 */
const SCHEMAS = ["project.schema.json", "knowledge.schema.json"].map((filename) => ({
  authoritative: path.join(ROOT, "schemas", filename),
  managedCopy: path.join(
    ROOT,
    "distribution",
    "base",
    "files",
    ".ai",
    "managed",
    "schemas",
    filename,
  ),
}));

/** repo root からの相対表示（ログ用）。 */
function rel(absolute) {
  return path.relative(ROOT, absolute);
}

/**
 * canonical text へ正規化する（§6.2 `canonical_text_lf_utf8bom_strip_v1`）。
 * aro-cli core の canonicalizeTextString と同一規則（先頭 BOM strip / CRLF・CR → LF）。
 * script は build 対象外のため、依存を増やさず同じ規則をここに持つ。
 */
function canonicalize(input) {
  const withoutBom = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  return withoutBom.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

async function readTextOrNull(absolute) {
  try {
    return await readFile(absolute, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  const check = process.argv.slice(2).includes("--check");
  let failed = false;

  for (const schema of SCHEMAS) {
    const authoritativeRaw = await readTextOrNull(schema.authoritative);
    if (authoritativeRaw === null) {
      console.error(`ERROR: authoritative schema が見つかりません: ${rel(schema.authoritative)}`);
      failed = true;
      continue;
    }
    const expected = canonicalize(authoritativeRaw);
    const current = await readTextOrNull(schema.managedCopy);

    if (check) {
      if (current === null) {
        console.error(`FAIL: managed copy が存在しません: ${rel(schema.managedCopy)}`);
        console.error("      `pnpm schema:sync` を実行してください。");
        failed = true;
      } else if (canonicalize(current) !== expected) {
        console.error(`FAIL: managed copy が authoritative schema と一致しません: ${rel(schema.managedCopy)}`);
        console.error("      `pnpm schema:sync` を実行して再コミットしてください。");
        failed = true;
      } else {
        console.log(`OK: managed copy は最新です（${rel(schema.managedCopy)}）。`);
      }
      continue;
    }

    if (current !== null && canonicalize(current) === expected) {
      console.log(`unchanged: ${rel(schema.managedCopy)}`);
      continue;
    }
    await mkdir(path.dirname(schema.managedCopy), { recursive: true });
    await writeFile(schema.managedCopy, expected, "utf8");
    console.log(`wrote: ${rel(schema.managedCopy)} <- ${rel(schema.authoritative)}`);
  }

  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

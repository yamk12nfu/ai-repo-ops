import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalSha256OfString } from "../checksum.js";
import { ManifestError, SourceError } from "../errors.js";
import {
  loadDistribution,
  loadKnowledgeSchema,
  loadProjectSchema,
  resolveSourceLocation,
  resolveSourceRoot,
} from "../source.js";

let sourceRoot: string;

beforeEach(async () => {
  sourceRoot = await mkdtemp(path.join(tmpdir(), "aro-src-"));
});

afterEach(async () => {
  await rm(sourceRoot, { recursive: true, force: true });
});

/** sourceRoot 配下にファイルを書く（親ディレクトリは作成する）。 */
async function writeSourceFile(relPath: string, content: string): Promise<void> {
  const abs = path.join(sourceRoot, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
}

/** sourceRoot 配下に生バイトを書く（不正 UTF-8 などの検証用）。 */
async function writeSourceBytes(relPath: string, bytes: Buffer): Promise<void> {
  const abs = path.join(sourceRoot, relPath);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

const REVIEW_REL = "distribution/base/files/.ai/managed/prompts/review.md";
const POLICY_REL = "distribution/base/files/.ai/managed/policies/default.yaml";
const TEMPLATE_REL = "distribution/base/project.yaml.hbs";

/** 標準的な base distribution を sourceRoot に作る。manifest は引数で差し替え可能。 */
async function setupBaseDistribution(manifestYaml?: string): Promise<void> {
  await writeSourceFile(REVIEW_REL, "# Review prompt\n");
  await writeSourceFile(POLICY_REL, "risk: low\n");
  await writeSourceFile(TEMPLATE_REL, "name: {{ repo_name }}\n");
  const defaultManifest = `schema_version: 1
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
patches:
  - type: append_unique_lines
    path: .gitignore
    lines:
      - .ai/runs/
      - .ai/tmp/
`;
  await writeSourceFile("distribution/base/manifest.yaml", manifestYaml ?? defaultManifest);
}

describe("loadDistribution: manifest.name とディレクトリ名の一致", () => {
  it("manifest.name が distribution ディレクトリ名と違うと DISTRIBUTION_NAME_MISMATCH", async () => {
    const mismatched = `schema_version: 1
name: notbase
version: 0.1.0
files: []
seed_files: []
patches: []
preserve: []
`;
    await setupBaseDistribution(mismatched);
    await expect(loadDistribution(sourceRoot, "base")).rejects.toMatchObject({
      code: "DISTRIBUTION_NAME_MISMATCH",
    });
  });
});

describe("resolveSourceRoot", () => {
  it("明示 source に distribution/ があればそれを返す", async () => {
    await setupBaseDistribution();
    expect(await resolveSourceRoot(sourceRoot, "/nonexistent-start")).toBe(path.resolve(sourceRoot));
  });

  it("distribution/ が無い source は SourceError", async () => {
    await expect(resolveSourceRoot(sourceRoot, "/x")).rejects.toBeInstanceOf(SourceError);
  });

  it("source 未指定なら startDir から上方探索する", async () => {
    await setupBaseDistribution();
    const nested = path.join(sourceRoot, "a", "b", "c");
    await mkdir(nested, { recursive: true });
    expect(await resolveSourceRoot(undefined, nested)).toBe(path.resolve(sourceRoot));
  });

  it("上方に distribution/ が無ければ SourceError", async () => {
    const lonely = await mkdtemp(path.join(tmpdir(), "aro-lonely-"));
    await expect(resolveSourceRoot(undefined, lonely)).rejects.toBeInstanceOf(SourceError);
    await rm(lonely, { recursive: true, force: true });
  });
});

describe("loadDistribution（正常系）", () => {
  it("manifest を検証し src/template を読み込む", async () => {
    await setupBaseDistribution();
    const dist = await loadDistribution(sourceRoot, "base");

    expect(dist.manifest.name).toBe("base");
    expect(dist.managedFiles).toHaveLength(2);
    expect(dist.seedFiles).toHaveLength(1);
    expect(dist.seedFiles[0]?.sourceKind).toBe("template");
    expect(dist.patches).toHaveLength(1);
    expect(dist.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("managed file の sourceSha256 は canonical sha256 と一致する", async () => {
    await setupBaseDistribution();
    const dist = await loadDistribution(sourceRoot, "base");
    const review = dist.managedFiles.find((m) => m.dest === ".ai/managed/prompts/review.md");
    expect(review?.sourceSha256).toBe(canonicalSha256OfString("# Review prompt\n"));
  });

  it("CRLF の source でも canonical 化されて content は LF になる", async () => {
    await setupBaseDistribution();
    await writeSourceFile(REVIEW_REL, "# Review prompt\r\nline2\r\n");
    const dist = await loadDistribution(sourceRoot, "base");
    const review = dist.managedFiles.find((m) => m.dest === ".ai/managed/prompts/review.md");
    expect(review?.content).toBe("# Review prompt\nline2\n");
  });
});

describe("loadDistribution（異常系）", () => {
  it("distribution が無いと SourceError", async () => {
    await setupBaseDistribution();
    await expect(loadDistribution(sourceRoot, "missing")).rejects.toBeInstanceOf(SourceError);
  });

  it("manifest が参照する src が無いと SourceError（全 src 存在検証）", async () => {
    await setupBaseDistribution();
    await rm(path.join(sourceRoot, POLICY_REL));
    await expect(loadDistribution(sourceRoot, "base")).rejects.toMatchObject({
      code: "SOURCE_FILE_MISSING",
    });
  });

  it("壊れた manifest は ManifestError", async () => {
    await setupBaseDistribution("schema_version: 1\nname: base\n");
    await expect(loadDistribution(sourceRoot, "base")).rejects.toBeInstanceOf(ManifestError);
  });

  it("src が不正な UTF-8 だと SourceError（SOURCE_FILE_NOT_UTF8、指摘3）", async () => {
    await setupBaseDistribution();
    // 0xFF は UTF-8 として常に不正なバイト。toString だと U+FFFD に置換され見逃される。
    await writeSourceBytes(REVIEW_REL, Buffer.from([0x68, 0x69, 0xff, 0x0a]));
    await expect(loadDistribution(sourceRoot, "base")).rejects.toMatchObject({
      code: "SOURCE_FILE_NOT_UTF8",
    });
  });

  it("manifest が不正な UTF-8 だと SourceError（SOURCE_FILE_NOT_UTF8）", async () => {
    await setupBaseDistribution();
    await writeSourceBytes("distribution/base/manifest.yaml", Buffer.from([0xff, 0xfe, 0x41]));
    await expect(loadDistribution(sourceRoot, "base")).rejects.toMatchObject({
      code: "SOURCE_FILE_NOT_UTF8",
    });
  });
});

describe("distribution 名の検証（traversal 防止 / 指摘）", () => {
  it.each(["../evil", "a/b", "..", ".", ".hidden", "", "a\\b"])(
    "単一セグメントでない distribution 名 %j を拒否する",
    async (name) => {
      await expect(loadDistribution(sourceRoot, name)).rejects.toMatchObject({
        code: "DISTRIBUTION_NAME_INVALID",
      });
    },
  );

  it("../ を含む名前で distribution/ の外側 manifest を読み込ませない", async () => {
    await setupBaseDistribution();
    // distribution/ の外側（sourceRoot/evil/manifest.yaml）に有効な manifest を置く。
    // path.join(root, "distribution", "../evil") は root/evil を指すため、未対策なら読めてしまう。
    await writeSourceFile("evil/manifest.yaml", "schema_version: 1\nname: evil\nversion: 0.1.0\n");
    await expect(loadDistribution(sourceRoot, "../evil")).rejects.toMatchObject({
      code: "DISTRIBUTION_NAME_INVALID",
    });
  });

  it("resolveSourceLocation 単体でも traversal 名を拒否する", async () => {
    await setupBaseDistribution();
    await expect(resolveSourceLocation(sourceRoot, "../evil")).rejects.toMatchObject({
      code: "DISTRIBUTION_NAME_INVALID",
    });
  });

  it("通常の単一セグメント名は受理する", async () => {
    await setupBaseDistribution();
    const loc = await resolveSourceLocation(sourceRoot, "base");
    expect(loc.distribution).toBe("base");
  });
});

describe("loadDistribution（content hash の安定性 §10）", () => {
  it("manifest のコメントやエントリ順を変えても content hash は変わらない", async () => {
    await setupBaseDistribution();
    const before = (await loadDistribution(sourceRoot, "base")).contentSha256;

    // エントリ順を反転し、コメントを足した manifest に差し替える。
    const reordered = `# このコメントは hash に影響しない
schema_version: 1
name: base
version: 0.1.0
files:
  - src: files/.ai/managed/policies/default.yaml
    dest: .ai/managed/policies/default.yaml
    strategy: managed_overwrite
  - src: files/.ai/managed/prompts/review.md # 行末コメント
    dest: .ai/managed/prompts/review.md
    strategy: managed_overwrite
seed_files:
  - dest: .ai/project.yaml
    template: project.yaml.hbs
    strategy: create_only
patches:
  - type: append_unique_lines
    path: .gitignore
    lines:
      - .ai/runs/
      - .ai/tmp/
`;
    await writeSourceFile("distribution/base/manifest.yaml", reordered);
    const after = (await loadDistribution(sourceRoot, "base")).contentSha256;
    expect(after).toBe(before);
  });

  it("manifest.version だけ変えても content hash は変わらない", async () => {
    await setupBaseDistribution();
    const before = (await loadDistribution(sourceRoot, "base")).contentSha256;

    const bumped = `schema_version: 1
name: base
version: 9.9.9
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
patches:
  - type: append_unique_lines
    path: .gitignore
    lines:
      - .ai/runs/
      - .ai/tmp/
`;
    await writeSourceFile("distribution/base/manifest.yaml", bumped);
    const after = (await loadDistribution(sourceRoot, "base")).contentSha256;
    expect(after).toBe(before);
  });

  it("managed file の内容が変われば content hash も変わる（version 同一でも検出）", async () => {
    await setupBaseDistribution();
    const before = (await loadDistribution(sourceRoot, "base")).contentSha256;

    await writeSourceFile(REVIEW_REL, "# Review prompt CHANGED\n");
    const after = (await loadDistribution(sourceRoot, "base")).contentSha256;
    expect(after).not.toBe(before);
  });
});

describe("loadProjectSchema", () => {
  it("schemas/project.schema.json を JSON.parse して返す", async () => {
    await writeSourceFile("schemas/project.schema.json", '{"type":"object"}');
    const schema = await loadProjectSchema(sourceRoot);
    expect(schema).toEqual({ type: "object" });
  });

  it("先頭 UTF-8 BOM 付きでも parse できる（§6.2。JSON.parse は BOM を自動で無視しない）", async () => {
    const withBom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{"type":"object"}', "utf8"),
    ]);
    await writeSourceBytes("schemas/project.schema.json", withBom);
    const schema = await loadProjectSchema(sourceRoot);
    expect(schema).toEqual({ type: "object" });
  });

  it("ファイルが無ければ SourceError（PROJECT_SCHEMA_NOT_FOUND）", async () => {
    await expect(loadProjectSchema(sourceRoot)).rejects.toMatchObject({
      code: "PROJECT_SCHEMA_NOT_FOUND",
    });
  });

  it("壊れた JSON は SourceError（PROJECT_SCHEMA_PARSE）", async () => {
    await writeSourceFile("schemas/project.schema.json", "{not valid json");
    await expect(loadProjectSchema(sourceRoot)).rejects.toMatchObject({
      code: "PROJECT_SCHEMA_PARSE",
    });
  });

  it("不正な UTF-8 は SourceError（SOURCE_FILE_NOT_UTF8）", async () => {
    await writeSourceBytes("schemas/project.schema.json", Buffer.from([0x68, 0x69, 0xff, 0x0a]));
    await expect(loadProjectSchema(sourceRoot)).rejects.toMatchObject({
      code: "SOURCE_FILE_NOT_UTF8",
    });
  });
});

describe("loadKnowledgeSchema", () => {
  it("schemas/knowledge.schema.json を JSON.parse して返す", async () => {
    await writeSourceFile("schemas/knowledge.schema.json", '{"type":"object"}');
    await expect(loadKnowledgeSchema(sourceRoot)).resolves.toEqual({ type: "object" });
  });

  it("ファイルが無ければ KNOWLEDGE_SCHEMA_NOT_FOUND", async () => {
    await expect(loadKnowledgeSchema(sourceRoot)).rejects.toMatchObject({
      code: "KNOWLEDGE_SCHEMA_NOT_FOUND",
    });
  });

  it("壊れたJSONなら KNOWLEDGE_SCHEMA_PARSE", async () => {
    await writeSourceFile("schemas/knowledge.schema.json", "{broken");
    await expect(loadKnowledgeSchema(sourceRoot)).rejects.toMatchObject({
      code: "KNOWLEDGE_SCHEMA_PARSE",
    });
  });
});

# ai-repo-ops 実装計画書 v3

作成日: 2026-06-28  
更新版: v3  
想定実装者: Claude Opus 4.8 または GPT-5.5  
対象リポジトリ名: `ai-repo-ops`  
目的: AI運用基盤の標準装備を複数のGitHubリポジトリへ安全に展開・更新・検証できる仕組みを実装する。

---

## 0. v3での主要修正

v1レビューとv2レビューを受け、MVP仕様を以下のように修正する。v3では特に、実装者間で解釈が割れると後から直しづらい **distribution content hash** と **`aro diff` のexit code** を仕様として固定する。

### 0.1 v2で採用済みの修正

1. **改行コード方針をMVP仕様に入れる**
   - checksumはテキスト内容をcanonical contentに対して計算する。
   - canonical contentはUTF-8 decode後、先頭UTF-8 BOMを取り除き、CRLF/CRをLFへ正規化したものとする。
   - 書き込みはUTF-8 LF、BOMなしに統一する。
   - `.gitattributes` へ管理対象ファイルのLF固定ルールを配布する。

2. **`--to <version>` をMVPから外す**
   - MVPでは同期先は「現在のsource checkoutに含まれるmanifest」だけ。
   - `aro diff --to v0.3.0` のようなUIは実装しない。
   - versionは表示情報として使うが、更新判定はchecksum / distribution content hashを正とする。

3. **`merge_or_conflict` をMVPから外す**
   - MVPのstrategyは `managed_overwrite` / `create_only` / `append_unique_lines` の3つに絞る。
   - 3-way mergeはMVP後の明確な拡張として扱う。

4. **workflow stubは原則 `create_only` にする**
   - 各repo側のworkflowはrepo固有のpermissionsやschedule調整が入りやすいため、MVPでは初回生成のみ。
   - reusable workflow本体を中央で進化させる。
   - doctorでstubの不足・危険なpermissions・古い参照をWARN/FAILする。

5. **schema検証は中央sourceのschemaで行う**
   - `.ai/managed/schemas/project.schema.json` はエディタ補完・可視性・ドキュメント用途のコピー。
   - `aro doctor` の検証は `ai-repo-ops` source側のauthoritative schemaを使う。
   - 対象repo内のschemaが改変されても検証の信頼性は落とさない。

6. **既存ツールとの比較を計画に入れる**
   - Copier / Cruft と近い問題領域であることを明記する。
   - ただしMVPでは薄いAI運用基盤専用syncerとして自作する。
   - 将来3-way mergeやテンプレート変数更新を広げる場合は、既存ツールをラップする選択肢を再評価する。

### 0.2 v3で新たに採用する修正

1. **`distribution_content_sha256` の正規シリアライズ仕様を固定する**
   - hash対象は「対象repoに影響する配布payload」のみとする。
   - `manifest.version`、manifestコメント、YAML key順、source checkoutの絶対pathはhash対象に含めない。
   - managed files / seed files / patches を正規化したJSON payloadにし、object keyを再帰的にsortし、余分な空白なしでUTF-8 encodeしてSHA-256を計算する。
   - 配列のうち、manifest上の順序に依存させたくないものは `dest` / `path` / `type` 等でsortする。`append_unique_lines.lines` の行順は適用結果に影響するため保持する。

2. **`aro diff --detailed-exitcode` をMVPに入れる**
   - 通常の `aro diff` は人間向けに成功時exit code 0を維持する。
   - CI / rollout / automation向けに `--detailed-exitcode` を用意し、「差分なし」「更新あり」「conflictあり」をexit codeで区別できるようにする。

3. **managed file誤編集からの復旧導線をMVP docsに入れる**
   - `.ai/managed/**` は直接編集禁止。
   - `.prettierignore` に `.ai/managed/` と `.ai/ai-repo-ops.lock.yaml` を追記する。
   - conflict時の復旧手順として `git restore -- .ai/managed/<path>` と `aro sync --repo .` を明記する。
   - `aro reset-managed` はMVPでは実装しない。

4. **managed fileの削除・リネーム追従はMVP非ゴールとして明記する**
   - source manifestから消えたmanaged fileはMVPでは自動削除しない。
   - `aro diff` / `aro doctor` はlockに残っているが現manifestに存在しないmanaged fileを `orphaned managed file` としてWARNできる。
   - 自動削除・rename migrationはPost-MVPで扱う。

5. **authoritative schemaからmanaged copyを生成する方針を明記する**
   - `schemas/project.schema.json` を唯一の正とする。
   - `distribution/base/files/.ai/managed/schemas/project.schema.json` はビルドまたはsync scriptで生成する。
   - 人間が2箇所を手で編集する運用は禁止する。

6. **atomicityは自前backupではなくplan + git復旧前提に寄せる**
   - conflict時はapply前に必ずabortし、ファイル変更を行わない。
   - applyでは全変更内容をmemory上で準備してから書く。
   - 一時backup fileはMVPでは作らない。
   - I/O失敗時はtouched pathsを表示し、tracked fileは `git restore`、new fileは削除で復旧できるようにする。

7. **canonical textは先頭UTF-8 BOMをstripする**
   - Windowsエディタ由来のBOMだけで恒久conflictになるのを避ける。
   - lock fileのchecksum mode名は `canonical_text_lf_utf8bom_strip_v1` とする。

8. **`seed_files` schemaを厳密化する**
   - 各 `seed_files[]` は `dest` と `strategy: create_only` を必須にする。
   - `src` と `template` は「どちらか一方だけ必須」。両方あり、両方なしはvalidation error。

### 0.3 MVPではまだ採用しないもの

1. **3-way merge**
   - 「人間がmanaged fileを触ったらconflict」問題は認識する。
   - MVPでは安全性を優先し、managed fileの直接編集は禁止方針にする。
   - repo固有差分は `.ai/local/**` と `.ai/project.yaml` に逃がす。
   - 3-way mergeはPost-MVP Phase Aとして前倒し候補にする。

2. **複数versionのdistribution保持**
   - MVPではsource checkoutに存在する単一manifestだけを対象にする。
   - version指定やremote tag取得はrollout/migrationフェーズで実装する。

3. **managed fileの自動削除・rename migration**
   - MVPでは古いmanaged fileの自動削除は行わない。
   - orphan検出とdocsでの説明に留める。

4. **`aro reset-managed`**
   - 便利だがMVPでは実装しない。
   - 復旧は `git restore -- .ai/managed/<path>` を案内する。

## 1. 背景

複数のリポジトリを個別に育てる場合、毎回以下を手作業で作るのは重い。

```txt
.ai/project.yaml
AI用プロンプト
AI用ポリシー
GitHub Actions workflow
repoごとのAI改善ハーネス設定
実行ログ・一時ファイルのignore設定
将来のAIレビュー / AI改善 / Issue修正 / Releaseチェック用の入口
```

既存の `dark-part-time-job` には、中央オーケストレータから対象リポジトリに初期ファイルを展開する思想がある。`ai-repo-ops` ではその思想を、複数GitHubリポジトリへAI運用ファイルを安全に配布・更新・検証するための専用syncerとして発展させる。

---

## 2. ゴール / 非ゴール

### 2.1 最終ゴール

`ai-repo-ops` を中央基盤として、各リポジトリに以下を展開・更新できるようにする。

```txt
.ai/
  project.yaml
  ai-repo-ops.lock.yaml
  managed/
    prompts/
    policies/
    schemas/
  local/
  runs/        # gitignore
  tmp/         # gitignore
  logs/        # gitignore
.github/
  workflows/
    ai-review.yml
    ai-improve.yml
.gitattributes
.gitignore
.prettierignore
```

各リポジトリには薄い設定とstub workflowだけを置く。AI改善ループ本体、再利用可能workflow本体、ハーネス本体、配布ロジックは `ai-repo-ops` 側で育てる。

### 2.2 MVPゴール

MVPでは以下のみ実装する。

```txt
aro init    # 初回展開
aro diff    # 更新差分の確認。実変更なし。
aro sync    # 中央配布物を対象repoへ同期
aro doctor  # 対象repoの状態診断
```

MVP完了時点で達成したい状態はこれ。

```txt
任意のGit repoに対して:
  aro init --repo .
  aro doctor --repo .
  aro diff --repo .
  aro sync --repo .

が安全に動き、managed fileの中央更新をchecksumベースで反映できる。
```

### 2.3 MVP非ゴール

MVPでは以下を実装しない。

```txt
LLM API呼び出し
AIがコードを自動修正する本体ループ
クラウドrunner実行基盤
複数repoへの一括PR作成
GitHub APIによるPR作成
GitHub App化
Web UI
Organization全体設定の自動変更
本番deploy連携
--to <version> による過去/未来version選択
remote GitHub sourceからのdistribution取得
3-way merge
managed fileの自動削除・rename migration
aro reset-managed
migration engine
examples一式の整備
```

---

## 3. 既存ツールとの関係

この計画は、テンプレート配布・更新という意味では Copier / Cruft と近い領域にある。

### 3.1 Copier / Cruftが解いている問題

- テンプレートからプロジェクトを生成する。
- 生成済みプロジェクトをテンプレート更新に追従させる。
- テンプレート由来の差分とプロジェクト側の差分を扱う。
- template repositoryのversionやcommitを追跡する。
- 一部ツールはconflict時に `.rej` やinline conflict markerを出せる。

### 3.2 それでもMVPで自作する理由

`ai-repo-ops` のMVPは汎用テンプレートエンジンではなく、AI運用基盤専用の薄い配布・検証ツールにする。

自作する理由は以下。

```txt
1. TypeScript / Node.jsでai-repo-ops全体を統一したい
2. 配布対象がprompts / policies / workflow / schemaに限定される
3. 既存repoへ部分的にoverlayしたい
4. .ai/managed / .ai/local / runtimeの境界を強制したい
5. checksum / lock / strategyをAI運用基盤向けに単純化したい
6. 将来のAI harness / telemetry / GitHub Actions連携と同じCLIに統合したい
```

### 3.3 再評価ポイント

次のどれかを実装する段階では、既存ツールをラップするか、自前実装を継続するかを再評価する。

```txt
3-way merge
テンプレート変数の再質問・再生成
複数version間migration
既存repoへのlink/adopt
大規模rollout
conflict marker / .rej 出力
```

MVPでは、既存ツールの完全な再実装はしない。

---

## 4. 基本設計

### 4.1 中央管理repo

```txt
ai-repo-ops/
  README.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json

  bin/
    aro

  distribution/
    base/
      manifest.yaml
      files/
        .ai/
          managed/
            prompts/
              review.md
              improve.md
              issue-fix.md
              release-check.md
            policies/
              default.yaml
              low-risk.yaml
              security.yaml
            schemas/
              project.schema.json
        .github/
          workflows/
            ai-review.yml
            ai-improve.yml

  schemas/
    project.schema.json              # doctorが使う authoritative schema。唯一の正。
    manifest.schema.json             # docs用。実装はzodでもよい。
    lockfile.schema.json             # docs用。実装はzodでもよい。

  scripts/
    sync-managed-schema.ts           # schemas/project.schema.json を distribution配布コピーへ同期する。
    compute-distribution-hash.ts     # CI/docs用のcontent hash確認補助。

  packages/
    aro-cli/
      package.json
      tsconfig.json
      src/
        main.ts
        commands/
          init.ts
          diff.ts
          sync.ts
          doctor.ts
        core/
          canonical-text.ts
          checksum.ts
          manifest.ts
          lockfile.ts
          filesystem.ts
          template.ts
          conflict.ts
          planner.ts
          apply.ts
          gitignore.ts
          gitattributes.ts
          doctor.ts
          paths.ts
          errors.ts
          source.ts
        types/
          manifest.ts
          lockfile.ts
          plan.ts
        __tests__/

  .github/
    workflows/
      ci.yml
      ai-review.reusable.yml
      ai-improve.reusable.yml

  docs/
    project-yaml.md
    distribution.md
    sync-strategy.md
    operations.md
    security.md
    existing-tools.md
```

### 4.2 対象repo側

```txt
product-repo/
  .ai/
    project.yaml                 # repo固有。syncでは上書き禁止。
    ai-repo-ops.lock.yaml        # aroが管理。
    managed/                     # aroが管理。直接編集禁止。
      prompts/
      policies/
      schemas/
    local/                       # repo固有。aroは触らない。
    runs/                        # gitignore。
    tmp/                         # gitignore。
    logs/                        # gitignore。

  .github/
    workflows/
      ai-review.yml              # 初回生成。以後原則preserve。
      ai-improve.yml             # 初回生成。以後原則preserve。

  .gitattributes                 # aroが必要行を追記。
  .gitignore                     # aroが必要行を追記。
  .prettierignore                # aroがmanaged file保護行を追記。
```

---

## 5. 設計原則

### 5.1 managed / local / runtime を分ける

```txt
.ai/project.yaml
  repo固有設定。
  init時に存在しなければ作る。
  syncでは上書きしない。

.ai/managed/**
  ai-repo-opsが管理する標準ファイル。
  原則として人間は直接編集しない。
  checksumで変更検出する。
  中央更新に追従する。

.ai/local/**
  repo固有の追加プロンプト、追加ポリシー、ドメイン知識。
  ai-repo-opsは絶対に上書きしない。

.ai/runs/**, .ai/tmp/**, .ai/logs/**
  実行結果や一時ファイル。
  gitignore対象。
```

### 5.2 変更は必ずplan経由にする

全ての破壊的操作は、まずplanを生成する。

```bash
aro diff --repo .
aro sync --repo . --dry-run
```

`aro sync` も内部では必ずplanを作る。

### 5.3 conflict時はatomic abort

conflictが1つでもあれば、MVPでは一切変更しない。

```txt
Sync aborted because conflicts were detected.
No files were modified.
```

partial apply、`.rej` 出力、inline conflict markerはMVPでは実装しない。

### 5.4 更新判定はversionではなくchecksumを正とする

`manifest.version` は人間向け表示・release管理のために使う。  
実際の更新判定は以下で行う。

```txt
source file canonical sha256
target file canonical sha256
lock fileに記録されたinstalled sha256
distribution content sha256
```

これにより、manifest versionのバンプ忘れがあっても `aro diff` は内容差分を検出できる。

### 5.5 workflow stubは薄く、中央reusable workflowを太くする

各repoの `.github/workflows/ai-review.yml` / `ai-improve.yml` は初回生成する。  
その後の改善は基本的に中央の reusable workflow 側で行う。

repo側workflowは、permissions、schedule、triggerにrepo固有調整が入りやすい。そのためMVPでは `create_only` とし、自動上書きしない。

---

## 6. 改行コード・checksum仕様

### 6.1 前提

MVPで扱う配布ファイルはUTF-8テキストのみ。binary fileは対象外。

### 6.2 canonical text

checksum計算前に、テキスト内容をcanonical formへ変換する。canonicalizationは、配布物・対象repoのmanaged file・lock fileに記録するinstalled checksumのすべてで同じ関数を使う。

```txt
1. bytesをUTF-8としてdecodeする
2. decode後の先頭文字が U+FEFF の場合だけ取り除く
3. CRLFをLFへ変換する
4. 単独CRをLFへ変換する
5. canonical textをUTF-8 bytesに戻す
6. SHA-256を計算する
```

BOM方針:

```txt
先頭UTF-8 BOMはstripする。
途中に現れるU+FEFFは通常の内容として扱い、stripしない。
aroが書き込むファイルはUTF-8 LF、BOMなしにする。
```

checksum mode名:

```txt
canonical_text_lf_utf8bom_strip_v1
```

疑似コード:

```ts
export function canonicalizeText(input: Buffer): Buffer {
  let text = input.toString("utf8");

  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }

  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return Buffer.from(normalized, "utf8");
}
```

### 6.3 checksum対象

```txt
manifest files[].src:
  sourceファイルをcanonicalizeしてsha256

target managed files:
  targetファイルをcanonicalizeしてsha256

lock file:
  installed_sha256にはcanonical sha256を記録
```

### 6.4 書き込み方針

`aro` がファイルを書き込むときはLFで書く。

```txt
source distribution file
  ↓ canonicalize to LF
write target file as UTF-8 LF without BOM
```

### 6.5 .gitattributes配布

`aro init` では `.gitattributes` に以下の行を追記する。

```gitattributes
# ai-repo-ops managed text files
.ai/managed/** text eol=lf
.ai/project.yaml text eol=lf
.ai/ai-repo-ops.lock.yaml text eol=lf
.github/workflows/ai-*.yml text eol=lf
```

既存 `.gitattributes` がある場合は、同一行がなければ追記する。既存行は書き換えない。

### 6.6 テスト必須ケース

```txt
1. target managed fileがCRLFでも内容が同じならconflictにならない
2. sourceがLF、targetがCRLF、lockがLF shaでもnoopになる
3. targetに実内容変更がある場合はCRLF/LFに関係なくconflictになる
4. syncで更新されたファイルはLFで書かれる
5. .gitattributesに必要行が重複なく追記される
6. 先頭UTF-8 BOMだけの差分ではconflictにならない
7. syncで更新されたファイルはBOMなしで書かれる
8. .prettierignoreに必要行が重複なく追記される
```

---

## 7. 技術スタック

MVPではTypeScriptでCLIを実装する。

```txt
Node.js 20以上
TypeScript strict mode
pnpm workspace
Vitest
```

主要ライブラリ案:

```txt
commander       CLIコマンド定義
zod             manifest / lock file / project yaml validation
yaml            YAML parse / stringify
execa           gitや外部コマンド実行
fast-glob       ファイル探索
fs-extra        ファイル操作
picocolors      CLI出力の色付け
diff            diff表示
vitest          test
tmp-promise     integration test用一時repo
```

標準APIで十分な箇所は標準APIを優先してよい。

---

## 8. CLI仕様

CLI名は `aro` とする。

```txt
aro = ai-repo-ops
```

### 8.1 共通オプション

```bash
aro <command> [options]

Options:
  --repo <path>                 対象repo path。省略時はcurrent working directory。
  --distribution <name>         distribution名。デフォルトbase。
  --source <path>               ai-repo-ops source path。MVPではlocal pathのみ。
  --dry-run                     実ファイル変更を行わない。
  --json                        JSONで結果出力。
  --verbose                     詳細ログ。
  --no-color                    色なし出力。
```

### 8.2 MVPで実装しないオプション

```txt
--to <version>
--from <version>
--remote <repo>
--ref <git-ref>
--force
--allow-partial
--conflict inline|rej
```

`--to` は将来、sourceをremote tag/commitから取得できるようになってから入れる。

---

## 9. distribution / manifest仕様

### 9.1 ファイル位置

```txt
distribution/base/manifest.yaml
```

### 9.2 strategy

MVPのstrategyは3つのみ。

```txt
managed_overwrite
  aro管理対象。
  lock上のinstalled shaと現在shaが一致すれば更新可能。
  一致しなければconflict。

create_only
  存在しない場合だけ作る。
  既存ならpreserve。

append_unique_lines
  指定行がなければ追記する。
  .gitignore / .gitattributes / .prettierignore に使う。
```

### 9.3 例

```yaml
schema_version: 1
name: base
version: 0.1.0

files:
  - src: files/.ai/managed/prompts/review.md
    dest: .ai/managed/prompts/review.md
    strategy: managed_overwrite

  - src: files/.ai/managed/prompts/improve.md
    dest: .ai/managed/prompts/improve.md
    strategy: managed_overwrite

  - src: files/.ai/managed/prompts/issue-fix.md
    dest: .ai/managed/prompts/issue-fix.md
    strategy: managed_overwrite

  - src: files/.ai/managed/prompts/release-check.md
    dest: .ai/managed/prompts/release-check.md
    strategy: managed_overwrite

  - src: files/.ai/managed/policies/default.yaml
    dest: .ai/managed/policies/default.yaml
    strategy: managed_overwrite

  - src: files/.ai/managed/policies/low-risk.yaml
    dest: .ai/managed/policies/low-risk.yaml
    strategy: managed_overwrite

  - src: files/.ai/managed/policies/security.yaml
    dest: .ai/managed/policies/security.yaml
    strategy: managed_overwrite

  - src: files/.ai/managed/schemas/project.schema.json
    dest: .ai/managed/schemas/project.schema.json
    strategy: managed_overwrite

seed_files:
  - dest: .ai/project.yaml
    template: project.yaml.hbs
    strategy: create_only

  - src: files/.github/workflows/ai-review.yml
    dest: .github/workflows/ai-review.yml
    strategy: create_only

  - src: files/.github/workflows/ai-improve.yml
    dest: .github/workflows/ai-improve.yml
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
      - ".ai/project.yaml text eol=lf"
      - ".ai/ai-repo-ops.lock.yaml text eol=lf"
      - ".github/workflows/ai-*.yml text eol=lf"

  - type: append_unique_lines
    path: .prettierignore
    lines:
      - "# ai-repo-ops managed files"
      - ".ai/managed/"
      - ".ai/ai-repo-ops.lock.yaml"

preserve:
  - .ai/project.yaml
  - .ai/local/**
  - .env
  - .env.*
  - secrets/**
```

### 9.4 validation rules

```txt
schema_version は必須
name は必須
version は必須。semver文字列
files[].src はdistribution rootからの相対path
files[].dest はrepo rootからの相対path
seed_files[].dest はrepo rootからの相対path
seed_files[] は strategy: create_only のみ
seed_files[] は src または template のどちらか一方だけを持つ。両方あり/両方なしは禁止
patches[].path はrepo rootからの相対path
絶対pathは禁止
.. を含むpathは禁止
symlink traversalは禁止
strategyは managed_overwrite | create_only | append_unique_lines のみ
preserveに該当するpathは managed_overwrite 対象にできない
src/templateはUTF-8 textとして読める必要がある
```

---

## 10. distribution content hash

versionだけではなく、distribution全体のcontent hashを計算する。v3では、実装者によってhashが揺れないよう、正規シリアライズ仕様を固定する。

### 10.1 目的

`distribution_content_sha256` は、source distributionの「対象repoに影響する配布payload」が変わったかを判定するためのhashである。

```txt
使う:
  aro diffでsource側distribution hashとlock側hashを比較する
  manifest.versionが同じでもhashが違えばsource content driftとして扱う
  rollout時に更新対象repoを検出する

使わない:
  manifest.versionの代替として人間向けrelease番号にする
  target repoの実ファイル状態を証明する
  create_only seed fileがtargetに適用済みであることを証明する
```

### 10.2 hash対象に含めるもの

hash対象は、対象repoへ配布・作成・追記され得るpayloadのみとする。

```txt
含める:
  distribution name
  manifest schema_version
  checksum mode
  managed files:
    dest
    strategy
    source canonical sha256
  seed files:
    dest
    strategy
    source kind: src | template
    source/template canonical sha256
  patches:
    type
    path
    lines

含めない:
  manifest.version
  manifestのコメント
  YAML key順
  manifest内エントリ順そのもの
  files[].src のpath文字列
  seed_files[].src / template のpath文字列
  source checkoutの絶対path
  created_at / updated_at
```

`manifest.version` をhashに含めない理由は、version bumpだけでcontent hashが変わると「内容は同じだがversionだけ違う」状態を内容差分として誤検出するためである。versionは表示・release管理、content hashはpayload差分検出に分離する。

### 10.3 正規payload構造

内部的には以下のようなpayload objectを作る。

```json
{
  "schema_version": 1,
  "distribution": "base",
  "checksum_mode": "canonical_text_lf_utf8bom_strip_v1",
  "managed_files": [
    {
      "dest": ".ai/managed/prompts/review.md",
      "strategy": "managed_overwrite",
      "sha256": "..."
    }
  ],
  "seed_files": [
    {
      "dest": ".ai/project.yaml",
      "strategy": "create_only",
      "source_kind": "template",
      "sha256": "..."
    }
  ],
  "patches": [
    {
      "type": "append_unique_lines",
      "path": ".gitignore",
      "lines": [".ai/runs/", ".ai/tmp/", ".ai/logs/"]
    }
  ]
}
```

### 10.4 正規化ルール

```txt
1. managed_files は dest 昇順でsortする
2. seed_files は dest 昇順でsortする
3. patches は type, path, JSON.stringify(lines) の昇順でsortする
4. object keyは再帰的にUTF-16 code unit昇順でsortする
5. JSONは余分な空白なしでstringifyする
6. stringify結果をUTF-8 bytesにする
7. SHA-256 hex lowercaseを計算する
```

`append_unique_lines.lines` の行順は実際の追記順に影響するため、lines配列の中身はsortしない。

疑似コード:

```ts
const CHECKSUM_MODE = "canonical_text_lf_utf8bom_strip_v1";

interface DistributionHashPayload {
  schema_version: 1;
  distribution: string;
  checksum_mode: typeof CHECKSUM_MODE;
  managed_files: Array<{
    dest: string;
    strategy: "managed_overwrite";
    sha256: string;
  }>;
  seed_files: Array<{
    dest: string;
    strategy: "create_only";
    source_kind: "src" | "template";
    sha256: string;
  }>;
  patches: Array<{
    type: "append_unique_lines";
    path: string;
    lines: string[];
  }>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return `{${entries
      .map(([key, val]) => `${JSON.stringify(key)}:${stableJson(val)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function computeDistributionContentSha256(payload: DistributionHashPayload): string {
  return sha256(Buffer.from(stableJson(payload), "utf8"));
}
```

### 10.5 用途

```txt
lock fileに前回同期したdistribution_content_sha256を記録する
aro diffでsource側distribution hashとlock側hashを比較する
manifest.versionが同じでもhashが違えば差分ありとして扱う
versionが同じでhashが違う場合はWARNを出す
```

表示例:

```txt
Current lock:
  version: 0.1.0
  content: 8c8f7a...

Source distribution:
  version: 0.1.0
  content: d92a41...

WARN  manifest version is unchanged, but distribution content changed.
      Consider bumping manifest.version before release.
```

### 10.6 seed file変更の扱い

`seed_files` は `create_only` なので、既存repoでは自動上書きされない。それでもseed fileのsource/template内容は `distribution_content_sha256` に含める。

理由:

```txt
新規repoに配布される初期状態は変わっているため、distribution payloadとしては変化している
既存repoではpreserveになるが、lockのdistribution_content_sha256を更新することで「このrepoは新しいsource distributionを確認済み」と表現できる
```

`aro diff` は、seed file変更が既存repoに適用されない場合、以下のように表示する。

```txt
Distribution content changed, but existing create_only files are preserved.

Preserved:
  = .ai/project.yaml
  = .github/workflows/ai-review.yml
```

## 11. lock file仕様

### 11.1 ファイル位置

```txt
.ai/ai-repo-ops.lock.yaml
```

### 11.2 例

```yaml
schema_version: 1

source:
  repository: yamk12nfu/ai-repo-ops
  distribution: base
  version: 0.1.0
  commit: null
  distribution_content_sha256: 8c8f7aa0...

checksum:
  algorithm: sha256
  mode: canonical_text_lf_utf8bom_strip_v1

managed_files:
  - path: .ai/managed/prompts/review.md
    source: distribution/base/files/.ai/managed/prompts/review.md
    installed_sha256: 2e7d2c03a9507ae265ecf5b5356885a53393a2029d241c9b6d6e24eaf5ecf31a
    strategy: managed_overwrite

  - path: .ai/managed/policies/default.yaml
    source: distribution/base/files/.ai/managed/policies/default.yaml
    installed_sha256: 51b0a1...
    strategy: managed_overwrite

seed_files:
  - path: .ai/project.yaml
    strategy: create_only

  - path: .github/workflows/ai-review.yml
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
      - ".ai/project.yaml text eol=lf"
      - ".ai/ai-repo-ops.lock.yaml text eol=lf"
      - ".github/workflows/ai-*.yml text eol=lf"

  - type: append_unique_lines
    path: .prettierignore
    lines:
      - "# ai-repo-ops managed files"
      - ".ai/managed/"
      - ".ai/ai-repo-ops.lock.yaml"

created_at: "2026-06-28T00:00:00.000Z"
updated_at: "2026-06-28T00:00:00.000Z"
```

### 11.3 注意

- lock fileはaro管理。
- 人間が手編集しない。
- doctorはlock file schemaを検証する。
- lock file自体の改行もLFで書く。

---

## 12. project.yaml初期テンプレート

生成先:

```txt
.ai/project.yaml
```

初期内容:

```yaml
schema_version: 1

project:
  name: "{{ repo_name }}"
  type: "generic"
  risk_level: "medium"
  owner: "unknown"

runtime:
  devcontainer: null

commands:
  setup: ""
  lint: ""
  typecheck: ""
  test: ""
  build: ""

quality_gates:
  required:
    - lint
    - test

ai:
  max_loops: 4
  max_changed_files: 10
  allowed_paths:
    - "src/**"
    - "tests/**"
    - "docs/**"
  forbidden_paths:
    - ".env"
    - "secrets/**"
    - "infra/prod/**"
    - ".github/workflows/**"

review:
  create_pr: true
  require_human_review: true
  auto_merge: false

evals: {}
```

`commands` の空文字は `doctor` でWARNにする。初回init時点では言語やFWが不明なためFAILにはしない。

---

## 13. workflow stub

workflow stubは `create_only` で初回生成する。  
後続更新は自動上書きしない。

### 13.1 `.github/workflows/ai-review.yml`

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  issues: write

jobs:
  ai_review:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@v1
    with:
      config_path: ".ai/project.yaml"
      lock_path: ".ai/ai-repo-ops.lock.yaml"
```

### 13.2 `.github/workflows/ai-improve.yml`

```yaml
name: AI Improve

on:
  workflow_dispatch:
  schedule:
    - cron: "0 18 * * 1"

permissions:
  contents: write
  pull-requests: write
  issues: write

jobs:
  ai_improve:
    uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-improve.reusable.yml@v1
    with:
      config_path: ".ai/project.yaml"
      lock_path: ".ai/ai-repo-ops.lock.yaml"
      mode: "maintenance"
```

### 13.3 doctorで見ること

```txt
workflow fileが存在するか
central reusable workflowを呼んでいるか
参照が @main になっていないか
permissionsが極端に過剰でないか
ai-reviewにcontents:writeがないか
ai-improveがcontents:writeを持つ場合はWARNに留める
```

---

## 14. reusable workflow本体のMVP

MVPではAI改善はまだ行わない。呼び出しが成立するstub workflowにする。

### 14.1 `.github/workflows/ai-review.reusable.yml`

```yaml
name: Reusable AI Review

on:
  workflow_call:
    inputs:
      config_path:
        required: true
        type: string
      lock_path:
        required: false
        type: string
        default: ".ai/ai-repo-ops.lock.yaml"

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4

      - name: Print AI review context
        run: |
          echo "AI Review stub"
          echo "config_path=${{ inputs.config_path }}"
          echo "lock_path=${{ inputs.lock_path }}"

      - name: Validate config presence
        run: |
          test -f "${{ inputs.config_path }}"
```

### 14.2 `.github/workflows/ai-improve.reusable.yml`

```yaml
name: Reusable AI Improve

on:
  workflow_call:
    inputs:
      config_path:
        required: true
        type: string
      lock_path:
        required: false
        type: string
        default: ".ai/ai-repo-ops.lock.yaml"
      mode:
        required: false
        type: string
        default: "maintenance"

jobs:
  improve:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
    steps:
      - uses: actions/checkout@v4

      - name: Print AI improve context
        run: |
          echo "AI Improve stub"
          echo "config_path=${{ inputs.config_path }}"
          echo "lock_path=${{ inputs.lock_path }}"
          echo "mode=${{ inputs.mode }}"

      - name: Validate config presence
        run: |
          test -f "${{ inputs.config_path }}"
```

---

## 15. sync plan内部表現

```ts
export type ChangeKind =
  | "create"
  | "update"
  | "append_unique_lines"
  | "preserve"
  | "orphaned"
  | "conflict"
  | "noop";

export type ChangeStrategy =
  | "managed_overwrite"
  | "create_only"
  | "append_unique_lines";

export interface SyncChange {
  kind: ChangeKind;
  path: string;
  strategy?: ChangeStrategy;
  reason?: string;
  beforeSha256?: string | null;
  installedSha256?: string | null;
  afterSha256?: string | null;
  sourcePath?: string;
  lines?: string[];
}

export interface SyncPlan {
  repoRoot: string;
  distribution: string;
  currentVersion: string | null;
  targetVersion: string;
  currentDistributionSha256: string | null;
  targetDistributionSha256: string;
  versionUnchangedButContentChanged: boolean;
  changes: SyncChange[];
  hasConflicts: boolean;
  warnings: string[];
}
```

---

## 16. conflict判定アルゴリズム

### 16.1 managed_overwrite

```txt
対象ファイルが存在しない:
  create

対象ファイルが存在する & lockに記録がない:
  conflict

対象ファイルの現在canonical sha == lockのinstalled_sha256:
  source canonical sha == lock installed_sha256:
    noop
  source canonical sha != lock installed_sha256:
    update可能

対象ファイルの現在canonical sha != lockのinstalled_sha256:
  人間が変更した可能性があるためconflict
```

### 16.2 create_only

```txt
対象ファイルが存在しない:
  create

対象ファイルが存在する:
  preserve
```

### 16.3 append_unique_lines

```txt
対象ファイルが存在しない:
  create with lines

対象ファイルが存在する:
  まだ存在しない行だけ追記
```

行比較はLF正規化後に行単位で行う。既存行の順序やコメントは保持する。


### 16.4 orphaned managed file

lock fileに記録されているmanaged fileが、現在のsource manifestの `files[].dest` に存在しない場合は `orphaned` として扱う。

MVPでは自動削除しない。

```txt
lockにある & manifestにない:
  orphaned WARN
  syncでは削除しない
  lockからも自動削除しない
```

表示例:

```txt
Orphaned managed files:
  ? .ai/managed/prompts/old-review.md
    reason: present in lock file but no longer present in source manifest
    action: not deleted in MVP
```

自動削除・rename追従はPost-MVP Phase A/Bで扱う。

---

## 17. コマンド仕様

## 17.1 `aro init`

目的: 対象repoにAI運用基盤ファイルを初回展開する。

```bash
aro init --repo /path/to/product-repo --distribution base
```

処理内容:

```txt
1. 対象repo pathを解決する
2. Git repoか確認する
3. source pathを解決する
4. distribution/base/manifest.yaml を読む
5. manifest validation
6. distribution content hashを計算する
7. .ai/project.yaml がなければ生成する
8. .ai/managed/** を生成する
9. .github/workflows/ai-review.yml がなければ生成する
10. .github/workflows/ai-improve.yml がなければ生成する
11. .gitignore にruntime ignore行を追記する
12. .gitattributes にLF固定行を追記する
13. .prettierignore にmanaged file保護行を追記する
14. .ai/ai-repo-ops.lock.yaml を生成する
15. 結果サマリを表示する
```

エラー条件:

```txt
対象pathが存在しない
対象pathがGit repoではない
manifestが壊れている
path traversalが検出された
.ai/ai-repo-ops.lock.yaml が既にある
managed_overwrite対象に既存ファイルがある
```

`--force` はMVPでは実装しない。

## 17.2 `aro diff`

目的: 同期した場合に何が変わるかを表示する。

```bash
aro diff --repo /path/to/product-repo --distribution base
```

処理内容:

```txt
1. lock fileを読む
2. source manifestを読む
3. distribution content hashを計算する
4. managed filesの現在canonical checksumを計算する
5. lock checksumと比較する
6. source checksumと比較する
7. update planを作る
8. human-readable diffを表示する
9. --jsonならmachine-readable planを出力する
```

期待出力:

```txt
ai-repo-ops diff

Repo:         /path/to/product-repo
Distribution: base
Current:      version=0.1.0 content=8c8f7a...
Target:       version=0.1.0 content=d92a41...

WARN  manifest version is unchanged, but distribution content changed.

Will update:
  M .ai/managed/prompts/review.md
  M .ai/managed/policies/default.yaml

Will append lines:
  M .gitattributes
    + .ai/managed/** text eol=lf

Conflicts:
  ! .ai/managed/prompts/improve.md
    reason: locally modified since last sync

Preserved:
  = .ai/project.yaml
  = .github/workflows/ai-review.yml
  = .github/workflows/ai-improve.yml
```

終了コード:

通常モード:

```txt
0: plan生成成功。差分なし、または差分ありだがconflictなし
1: validation error
2: conflictあり
3: unexpected error
```

`--detailed-exitcode` 指定時:

```txt
0: 差分なし、conflictなし
1: validation error
2: 更新あり、conflictなし
3: conflictあり
4: unexpected error
```

CI / rollout / drift検出では `--detailed-exitcode` を使う。人間がローカルで確認する通常利用では、更新予定があるだけでcommand failure扱いにしない。

## 17.3 `aro sync`

目的: 中央配布物を対象repoに適用する。

```bash
aro sync --repo /path/to/product-repo --distribution base
```

処理内容:

```txt
1. aro diff と同じplanを作る
2. conflictがあれば適用せず停止する
3. create/update/appendを適用する
4. lock fileを更新する
5. 結果サマリを表示する
```

atomicity:

```txt
conflictが1つでもあればファイルは変更しない
apply前に全変更内容をmemory上で準備する
一時backup fileはMVPでは作らない
書き込み順序は通常ファイル -> patch対象 -> lock file
lock fileは最後に書く
```

MVPのatomicity保証は2段階に分ける。

```txt
1. conflict atomicity
   conflictがある場合はapply前にabortし、対象repoには一切書き込まない。
   これは必須保証。

2. I/O failure rollback
   書き込み中のdisk errorやpermission errorは稀だが、発生時はtouched pathsを表示する。
   tracked fileは git restore、new fileは削除で復旧できるようにする。
   aro自身は複雑なbackup/restore機構をMVPでは持たない。
```

失敗時の表示例:

```txt
ERROR apply failed while writing .ai/managed/prompts/review.md

Touched paths:
  .ai/managed/prompts/review.md
  .gitattributes

Suggested recovery:
  git restore -- .ai/managed/prompts/review.md .gitattributes
  git clean -fd -- .ai/tmp/
```

`init` は新規ファイル作成が中心なので、失敗時はcreated pathsを表示し、人間が `rm` / `git clean` で戻せるようにする。

期待出力:

```txt
ai-repo-ops sync

Repo:         /path/to/product-repo
Distribution: base
From:         version=0.1.0 content=8c8f7a...
To:           version=0.1.0 content=d92a41...

Applied:
  M .ai/managed/prompts/review.md
  M .ai/managed/policies/default.yaml
  M .gitattributes

Updated lock file:
  M .ai/ai-repo-ops.lock.yaml

Done.
```

## 17.4 `aro doctor`

目的: 対象repoが `ai-repo-ops` に正しく参加できているか診断する。

```bash
aro doctor --repo /path/to/product-repo
```

チェック項目:

```txt
Repository:
  - Git repoである
  - working treeが取得できる

.ai:
  - .ai/project.yaml が存在する
  - .ai/project.yaml が中央source schemaに合っている
  - .ai/ai-repo-ops.lock.yaml が存在する
  - lock fileがschemaに合っている
  - .ai/managed/** のchecksumがlockと一致する
  - lockにあるがmanifestにないmanaged fileをorphanedとしてWARNする
  - managed checksum mismatch時は git restore による復旧手順を表示する
  - .ai/local/** は存在してもしなくてもよい

Schema:
  - doctor validationは中央source schemaを使う
  - .ai/managed/schemas/project.schema.json はchecksum検証だけ行う

GitHub Actions:
  - .github/workflows/ai-review.yml が存在する
  - .github/workflows/ai-improve.yml が存在する
  - reusable workflow呼び出しが含まれている
  - @main参照ならWARN
  - ai-reviewにcontents:writeがあればFAILまたはWARN
  - ai-improveのcontents:writeはWARN

Runtime / formatter ignore:
  - .ai/runs/
  - .ai/tmp/
  - .ai/logs/
  - .prettierignore に .ai/managed/ がある
  - .prettierignore に .ai/ai-repo-ops.lock.yaml がある

Line endings:
  - .gitattributesに必要行がある

Commands:
  - project.yamlにcommands.setup/lint/test/build等が定義されている
  - required quality gatesがcommandsに存在する
  - 空文字commandはWARN
```

期待出力:

```txt
ai-repo-ops doctor

Repo: /path/to/product-repo

PASS  .ai/project.yaml exists
PASS  project schema is valid using source schema
PASS  lock file exists
PASS  managed file checksums are valid
PASS  .gitattributes has LF rules
PASS  ai-review workflow exists
WARN  ai-improve workflow has contents:write permission
      This is expected for improve mode, but keep branch protection enabled.
FAIL  required command "typecheck" is listed in quality_gates but missing in commands

Summary:
  6 passed
  1 warning
  1 failed
```

終了コード:

```txt
0: failなし
1: failあり
3: unexpected error
```

---

## 18. 実装フェーズ

## Phase 0: リポジトリ初期化

タスク:

```txt
package.json 作成
pnpm-workspace.yaml 作成
packages/aro-cli 作成
TypeScript設定
Vitest設定
bin/aro 作成
aro --help が動く状態にする
```

完了条件:

```bash
pnpm install
pnpm build
pnpm test
pnpm aro --help
```

## Phase 1: path safety / canonical checksum

タスク:

```txt
path traversal防止utility
safe relative path resolver
symlink detection
canonical text utility
sha256 utility
LF write utility
.gitattributes append utility
.gitignore append utility
.prettierignore append utility
```

完了条件:

```txt
.. を含むdestが拒否される
絶対pathが拒否される
CRLFとLFの同一内容が同じchecksumになる
実内容変更はchecksum差分になる
write utilityがLF+BOMなしで書く
append utilityが重複行を作らない
先頭UTF-8 BOMだけの差分が同一checksumになる
```

## Phase 2: manifest / lockfile / source loader

タスク:

```txt
manifest schemaをzodで定義
lock file schemaをzodで定義
YAML read/write utility
source path resolver
distribution loader
distribution content hash計算
stable JSON serialization
lockfile loader / writer
```

完了条件:

```txt
壊れたmanifestでvalidation errorになる
manifest内の全src存在を検証できる
lock fileを読み書きして内容が維持される
version同一でもcontent hash差分を検出できる
manifestのエントリ順やYAMLコメントではcontent hashが変わらない
manifest.versionだけを変えてもcontent hashが変わらない
```

## Phase 3: distribution/base作成

タスク:

```txt
distribution/base/manifest.yaml 作成
prompts作成
policies作成
source authoritative schemas/project.schema.json 作成
managed copy用 project.schema.json はsource schemaから生成する
schema copy scriptを作成する
workflow stub作成
reusable workflow stub作成
```

完了条件:

```txt
manifest内の全srcが存在する
manifest validationが通る
schema validationが通る
```

## Phase 4: sync planner / aro diff

タスク:

```txt
lock fileとmanifestからsync plan生成
managed_overwrite判定
create_only判定
append_unique_lines判定
human-readable diff出力
JSON出力
exit code制御
--detailed-exitcode制御
orphaned managed file WARN
```

完了条件:

```txt
差分なし
中央ファイルだけ更新された
対象repoのmanaged fileが人間に編集された
新しいmanaged fileが追加された
.gitignoreに追記が必要
.gitattributesに追記が必要
create_only対象が既に存在する
CRLF差分だけではconflictにならない
```

をtestで網羅する。

## Phase 5: aro init / aro sync

タスク:

```txt
repo root解決
Git repo確認
seed template生成
managed files copy
workflow stub create_only生成
.gitignore append
.gitattributes append
.prettierignore append
lock file生成
sync plan適用
conflict時atomic abort
I/O failure時のtouched paths表示
dry-run対応
CLI出力整形
unit test / integration test
```

完了条件:

```txt
initで期待ファイルが生成される
syncでmanaged filesが更新される
sync後にlock fileが更新される
conflictありならファイルが一切変更されない
sync後にdiffすると差分なしになる
```

## Phase 6: aro doctor

タスク:

```txt
project.yaml存在チェック
中央source schemaによるvalidation
lock file validation
managed file checksum検証
workflow存在チェック
workflow content簡易チェック
.gitattributesチェック
.gitignoreチェック
.prettierignoreチェック
orphaned managed fileチェック
commands / quality_gates整合性チェック
PASS/WARN/FAIL出力
JSON出力
```

完了条件:

```txt
正常repoではexit code 0
required command不足ではFAIL
managed file改変ではFAIL
空のcommandsはWARN
target repo内のschema改変では検証結果が影響を受けない
```

## Phase 7: 最小docs

MVPに必要なdocsだけ作る。

```txt
README.md
docs/distribution.md
docs/sync-strategy.md
docs/security.md
docs/existing-tools.md
```

examplesはMVP DoDから外す。

---

## 19. テスト計画

### 19.1 unit test

```txt
canonical-text.ts
checksum.ts
manifest.ts
lockfile.ts
paths.ts
gitignore.ts
gitattributes.ts
planner.ts
conflict.ts
source.ts
```

### 19.2 integration test

一時ディレクトリにGit repoを作り、CLIを実行する。

```txt
init creates expected files
init is blocked when lock exists
sync updates managed files
sync aborts on conflict
sync updates lock file
sync preserves project.yaml
sync preserves .ai/local/**
sync preserves workflow stubs after creation
diff returns conflict exit code
diff --detailed-exitcode returns 0/2/3 appropriately
doctor detects missing commands
doctor detects checksum mismatch
doctor warns orphaned managed files
doctor validates project.yaml using source schema
```

### 19.3 改行コードtest

```txt
managed fileがCRLFでも内容同一ならnoop
managed fileがCRLF + 内容変更ならconflict
sync更新後のmanaged fileはLF
.gitattributes必要行が追記される
.gitattributes重複追記されない
先頭UTF-8 BOMだけではconflictにならない
sync更新後のmanaged fileはBOMなし
.prettierignore必要行が追記される
.prettierignore重複追記されない
```

### 19.4 snapshot test

CLI出力はsnapshot化しすぎるとメンテが重い。主要な見出し、change count、exit codeだけ検証する。

### 19.5 手動検証

```bash
mkdir /tmp/aro-test
cd /tmp/aro-test
git init
aro init --repo .
aro doctor --repo .
aro diff --repo .
aro sync --repo .
git diff
```

---

## 20. セキュリティ要件

### 20.1 path traversal防止

manifestの `src` / `dest` / patch path は必ずsafe path validationを通す。

禁止:

```txt
/path/to/file
../file
.ai/../../.ssh/config
```

### 20.2 symlink

MVPではsymlinkは追従しない。

```txt
対象pathまたは親pathにsymlinkがある場合はerror
source distribution内のsymlinkもerror
```

### 20.3 preserve path保護

以下はsync対象にしてはいけない。

```txt
.env
.env.*
secrets/**
.ai/local/**
.ai/project.yaml  # create_only以外禁止
```

### 20.4 workflow permissions

配布するworkflowではpermissionsを明示する。

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write
```

`ai-improve` はPR作成のために `contents: write` が必要になる想定だが、mainへの直接pushは禁止する運用前提にする。

### 20.5 token / secret

MVPではsecretを扱わない。将来reusable workflowへsecretsを渡す場合は、明示的な `workflow_call.secrets` のみ許可し、`secrets: inherit` は原則避ける。

---

## 21. リリース運用

### 21.1 versioning

`ai-repo-ops` はsemverでtagを切る。

```txt
v0.1.0: init / diff / sync / doctor MVP
v0.2.0: 3-way merge検討またはlimited merge
v0.3.0: rollout local clone対応
v0.4.0: GitHub PR作成対応
v0.5.0: migrations対応
v1.0.0: schema安定化
```

### 21.2 workflow参照

対象repoのworkflowは中央reusable workflowをtag参照する。

```yaml
uses: yamk12nfu/ai-repo-ops/.github/workflows/ai-review.reusable.yml@v1
```

`@main` はdoctorでWARNにする。

### 21.3 manifest versionとcontent hash

```txt
manifest.version:
  人間向けrelease表示

distribution_content_sha256:
  実際の同期判定
```

version bump忘れがあっても差分検出はできる。  
ただしrelease時にはversion bumpを要求する運用にする。

---

## 22. MVP後の拡張計画

## Post-MVP Phase A: 3-way merge / conflict支援

「managed fileを少し触ったら永久conflict」問題への対策。

候補:

```txt
git merge-fileを使った3-way merge
inline conflict marker
.rej出力
aro reset-managed --path <path>
aro explain-conflict
managed fileからlocal overrideへの移行支援
managed file delete / rename migration
```

この段階でCopier / Cruftのラップも再評価する。

## Post-MVP Phase B: aro rollout

複数repoに一括同期PRを出す。

```bash
aro rollout --target v0.3.0
```

必要なもの:

```txt
registry/repos.yaml
GitHub token
clone/update branch
commit
push
PR作成
結果レポート
```

PRタイトル:

```txt
chore(ai-repo-ops): sync ai repo ops files
```

## Post-MVP Phase C: migrations

schema変更を自動移行する。

```bash
aro upgrade --repo .
```

例:

```txt
quality_gates.required -> gates.required
ai.max_loops -> loop.max_iterations
```

## Post-MVP Phase D: AI harness統合

`ai-review.reusable.yml` と `ai-improve.reusable.yml` から実際にharnessを呼ぶ。

```bash
aro-harness review --config .ai/project.yaml
aro-harness improve --config .ai/project.yaml --mode maintenance
```

## Post-MVP Phase E: telemetry

AI改善ジョブの結果を蓄積する。

```txt
run id
repo
mode
duration
commands executed
pass/fail
changed files
PR URL
risk level
```

---

## 23. 実装者向け作業指示

### 23.1 進め方

```txt
1. MVPのみ実装する
2. 既存のdark-part-time-jobの思想は参考にするがコードコピーはしない
3. すべてのファイル更新はplan生成を経由する
4. conflict時はatomic abortする
5. path validationを最初に実装する
6. 改行正規化、BOM strip、checksumを早期に固める
7. --to はMVPでは実装しない
8. merge_or_conflict はMVPでは実装しない
9. workflow stubはcreate_onlyにする
10. doctorは中央source schemaでproject.yamlを検証する
11. CLI出力は人間が読んで判断できるようにする
12. testを先に作れる箇所は先に作る
13. 破壊的な --force は実装しない
14. distribution_content_sha256は正規payloadから計算し、manifest.versionを含めない
15. diffのautomation用途は --detailed-exitcode で扱う
16. managed file直接編集の復旧導線をdocsとdoctor出力に含める
```

### 23.2 実装順序

```txt
1. repo scaffold
2. path safety
3. canonical text / checksum
4. manifest / lockfile schemas
5. source / distribution loader
6. distribution content hash canonical serialization
7. distribution files and generated schema copy
8. sync planner
9. diff command
10. init command
11. sync command
12. doctor command
13. tests
14. docs
```

### 23.3 品質基準

```txt
TypeScript strict modeを有効にする
例外は握りつぶさない
CLIエラーは人間が解決できるメッセージにする
ファイル変更前に必ず親ディレクトリを作成する
Windows path separatorに依存しない
symlinkはMVPでは追従しない
binary fileはMVPでは対象外
```

---

## 24. Definition of Done

MVP完了条件:

```txt
[ ] pnpm install が成功する
[ ] pnpm build が成功する
[ ] pnpm test が成功する
[ ] aro --help が表示される
[ ] aro init --repo <empty-git-repo> が成功する
[ ] initで期待ファイルが生成される
[ ] .gitattributesにLF固定行が追記される
[ ] .prettierignoreにmanaged file保護行が追記される
[ ] lock fileにmanaged file canonical checksumが記録される
[ ] aro diff が差分なしを検出できる
[ ] 中央配布ファイル更新後、aro diff が更新予定を表示できる
[ ] manifest versionが同じでもcontent hash差分で更新予定を表示できる
[ ] manifest.versionだけを変えてもcontent hashが変わらない
[ ] manifestのコメントやエントリ順変更だけではcontent hashが変わらない
[ ] aro diff --detailed-exitcode が差分なし=0、更新あり=2、conflict=3を返す
[ ] aro sync がmanaged filesを更新できる
[ ] sync後にlock fileが更新される
[ ] CRLF差分だけではconflictにならない
[ ] 先頭UTF-8 BOMだけではconflictにならない
[ ] 対象repo側でmanaged fileを実編集するとconflict検出できる
[ ] conflict時にsyncが対象repoを変更しない
[ ] workflow stubは既存ならpreserveされる
[ ] aro doctor が正常repoをPASSできる
[ ] aro doctor が壊れたrepoをFAILできる
[ ] aro doctor が中央source schemaでproject.yamlを検証する
[ ] orphaned managed fileをWARNできるが自動削除しない
[ ] READMEに基本利用手順がある
[ ] READMEにmanaged file誤編集時の復旧手順がある
[ ] docsにmanifest / lockfile / sync strategy / existing tools comparisonの説明がある
```

---

## 25. 受け入れテストシナリオ

### Scenario 1: 新規repo参加

```bash
mkdir /tmp/product-a
cd /tmp/product-a
git init
aro init --repo .
aro doctor --repo .
git status --short
```

期待:

```txt
.ai/project.yaml が生成される
.ai/ai-repo-ops.lock.yaml が生成される
.ai/managed/** が生成される
.github/workflows/** が生成される
.gitignore が更新される
.gitattributes が更新される
.prettierignore が更新される
doctorが大きなFAILなしで完了する
```

### Scenario 2: 中央プロンプト更新

```bash
# ai-repo-ops側で distribution/base/files/.ai/managed/prompts/review.md を変更
aro diff --repo /tmp/product-a
aro sync --repo /tmp/product-a
aro diff --repo /tmp/product-a
```

期待:

```txt
最初のdiffでreview.mdの更新が表示される
syncで更新される
2回目のdiffで差分なしになる
manifest.versionが同じでもcontent hash差分で検出される
aro diff --detailed-exitcode は更新ありでexit code 2を返す
```

### Scenario 3: 人間がmanaged fileを実編集

```bash
echo "local edit" >> /tmp/product-a/.ai/managed/prompts/review.md
aro diff --repo /tmp/product-a
aro sync --repo /tmp/product-a
```

期待:

```txt
diffでconflict表示
syncはabort
ファイルは変更されない
doctorまたはdiffが git restore -- .ai/managed/prompts/review.md による復旧を案内する
```

### Scenario 4: CRLF差分だけ

```bash
# .ai/managed/prompts/review.md をCRLFに変換。ただし内容は同じ。
aro diff --repo /tmp/product-a
```

期待:

```txt
CRLF差分だけではconflictにならない
内容が同じならnoopになる
```

### Scenario 5: project.yamlは保持される

```bash
# .ai/project.yaml をrepo固有に編集
aro sync --repo /tmp/product-a
```

期待:

```txt
.ai/project.yaml は上書きされない
```

### Scenario 6: workflow stubは保持される

```bash
# .github/workflows/ai-improve.yml のscheduleをrepo固有に変更
aro sync --repo /tmp/product-a
```

期待:

```txt
.github/workflows/ai-improve.yml は上書きされない
doctorは必要に応じてWARNする
```

### Scenario 7: target repo内schema改変

```bash
echo '{}' > /tmp/product-a/.ai/managed/schemas/project.schema.json
aro doctor --repo /tmp/product-a
```

期待:

```txt
managed schema checksum mismatchはFAIL
project.yaml validation自体は中央source schemaで行われる
```


### Scenario 8: BOM差分だけ

```bash
# .ai/managed/prompts/review.md の先頭にUTF-8 BOMを付ける。ただし内容は同じ。
aro diff --repo /tmp/product-a
```

期待:

```txt
先頭UTF-8 BOM差分だけではconflictにならない
内容が同じならnoopになる
```

### Scenario 9: managed file削除がsourceから発生

```bash
# ai-repo-ops側で、以前配布していた .ai/managed/prompts/old.md をmanifestから削除する
aro diff --repo /tmp/product-a
aro doctor --repo /tmp/product-a
```

期待:

```txt
old.md は自動削除されない
orphaned managed fileとしてWARNされる
MVPでは自動削除・rename migrationは非対応であることが表示される
```

---

## 26. READMEに載せる最小例

````md
# ai-repo-ops

AI-assisted repository operations toolkit.

## Install

```bash
pnpm install
pnpm build
pnpm link --global
```

## Initialize a repository

```bash
aro init --repo /path/to/your-repo
```

## Check status

```bash
aro doctor --repo /path/to/your-repo
```

## Preview updates

```bash
aro diff --repo /path/to/your-repo
```

## Apply updates

```bash
aro sync --repo /path/to/your-repo
```
````

---

## 27. 将来の完成イメージ

最終的には以下の運用になる。

```txt
1. ai-repo-opsで配布物・プロンプト・policy・workflowを改善する
2. tagを切る
3. aro rolloutで各repoへ同期PRを作る
4. 各repoのCIが検証する
5. 人間がPRをmergeする
6. 各repoのAI運用基盤が更新される
7. その改善結果をまたai-repo-opsに反映する
```

この構造により、各repoは個別に進化しながら、AIで育てるための装備だけを中央で継続的に磨き上げられる。


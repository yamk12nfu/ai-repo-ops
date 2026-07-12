# Distribution / Manifest

`ai-repo-ops` が対象 repo へ配布する内容は、すべて `distribution/<name>/manifest.yaml` で宣言する。このドキュメントは manifest の構造、各 strategy の意味、distribution content hash の仕組みをまとめる。実装は `packages/aro-cli/src/core/manifest.ts`（zod schema）・`packages/aro-cli/src/core/source.ts`（distribution loader）・`packages/aro-cli/src/core/distribution-hash.ts`（content hash）にある。

## ディレクトリ構造

```txt
distribution/
  base/                                 # distribution 名 = ディレクトリ名（manifest.name と一致必須）
    manifest.yaml
    project.yaml.hbs                    # seed_files の template
    files/
      .ai/
        managed/
          prompts/*.md                      # knowledge-refresh.mdを含む
          policies/*.yaml
          schemas/
            project.schema.json             # authoritative schema のコピー（後述）
            knowledge.schema.json
      .github/
        workflows/
          ai-review.yml
```

`--distribution` オプション（デフォルト `base`）で `distribution/<name>/` を選択する。distribution 名は単一セグメントで、先頭は英数字・`_`・`-` のいずれか（先頭ドットは不可）、2 文字目以降は英数字・`.`・`_`・`-` を許可する（`assertValidDistributionName`）。`manifest.yaml` の `name` フィールドとディレクトリ名は一致していなければならない（不一致は `DISTRIBUTION_NAME_MISMATCH` エラー）。

## manifest.yaml の構造

```yaml
schema_version: 1
name: base
version: 0.1.0

files: [...]        # managed_overwrite
seed_files: [...]   # create_only
patches: [...]      # append_unique_lines
preserve: [...]      # managed_overwrite 対象にできない glob
```

| フィールド | 必須 | 説明 |
| --- | --- | --- |
| `schema_version` | ○ | 現在は `1` のみ許可。 |
| `name` | ○ | distribution 名。ディレクトリ名と一致必須。 |
| `version` | ○ | semver 文字列（`major.minor.patch[-pre][+build]`）。人間向け release 表示に使う（§10 参照、更新判定には使わない）。 |
| `files[]` | - | `managed_overwrite` エントリ。省略時 `[]`。 |
| `seed_files[]` | - | `create_only` エントリ。省略時 `[]`。 |
| `patches[]` | - | `append_unique_lines` エントリ。省略時 `[]`。 |
| `preserve[]` | - | `files[].dest` に使えない glob パターン一覧。省略時 `[]`。 |

## strategy

MVP の strategy は 3 つのみ。挙動の詳細（conflict 判定含む）は [`sync-strategy.md`](./sync-strategy.md) を参照。

### `managed_overwrite`（`files[]`）

```yaml
- src: files/.ai/managed/prompts/review.md
  dest: .ai/managed/prompts/review.md
  strategy: managed_overwrite
```

- `aro` が管理する。対象 repo 側での直接編集は禁止（編集すると `aro diff` / `aro sync` が conflict と判定する）。
- `src` は distribution root（`distribution/<name>/`）からの相対 path、`dest` は repo root からの相対 path。

### `create_only`（`seed_files[]`）

```yaml
- dest: .ai/project.yaml
  template: project.yaml.hbs
  strategy: create_only

- src: files/.github/workflows/ai-review.yml
  dest: .github/workflows/ai-review.yml
  strategy: create_only
```

- 対象ファイルが存在しない場合だけ作成する。既存なら以後 `aro sync` で二度と触らない（`preserve` 扱い）。
- `src` と `template` はどちらか一方だけを持たなければならない（両方あり／両方なしは validation error）。
  - `template`: Handlebars 的な `{{ repo_name }}` プレースホルダを repo 名で置換してから書き込む（`packages/aro-cli/src/core/template.ts`）。`init` ではrepo rootのディレクトリ名、既存repoへの`sync`では`.ai/project.yaml`の`project.name`を使う（設定が無い・不正な旧repoだけディレクトリ名へfallback）。プレースホルダ以外の内容はそのまま。
  - `src`: プレースホルダ置換なしでそのまま書き込む（workflow stub など）。

#### 配布終了した seed file の扱い

`create_only` の seed を manifest から外しても、**既に seed 済みの repo からは消えない**
（sync はファイルに触らず、lock の `seed_files` から当該エントリが外れるだけ）。撤去は手動で行う。

- `.github/workflows/ai-improve.yml`（計画 03 Stage 2-2 で配布終了）: CI 内で AI 改善を実行しない
  方針になったため、残っている repo では `git rm .github/workflows/ai-improve.yml` で削除して PR を
  出す。残置は `aro doctor` が WARN（`workflow.ai-improve.legacy`）として検出する。

### `append_unique_lines`（`patches[]`）

```yaml
- type: append_unique_lines
  path: .gitignore
  lines:
    - .ai/runs/
    - .ai/tmp/
    - .ai/logs/
```

- 指定した `lines` のうち、対象ファイルにまだ存在しない行だけを末尾に追記する。
- 行の同一判定は canonical text（LF 正規化後）で行単位に行う。既存行の順序・コメントは変更しない。
- `lines` の各要素に改行文字（CR/LF）を含めることはできない（manifest 検証エラー）。追記順序は `lines` の並びどおりを維持する（distribution content hash の計算でもこの順序は保持する）。

## validation rules

manifest は zod schema（`manifestSchema`）で検証される。主なルール:

```txt
schema_version は 1 のみ
name は必須（空文字不可）
version は semver 文字列
files[].src / files[].dest は distribution/repo root からの安全な相対 path
seed_files[].dest は安全な相対 path
seed_files[] は strategy: create_only のみ許可
seed_files[] は src または template のどちらか一方だけを持つ（両方あり/両方なしは禁止）
patches[].path は安全な相対 path
patches[].lines の各行は改行文字を含めない・1行以上必須
strategy は managed_overwrite | create_only | append_unique_lines のみ
絶対 path・.. を含む path・NUL 文字・Windows 予約名は禁止（詳細は security.md）
files[].dest / seed_files[].dest / patches[].path は全体で一意（大文字小文字を区別しない）
```

さらに、常時保護される固定 path（`.env` / `.env.*` / `secrets/**` / `.ai/local/**` / `.git/**`）は `files[]` / `seed_files[]` / `patches[]` のいずれの対象にもできない。`.ai/project.yaml` だけは唯一の例外で、`seed_files[]`（`create_only`）でのみ配布でき、`files[]` / `patches[]` の対象にはできない。`preserve[]` に一致する path も `files[].dest` にはできない。これらは manifest 作者が `preserve` を書き忘れても効く defense-in-depth であり、詳細は [`security.md`](./security.md) を参照。

`src` / `template` で参照するファイルは UTF-8 テキストとして読める必要がある（不正なバイト列は `SOURCE_FILE_NOT_UTF8` エラー。binary は MVP 非対応）。

## authoritative schemas と managed copies

`.ai/project.yaml` と `.ai/local/knowledge/index.yaml` の JSON Schema は、それぞれ
`schemas/project.schema.json` と `schemas/knowledge.schema.json` を唯一の正（authoritative）とする。
`distribution/base/files/.ai/managed/schemas/` の同名ファイルは、対象 repo 内でのエディタ補完・可視性の
ためだけに存在する配布用コピーである。

```bash
pnpm schema:sync    # 2つのauthoritative schema -> managed copies
pnpm schema:check   # どちらかに差分があれば exit 1（CI 向け）
```

authoritative と copy の両方を人間が手で編集する運用は禁止する。`aro doctor` と
`aro knowledge check` は常に ai-repo-ops source 側の authoritative schema を読む。対象 repo 側の
managed copy が改変されても検証の信頼性は落ちない（copy 自体は managed file の checksum 検証で
drift 検出される）。

## `.ai/local/knowledge/**` の所有境界

`.ai/local/**` は常時保護 path のため、distribution manifest の `files[]` / `seed_files[]` /
`patches[]` は一切書き込めない。Repo Knowledge Loop が中央管理するのは次の2点だけである。

- `.ai/managed/prompts/knowledge-refresh.md`: ローカルAI向け更新手順。
- `.ai/managed/schemas/knowledge.schema.json`: indexのエディタ向けcopy。

対象 repo 所有の `.ai/local/knowledge/index.yaml` と Markdown は専用の `aro knowledge init` だけが作成し、
`aro sync` は以後も触れない。`knowledge init` は distribution の例外ではなく、必須 `--base` と HEAD の
merge-baseにある `.ai/project.yaml` による許可、symlink検査、exclusive createを備えた別の明示的経路である。詳細は
[`repo-knowledge-loop.md`](./repo-knowledge-loop.md) を参照。

## distribution content hash

`version` だけでは「manifest 内容は変わったが version bump を忘れた」状態を検出できない。そのため `aro` は distribution 全体の `distribution_content_sha256` を計算し、`aro diff` / `aro sync` の更新判定・lock file への記録に使う。

### 目的

```txt
使う:
  aro diff で source 側 distribution hash と lock 側 hash を比較する
  manifest.version が同じでも hash が違えば source content drift として扱う（WARN）
  rollout（post-MVP）で更新対象 repo を検出する

使わない:
  manifest.version の代替として人間向け release 番号にする
  対象 repo の実ファイル状態を証明する
  create_only の seed file が対象 repo に適用済みであることを証明する
```

### hash 対象

含める:

```txt
distribution 名 / manifest schema_version / checksum mode
managed files: dest, strategy, source canonical sha256
seed files: dest, strategy, source kind(src|template), source canonical sha256
patches: type, path, lines
```

含めない:

```txt
manifest.version（version bump だけでは hash が変わらない）
manifest のコメント・YAML key 順・エントリ順そのもの
files[].src / seed_files[].src / template の path 文字列
source checkout の絶対 path・created_at / updated_at
```

### 正規化ルール

1. `managed_files` は `dest` 昇順で sort する
2. `seed_files` は `dest` 昇順で sort する
3. `patches` は `(type, path, JSON.stringify(lines))` の昇順で sort する（`lines` の中身自体は sort しない）
4. object key は再帰的に UTF-16 code unit 昇順で sort する
5. JSON は余分な空白なしで stringify する
6. UTF-8 bytes 化して SHA-256 hex lowercase を計算する

実装は `packages/aro-cli/src/core/distribution-hash.ts` の `buildDistributionHashPayload` / `stableJson` / `computeDistributionContentSha256`。

### `aro diff` での見え方

`manifest.version` が同じでも `distribution_content_sha256` が異なる場合、`aro diff` は次の WARN を出す。

```txt
WARN  manifest version is unchanged, but distribution content changed.
      Consider bumping manifest.version before release.
```

`seed_files`（`create_only`）は既存 repo では自動上書きされないが、その内容変化も `distribution_content_sha256` には含まれる。新規 repo には新しい初期状態が配布されるため、payload としては変化しているとみなす。既存 repo で seed file が preserve される場合でも、`aro sync` は lock の `distribution_content_sha256` を最新化することで「この repo は新しい distribution を確認済み」と表現する。

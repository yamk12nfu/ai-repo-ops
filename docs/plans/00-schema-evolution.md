# 計画 00: `.ai/project.yaml` の schema evolution 方針

> **これは実装計画ではなく方針文書。** 番号付き計画（01〜05）のような Before/After・実装タスク・DoD は持たない。
> `aro upgrade`（schema migration コマンド）の実装は保留する。着手条件は本文末尾「`aro upgrade` が必要になる条件」を参照。
> それまでは、この文書に書かれたルールに従って `schemas/project.schema.json` を人手で進化させ、
> `aro doctor` の FAIL 表示と手動編集で対応する。

## 背景

[`README.md`](./README.md) の「計画化を保留しているもの（運用データ待ち）」に記載のとおり、schema migration
（`aro upgrade`）は dogfooding（計画 02）で実際に痛みが出るまで計画化しない。ただし `.ai/project.yaml` は
各対象 repo に散らばるローカル設定であり、後から方針を変えると移行コストが跳ねるため、実装を保留する一方で
**方針だけは先に決めておく**。

## 対象範囲: どの `schema_version` の話か

このリポジトリには `schema_version` という名前のフィールドが複数箇所にあるが、**互いに独立したバージョン**
であり、同じ値（現在はすべて `1`）を共有しているのは偶然に過ぎない。本文書が扱うのは (1) のみ。

| 対象 | フィールドの所在 | 検証コード | 現在値 |
|---|---|---|---|
| **(1) `.ai/project.yaml` の schema**（本文書の対象） | 対象 repo の `.ai/project.yaml` | `schemas/project.schema.json`（authoritative JSON Schema）を `packages/aro-cli/src/core/json-schema.ts` の `validateJsonSchema` が解釈し、`packages/aro-cli/src/core/doctor.ts` の `checkProjectYaml` が呼ぶ | `"const": 1` |
| (2) `distribution/<name>/manifest.yaml` の schema | 各 distribution の `manifest.yaml` | `packages/aro-cli/src/core/manifest.ts` の zod schema（`MANIFEST_SCHEMA_VERSION = 1`、`schema_version: z.literal(MANIFEST_SCHEMA_VERSION)`） | `1` |
| (3) `.ai/ai-repo-ops.lock.yaml` の schema | 対象 repo の lock file | `packages/aro-cli/src/core/lockfile.ts` の zod schema（`LOCKFILE_SCHEMA_VERSION = 1`） | `1` |

(2) は manifest.yaml というファイル形式自体の互換性（`files[]` / `seed_files[]` / `patches[]` の構造）を表し、
(1)（配布対象である project.yaml の中身の構造）とは無関係に進化しうる。(3) も同様に lock file 形式専用の
バージョンで、(1) とは独立している。distribution 側の `manifest.yaml` を書き換えても `.ai/project.yaml` の
`schema_version` は変わらないし、その逆も同様。**「schema_version を上げる」と言うときは、必ずどの (1)〜(3)
の話かを明示する。** 以降、本文書で単に「schema_version」と書くときは (1) を指す。

## `schema_version` の意味

`.ai/project.yaml` の `schema_version` は、`schemas/project.schema.json` が定義する **project.yaml の
フィールド構造（必須キー・型・enum など）に対する互換性** を表す整数である。定義は
`schemas/project.schema.json:9-12`:

```json
"schema_version": {
  "description": "project.yaml schema のバージョン。MVP は 1 のみ。",
  "const": 1
}
```

`schemas/project.schema.json` が「ai-repo-ops source 側の唯一の正（authoritative）」であり
（[`docs/distribution.md`](../distribution.md) 「authoritative schema と managed copy」節）、
`distribution/base/files/.ai/managed/schemas/project.schema.json` はこれを `pnpm schema:sync` で
生成したコピーで、対象 repo 内でのエディタ補完・可視性のためだけに存在する。`aro doctor` の検証は常に
authoritative 側を読み、コピー側は使わない（`packages/aro-cli/src/core/doctor.ts` の
`RunDoctorInput.projectSchema` に authoritative schema を渡す。呼び出し元は `packages/aro-cli/src/commands/doctor.ts`）。
コピー側が改変されていても検証の信頼性は落ちない。

現在の実装（`json-schema.ts` の `validateNode`）は `const` を厳密な等価比較（`deepEqual`、実体は
`JSON.stringify` 比較）で判定する。つまり `schema_version` は **単一の許容値**であり、`>= 1` のような範囲や
`enum: [1, 2]` のような複数許容にはなっていない。値が `1` でなければ即座に `must be 1` という違反になる。

## minor compatible と major breaking の扱い

MVP では `schema_version` は `1` しか存在したことがなく、実際に破壊的変更をした経験はまだない。以下は
**将来 `schemas/project.schema.json` を変更するときに従うべき方針**であり、現状の実装がすでに区別している
わけではない（`const` は 1 値のみを許すため、区別は「schema_version を上げるかどうか」という
schema 変更時の運用判断として行う。実装側の分岐はまだ無い）。

### minor（compatible）— `schema_version` を上げない

既存の有効な `.ai/project.yaml` が、変更後も**そのまま**（1 文字も書き換えずに）有効であり続ける変更。

- 許可される例:
  - 新しい **省略可能** なプロパティを追加する（例: `project` に新しい optional フィールドを足す）。
  - `enum` に新しい選択肢を追加する（既存の値が禁止にならない限り）。
  - 制約を緩める（`minLength` を下げる、`required` から外す等）。
  - `commands` のように `additionalProperties` が緩い（`{ "type": "string" }`）セクションへ、
    新しい既知コマンド名を「予約」する（すでに任意の文字列キーを許しているため schema 上は無変更）。
- 禁止される例（これらは minor ではなく major）:
  - 既存の `required` フィールドの追加・既存フィールドの型変更・rename・削除。
  - 既存フィールドの意味を変える（見た目の schema は同じでも解釈が変わる場合は major 扱いにする）。

minor 変更は `schema_version` の値を変えないため、`aro doctor` の `schema_version` チェック
（`const: 1` との一致）には一切影響しない。対象 repo の `.ai/project.yaml` が新しい `schemas/project.schema.json`
を初めて見る（例えば `aro doctor` が別マシンの最新 source で実行された）としても、既存の値だけで検証は
通り続ける。

### major（breaking）— `schema_version` を上げる

既存の有効な `.ai/project.yaml` が、変更後は**そのままでは無効になる**変更。

- 例: 新しい必須フィールドの追加、既存フィールドの rename・削除・型変更、`quality_gates` /
  `ai` のような既存セクションの再構成。
- major 変更をする場合は `schemas/project.schema.json` の `schema_version` の `const` 値を上げる
  （例 `const: 1` → `const: 2`）と同時に、`.ai/project.yaml` 側の実データも新しい構造に合わせて
  書き換えないと検証が通らなくなる。
- 現在の `const`（単一許容値）という実装のままでは、bump した瞬間に旧 `schema_version: 1` の
  `.ai/project.yaml` はすべて検証エラーになる。移行期間中に新旧両方を許容する
  （`"enum": [1, 2]` にする、あるいは `schema_version` ごとに別 sub-schema を適用する）かどうかは、
  実際に major 変更が必要になった時点で判断する未決事項であり、本文書では決め打ちしない
  （`aro upgrade` の実装設計はスコープ外のため）。

## `aro doctor` が旧 schema をどう扱うか

現状の実装（事実）: `packages/aro-cli/src/core/doctor.ts` の `checkProjectYaml`（148-189 行目）は、
`.ai/project.yaml` を parse した値を `validateJsonSchema(projectSchema, parsed)` で検証し、
1 件でも違反があれば chek id `project-yaml.schema` を **FAIL** として報告する（179-185 行目）。
`schema_version` が `1` 以外であれば `$.schema_version: must be 1` が違反の一つとして含まれ、
他のフィールドがすべて有効でも `project-yaml.schema` チェック全体が FAIL になる。WARN に軽減する分岐は無い。

方針: **schema_version 不一致は今後も FAIL のままとする。** 根拠は doctor.ts 冒頭のコメント（12-17 行目）
にすでに書かれている重大度の定義そのものである。

```txt
FAIL: 必須アーティファクトの欠如・schema 違反・人間による managed file の直接編集など、
      安全に自動修復できない、または見過ごすとセキュリティ/正しさに影響する状態。
WARN: aro sync で自動的に解消される drift や、許容されるが注意を要する設定。
```

schema 違反は明示的に FAIL の定義に含まれる。加えて、`.ai/project.yaml` は `create_only`（後述）のため
`aro sync` では**絶対に自動修復されない** — WARN の定義（sync で解消される drift）に一切当てはまらない。
よって schema_version 不一致を WARN に格下げする理由はなく、現状の FAIL 挙動を維持するのが妥当という
結論になる。

実務上の影響: `aro doctor` は FAIL が 1 件でもあれば exit code `1` を返す
（[`docs/sync-strategy.md`](../sync-strategy.md) 「`aro doctor`」節）。将来 CI（`aro guard` 等、計画 03）
が `aro doctor` をゲートとして使う場合、schema_version の古い repo はそこで検知される。

`aro upgrade` が存在しない現状での対応手段は手動編集のみである。`checkProjectYaml` が積む `hint` は
違反一覧（`issue.path: issue.message` の join、183 行目）だけで、修復コマンドへの案内は含まれない
（`aro upgrade` が無いため案内しようがない）。`aro upgrade` を実装する際は、この hint を
「`aro upgrade --repo .` を実行してください」のような案内に更新することが望ましいが、それ自体は
`aro upgrade` 実装 PR のスコープであり本文書では扱わない。

## `aro upgrade` が必要になる条件

以下のいずれかが実際に発生するまでは実装に着手しない（[`README.md`](./README.md) の
「計画化を保留しているもの（運用データ待ち）」の方針に従う）。

1. `schemas/project.schema.json` に対して、上記の「major（breaking）」に該当する変更が実際に必要になった
   ——つまり `schema_version` の `const` 値を初めて `1` から動かす具体的な理由が生まれたとき。
   MVP 開始以来 `schema_version` は `1` のまま変わったことがなく、移行すべき対象がまだ存在しない。
2. `aro init` 済みの参加 repo が複数存在し（計画 05 の目安と同じく「3 個を超えたら」）、
   `.ai/project.yaml` を repo ごとに手で編集する運用コストが無視できなくなったとき。
3. 実際に (1) が起きた結果として `aro doctor` の `project-yaml.schema` FAIL が複数 repo で
   同時に発生し、fleet 診断（計画 05）や CI ゲート（計画 03）で運用上の障害として顕在化したとき。

いずれも「起きたら着手する」条件であり、先回りして `aro upgrade` の CLI 設計・移行コードを今書くことは
本文書のスコープ外とする。

## `.ai/project.yaml` の `create_only` 戦略との関係

`distribution/base/manifest.yaml` の `seed_files` において、`.ai/project.yaml` は次のように宣言されている
（`distribution/base/manifest.yaml:38-41`）。

```yaml
seed_files:
  - dest: .ai/project.yaml
    template: project.yaml.hbs
    strategy: create_only
```

`create_only` の挙動は [`docs/sync-strategy.md`](../sync-strategy.md) 「`create_only`」節のとおり:
対象ファイルが存在しなければ `aro init` 時に一度だけ作成し、既に存在すれば `aro sync` / `aro diff` は
**以後一切触らない**（`preserve` 扱い）。加えて `.ai/project.yaml`（`PROJECT_YAML_PATH`）は
`packages/aro-cli/src/core/manifest.ts` の `FULLY_PROTECTED_MATCHERS`（66-69 行目）に含まれており、
`files[]`（`managed_overwrite`）や `patches[]` の対象に**する**こと自体が manifest schema レベルで禁止されている
（`create_only` のみが唯一の配布経路として許可される）。

この設計から導かれる帰結:

- distribution 側の `schemas/project.schema.json` や `project.yaml.hbs`（seed テンプレート）を進化させても、
  既に `aro init` 済みの対象 repo の `.ai/project.yaml` は**自動的には一切更新されない**。`aro sync` を
  何度実行しても、`.ai/project.yaml` は初回作成時点の内容のまま残り続ける。
  `risk_level` や `commands` を人間がカスタマイズしている前提のフィールドだからこそ `create_only` にした
  という設計判断（README「`.ai/project.yaml` は各 repo に散らばるローカル設定」）と表裏一体である。
- したがって distribution 側の schema が進んでも、各 repo の `.ai/project.yaml` は
  「作成された時点の schema_version」に凍結される。fleet 全体で見れば、`schema_version` が異なる
  `.ai/project.yaml` が長期間混在しうる、という前提に立って方針を決める必要がある
  （「minor は互換性を壊さない」という原則が効いてくるのはこのため。minor である限り、凍結された
  古い `.ai/project.yaml` も新しい schema に対してそのまま valid であり続ける）。
- `managed_overwrite`（`files[]`）が使えるファイル（prompts / policies / schema コピーなど）であれば
  `aro sync` が自動で最新化するが、`.ai/project.yaml` はその経路が manifest schema レベルで塞がれている。
  これは意図的な設計であり、`aro sync` の「中央が一方的に上書きする」モデルは、人間がカスタマイズした
  設定ファイルには使えない。そのため `.ai/project.yaml` を新しい `schema_version` へ移行させる手段は、
  既存の `sync` の仕組みを流用するのではなく、ユーザーのカスタマイズ値を保持したまま構造だけを
  書き換える専用の操作（`aro upgrade`）にならざるを得ない。これが `aro upgrade` を
  `aro sync` とは別の独立したコマンドとして設計する理由である（実装設計そのものは本文書のスコープ外）。
- `aro upgrade` が実装されるまでの間、`schema_version` を bump した場合の移行手段は
  「`aro doctor` の FAIL を見て、対象 repo の `.ai/project.yaml` を人間が手で新しい構造に書き換える」
  以外に存在しない。

## まとめ

- `schema_version`（`.ai/project.yaml` 側）は project.yaml のフィールド構造の互換性を表す。
  manifest.yaml 側・lock file 側の `schema_version` とは独立した別カウンタ。
- minor（compatible）は `schema_version` を上げずに済む変更、major（breaking）は上げる変更。
  現状は `const: 1` の 1 値のみ許容する実装であり、新旧共存の是非は major 変更が実際に必要になったときに決める。
- `aro doctor` は schema 違反（`schema_version` 不一致含む）を FAIL として扱う。`.ai/project.yaml` は
  `aro sync` で自動修復されない（`create_only`）ため、WARN に格下げする理由がない。
- `aro upgrade` は、major 変更が実際に必要になり・参加 repo 数が増え・FAIL が運用上の問題として
  顕在化してから着手する。
- `.ai/project.yaml` が `create_only` である以上、distribution 側の schema がいくら進化しても
  各 repo の実ファイルは凍結されたまま残る。この凍結問題を解消する手段が `aro upgrade` であり、
  `aro sync` の仕組み（managed_overwrite）を流用できない設計上の理由がある。

## 関連ドキュメント

- [`docs/plans/README.md`](./README.md) — 本文書の位置づけの根拠（保留理由・着手条件の全体方針）
- [`docs/distribution.md`](../distribution.md) — manifest / authoritative schema と managed copy の関係
- [`docs/sync-strategy.md`](../sync-strategy.md) — `create_only` / `managed_overwrite` の挙動、`aro doctor` の終了コード

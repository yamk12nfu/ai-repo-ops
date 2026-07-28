# 計画 06: Proposal Loop — AI が提案し、人間が採否を決め、判断が蓄積される

優先度: 高 / 前提: 計画 03（Stage 2 完了済み） / 規模: 中
（**Stage 1 / Stage 2 に分割し、別 PR で実装する**）

- **Stage 1: 提案の形式と `aro proposals check`** — AI 不要。fixture repo で完結する独立実装
- **Stage 2: improve ループとの接続** — 採用済み提案を改善ループの入力にし、実装後に `done` へ閉じる

> **方針**: 採否を判断するのは**常に人間**である。AI は提案を作るところまでを担い、良し悪しの評価・
> 順位付け・選抜は一切行わない。本計画は自動スコアリングや候補の自動選抜を**恒久的に非スコープ**とする。
> 機械が担うのは「提案が消えないこと」「判断が記録されること」「根拠が腐ったら検出されること」
> 「採否の変更が人間の目を必ず通ること」だけである。
> AI の実行はローカル、CI は決定的検証という計画 03 の分担をそのまま引き継ぐ。

> **PR #35（guard の `severity: fail/warn`）との関係**: 本計画は #35 に**依存しない**。
> 後述の `proposal_decision` は `severity: fail` として設計しており、severity map の未定義キーは
> 既定で `fail` として扱われる（`core/policy.ts` の設計）。したがって #35 が merge される前でも後でも
> 実装できる。#35 が先に入った場合のみ、配布 policy の severity map に `proposal_decision: fail` を
> 明示列挙して意図を可視化する（Stage 1-3 の任意タスク）。

## できるようになること

| | Before（現状） | After（完了後） |
|---|---|---|
| 提案の行き先 | `improve.md` の「次にやるべき改善候補」は出力に書かれて消える。`aro doctor` の WARN、`aro guard` の `severity: warn` も同様 | **提案が `.ai/local/proposals/**` に残る**。次の周・別の開発者・別の AI セッションから読める |
| 人間の判断 | merge するかどうかだけ。「この改善はやらない」という判断はどこにも残らない | **採否と理由が repo に記録される**（`status: accepted` / `rejected` + `decision_reason`） |
| 再提案 | 同じ提案が毎回出てくる。却下した理由を AI は知らない | **却下済み提案を読んだ上で提案する**ため、同じ提案が繰り返されない。判断の蓄積がそのまま提案の質になる |
| レビュー負荷 | 改善 PR を読んで初めて「これはやらなくていい」と分かる。実装が無駄になる | **提案だけの PR（コード変更ゼロ）で先に採否を決められる**。実装は採用後 |
| 提案の根拠 | 口頭・PR コメント。時間が経つと何を見て言ったのか分からない | **source path + 検証 commit を持ち**、根拠が変化したら `aro proposals check` が stale として検出する |

```txt
開発者のローカル                                  CI（中央が配布した workflow）
┌──────────────────────────────┐  PR①  ┌──────────────────────────┐
│ propose.md                    │ ─────► │ aro proposals check       │
│  └ 既存の提案・却下理由を読む   │ 提案のみ│ aro guard                 │
│  └ 新しい提案を N 件書く        │        └──────────────────────────┘
└──────────────────────────────┘              │
        ▲                                      ▼
        │                          人間が status を書く（accepted / rejected + 理由）
        │                                      │
        │                                      ▼
┌──────────────────────────────┐  PR②  ┌──────────────────────────┐
│ improve.md                    │ ─────► │ aro guard + quality gates │
│  └ accepted を 1 件だけ実装    │ 実装   └──────────────────────────┘
│  └ 実装できたら done へ閉じる   │              merge は常に人間が判断
└──────────────────────────────┘
```

## 現状とギャップ

- `.ai/local/knowledge/**`（計画外で実装済み）は「repo 所有のローカル領域を中央が検証する」形式の先例であり、
  schema 検証・source path の安全境界・検証 commit と HEAD の祖先関係・stale 判定は
  [`core/knowledge-check.ts`](../../packages/aro-cli/src/core/knowledge-check.ts) と
  [`core/knowledge-git.ts`](../../packages/aro-cli/src/core/knowledge-git.ts) に実装済み。**proposals はこの検証を再利用する**。
- `improve.md` は出力に「次にやるべき改善候補（実施はしない）」を要求しているが、**書き出す先が無い**。
- `aro guard` の `severity: warn`（PR #35。**まだ merge されていない**）は「落とさないが指摘する」層を
  作ろうとしている。この warn は improve ループの中止条件として使われるだけで、**指摘そのものは残らない**。
- 現在の `core/guard.ts` の violation は 7 種類すべてが「変更 path の glob 判定」か「ファイル数・
  追加行数の計数」であり、`GuardChangedFile` は `{ path, addedLines, deletedLines }` しか持たない。
  **guard はファイルの内容を一度も読んでいない**（後述 Stage 1-3 の見積もりに影響する）。
- `aro doctor` の WARN も同様に実行ごとに消える。
- `project.yaml.hbs` の `ai.allowed_paths` に `.ai/local/knowledge/**` はあるが、**proposals 用の path が無い**。
- 提案を repo に置く前例が無いため、「AI が書いてよい範囲」と「人間だけが書く範囲」を分ける仕組みも無い。

## スコープ

- `.ai/local/proposals/**` の形式定義（1 提案 = 1 Markdown ファイル + YAML frontmatter）
- `aro proposals check`（読み取り専用の機械検証）
- `.ai/managed/prompts/propose.md` の新規配布と `improve.md` の改訂
- `project.yaml.hbs` の `ai.allowed_paths` への追加と authoritative schema の追随
- `aro guard` への `proposal_decision` violation（採否の変更を PR で必ず表面化させる）
- dogfooding（Stage 3）

## 非スコープ

- **AI による採否の判定・スコアリング・候補の自動選抜**（本計画の前提を壊すため恒久的に非スコープ）
- **AI が `status` を `open` 以外へ書き換えること**（実装完了に伴う `accepted` → `done` のみ例外。後述）
- CI 内での AI 実行 / 提案の自動生成 / 自動 PR（計画 03 の方針を継承）
- 中央 repo への提案の集約・repo 横断の統計（計画 05 の fleet 段階。後述「中央への還流」）
- 提案の優先度フィールド・期限・担当者（運用データが出るまで持たない）

## 形式

```txt
.ai/
  managed/
    prompts/
      propose.md                       # 提案を書く手順（新規）
      improve.md                       # 採用済み提案を実装する手順（改訂）
    schemas/proposal.schema.json        # エディタ向け配布コピー
  local/
    proposals/
      2026-07-reduce-duplicate-fetch.md
      2026-07-add-missing-error-test.md
```

```markdown
---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: reduce-duplicate-fetch
status: open
proposed_at_commit: 0123456789abcdef0123456789abcdef01234567
sources:
  - path: src/api/client.ts
  - path: src/api/legacy-client.ts
decision:
  by: ""
  reason: ""
---

## 課題
（何が問題か。source のどこを見てそう判断したか）

## 提案
（何をするか。1 提案 = 1 つの明確な改善）

## 想定する変更範囲
（触るファイルの見込み。`ai.max_changed_files` に収まるか）

## リスク・見送る理由になりうる点
（人間が却下を判断するための材料。ここを書くのが AI の仕事の半分である）
```

- `id`: kebab-case。repo 内で一意（ファイル名の日付 prefix は含めない）。
- `status`: `open` / `accepted` / `rejected` / `done` / `superseded`。
- `proposed_at_commit`: 根拠を確認した完全な lowercase Git SHA。knowledge の `verified_at_commit` と同じ検証を使う。
- `sources[].path`: repo root からの正確な相対 path。knowledge と同じ安全境界（secret・`.git`・`.ai`・
  依存物・build 生成物・symlink・glob を拒否）。
- `decision.reason`: `rejected` では必須。`accepted` では任意。**却下理由が次の提案の入力になる**ため、
  「なぜやらないか」を書くことに最大の価値がある。

> **index.yaml を持たない理由**: knowledge は `index.yaml` に集約しているが、提案は件数が増え続け、
> 状態が変わり、複数 PR が並行して触る。単一 index は conflict の原因になるだけで、
> 検証に必要な情報はすべて frontmatter に入る。ファイルシステムを index として扱う。

## 状態遷移と「人間が決める」の担保

| 遷移 | 誰が | guard の扱い |
|---|---|---|
| （なし）→ `open` | AI（propose.md） | **違反にしない**（propose.md の正常な出力）。`aro proposals check` が schema と根拠を検証 |
| `open` → `accepted` / `rejected` | **人間のみ** | `proposal_decision` violation（**`severity: fail`**） |
| 任意 → `superseded` | **人間のみ** | 同上 |
| `accepted` → `done` | AI（improve.md）または人間 | **違反にしない**（実装 PR の正常な出力）。実装を伴わない `done` 化は人間がレビューで却下する |

機械は「誰が編集したか」を判別できない。したがってこれは**強制ではなく可視化**である。ただし
「可視化」の強度は `.ai/project.yaml` の変更と揃える。すなわち採否の変更を含む PR は
**required check が落ちた状態になり、人間が内容を確認したうえで明示的に override して merge する**
（[`guard.md`](../guard.md) の `project_config` の扱いと同じ運用）。

`severity: warn`（落とさず指摘するだけ）は採らない。`guard.md` が `project_config` について
「警告どまりだと設定変更が誰にも見られずに通りうる」として `fail` を選んだのと、守ろうとしている
脅威が同型だからである（AI が自分に有利な状態変更を、人間に気づかれずに通す経路）。ここだけ
緩めると、その差を説明できない。

`propose.md` は「既存ファイルの `status` と `decision` を変更しない」ことを明示的に禁止する。
この二段（guard の fail + プロンプトの禁止）で、AI が黙って自分の提案を採用済みにする経路を塞ぐ。

> **`accepted` → `done` を違反にしない理由**: これを違反に含めると、Stage 2 の正常な実装 PR が
> 毎回 required check を落とすことになり、「採否の変更が出たら止まる」というシグナルが日常的な
> ノイズに埋もれる。遷移の種類を区別しない実装は、可視化の目的そのものを損なう。

## 実装タスク

### Stage 1-1: 形式と schema

1. `schemas/proposal.schema.json`（authoritative）を追加し、`pnpm schema:sync` / `schema:check` の
   対象に加える（既存の project / knowledge と同じ扱い）。
2. frontmatter parser を追加する。knowledge の YAML 読み込み（`core/yaml.ts` + zod）を再利用し、
   Markdown 本文と frontmatter の分離だけを新規実装する。

### Stage 1-2: `aro proposals check`

```bash
aro proposals check --repo <path> [--strict] [--json]
```

検証項目（knowledge check の実装を最大限流用する）:

1. frontmatter が schema と意味制約に適合する（`rejected` なら `decision.reason` が非空、等）。
2. `id` が repo 内で一意。
3. `sources[].path` が許可された正確な相対 path の UTF-8 text file で、HEAD に追跡されている。
4. `proposed_at_commit` が存在し、HEAD の祖先である。
5. `status: open` **および `accepted`** の提案について、`proposed_at_commit` 以降 source 内容が
   変わっていれば **stale**（通常 WARN / exit 0、`--strict` で FAIL / exit 1）。
   根拠が変わった提案は作り直すべきである。
6. `rejected` / `done` / `superseded` は stale 判定の対象外（判断が終わった履歴であり、
   後から根拠が変わっても記録としての価値は変わらない）。

> **`accepted` を stale 判定に含める理由**: `accepted` は「判断済み」ではあるが、同時に
> **未実装の実行待ちキュー**である。採用から improve ループに拾われるまでの間隔は運用次第で
> 長くなりうる（`open` の滞留と同じ力学が働く）。その間に source が変われば、Stage 2 の
> `improve.md` は**もう成立しない診断に基づいて実装する**ことになる。`improve.md` は
> stale な `accepted` を実装対象に選ばず、人間に再確認を促す。

終了コードは knowledge check に揃える（`0` / `1` / `3`）。提案が 0 件の repo は正常な状態として PASS。

### Stage 1-3: guard と配布物

1. `aro guard` に `proposal_decision` violation（`severity: fail`）を追加する。
   **これは既存 violation の流用では実装できない**。既存の 7 種類は path の glob 判定か件数の計数
   だけで完結しており、guard はファイルの内容を読んでいない。新規に必要なもの:
   - **merge-base 側と HEAD 側の 2 revision で、対象ファイルの frontmatter を読んで比較する機構**
     （`core/git-tree.ts` の blob 読み出しを利用する。判定ルールを merge-base から読む既存設計は維持）
   - 遷移の種類による場合分け（前掲の表）。少なくとも次を区別する:
     - merge-base に存在しないファイル（新規提案）は違反にしない
     - `accepted` → `done` は違反にしない
     - `open` → `accepted` / `rejected`、任意 → `superseded` を `fail` にする
   - frontmatter が壊れている・parse できない場合の扱い（`proposals check` の責務と重複させず、
     guard 側は「遷移が判定できない」として fail にする）
2. （#35 merge 後の任意タスク）配布 policy 3 ファイルの severity map に `proposal_decision: fail` を
   明示列挙する。未定義キーは既定 `fail` のため挙動は変わらないが、`default.yaml` が全キーを
   明示列挙している既存の書き方に揃える。
3. `project.yaml.hbs` の `ai.allowed_paths` に `.ai/local/proposals/**` を追加し、manifest を bump する。
   既存 repo は knowledge と同じく**設定専用 PR を先に merge する**。
4. `.ai/managed/prompts/propose.md` を配布物に追加する。要件:
   - 実行前に `.ai/local/proposals/**` を**すべて読む**。`rejected` と実質同じ提案を再提出しない。
   - 提案は `status: open` の新規ファイルとしてのみ書く。既存ファイルの `status` / `decision` は変更しない。
   - **コードを一切変更しない**（提案 PR は提案ファイルだけを含む）。
   - 1 提案 = 1 ファイル。1 回の実行で書く提案は既定 3 件までとし、`ai.max_changed_files` に収める。
   - 「リスク・見送る理由になりうる点」を必ず埋める（人間が却下できる材料を出すのが提案の質）。
   - 入力源として `aro guard --json` の違反（#35 merge 後は warn を含む）、`aro doctor` の WARN、
     lint 警告、TODO を明示する。
5. `aro doctor` に proposals の存在チェックを足すかは Stage 3 の観測後に決める（提案 0 件は異常ではない）。

### Stage 2: improve ループとの接続

1. `improve.md` を改訂する:
   - 改善対象は **`status: accepted` の提案から 1 件選ぶ**ことを既定にする（accepted が無い場合のみ、
     従来どおり自分で小さな改善を選ぶ）。
   - stale な `accepted`（根拠が変わっている）は実装対象に選ばず、人間に再確認を促す。
   - 実装が guard + gates を通ったら、その提案を `done` にして同じ PR に含める。
   - 破棄した場合は提案を `open` のまま残し、破棄理由を本文に追記する（提案自体は消さない）。
   - 出力の「次にやるべき改善候補」は、`propose.md` で提案ファイルに書き出す旨の案内に置き換える。
2. `docs/proposal-loop.md`（運用手順書）を追加し、`local-improve-loop.md` から相互リンクする。

### Stage 3: dogfooding

- 実 repo 1 個で、提案 PR → 採否記入 → 実装 PR → `done` を最低 1 周させる。
- 記録すること:
  - 提案の粒度（`max_changed_files` に収まるか、大きすぎて分割が要るか）
  - **却下率と、却下済みと実質同じ提案が再提出される頻度**（却下理由の蓄積が効いているか。
    意味的な同一性の判断は機械化できないため、DoD ではなくここで観測する）
  - open / accepted の滞留数（読まれないまま溜まらないか。溜まるなら上限か棚卸し手順が要る）
  - stale 判定の妥当性（source が少し変わっただけで stale になり過ぎないか）
  - `proposal_decision` の override 頻度（採否 PR ごとに required check を落とす運用が重すぎないか）

## 中央への還流

repo をまたいで繰り返し出る提案・繰り返される却下理由は、中央の `policies` / `prompts` /
distribution 自体の改善材料である（例: 毎回同じ理由で却下される提案は、そもそも `propose.md` の
指示が悪い）。ただし repo 横断の集約は registry を前提とするため、**計画 05（fleet）の後**に
`aro fleet proposals` として扱う。本計画では repo 内に閉じ、中央への還流は
[dogfooding の記録](../dogfooding/)経由の手動で行う。

## 受け入れ条件（DoD）

### Stage 1

- [ ] 不正な提案（schema 違反 / `rejected` で理由が空 / `id` 重複 / 追跡外 source / HEAD の祖先でない commit）で
      `aro proposals check` が exit 1 と違反一覧を返す（ユニットテスト。AI は関与しない）
- [ ] 正常な提案で exit 0、`--json` が機械可読の結果を返す
- [ ] `open` / `accepted` の提案の source が変化した場合に stale（通常 WARN / `--strict` で FAIL）になり、
      `rejected` / `done` / `superseded` では stale にならない
- [ ] `open` → `accepted` / `rejected` を含む diff で `aro guard` が `proposal_decision` を報告し、
      **exit 1（required check が落ちる）**になる
- [ ] 新規提案ファイルの追加のみ、および `accepted` → `done` の diff では `proposal_decision` が
      報告されない（正常な propose PR / 実装 PR がノイズで落ちない）
- [ ] 提案 0 件の repo で PASS する（導入直後が異常扱いにならない）

### Stage 2

- [ ] コード変更を含まない提案 PR が 1 件 merge される
- [ ] 人間が `open` → `rejected` + 理由を書いた PR で `proposal_decision` が fail し、
      内容を確認した override を経て merge される（採否が人間の目を通ったことが記録に残る）
- [ ] `accepted` の提案が improve ループで実装され、同じ PR で `done` に閉じる
- [ ] ループ全体を通して、対象 repo にも中央にも新しい secrets・API キー・書き込み権限が増えていない
- [ ] `auto_merge` が封印されたままである

## リスク / 未決事項

- **open が溜まって誰も読まなくなる**: 最大のリスク。提案が増えるほど `propose.md` の入力も膨らむ。
  Stage 3 で滞留数を観測し、必要なら「open の上限」または棚卸し手順（一定期間 open のものを
  `superseded` にする）を追加する。上限を先に決め打ちしない。
- **AI が自分の提案を採用済みにする**: 機械的な強制はできない（前述）。`proposal_decision` の
  `fail` とプロンプトの禁止で二段に構えるが、最終的には override する人間が内容を見るかどうかに
  依存する。この限界は `docs/proposal-loop.md` にも明記する。
- **採否 PR が毎回 required check を落とす運用の重さ**: `severity: fail` を選んだ結果、提案に
  ◯× を付けるだけの PR も override が必要になる。`project_config` と同じ運用なので新しい負担
  ではないが、採否は設定変更より頻度が高い。Stage 3 で override 頻度を観測し、重すぎると
  分かった場合に限って `warn` への緩和を検討する（`guard.md` が `project_config` について
  「運用して厳しすぎると分かった時点で検討する」としているのと同じ順序で判断する）。
- **`id` の重複が並行 PR で検出されない**: index.yaml を廃止した副作用。提案が 1 ファイルずつ
  独立しているため、2 つの PR が同じ `id` の別ファイルを追加しても git の conflict は起きず、
  各 PR 単体の `aro proposals check` も通り、**両方 merge された後で初めて重複が混入する**。
  緩和候補: (a) CI の `proposals check` を PR の merge 先（default branch 統合後の状態）に対しても
  実行し、次の PR の CI で必ず拾う、(b) `id` をファイル名から導出して人間が気づきやすくする。
  どちらを採るかは Stage 1-2 の実装時に決める。
- **提案の粒度が大きすぎる**: 「アーキテクチャを見直す」のような提案は採用しても実装できない。
  `propose.md` で「1 提案 = 1 PR で完結する大きさ」を規定するが、実効性は Stage 3 待ち。
- **knowledge と形式が違う**: knowledge は index.yaml、proposals は frontmatter。理由は前述のとおり
  だが、利用者から見ると `.ai/local/` 配下で 2 つの形式を覚えることになる。ドキュメントで吸収する。
- **stale の閾値**: source が 1 行変わっただけで stale にすると提案が作り直しばかりになる。
  まず knowledge と同じ「内容が変わったら stale」で始め、Stage 3 で緩和の要否を判断する。
- `aro proposals` に `init` サブコマンドを設けるか（knowledge は `init` を持つ）は未決。
  proposals は index が無く、ディレクトリを掘るだけで始められるため Stage 1 では不要と判断している。

# Proposal Loop（AI が提案し、人間が採否を決め、判断が蓄積される）

`ai-repo-ops` に参加している repo で、改善の**提案**と**採否の判断**と**実装**を分離して回す
運用の手順書である（[計画 06](./plans/06-proposal-loop.md)）。

方針は一貫している: **採否を判断するのは常に人間**。AI は提案を作るところまでを担い、
良し悪しの評価・順位付け・選抜は行わない。機械（`aro proposals check` / `aro guard`）が担うのは
「提案が消えないこと」「判断が記録されること」「根拠が腐ったら検出されること」「採否の変更が
人間の目を必ず通ること」だけである。AI の実行はローカル、CI は決定的検証という
[ローカル改善ループ](./local-improve-loop.md)の分担をそのまま引き継ぐ。

```txt
開発者のローカル                                  CI（中央が配布した workflow）
┌──────────────────────────────┐  PR①  ┌──────────────────────────┐
│ propose.md                    │ ─────► │ aro proposals check       │
│  └ 既存の提案・却下理由を読む   │ 提案のみ│ aro guard                 │
│  └ 新しい提案を書く（open）     │        └──────────────────────────┘
└──────────────────────────────┘              │
        ▲                                      ▼
        │                          人間が status を書く（accepted / rejected + 理由）
        │                          → guard の proposal_decision が fail
        │                          → 人間が内容を確認して override merge
        │                                      │
        │                                      ▼
┌──────────────────────────────┐  PR②  ┌──────────────────────────┐
│ improve.md                    │ ─────► │ aro guard + quality gates │
│  └ accepted を 1 件だけ実装    │ 実装   └──────────────────────────┘
│  └ 実装できたら done へ閉じる   │              merge は常に人間が判断
└──────────────────────────────┘
```

## 前提

- 対象 repo が `aro sync` で distribution 0.1.8 以降を導入済みであること
  （`.ai/managed/prompts/propose.md` と accepted 消化に対応した improve.md があり、
  `ai.allowed_paths` に `.ai/local/proposals/**` が含まれる。既存 repo は設定専用 PR を
  先に merge する）。
- [ローカル改善ループ](./local-improve-loop.md)の前提（AI 実行環境・`aro` CLI・clean worktree）。

## 提案の形式

1 提案 = 1 Markdown ファイル（`.ai/local/proposals/YYYY-MM-<slug>.md`）+ YAML frontmatter。
形式の詳細と設計判断は [計画 06「形式」節](./plans/06-proposal-loop.md#形式) を参照。

- `status`: `open` / `accepted` / `rejected` / `done` / `superseded`
- `decision.by`: `open` 以外では必須（判断した人間）。`decision.reason`: `rejected` / `superseded` で必須
- `sources[].path` + `proposed_at_commit`: 根拠。`open` / `accepted` の提案は source が変化すると
  `aro proposals check` が stale として検出する（`rejected` / `done` / `superseded` は判断が終わった
  履歴であり、stale 判定の対象外）
- **却下理由が次の提案の入力になる**。「なぜやらないか」を書くことに最大の価値がある

## 手順

### 1. 提案を作る（propose.md / PR①）

```bash
git status --short                          # 空であること
git switch -c docs/ai-propose-<topic>
```

```txt
.ai/managed/prompts/propose.md を読んで、その手順に従って提案を書いて
```

AI は既存の提案（特に `rejected` の理由）をすべて読んだ上で、`status: open` の新規ファイル
だけを書く（コード変更ゼロ・3 件まで）。自己検証は `aro proposals check --repo . --strict` と
commit 後の `aro guard`。開発者が確認して PR を作成する（タイトル規約:
`docs(proposals): <提案の要約>`）。`open` の新規追加は guard の違反にならないため、
この PR は通常どおり merge できる。

### 2. 採否を書く（人間 / PR①への追記または別 PR）

人間が提案ファイルの frontmatter を編集する:

```yaml
status: accepted        # または rejected
decision:
  by: "<あなたの名前>"
  reason: "<rejected / superseded では必須。却下理由は次の提案の質になる>"
```

**この PR は CI の `aro guard` が `proposal_decision`（severity: fail）で必ず落とす。**
これは正常な動作である（採否の変更が人間の目を通らずに merge される経路を塞ぐため。
`.ai/project.yaml` 変更の `project_config` と同じ運用）。PR の内容（誰が・どの提案を・
どう判断したか）を確認したうえで、required check を明示的に override して merge する。

### 3. 実装する（improve.md / PR②）

```txt
.ai/managed/prompts/improve.md を読んで、その手順に従って改善を 1 つ実施して
```

improve.md は `status: accepted` の提案から 1 件選ぶことを既定とする（accepted が 1 件も無い
場合のみ自選）。選定のルール:

- **stale な accepted は選ばない**。復帰は人間の仕事: 根拠を現在の HEAD で再確認し、
  frontmatter の `proposed_at_commit` を更新する（`status` は変えないため guard は通る）
- 実装可能な accepted が**複数**あるときは、AI は一覧を提示して**開発者が選ぶ**
  （AI は順位付け・選抜をしない）
- accepted が**すべて stale** のときは自選に進まず**停止**し、人間に再確認を求める

実装が自己検証（guard + quality gates）を通ったら、提案の `status` を `accepted` → `done` に
して同じ PR に含める（この遷移は guard の違反にならない）。実装を破棄した場合は `accepted` の
まま据え置き、本文に破棄の記録を追記して、**記録だけの commit / PR として残す**
（`status` が変わらないため通常どおり merge できる）。

### 4. CI の検証

- **PR ごと**: `aro guard`（`proposal_decision` を含む）+ `aro proposals check`
  （proposals を変更する PR は `--strict`）。
- **default branch への push**: `aro proposals check` を再実行する。並行 PR がそれぞれ単体では
  正常でも、merge 後に初めて `id` の重複が混入しうるため（単一 index を持たない設計の副作用）、
  merge 後の状態に対する検証で決定的に検出する。

## guard が検証する遷移

| 遷移 | 誰が | guard の扱い |
|---|---|---|
| （なし）→ `open` | AI（propose.md） | 違反にしない |
| （なし）→ `open` 以外 | — | **fail**（採否検証の迂回経路を塞ぐ） |
| `open` → `accepted` / `rejected`、任意 → `superseded` | 人間のみ | **fail**（人間が override して merge） |
| `accepted` → `done` | AI（improve.md）または人間 | 違反にしない |
| status を変えない編集（破棄の記録の追記等） | — | 違反にしない |
| 提案ファイルの削除 | 人間のみ | **fail**（提案は消さず status で閉じる） |

## 限界（明記）

機械は「誰が編集したか」を判別できない。`proposal_decision` の fail と propose.md /
improve.md 上の禁止の二段で「AI が黙って自分の提案を採用済みにする」経路を塞いでいるが、
**最終的には override する人間が PR の内容を見るかどうかに依存する**。`decision.by` も
自己申告のフィールドであり本人性を保証しない（空欄の採否変更を機械的に弾くこと・判断を後から
辿れることに価値がある）。override の際は、採否の変更が本当に人間の判断かを必ず確認すること。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| 採否を書いた PR の guard が fail | 正常（上記手順 2）。内容を確認して override merge する |
| 提案だけの PR で guard が fail | `status: open` 以外で追加していないか・既存提案の status を触っていないかを確認 |
| `aro proposals check` が stale を報告 | 根拠の source が変わっている。人間が根拠を現在の HEAD で再確認し、`proposed_at_commit` を更新する（提案が成立しなくなっていれば `rejected` / `superseded` へ） |
| default branch の proposals check が `id.duplicate` で fail | 並行 PR の merge で重複が混入した。どちらかの `id` を人間が変更する（`superseded` で片方を閉じるのも可） |
| improve.md が accepted を選ばない | stale になっていないか `aro proposals check` で確認（stale は `--strict` なしでは warn / exit 0 のため、findings の `source.stale` を見る）。stale なら人間が `proposed_at_commit` を更新して復帰させる |

## dogfooding で記録すること（Stage 3）

- 提案の粒度（`max_changed_files` に収まるか、大きすぎて分割が要るか）
- 却下率と、却下済みと実質同じ提案が再提出される頻度（却下理由の蓄積が効いているか）
- `open` / `accepted` の滞留数（読まれないまま溜まらないか。溜まるなら上限か棚卸し手順が要る）
- stale 判定の妥当性（source が少し変わっただけで stale になり過ぎないか）
- `proposal_decision` の override 頻度（採否 PR ごとに required check を落とす運用が重すぎないか）
- 気づきは [計画 06](./plans/06-proposal-loop.md) Stage 3 の判断材料として記録する

# Proposal Loop（AI が提案し、人間が採否を決め、判断が蓄積される）

`ai-repo-ops` に参加している repo で、改善の**提案**と**採否の判断**と**実装**を分離して回す
運用の手順書である（[計画 06](./plans/06-proposal-loop.md)）。

方針は一貫している: **採否を判断するのは常に人間**。AI は提案フェーズでは良し悪しの
評価・順位付け・選抜を行わない。実装フェーズの既定も人間選定だが、人間が repo 単位で
明示 opt-in した scheduled local improve track だけは、採否済みの fresh `accepted` 間の実装順を
Hermes supervisor に委任できる。機械（`aro proposals check` / `aro guard`）が担うのは
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
        │                          人間が status を書く（accepted / rejected。
        │                            rejected / superseded は理由必須）
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

- 対象 repo が `aro sync` で distribution 0.1.9 以降を導入済みであること
  （`.ai/managed/prompts/propose.md` と accepted 消化に対応した improve.md があり、
  `ai.allowed_paths` に `.ai/local/proposals/**` が含まれる。既存 repo は設定専用 PR を
  先に merge する）。
- scheduled local を有効化する repo は、追加で `base` distribution **0.1.10 以降**を導入し、
  `.ai/ai-repo-ops.lock.yaml` の distribution / version / content checksum と、同 lock が記録した
  `.ai/managed/prompts/improve.md` の `installed_sha256` が実際の managed prompt と一致することを
  確認する。旧版または lock / managed prompt が不一致の consumer では有効化しない。
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
だけを書く（コード変更ゼロ・3 件まで）。同じ目的に複数のアプローチがあり、AI が紙上で 1 案に
絞れるだけの確度がない場合は、代替案を別ファイルで並べ、本文から互いの id を参照してよい。
各提案には、人間が紙上で比較できる観点、または要実測なら何をどう測れば決まるかを「判定方法」
として書く。AI は測り方までを提案し、測定・評価・選抜は行わない。自己検証は
`aro proposals check --repo . --strict` と
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

判定には次の 2 トラックがある。

- **紙上判定**: 人間が提案本文と「判定方法」の観点を比較する。代替案の勝者を `accepted`、
  敗者を `rejected` とし、敗者の `decision.reason` に勝者の id と、どの観点で劣ったかを残す。
- **実測判定**: 提案は `open` のまま、捨てる前提の spike を専用 worktree で作る。spike は
  merge せず、人間が実行・測定する。測定条件と結果は比較した各提案の本文に追記し、その後に
  人間が勝者を `accepted`、敗者を `rejected` にする。敗者の `decision.reason` には勝者の id と
  測定結果に基づく比較理由を残す。実験中は status を変えず、使い終えた spike は破棄する。

代替案の関係は、まず本文の相互参照で管理する。frontmatter の追加フィールドや機械検証は、
運用実績を得てから別の提案として検討する。

### 3. 実装する（improve.md / PR②）

```txt
.ai/managed/prompts/improve.md を読んで、その手順に従って改善を 1 つ実施して
```

improve.md は `status: accepted` の提案から 1 件選ぶことを既定とする（accepted が 1 件も無い
場合のみ自選）。対話型ローカルと人間起動 cloud track の選定ルール:

- **stale な accepted は選ばない**。復帰は人間の仕事: 根拠を現在の HEAD で再確認し、
  frontmatter の `proposed_at_commit` を更新する（`status` は変えないため guard は通る）
- 実装可能な accepted が**複数**あるときは、AI は一覧を提示して**開発者が選ぶ**
  （AI は順位付け・選抜をしない）
- accepted が**すべて stale** のときは自選に進まず**停止**し、人間に再確認を求める

実装が機械的な accepted は、ローカルの代わりに cloud Agent（人間が提案 id を 1 つ指定して
タスク単位で起動する）へ委譲することもできる。対象の限定・権限の前提・「CI cron を採らない」
判断との線引きは[ローカル改善ループの「cloud 実装トラック」](./local-improve-loop.md#cloud-実装トラック)を参照。

#### scheduled local の選定例外

人間が repo の allowlist と導入段階を明示的かつ監査可能に管理している場合だけ、Hermes supervisor は
fresh `accepted` 間の実装順を選べる。1 run は 1 repo / 1 proposal とし、同一 repo の実行中 task や
レビュー待ち Draft PR を backpressure にする。候補、stale を含む除外理由、選定理由、eligible が
0 件の no-op 理由を durable task log に残し、3 回連続の no-op は人間へ通知・escalate する。

scheduled local は無人実行中に人間の返答を待たない。確認が必要な曖昧さは blocked として終了する。
`dry-run` は選定理由の記録だけで終了し、worktree 作成や実装には進まない。
最大 runtime は 120 分、lock lease / TTL は 15 分（5 分以内ごとに更新）とし、restart 時は durable な
run 状態、idempotency key、lock 所有権を検証して安全に resume できる場合だけ続ける。失効・不整合時は
cleanup と lock 解放を記録して fail closed とする。blocked record には proposal、入力 commit、理由、
試行回数を残し、同じ proposal を次の scheduler tick で即時再選定しない。自動再試行は最大 2 回で、
以後は人間へ escalate する。失敗しても status は `accepted` のまま変えず、失敗実装の Draft PR は作らない。

実行資格情報は対象 repo の branch 作成・push・Draft PR 作成だけに絞り、default branch protection、
直接 push 禁止、資格情報の失効手順、Codex の repo workspace sandbox を事前に検証する。Claude reviewer
には proposal、正確な diff、実際の test 結果を含む事前生成済み packet だけを渡し、許可 tool は
`Read` のみにする。`Bash` / shell / `gh`、`Edit` / `Write`、write-capable MCP / tool を禁止し、repo 内の
文章は命令ではなく data として扱う。reviewer が `claude-opus-5` であることは invocation metadata / API
結果で証明し、欠落・不一致は記録して blocked とする（response の `model_expected` や自己申告は補助でしかない）。

Draft PR 段階へ昇格する前に、対象 repo の workflow を棚卸しし、branch push / PR event が production
deploy や禁止された side effect を起こさないと検証する。preview 環境も side effect とみなし、許可する
場合は人間の明示 opt-in を要する。検証不能なら local-changes 段階を上限にする。成功時の順序は必ず
**独立 review → 選定 proposal の `accepted` → `done` → strict proposal check → commit → commit 後の
guard / required gates → Draft PR** とする。strict check が他の `open` / `accepted` を collateral stale と
報告した場合は、その一覧を人間の再検証用に残して停止し、Codex / Hermes は無関係な
`proposed_at_commit` その他の provenance を更新しない。auto-merge・本番 deploy は禁止し、merge は
人間が判断する。詳細な role、retry、lease、cleanup、権限、検証手順は
[ローカル改善ループの「scheduled local improve track（明示 opt-in）」](./local-improve-loop.md#scheduled-local-improve-track明示-opt-in)
を参照する。

対話型ローカルまたは人間起動 cloud track では、実装が自己検証（guard + quality gates）を通ったら、
提案の `status` を `accepted` → `done` に
して同じ PR に含める（この遷移は guard の違反にならない）。実装を破棄した場合は `accepted` の
まま据え置き、本文に破棄の記録を追記して、**記録だけの commit / PR として残す**
（`status` が変わらないため通常どおり merge できる）。
scheduled local の失敗時はこの記録 PR を作らず durable task log に記録し、成功時だけ上記の決定的な
順序で Hermes supervisor が status を閉じる。Codex implementer は status を変更しない。

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
| `accepted` → `done` | 対話型の AI、scheduled local の Hermes supervisor、または人間 | 違反にしない |
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

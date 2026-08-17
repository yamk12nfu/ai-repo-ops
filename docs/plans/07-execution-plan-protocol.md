# 計画 07: Execution Plan Protocol — repo が実行計画と権限段階を所有する

優先度: 最優先 / 前提: 計画 03・06 / 規模: 中

## できるようになること

| Before | After |
|---|---|
| scheduled-local の現在地と次操作が Hermes の外部設定・会話・GitHub Issue に分散する | 各 repo が `.ai/local/execution-plans/*.md` に現在地、次操作、許可された副作用を Git 管理する |
| supervisor が Markdown と運用文脈を独自解釈する | `aro plans check/status/next --json` の決定的出力を実行契約として使う |
| stage promotion が prompt 上の人間判断だけで、repo 内の監査対象にならない | promotion と権限拡大を guard が表面化し、人間の明示 review を要求する |
| ARO 固有の scheduled-local 設定でしか再利用できない | distribution を通じて warikapp 等の consumer も同じ protocol を使える |

## 価値仮説

AI 実行の計画・現在地・次操作・許可された副作用を repo-owned state として保持し、ARO CLI が
決定的に検証・解釈すれば、特定 scheduler や会話履歴に依存せず、別 session・別 agent・別 consumer
repo でも人間が承認した地点から安全に再開できる。

## 状態の正本

- **Execution Plan**: `.ai/local/execution-plans/*.md`。現在地、次操作、stage、許可された副作用。
- **Proposal**: `.ai/local/proposals/*.md`。個別改善の採否と freshness。1 Proposal = 1 実装 PR を維持する。
- **Run evidence**: host 側 durable run log。repo には run id と stage 完了の要約だけを記録する。
- **Managed protocol**: schema、prompt、policy。consumer は直接編集せず `aro sync` で受け取る。

GitHub Issue、Kanban、Discord は表示・通知・投入手段には使えるが、実行判断の正本にしない。

`docs/plans/README.md` と本書の「Stage 1〜5」は **ARO開発ロードマップ**上の実装工程であり、
consumer Execution Planの`current_stage`ではない。ロードマップの正本は`docs/plans/README.md`、
各consumerの実行状態の正本は`.ai/local/execution-plans/*.md`とし、両者を同期または転記しない。

## 基本形式

```text
.ai/
├── managed/
│   ├── schemas/execution-plan.schema.json
│   └── prompts/execute-plan.md
└── local/
    └── execution-plans/
        └── <plan-id>.md
```

Execution Plan frontmatter の最小概念:

```yaml
schema_version: 1
id: scheduled-local-runtime-rollout
status: active
current_stage: dry-run
next_action: implement-dry-run-runtime
updated_at: 2026-08-17
proposals:
  - execution-plan-protocol-foundation
permissions:
  commit: false
  push: false
  draft_pr: false
  merge: false
stages:
  - id: dry-run
    status: active
  - id: local-changes
    status: pending
  - id: remote-branch
    status: pending
  - id: draft-pr
    status: pending
```

`permissions.merge` は v1 では常に `false`。`active` plan は repo ごとに最大 1 件とする。

## Execution Plan v1 の状態契約

Plan statusは`proposed | active | blocked | completed | abandoned | superseded`、Stage statusは
`pending | active | blocked | completed`とする。許可する遷移は次のとおり。

| 対象 | 許可する遷移 | 備考 |
|---|---|---|
| Plan | `proposed -> active` | 人間の承認が必要 |
| Plan | `active <-> blocked` | blocked中は実行不可 |
| Plan | `active -> completed` | 全Stage完了後だけ |
| Plan | `proposed/active/blocked -> abandoned or superseded` | 人間の判断が必要なterminal遷移 |
| Stage | `pending -> active` | 直前Stageがcompletedの場合だけ。人間のpromotionが必要 |
| Stage | `active <-> blocked` | blocked中は実行不可 |
| Stage | `active -> completed` | DoDとevidenceが揃った場合だけ |

追加のinvariant:

- repo内の`active` Planは最大1件。複数なら自動選択せず`blocked`として返す。
- `active` Planは`active` Stageをちょうど1件持ち、`current_stage`はそのStage IDと一致する。
- `blocked` Planの`current_stage`は`blocked` Stageを指す。`next_action`は保持できるが実行不可。
- terminal Plan（`completed | abandoned | superseded`）はactive/blocked Stage、`current_stage`、`next_action`を持たない。
- 完了済みStageより前にpending Stageを残さず、Stage列を逆行させない。
- `permissions.merge: true`は常にinvalid。その他の`permissions`拡大は人間のpromotionとして扱う。

`next_action`がProposalを必要とする場合、そのactionが参照する`proposal_id`だけを実行可否判定の対象にする。
将来Stageのopen Proposalまで一括して現在Stageのblockerにはしない。対象Proposalは存在し、`accepted`で、
`proposed_at_commit`がHEADの祖先かつ全`sources[].path`がそのcommit以降未変更の場合だけfreshとする。
`proposed_at_commit`とHEADが異なるだけではstaleではない。Git object、HEAD、source、履歴を取得・判定できない
場合はstaleと推測せず`blocked`にする。不在、非accepted、stale、判定不能は別々の`runnable: false`理由として返す。

## 実装段階

### Stage 1: protocol foundation

期限上限: 2026-08-19

- authoritative `execution-plan.schema.json`
- `.ai/local/execution-plans/*.md` の discovery / parse / semantic validation
- `aro plans check --repo . [--strict] [--json]`
- `aro plans status --repo . [--json]`
- `aro plans next --repo . --json`
- distribution への managed schema 配布
- 新規 consumer の `ai.allowed_paths` に `.ai/local/execution-plans/**` を追加
- fixture consumer を含む TDD

Stage 1 は read-only。plan の作成・promotion・実装・commit・push・PR は行わない。

### Stage 2: promotion guard

期限上限: 2026-08-21

- `execution_plan_promotion` violation
- `proposed -> active`、stage 前進、`permissions` の拡大を人間 review 対象にする
- stage 据え置きの evidence 追記は許可する
- `merge: true` は拒否する

### Stage 3: Hermes runtime adapter

期限上限: 2026-08-24

- supervisor は、lockを取得した対象repoの絶対pathを使う
  `aro plans next --repo <absolute-repo-root> --json`だけを実行入力にする。cwdへ依存しない
- repo 別 lock / lease / run id / `BASE_SHA` / stop switch / durable evidence
- ARO を `DRY_RUN` から `LOCAL_CHANGES` へ段階導入する

### Stage 4: distribution dogfooding

期限上限: 2026-08-27

- distribution release -> self-sync -> consumer sync の順序を守る
- warikapp へ sync
- ARO と warikapp が別 stage を保持できることを確認する
- warikapp では最初に read-only `plans check/status/next` だけを実行する

### Stage 5: Draft PR Go / No-Go

期限上限: 2026-08-31

- 誤った main push 0
- guard 迂回 0
- evidence 欠損 0
- base drift 時の誤継続 0
- 解放不能 lock 0
- 人間が不適切と判断した自動選定と介入量を記録

結果は Go / No-Go のどちらでも repo に記録し、計画を `completed` または `blocked` に閉じる。

## Stage 1 DoD

- [ ] `plans check/status/next` が fixture と実 repo で実行できる
- [ ] active plan 0件、1件、複数件を決定的に扱う
- [ ] invalid schema、invalid stage、Proposal不存在・非accepted・staleを停止理由として返す
- [ ] `permissions` は現在stageと整合し、`permissions.merge: true`を拒否する
- [ ] 別repoをcwdにしても`--repo <absolute-repo-root>`で指定したrepoだけを評価する
- [ ] JSON 出力が Hermes 以外の caller からも利用できる
- [ ] distribution manifest と managed schema が同期する
- [ ] project/policy limits 内に収まる
- [ ] strict Proposal check、guard、schema、typecheck、全test、build が通る
- [ ] fresh Claude Opus 5 review で blocking finding 0

## 非スコープ

- 複数 active plan の自動優先順位
- plan 間 DAG / 条件式言語
- GitHub Issue / Projects との双方向同期
- fleet 横断集計
- 自動 stage promotion
- auto-merge / deploy / release
- lock や生ログの Git commit
- 汎用 workflow engine 化

## 実装規則

- 1実装PR = 1 accepted Proposal
- TDDで RED -> GREEN -> REFACTOR を記録する
- distribution の正本を変更し、consumer managed copyを直接編集しない
- distribution 変更後は release -> self-sync -> consumer sync を別工程で行う
- stage promotion、Proposal採否、mergeは人間だけが判断する

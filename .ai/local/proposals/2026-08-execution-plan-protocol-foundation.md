---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: execution-plan-protocol-foundation
status: done
proposed_at_commit: 87f4904c9040e61aa82b7208e3346da9e9d88eaa
sources:
  - path: "docs/local-improve-loop.md"
  - path: "docs/proposal-loop.md"
  - path: "distribution/base/manifest.yaml"
decision:
  by: "fooya"
  reason: "scheduled-local の計画・現在地・次操作を GitHub Issue や会話ではなく repo-owned state として保持し、warikapp 等の consumer へ配布できる共通 protocol として実装する方針を承認した。"
---

## 課題

scheduled-local improve の安全契約は distribution 0.1.10 に入ったが、runtime の現在地、次操作、
許可された副作用は Hermes の外部設定・会話・Kanban に分散している。GitHub Issueを進捗の正本に
すると clone、commit、guard、freshness 検証の対象外になり、repo の特定 revision と実行許可を
一致させられない。

また、ARO 固有の scheduler 設定だけで実装すると、warikapp などの consumer は同じ段階導入と
人間承認境界を再利用できない。

## 提案

各 repo が `.ai/local/execution-plans/*.md` に実行計画を所有し、ARO CLI が read-only で検証・解釈する
Execution Plan Protocol の Stage 1を実装する。

1. authoritative schemaで plan id、status、current stage、next action、Proposal参照、stage列、`permissions`を定義する。
2. `aro plans check` はschemaとsemantic invariantを検査する。
3. `aro plans status` はactive planと現在stageを返す。
4. `aro plans next` は実行可能性、next action、Proposal、許可された副作用、blockerをJSONで返す。
5. active planはrepoごとに最大1件とし、複数なら自動選択せずblockedにする。
6. 現在のnext actionが参照するProposalが不存在、非accepted、stale、またはfreshness判定不能なら、
   それぞれ別の理由で`runnable: false`にする。将来StageのProposalは現在actionの判定対象にしない。
7. Proposalは`proposed_at_commit`がHEADの祖先で、全`sources[].path`がそのcommit以降未変更の場合だけfreshとする。
   commitとHEADが異なるだけではstaleにせず、Git object・HEAD・source・履歴を取得できなければblockedにする。
8. `permissions.merge: true` はv1で常に拒否する。
9. managed schemaと新規consumerのallowed pathをdistributionから配布する。

Stage 1はread-onlyであり、plan作成、stage promotion、実装、commit、push、PRを行わない。
promotion guardとHermes runtime adapterは、Stage 1の実測後に別Proposal・別PRで実装する。

## 想定する変更範囲

- `packages/aro-cli/src/core/execution-plans.ts`
- `packages/aro-cli/src/commands/plans.ts`
- 上記のテストとCLI登録
- `schemas/execution-plan.schema.json`
- `distribution/base/files/.ai/managed/schemas/execution-plan.schema.json`
- `distribution/base/manifest.yaml`
- `distribution/base/templates/project.yaml.hbs`
- `CHANGELOG.md`
- 本Proposalの `accepted -> done`

project/policyの10ファイル・400追加行上限に収める。収まらない場合は変更を広げずblockedとして記録し、
人間が分割を判断する。

### 人間承認済みの今回限りの変更予算例外（2026-08-17）

Stage 1のTDD試行では、schema・CLI・tests・distributionの一部だけで約647追加行に達し、未実装の
schema/distributionを含めると既定の10 files / 400 added linesへ収めるには、検証可能な中間状態を
壊す人工的なPR分割またはテスト省略が必要になることが実測された。

fooyaは本Proposalの実装PRに限り、次の変更予算を明示承認する。

- `max_changed_files: 14`
- `max_added_lines: 1200`
- 理由: schema、CLI、tests、distributionを同一revisionで整合させ、TDDとconsumer fixtureを省略しないため

この例外が緩和するのは変更ファイル数と追加行数だけである。allowed/forbidden paths、managed file、
workflow、project config、Proposal遷移、strict check、quality gates、独立review、人間mergeの境界は
一切緩和しない。他Proposalや再利用可能な一般権限として扱わない。

AROは後続Proposalで、merge-base側の人間承認済みProposalからだけ予算を読み、実装PRによる自己増額を
拒否するProposal単位change budgetを実装する。この機構をscheduled-local Stage 3開始前の必須gateとする。

## 判定方法

- TDDでinvalid/valid fixtureから開始し、各テストが実装前に期待理由で失敗する。不在、非accepted、stale、
  freshness判定不能、複数active Plan、状態invariant違反、`permissions.merge: true`を個別fixtureで検証する。
- `plans check/status/next` のtext/JSON契約をfixtureとself repoで検証する。
- 既存Proposal check、guard、schema、typecheck、全test、buildを通す。
- distribution syncのfixture testを通す。
- fresh Claude Opus 5がread-onlyで最終diffをレビューし、blocking finding 0を確認する。

## リスク・見送る理由になりうる点

- Proposal LoopとExecution Planの責務が重なると、1 Proposal = 1実装PRの境界が曖昧になる。Planは複数の
  Proposalとstageの順序だけを持ち、採否を変更しない。
- schemaを早く固定しすぎるとconsumer migrationが必要になる。v1は1 active plan・直列stage・単一next actionに限定する。
- Markdown本文までworkflow DSLとして解釈すると複雑化する。機械が読むのはfrontmatterだけに限定する。
- distribution変更とself-syncを同一PRにするとtrusted syncに失敗するため、release後の別PRに分ける。
- 一律の10 files / 400 linesは大型横断機能を人工分割させる。既定値はroutine自律改善向けに維持し、
  大型変更は人間承認済みProposal単位budgetで扱う必要がある。

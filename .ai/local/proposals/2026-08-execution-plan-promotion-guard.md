---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: execution-plan-promotion-guard
status: accepted
proposed_at_commit: 661f270bf54647093553e6269afa0565655cdb5b
sources:
  - path: "docs/plans/07-execution-plan-protocol.md"
  - path: "packages/aro-cli/src/core/execution-plans.ts"
  - path: "packages/aro-cli/src/commands/guard.ts"
decision:
  by: "fooya"
  reason: "Stage 3の前提としてself-promotionをmerge-base基準で検出するStage 2を承認する。提案記載の遷移境界と、実装PRに限るmax_added_lines: 800の変更予算例外を含む。"
---

## 課題

Execution Plan Protocol Stage 1で `aro plans check/status/next` とschema・semantic invariantは実装されたが、
現在の検証は単一revisionの状態が有効かを判定するだけで、baseからHEADへの遷移を誰が承認したかは
検証しない。`.ai/local/execution-plans/*.md` がallowed pathに含まれるconsumerでは、AI自身が
`proposed -> active`、stage前進、`permissions`拡大を書き込んでも、最終状態がschema上有効なら
既存guardはその権限拡大を表面化できない。

Stage 3でHermes runtime adapterが `aro plans next --json` を実行入力にする前に、Planのactivation、
stage前進、実行可能な副作用の拡大を、Proposal採否と同じくmerge-base基準の遷移として検出し、
人間が明示的にreviewする境界が必要である。一方、同じstageのままrun evidenceや本文、`updated_at`、
`next_action`を更新するだけの記録まで違反にすると、通常の実行記録が毎回overrideを要求する。

## 提案

`aro guard` に `execution_plan_promotion` violationを追加し、
`.ai/local/execution-plans/*.md` のmerge-base側とHEAD側を比較して、次の遷移を人間review対象として
表面化する。

1. Planの `proposed -> active` と `blocked -> active`。
2. Stageの `pending -> active`、`blocked -> active`、`active -> completed`などの前進・再開。
3. `permissions.commit/push/draft_pr` の `false -> true`。
4. PlanまたはStageのterminal化、既存Stageの削除・ID変更など、履歴を閉じるか書き換える不可逆変更。
5. 新規Planが `proposed`、全Stage `pending`、全permission `false` 以外の状態で追加された場合。
6. Planファイルの削除、またはbase/HEADいずれかのfrontmatterを遷移判定に必要な範囲で読めない場合。
7. `permissions.merge: true` はbaseからの拡大かどうかに関係なく常にfailとする。

状態・権限・Stage列が不変の本文/evidence、`updated_at`、`next_action`の更新、
`active -> blocked`のような安全側への停止、permissionの `true -> false` は
`execution_plan_promotion` にしない。Stageの追加は末尾への `pending` 追加だけを許可し、既存履歴の
削除・並べ替え・置換とは区別する。

統合方法は既存のProposal遷移検証と同型にする。`guard` commandがworking treeではなく
merge-base revisionと`HEAD` revisionのPlanを読み、純粋な遷移判定をcoreへ渡す。policyも既存どおり
merge-base側から読むことで、PR自身がPlanやpolicyを書き換えて検出を迂回するself-modificationを防ぐ。
旧distributionのpolicyに新kindが未記載でも、未定義kindをfailとする既存契約を使いfail closedにする。
managed policyやworkflowの配布変更はこの実装PRに含めず、severityの明記は後続distribution releaseで
行う。

Stage 2はpromotionの検出と人間reviewへの表面化までとする。Plan作成コマンド、自動promotion、
DoD/evidence本文の意味判定、Hermes runtime adapter、commit/push/draft PR実行は実装しない。

## 判定方法

紙上判定では、次の境界を人間が確認する。

- activation・再開・stage前進・権限拡大・terminal化・履歴書き換えがすべて
  `execution_plan_promotion` として列挙される。
- 状態不変のevidence追記、安全側へのblock、permission縮小は違反にならない。
- `permissions.merge: true` は既存値でも新規値でも必ずfailする。
- 判定元はmerge-baseとcommitted `HEAD`であり、working treeやPR側policyに依存しない。
- 1ファイルに複数の遷移がある場合、overrideする人間が承認対象を把握できるよう全件を決定的順序で返す。

実装時はTDDで、各許可・違反遷移、新規追加、削除、unreadable、Stage履歴変更、merge絶対拒否を
core unit testにする。実git fixtureを使うcommand integration testで、baseにPlanをcommitした後の
promotionがfailし、状態不変のevidence追記だけならpassすることを確認する。最終的に
`aro proposals check --strict`、`aro guard`、schema check、typecheck、全test、buildを通し、
fresh Claude Opus 5 reviewでblocking finding 0を確認する。

## 想定する変更範囲

- `packages/aro-cli/src/core/execution-plan-promotion.ts`（新規の遷移判定）
- 上記coreのunit test
- `packages/aro-cli/src/core/guard.ts`
- `packages/aro-cli/src/commands/guard.ts`
- guard commandのintegration test
- `docs/guard.md`
- `CHANGELOG.md`
- 本Proposalの `accepted -> done`

8ファイル前後で `ai.max_changed_files: 10` には収まる見込みだが、遷移表のunit testと実git fixtureを
省略せず実装すると、default policyの `max_added_lines: 400` を超え、600〜800行程度になる可能性が高い。
採用する場合は、実装を人工分割して検証可能な境界を失わせるか、テストを削るのではなく、本Proposalの
実装PRだけに限定した `max_added_lines: 800` 以下の変更予算例外を人間が明示承認するかを判断する。
例外が緩和するのは追加行数だけで、allowed/forbidden paths、managed file、workflow、project config、
promotion検出、quality gates、人間mergeの境界は緩和しない。

## リスク・見送る理由になりうる点

- Plan/Stage/permissionの複数軸を比較するため、Proposal statusだけの遷移検証より誤検知が増え、
  人間のoverride負荷が高くなる可能性がある。特に `active -> completed` とterminal化を毎回review対象に
  する厳格さが、運用頻度に見合うかは採否時の判断点である。
- guardは承認を自動判定するのではなく、failとして人間reviewを要求する。branch protectionのoverrideを
  誰でも行える設定では、組織側の権限制御なしに完全な強制境界にはならない。
- DoDやevidence本文の妥当性は判定しない。Markdown本文までworkflow DSLとして解釈するとStage 2の
  スコープを超え、誤判定とschema固定化を招く。
- `next_action`や参照Proposalの差し替えは、状態・権限が不変ならpromotion違反にしない。
  Stage 1のfreshness/accepted判定で未採用作業はrunnableにならないが、accepted Proposal間の差し替えを
  人間review対象にすべきなら遷移表を広げる必要がある。
- guardはcommitted `HEAD`を比較するため、未commit変更には効かない。実装・運用は既存契約どおり
  check、commit、guardの順序を守る必要がある。
- 新kindを既定failに任せると旧policyでも安全側に動く一方、policyファイルだけでは意図が見えない。
  distributionへのseverity明記をどのreleaseで配るかは別途決める必要がある。
- 400行上限を維持する判断の場合、遷移分類とintegration testを同一PRで完結できない可能性がある。
  その場合は本提案をそのまま採用せず、検証可能な分割境界または予算例外を人間が先に決める必要がある。

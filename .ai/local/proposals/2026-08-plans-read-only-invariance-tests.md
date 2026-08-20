---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: plans-read-only-invariance-tests
status: open
proposed_at_commit: 3a26046d991638b90bfe9de4c460fe46067630dc
sources:
  - path: packages/aro-cli/src/commands/plans.ts
  - path: packages/aro-cli/src/core/execution-plans.ts
  - path: packages/aro-cli/src/core/filesystem.ts
  - path: packages/aro-cli/src/core/git.ts
  - path: packages/aro-cli/src/core/git-tree.ts
  - path: packages/aro-cli/src/core/knowledge-check.ts
  - path: packages/aro-cli/src/core/knowledge-git.ts
  - path: packages/aro-cli/src/core/paths.ts
  - path: packages/aro-cli/src/core/proposal-frontmatter.ts
  - path: packages/aro-cli/src/core/yaml.ts
  - path: packages/aro-cli/src/__tests__/cli-scaffold.test.ts
  - path: packages/aro-cli/src/test-support/distribution.fixture.ts
  - path: packages/aro-cli/src/test-support/git.fixture.ts
---

## 課題

`aro plans check / status / next`はCLI上「読み取り専用」として公開されている。現在のapplication codeは
Execution Plan、Proposal、tracked source、Git treeを読み取って検証し、trackedなrepo contentや`HEAD`を
変更する処理を持たない。委譲先のfilesystem、Git tree、Knowledge、YAML、Proposal helperもsourceとして
追跡する。ただし、`git diff`等の読み取りcommandがindexのstat情報を更新する可能性までは否定せず、
`.git/**`のraw bytes全体が不変という意味ではない。既存のCLI testは3 commandの出力、schema/invariant、
Proposal freshness、blockerを広く検証している。

一方、testは実行前後のExecution Plan／Proposal bytes、`HEAD`、working tree状態が不変であることを
直接assertしていない。
将来、runtime adapterや補助処理を同じmoduleへ追加した際に、read-only commandへ意図しない書き込みが
混入しても、現在の結果中心のtestだけでは検出できない可能性がある。

## 提案

既存の`plans check / status / next` CLI testへ、読み取り専用契約の不変性testを追加する。

1. `initRealGitRepo`を使ってtracked sourceをcommitし、そのSHAを`proposed_at_commit`に持つfreshな
   accepted Proposalと、そのProposalを`next_action.proposal_id`で参照するactive Execution Planを作る。
2. ProposalとPlanも`gitCommitAll`でbaseline commitへ含め、`git status --porcelain`が空であることを確認する。
3. command実行前にExecution PlanとProposalのraw bytes、`HEAD`、porcelain statusを記録する。
4. `check`、`check --strict`、`status`、`next`をそれぞれ実行する。各呼び出しが期待する成功codeと
   structured resultを返したことを先にassertし、strict/nextではProposal freshnessのGit読み取り経路も通す。
5. 各成功実行の直後にPlan／Proposal bytes、`HEAD`、porcelain statusが実行前と同一であることをassertする。
6. promotion・commit・working tree cleanupなどのmutation機能は追加しない。

4呼び出しを1つのparameterized testへまとめるか個別testにするかは、失敗時にcommandを特定しやすい方を
実装時に選ぶ。Git metadataの時刻など不安定な全体snapshotは避け、契約に必要なPlan／Proposal bytes、
`HEAD`、porcelain statusだけを比較する。このtestが保証するのは代表的なvalid/fresh経路におけるtracked
repo contentと`HEAD`の不変性であり、refs、config、reflog、notes、stash、index stat等のGit内部metadata
全般や、stale／missing／ambiguous／undeterminableの全blocker分岐までは対象にしない。

## 判定方法

次を満たす場合に採用可能と判断する。

- Proposal、Plan、sourceを含むcleanなbaseline commitから`check`、`check --strict`、`status`、`next`を
  正常終了させ、Plan／Proposal bytes、`HEAD`、porcelain statusの不変性を再現可能に検証できる。
- 各不変性assertionは期待する成功codeとresultを確認した後に実行し、commandの早期失敗による空振りを防ぐ。
- strict/nextはfresh ProposalのGit読み取り経路を通る。
- test追加のためにproduction codeを変更しない。
- 既存のplans command testと全quality gatesが通る。
- filesystem全体や`.git/**`のraw snapshotに依存せず、OS差や実行時刻によるflaky testを生まない。
- production codeを変えず契約を十分に回帰検証できるならCLI不変性testを選び、書き込み依存を構造的に
  禁止するproduction境界が必要ならarchitecture testを別提案として検討する。

## 想定する変更範囲

- `packages/aro-cli/src/__tests__/cli-scaffold.test.ts`
- 必要ならtest helperのみ。production code、schema、distributionは変更しない。

## リスク・見送る理由になりうる点

- 現行実装には書き込みAPIがなく、実害は確認されていないため優先度は低い。
- 4呼び出しが同じread-only coreを共有しているため、個別testは重複になる可能性がある。
- Git status比較を雑に実装すると、test自身が作るfixtureや一時fileを差分として拾いflakyになる。
- 代表的なvalid/fresh経路だけを対象とするため、blocker分岐やGit内部metadataへの副作用は検出しない。
  それらの具体的な回帰リスクが生じた場合は、対象分岐またはarchitecture境界を別途提案する。
- runtime adapterを別module・別commandとして実装し、read-only moduleへの書き込み依存をarchitecture testで
  禁止する方が保守性に優れる可能性もある。実装前に最小の回帰testとarchitecture境界のどちらが適切か比較する。

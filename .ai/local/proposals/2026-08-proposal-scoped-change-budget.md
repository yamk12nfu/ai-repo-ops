---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: proposal-scoped-change-budget
status: accepted
proposed_at_commit: 6a2ed1031f17c685b2675e586b310bcf1f0c12d8
sources:
  - path: "docs/plans/07-execution-plan-protocol.md"
  - path: "packages/aro-cli/src/core/guard.ts"
  - path: "packages/aro-cli/src/core/proposal-decision.ts"
  - path: "packages/aro-cli/src/core/proposal-frontmatter.ts"
  - path: "packages/aro-cli/src/core/policy.ts"
  - path: "schemas/proposal.schema.json"
decision:
  by: "fooya"
  reason: "Stage 3のwrite stage前提として、merge-base上の人間承認済みProposalだけから数値予算を認証し、AIの自己増額を拒否する設計を承認する。policy ceilingはmedium 20 files / 1600 added lines、low-risk 40 files / 4000 added lines、high-riskはbaselineを超える緩和なしとする。本Proposalの初回実装PRに限りbootstrap予算27 files / 1200 added linesを承認する。実装差分21 files / 1000 added linesに加え、accepted -> done、collateral stale 5 Proposalの人間revalidation、独立reviewで不足が判明したbudget認証拒否testsを同一revisionへ含めるための改訂であり、他のProposalへ再利用しない。緩和対象はファイル数と追加行数だけで、path、managed file、workflow、Proposal/Plan遷移、strict check、quality gates、独立review、人間merge、release/deploy境界は変更しない。done Proposalを再accepted化してbudgetを再利用せず、再実装は新規Proposalで扱う。"
---

## 課題

Execution Plan Protocol Stage 3は、scheduled-localのwrite stageを開始する前提として、
「merge-base側の人間承認済みProposalだけから大型変更予算を取得し、AIの自己増額を拒否する」
Proposal単位change budgetを要求している。しかし現在の`aro guard`は、merge-base側の
`.ai/project.yaml`とpolicyからrepo共通の上限を読むだけで、個別Proposalに対する人間の限定承認を
機械的に解釈できない。

実際に`execution-plan-protocol-foundation`と`execution-plan-promotion-guard`では、schema、CLI、tests、
distributionを一つの検証可能なrevisionで揃えるため、既定の10 files / 400 added linesを超える今回限りの
予算を人間がProposal本文または`decision.reason`で承認した。この散文記録は監査には残るが、guardは
「事前承認済みの大型変更」と「実装PR内でAIが追加した自己増額」を決定的に区別できない。

repo全体の既定上限を恒久的に引き上げるとroutine改善の行動半径まで広がり、反対に大型変更を数値へ
収めるためだけに人工分割すると、schema・parser・guard・tests・distributionの整合性やテスト品質を
損なう。Stage 3 runtime adapterに散文解釈や独自のbudget引数を持たせず、既存guardのmerge-base信頼境界で
個別承認を認証する必要がある。

## 提案

Proposal frontmatterへoptionalな`decision.budget`を追加し、`aro guard`がmerge-base上で
人間承認済みだった唯一の実装対象Proposalからだけ数値上限を取得する。

### 1. Proposal schema

`decision.budget`は次の厳密なmappingとする。

```yaml
decision:
  by: "fooya"
  budget:
    max_changed_files: 15
    max_added_lines: 1200
    reason: "schema・CLI・tests・distributionを同一revisionで整合させるため"
```

- `max_changed_files`: optional、1以上の整数
- `max_added_lines`: optional、0以上の整数
- 少なくとも一方の数値軸を必須とする
- `reason`: 必須かつ空白以外を含む文字列
- 未知fieldを拒否する
- budgetは`status: accepted | done`でだけ許可し、`open | rejected | superseded`では拒否する

`open`でbudgetを許すと、通常の提案追加PRでbudgetを先に置き、後続decision PRではstatusだけを変える
密輸経路が生まれる。`done`で保持を許すのは、正常な実装PRが`accepted -> done`と同じbudgetを同一PRに
含める既存契約のためである。

### 2. 実装対象Proposalの決定

guardがすでに収集するmerge-baseとcommitted `HEAD`のProposal遷移から、base側が`accepted`かつ
HEAD側が`done`のものを実装対象候補とする。

budgetを適用できるのは、`--base`にbranch名ではなくfull `BASE_SHA`が渡され、解決したmerge-baseが
そのSHAと完全一致する場合だけとする。branch refをbaseにした通常CIやstacked PRではbudgetを不適用にし、
未mergeの親branchに置かれたbudgetを「人間承認済み」と誤認しない。scheduled-local supervisorは
run開始時にdefault branchからpinした`BASE_SHA`を渡し、ローカル対話実装でもbudgetを使う場合は
fetch済みdefault branchのfull SHAを固定して使う。

候補のbase側frontmatterは`proposalFrontmatterSchema`で完全にparseし、schema不適合、
`decision.by`が空、budget不適合のいずれかなら認証しない。status遷移の検出自体は従来どおりlenientに
statusだけを読むが、budget認証だけは人間判断の痕跡を含むstrictなProposal全体を要求する。

判定は次の優先順位で行う。

1. 対象Proposalにbudget付与・変更・削除・不正値を含む`proposal_decision`があれば、他の分岐より優先して
   budgetを`rejected`とし、既定上限を使う。
2. 該当0件: budgetを適用せず既定上限を使う。
3. 該当2件以上: 合算・最大値選択をせずbudgetを拒否し、既定上限を使う。
4. 該当1件・base側budgetなし: 一意なProposal id / pathは出力するが、budgetは`not_applicable`とし既定上限を使う。
5. 該当1件・base側budget有効: policy ceilingとの合成へ進む。
6. base側budgetを解釈不能: budgetを拒否し既定上限を使う。

複数候補をfail closedにすることで、複数Proposalのbatchingによる予算合算を防ぎ、
`1 Proposal = 1 implementation PR`を維持する。budgetの取得元は必ずmerge-base側frontmatterとし、
HEAD・working tree・branch ref・環境変数・Hermes worker入力からは取得しない。

### 3. budget変更の人間判断化

`proposal_decision`の内容比較をstatusだけでなくbudgetまで広げ、次をすべて既存の
`proposal_decision` violationとして表面化する。

- budgetの新規付与
- 数値またはreasonの変更
- budgetの削除
- budgetのparse不能
- 新規Proposalファイルへのbudget混入

baseとHEADでbudgetが深い等価なら違反にせず、同じbudgetを保持した`accepted -> done`を正常な実装遷移として
許可する。これにより、statusを変えない本文編集が許可される既存経路を使った静かな自己増額を防ぐ。
budgetは採否判断の一部なので新しいviolation kindを増やさず、既存の人間override境界へ統合する。
ただしbaseまたはHEADに`decision.budget` keyがあり、その値がbudget schemaに適合しない場合は、
両側の生データが等しくても必ず`proposal_decision`にする。壊れたbudgetを既定上限へ黙って倒し続ける
恒久状態を作らない。

### 4. policy-owned ceiling

policyの`change_limits`へ、Proposal承認でも超えられないoptional ceilingを追加する。policy parserは、
同じ軸のroutine limitとceilingが両方ある場合に`budget_ceiling >= routine limit`を必須とし、逆転した
policyを不正として拒否する。これによりbudget付きPRだけがbaselineより不利になる非単調な設定を防ぐ。

```yaml
change_limits:
  max_changed_files: 10
  max_added_lines: 400
  budget_ceiling:
    max_changed_files: 20
    max_added_lines: 1600
```

数値軸ごとに独立して次の規則を適用する。

1. まずbaselineを現行どおり求める。filesは`min(project.ai.max_changed_files, policy.max_changed_files)`、
   linesは`policy.max_added_lines`とする。
2. 認証済みbudgetがない軸、またはbudgetが指定しない軸はbaselineをそのまま使う。
3. requestedがbaseline以下なら緩和ではないため、ceilingの有無にかかわらずrequestedを実効上限にする。
   baselineが未定義ならrequestedを新しい厳しい上限として適用する。
4. requestedがbaselineを上回る場合だけpolicy ceilingを要求する。ceilingがなければbudgetを不発にして
   baselineへ戻し、ceilingがあれば`min(requested, ceiling)`を実効上限にする。
5. 認証済みbudgetが緩和する軸では、Proposalによる人間の個別承認がroutine用のproject/policy上限を
   置換し、policy ceilingだけを外枠とする。これは「project設定はpolicyを緩められない」という既存契約を
   projectが迂回するものではなく、merge-base上の人間承認済みProposalという別の信頼入力による限定例外である。

初期値はmedium policyで20 files / 1600 lines、low-risk policyで40 files / 4000 linesを候補とし、
high-risk policyにはceilingを配らず、baselineを超える個別budget緩和を無効にする。baseline以下の
厳格化はceilingなしでも適用する。最終値はaccept時に人間が判断し、repo共通のroutine上限は変更しない。

### 5. 出力契約

JSON reportのトップレベルへ、呼出しに使ったbase入力と解決済みfull merge-base SHAを常に返す。
さらに`budget`を追加し、少なくとも次を返す。

- `status`: `not_applicable | applied | rejected`
- `reason`: 不適用・拒否理由
- 一意な実装対象候補がある場合は、budgetの有無やstatusにかかわらずProposal idとpath
- 候補0件または複数件では`proposal: null`
- `requested`、policy `ceiling`、実際の`applied`

human出力にも一意な候補がある場合はProposal id / pathを含む1行の`Budget:`要約を出す。budget適用後も上限を超えた`too_many_files` /
`too_many_added_lines`は、既存kindとpolicy severityを維持し、violationの`limit`には実効値を入れる。
新しいCLI flagは追加しない。

### 6. 緩和しない境界

budgetが変更できるのは`too_many_files`と`too_many_added_lines`の数値だけである。次は一切緩和しない。

- allowed / forbidden paths
- managed file、workflow、project config
- `proposal_decision`、`execution_plan_promotion`
- trusted sync認証
- strict Proposal checkと全quality gates
- 独立review、人間merge、release・deploy境界
- `permissions.merge: true`の絶対拒否
- AI loop回数や、現在存在しない削除行数等の軸

### 7. bootstrapとrollout順序

この機構自身の実装PRでは、merge-baseにもreleased CI engineにも新schema・budget認証が存在しない。
そのため本Proposal自身へ新形式の`decision.budget`を書いても旧strict checkが拒否し、自己適用できない。
初回だけは既存2件と同じ散文形式で実装予算を人間がdecision PRに明示し、次の順序を固定する。

1. 本Proposalをacceptし、今回限りの実装予算を散文で承認するdecision PR
2. TDDによる実装PR
3. releaseと`v1`移動。ここからself repoとconsumer CIのengineは新budget schemaを解釈できる
4. self-sync PRでmanaged schema / policyを追随し、self repoでbudget緩和を有効にする
5. consumerはdistribution sync後にbudget緩和を利用する。policy未syncならceilingがなく緩和は不発とする
6. 古いローカルCLIは新budget schemaを拒否するため、budget付きProposalを扱う前に更新する

本Proposalの実装予算は、当初見積り22 files / 1000 added linesから、実装・独立review後の
人間decisionで最大27 files / 1200 added linesへ改訂した。これは
schema、parser、proposal transition、guard core/command、policy、既存test群、docs、distribution、
Proposalのdone化、collateral stale revalidationを一つの整合したPRへ含めるためのbootstrap例外である。
accept時に人間が数値と理由を確定し、`decision.reason`へ記録する。

### 8. Stage 3 runtimeとの責務分離

本Proposalはguardによるbudget認証・合成・検証・出力だけを扱う。runtime adapterはbudgetを解釈せず、
従来どおりpinned baseに対する`aro guard --json`を実行し、warning / failureがあれば停止する。
runtimeは同一性境界として、guardトップレベル出力のmerge-base SHAがrun開始時にpinした`BASE_SHA`と
一致することを常にassertする。一意な実装対象候補がある場合は、そのProposal idも自分の選定した
proposal idと一致することをassertする。候補がnullまたは複数、id不一致、SHA不一致はblockedとする。
budgetを持たない通常のaccepted Proposalでも、`accepted -> done`が一意ならidは出力される。
`aro plans check/status/next`、lock / lease、run id、stop switch、durable evidence、worker orchestrationは
後続Proposalの責務とする。

## 判定方法

採否時に人間は、次の紙上境界を確認する。

- `decision.budget`を`accepted | done`だけに限定することで、open Proposal経由の密輸を防げるか
- 唯一の`accepted -> done`遷移で実装対象を同定することが、既存improve契約と一致するか
- budgetの付与・変更・削除・parse不能をすべて`proposal_decision`にすることが過不足ないか
- 複数の`accepted -> done`でbudgetを適用しないことが、1 Proposal = 1 PRの境界として妥当か
- medium 20/1600、low-risk 40/4000、high-risk無効というceiling候補が妥当か
- bootstrap実装予算27 files / 1200 linesと、release -> self-syncの順序を承認するか
- done Proposalを再びacceptedへ戻してbudgetを再利用するのではなく、差し戻しは新規Proposalで扱う運用にするか

実装時のacceptance criteriaは次のとおりとする。

1. 意味検証の正本であるzodで、有効な両軸・片軸、空budget、reason欠落・空白、未知key、負値、非整数を検証する。
   JSON Schemaはeditor・外部consumer向けのdraft-07契約として同じ構造とstatus条件を表現し、authoritativeと
   managed copyのバイト一致をschema checkで検証する。zodとの意味上の構造一致はtestsと人間reviewで担保する。
   内蔵の限定JSON Schema validatorへ`if/then/not/allOf`実装を追加することは本Proposalの範囲外とする。
2. zodを使うstrict Proposal checkで`open | rejected | superseded`のbudgetを拒否し、`accepted | done`では許可する。
3. budget不変、付与、変更、削除、parse不能のProposal遷移表をunit testで網羅する。
   baseとHEADの双方に同じ不正budgetがある場合もviolationになることを含む。
4. `accepted -> done`が0件、budgetなし1件、有効1件、不正1件、複数件、full SHA以外のbase指定、
   merge-base不一致の導出を個別に検証する。空の`decision.by`を持つbase Proposalも拒否する。
5. ceiling内適用、ceiling超過の切詰め、片軸、ceilingなし、既定より厳しいbudgetを軸ごとに検証する。
   high-riskのceilingなしpolicyでもbaseline以下の厳しいbudgetは適用され、ceilingがroutine limitを下回る
   policyはparse時に拒否されることを含む。
6. budget適用下でもpath、managed、workflow、project config、Proposal / Plan遷移、trusted syncの判定が変わらない。
7. 実git fixtureで、baseにbudget付きaccepted Proposalを置き、done化と大型diffを含むPRについて、
   `report.budget`と`too_many_*`のkind / limit / actualを検証する。medium policyのwarnによるexit codeへ依存しない。
   さらにbaseにbudgetなし、HEADで自己増額してdone化した同一実行で、`proposal_decision`、
   `budget.status: rejected`、既定実効limitの`too_many_*`が同時に成立することを検証する。
8. budgetを持たない既存repoとProposalの全テストが後方互換で通る。
9. human / JSON出力が一意な候補のProposal id / path、トップレベルのbase入力 / full merge-base SHA、
   requested / ceiling / applied、不適用・拒否理由を決定的に返す。候補0件・複数件ではproposalをnullにする。
10. schema check、strict Proposal check、guard、typecheck、全test、buildを通す。
11. fresh Claude Opus 5のread-only敵対レビューでblocking findingが0件になる。

## 想定する変更範囲

- authoritative proposal schemaとdistribution managed schema
- proposal frontmatter parserとtests
- proposal decision transitionとtests
- policy parser、distribution policy、tests
- guard core / command / formatterとtests
- `docs/guard.md`（project/policy baselineとProposal例外の関係を含む）、`docs/proposal-loop.md`
- authoritative `distribution/base/files/.ai/managed/prompts/improve.md`と関連prompt tests
  （budgetを使うguardではfetch済みdefault branchのfull SHAを固定する。selfのmanaged copyはrelease後のself-syncで追随）
- distribution manifest、`CHANGELOG.md`
- 本Proposalの`accepted -> done`
- source共有によりstale化するProposalがあれば、人間確認後のprovenance更新

約20 files / 650 added linesを見込む。通常の10 files / 400 linesへ収めるためにschema保護とguard適用を
分断したり、境界テストを削ったりせず、accept時にbootstrap予算を確定する。

## 非スコープ

- allowed_pathsその他の非数値境界の緩和
- 複数Proposalのbudget合算・最大値選択
- `aro plans next`へのbudget表示
- runtime adapter、scheduler、lock、lease、credential、evidence実装
- 削除行数や実行時間など新しいbudget軸
- release、self-sync、consumer syncを本実装PRへ同梱すること

## リスク・見送る理由になりうる点

- Stage 3 scheduled-local write runtimeを中止するなら、対話運用では散文承認と人間reviewで足り、機械化の保守コストが利得を上回る。
- release前のengineまたは古いローカルCLIで新budget形式を書くとstrict checkがfailする。`v1`移動後のconsumer CIは新schemaを読めるが、policyを未syncならceilingがなくbudget緩和は不発になる。
- budget認証をfull `BASE_SHA`指定時に限定するため、branch refを渡す既存CIではbudgetを適用しない。managed improve promptはbudget利用時にdefault branchからfull SHAをpinする手順へ更新する。
- full SHAであること自体は、そのcommitがdefault branch由来であることを証明しない。pin元の正しさはHermes supervisorまたは対話運用者の信頼責務であり、guardはmerge-base一致までしか機械検証しない。
- AIが実装と無関係なbudget付きaccepted Proposalをdone化して予算だけ流用する意味的不正は、guardだけでは完全に判定できない。PR差分と人間reviewが最終防衛になる。
- 複数`accepted -> done`はbudget不適用になるが、それ自体を新しいviolationにはしない。運用上必要なら別Proposalで検討する。
- ceiling値が大きすぎればroutine上限との分離が形骸化し、小さすぎれば人工分割を解消できない。既存2件の実測と今後のdogfoodingで再評価する必要がある。
- reasonだけの変更も人間override対象になるため、説明文の軽微な修正でCIを落とす厳格さが負担になる可能性がある。
- docs変更により、同じsourceを持つopen / accepted Proposalがstaleになる可能性があり、実装PRで人間revalidationが必要になる。
- 本機構を2分割するとschemaだけ存在してguardが使わない中間状態がreleaseを跨ぎうる。一方、1 PR実装にはbootstrap予算が必要になるため、その例外を認めない場合は本提案をrejectし、別の検証可能な分割境界を設計し直す必要がある。

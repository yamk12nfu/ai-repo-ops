# AROのAI運用モデル（役割と権限境界）

正本は `docs/local-improve-loop.md`、`docs/proposal-loop.md`、`docs/guard.md`、
`docs/plans/07-execution-plan-protocol.md`、`docs/repo-knowledge-loop.md`、
`packages/aro-cli/src/commands/plans.ts`。本書はそこから導いた索引・要約であり、正本を置き換えない。

## AIとCIの分担

- AIは既定では開発者が管理するローカル環境で実行する。CI cronでLLMを起動せず、repoごとのAI API keyも追加しない。
  人間がproposal idを指定して起動するcloud実装トラックは例外であり、採用repoでは対象を限定したGitHub Appのwrite権限が加わる。
- ローカルAIは配布済みpromptに従ってproposal作成、accepted proposalの実装、knowledge更新を行う。
- CIは`aro guard`、knowledge check、proposals checkなどの決定的な検証を実行する。
- ローカルの自己検証は手戻りを早く見つけるため、CIの検証は自己申告へ依存せず境界を強制するために使う。

## repo-owned state

- `.ai/local/knowledge/**`はrepo固有knowledgeと根拠・検証commitを保持する。コードや正式文書が正本であり、knowledgeは索引・要約である。
- `.ai/local/proposals/**`は改善提案、根拠、人間の採否、必要なら今回限りのchange budgetを保持する。
- `.ai/local/execution-plans/**`は長期作業の現在stage、next action、許可された副作用を保持する。
- GitHub Issue、Kanban、Discord、scheduler設定は表示・通知・投入には使えても、実行判断の正本にはしない。

## 人間に残す判断

- AIは`status: open`のproposalを作れるが、`accepted` / `rejected` / `superseded`の判断は人間が行う。
- `.ai/project.yaml`の変更、proposalの採否、Execution Planのpromotionや権限拡大は、guardがrequired checkのfailureとして表面化する。人間が内容を確認して明示的にoverrideする。
- `accepted -> done`は実装完了として許可される。proposal budgetは人間が事前承認し、実装PRでは変更せず保持する。
- `permissions.merge: true`は常に拒否する。stage promotion、merge、release、deployは自動化しない。

## Execution Planの現在の境界

- `aro plans check/status/next`はread-onlyで、schema・状態invariant・current actionの実行可否を決定的に返す。
- guardはPlanやStageの前進、`commit` / `push` / `draft_pr`権限の拡大、履歴改変を`execution_plan_promotion`として表面化する。
- Hermes runtime adapter、scheduler、queue、leaseは計画上の後続段階であり、CLIのread-only protocolと混同しない。
- 自動stage promotionは後続段階ではなく非スコープである。

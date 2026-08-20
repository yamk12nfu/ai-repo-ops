# ai-repo-ops

`ai-repo-ops`（CLI: `aro`）は、AI支援開発の運用基盤を複数のGitリポジトリへ配布し、
AIが作る変更と各リポジトリが所有する運用状態を、AIなしで決定的に検証するためのツールです。

プロンプト・ポリシー・スキーマを中央から同期し、初回生成したCI callerから中央のreusable workflowを
参照します。repo固有のknowledge、proposal、execution planは各repoのGit履歴に残します。AIは開発者の
ローカル環境で動かし、提案の採否、権限段階のpromotion、mergeは人間の判断として分離します。

- CLI version: `0.4.4`
- Distribution version: `0.2.0`
- Node.js: `>=20`
- Package manager: `pnpm@9.15.9`

## 設計原則

### AIはローカル、CIは決定的検証

Claude CodeやCodexなどのAIは、開発者が管理するローカル環境で実行します。CIはLLMを呼び出さず、
`aro guard`、`aro knowledge check`、`aro proposals check`などの決定的な検証だけを行います。
repoごとのAI API keyや、CI上のAI cronは必要ありません。

### 運用状態はrepoが所有する

会話履歴、GitHub Issue、scheduler固有の設定を実行判断の正本にしません。各repoが次の状態をGit管理します。

| 状態 | 保存先 | 役割 |
|---|---|---|
| Project config | `.ai/project.yaml` | quality gates、AIの変更可能範囲、risk level |
| Knowledge | `.ai/local/knowledge/**` | repo固有の索引・要約と、その根拠・検証commit |
| Proposals | `.ai/local/proposals/**` | 改善提案、根拠、人間による採否、変更予算 |
| Execution Plans | `.ai/local/execution-plans/**` | 実行計画、現在stage、次の操作、許可された副作用 |

中央distributionは`.ai/managed/**`を管理しますが、`.ai/local/**`と`.ai/project.yaml`はconsumer repoの
所有物として保持します。

### 判断と副作用を段階化する

AIはopen proposalの作成や、accepted proposalの実装を担えます。一方、次の変更は`aro guard`が
required checkのfailureとして表面化し、人間による確認と明示的なoverrideを要求します。

- `.ai/project.yaml`による検証境界の変更
- proposalの採否変更
- execution planのpromotionや`commit` / `push` / `draft_pr`権限の拡大

`permissions.merge: true`は常に拒否され、mergeは人間の責務として残ります。

## 全体像

```text
ai-repo-ops（中央repo）
  ├─ prompts / policies / schemas
  ├─ reusable CI workflow
  └─ aro init / diff / sync / doctor
                │
                ▼
consumer repo
  ├─ .ai/managed/**              中央から同期
  ├─ .ai/ai-repo-ops.lock.yaml   同期状態を記録
  ├─ .ai/project.yaml            repo固有設定
  ├─ .github/workflows/ai-review.yml
  │                               初回生成。中央のreusable workflowを参照
  └─ .ai/local/**                repo-owned state
       ├─ knowledge
       ├─ proposals
       └─ execution-plans
                │
                │ ローカルAIが提案・実装
                ▼
               PR
                │
                ├─ aro guard / strict checks / quality gates
                └─ 人間のreview・必要なoverride・merge判断
```

## Getting Started

### 1. 中央repoを準備する

現時点の第一級サポートは、中央repoのcloneとglobal linkです。global linkには、`pnpm setup`済みで
`PNPM_HOME`が`PATH`に含まれている環境が必要です。

```bash
git clone git@github.com:yamk12nfu/ai-repo-ops.git
cd ai-repo-ops
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm -C packages/aro-cli link --global
aro --version
```

`aro`をglobal linkしない場合は、build後のentrypointを直接実行できます。

```bash
node /path/to/ai-repo-ops/packages/aro-cli/bin/aro --help
```

packした`@ai-repo-ops/aro-cli`からもCLIは起動できますが、distributionはpackageに同梱されません。
`init` / `diff` / `sync` / `doctor`などでは`--source /path/to/ai-repo-ops`を指定してください。
このpackageは現在privateで、public npm registryには公開していません。

### 2. consumer repoへ導入する

```bash
aro init --repo /path/to/target-repo
aro doctor --repo /path/to/target-repo
```

この時点の`doctor`は、汎用初期値の`commands.*`が未設定であることをWARNとして報告します。次の設定PRで
実際に成功するコマンドを登録して解消します。

`aro init`の生成物は、まず調整せずにcommitし、導入PRとしてmergeします。次のPRで`.ai/project.yaml`を
repoの実態に合わせて調整します。

```yaml
commands:
  setup: "pnpm install --frozen-lockfile"
  lint: "pnpm lint"
  typecheck: "pnpm typecheck"
  test: "pnpm test"
  build: "pnpm build"

quality_gates:
  required:
    - lint
    - typecheck
    - test
    - build

ai:
  allowed_paths:
    - "src/**"
    - "tests/**"
    - "docs/**"
```

`.ai/project.yaml`の変更は検証ルール自体の変更なので、`aro guard`が`project_config` violationで
意図的にfailします。人間が変更内容を確認し、明示的にoverrideしてmergeしてください。

導入PRではmerge-base側に`.ai/project.yaml`とpolicyがまだ無いため、中央workflowはguardを検証不能として
明示的にskipし、成功します。guardが変更を検証し始めるのは、導入PRをmergeした後の次のPRからです。

その後、knowledge領域を初期化できます。

```bash
aro knowledge init --repo /path/to/target-repo --base origin/main
aro knowledge check --repo /path/to/target-repo --strict
```

導入PRと設定PRを分ける理由、`allowed_paths`とquality gatesの調整方法は
[`docs/onboarding.md`](./docs/onboarding.md)を参照してください。

## 日常の運用ループ

```text
tracked source
    │
    ├─ knowledge refresh ──► 根拠付きrepo knowledge
    │
    └─ propose ──► open proposal ──► 人間の採否
                                      │
                                      ▼
                                accepted proposal
                                      │
                                      ▼
                          improve / execution plan
                                      │
                                      ▼
                         guard + gates + review
                                      │
                                      ▼
                                  人間がmerge
```

### Repo Knowledge Loop

`.ai/local/knowledge/**`に、コードや正式ドキュメントから導いた索引・要約を置きます。knowledgeは正本を
置き換えず、各entryがsource pathと検証済みcommitを持ちます。sourceがその後変更されるとstaleとして
検出されます。

```bash
aro knowledge check --repo . --strict
```

詳細: [`docs/repo-knowledge-loop.md`](./docs/repo-knowledge-loop.md)

### Proposal Loop

AIは既存の判断履歴を読んで`status: open`のproposalを作ります。採否と、routine limitを超える変更に
必要なproposal-scoped budgetは人間が決めます。accepted proposalの実装が完了すると、同じPRで
`accepted`から`done`へ閉じます。

```bash
aro proposals check --repo . --strict
```

詳細: [`docs/proposal-loop.md`](./docs/proposal-loop.md)

### Local Improve Loop

配布された`.ai/managed/prompts/improve.md`に従い、cleanな専用branchまたはworktreeで改善を1件実装します。
PR作成前に`aro guard`と`.ai/project.yaml`のrequired quality gatesを通し、CIで同じ境界を再検証します。

```bash
DEFAULT_BRANCH=main
git fetch origin "$DEFAULT_BRANCH"
BASE_SHA="$(git rev-parse "origin/$DEFAULT_BRANCH")"
aro guard --repo . --base "$BASE_SHA"
```

default branchが`main`以外のrepoでは`DEFAULT_BRANCH`を置き換えてください。full SHAを固定することで、
Proposal budgetの認証とbase driftの検出を同じ基準で扱えます。

人間が明示opt-inしたrepoでは、scheduled local trackとしてaccepted proposalの選定から検証済みDraft PR
までを委譲する契約も配布されています。ただしscheduler、queue、lease、credential配布などのruntimeは
このrepoにはまだ実装されていません。

詳細: [`docs/local-improve-loop.md`](./docs/local-improve-loop.md)

### Execution Plan Protocol

`.ai/local/execution-plans/**`に、長期作業の現在stage、次の操作、許可された副作用を記録します。
現在実装済みなのは、read-onlyの`plans check / status / next`と、promotion・権限拡大を検出する
`execution_plan_promotion` guardです。Hermes runtime adapterや自動stage promotionは未実装です。

```bash
aro plans check --repo . --strict
aro plans status --repo .
aro plans next --repo . --json
```

計画と実装境界: [`docs/plans/07-execution-plan-protocol.md`](./docs/plans/07-execution-plan-protocol.md)

## CLI

| Command | 変更 | 役割 |
|---|---:|---|
| `aro init` | あり | consumer repoへ初回展開する |
| `aro diff` | なし | 中央distributionを同期した場合の差分を表示する |
| `aro sync` | あり | conflictを検査して中央distributionを同期する |
| `aro doctor` | なし | schema、managed file、workflow、lock、設定を診断する |
| `aro guard` | なし | merge-baseからHEADまでの変更をproject configとpolicyで検証する |
| `aro knowledge init` | あり | repo knowledge領域を非上書きで初期化する |
| `aro knowledge check` | なし | knowledgeの形式、根拠、provenance、鮮度を検証する |
| `aro proposals check` | なし | proposalの形式、判断記録、根拠の鮮度を検証する |
| `aro plans check` | なし | execution planのschemaとinvariantを検証する |
| `aro plans status` | なし | active execution planの現在地を表示する |
| `aro plans next` | なし | next actionと実行可否を決定的に返す |

各コマンドのoptionは`aro <command> --help`で確認できます。`knowledge`、`proposals`、`plans`は
subcommandを持つため、たとえば`aro plans next --help`のように実行します。

## 安全境界

- `.ai/managed/**`と`.ai/ai-repo-ops.lock.yaml`は直接編集せず、authoritative distributionを変更して
  `aro sync`で配布します。
- `aro guard`はPR側ではなくmerge-base側のproject configとpolicyを読みます。同じPRで検証を緩めて
  自身の変更を通すことはできません。
- 正規の`aro sync` bundleは、merge-baseの状態とauthoritative distributionから再現して認証します。
  lock fileの自己申告は信用しません。
- KnowledgeとProposalのsourceは、追跡済みのrepo内UTF-8 text fileに限定します。secret、`.git`、`.ai`、
  dependency、build artifact、symlink、globは拒否します。
- AI向けの変更範囲や行数上限は、local improve loopではwarningも含めて中止条件です。大型変更は
  人間承認済みproposal budgetで対象proposalにだけ限定的に拡張できます。
- proposalの採否、execution planのpromotion、merge、release、deployは自動化しません。

詳細な検証仕様は[`docs/guard.md`](./docs/guard.md)、同期とconflictの仕様は
[`docs/sync-strategy.md`](./docs/sync-strategy.md)、脅威モデルは[`docs/security.md`](./docs/security.md)を
参照してください。

## Development

このrepoはpnpm workspaceです。

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm schema:check
pnpm typecheck
pnpm test
pnpm build
```

| Command | 内容 |
|---|---|
| `pnpm schema:sync` | authoritative schemaをdistributionのmanaged copyへ同期する |
| `pnpm schema:check` | authoritative schemaとmanaged copyの差分を検出する |
| `pnpm typecheck` | testを含むTypeScriptの型検査 |
| `pnpm test` | Vitest test suite |
| `pnpm build` | workspace全体をbuildする |
| `pnpm release:check` | release前の整合性を検証する |

release手順は[`RELEASE.md`](./RELEASE.md)、変更履歴は[`CHANGELOG.md`](./CHANGELOG.md)を参照してください。

## Documentation

### 導入・運用

- [`docs/onboarding.md`](./docs/onboarding.md) — consumer repoへの導入とproject config調整
- [`docs/local-improve-loop.md`](./docs/local-improve-loop.md) — ローカル改善ループとopt-in track
- [`docs/repo-knowledge-loop.md`](./docs/repo-knowledge-loop.md) — Knowledge Loop
- [`docs/proposal-loop.md`](./docs/proposal-loop.md) — Proposal Loop

### 配布・検証

- [`docs/distribution.md`](./docs/distribution.md) — manifest、strategy、distribution content hash
- [`docs/sync-strategy.md`](./docs/sync-strategy.md) — checksum、conflict、atomicity、終了コード
- [`docs/guard.md`](./docs/guard.md) — guard、proposal budget、promotion guard、CI利用
- [`docs/security.md`](./docs/security.md) — path safety、symlink、workflow permissions

### 設計・ロードマップ

- [`docs/plans/README.md`](./docs/plans/README.md) — 開発ロードマップと各計画の位置づけ
- [`docs/plans/07-execution-plan-protocol.md`](./docs/plans/07-execution-plan-protocol.md) — Execution Plan Protocol
- [`docs/existing-tools.md`](./docs/existing-tools.md) — Copier / Cruftとの関係と自作する理由
- [`docs/ai-review.md`](./docs/ai-review.md) — 廃止したCI内AI reviewの実装記録

## Status

配布・同期、guard、Knowledge Loop、Proposal Loop、Execution Plan Protocolのread-only CLIとpromotion guardは
実装済みです。Execution Plan Protocolのruntime adapter、consumerでの段階的dogfooding、fleet診断と
rolloutは計画中です。各計画の設計と段階は[`docs/plans/README.md`](./docs/plans/README.md)から参照できます。

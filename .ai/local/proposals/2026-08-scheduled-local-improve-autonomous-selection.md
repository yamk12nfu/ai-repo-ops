---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: scheduled-local-improve-autonomous-selection
status: accepted
proposed_at_commit: 8f106b0039a2e0cfe318f8fd35916b22db0c84a3
sources:
  - path: "docs/local-improve-loop.md"
  - path: "docs/proposal-loop.md"
  - path: "distribution/base/manifest.yaml"
decision:
  by: "fooya"
  reason: "accepted間の優先順位をHermes監督者へ委任し、Codex実装とClaude Opus 5の敵対レビューを経てDraft PRまで自動化する方針を承認。mergeと本番deployは引き続き人間が判断する。"
---

## 課題

現行のローカル改善ループと cloud 実装トラックは、起動・proposal 選択・PR 作成の各段階で
開発者が同席することを安全境界にしている。特に `docs/local-improve-loop.md` は cloud Agent でも
「起動は常に人間が proposal id を 1 つ指定」「cron 等の無人起動はしない」と定め、
`docs/proposal-loop.md` は実装可能な accepted が複数ある場合に AI が順位付けせず開発者が選ぶ。

一方、Proposal Loop では採否そのものは既に人間が `accepted` として記録済みであり、stale 判定、
変更範囲、quality gates、`aro guard`、人間による merge という決定的な境界も存在する。
accepted が複数滞留する運用では、人間が毎回起動と選択を行うことが実装待ちの律速になる。
また、CI cron に API key と書き込み権限を配る旧方式と、開発者自身の端末上で Hermes の永続
scheduler / task queue / 監督 agent / Codex CLI を使う方式は、credential と実行場所の境界が異なるが、
現行文書には後者を明示的に許可・制約する契約がない。

## 提案

明示的に opt-in したローカル環境向けに「scheduled local improve track」を追加する。
採否と merge は引き続き人間に限定し、accepted 間の実装順序と Draft PR までの作業を監督 agent に
委任できる契約を、中央の authoritative improve prompt と運用文書に定義する。

1. **ローカル限定**: scheduler、task queue、監督 agent、実装 agent は開発者の管理端末で動かす。
   対象 repo や CI に新しい API key / secret を配布しない。GitHub Actions の AI cron は復活させない。
2. **対象とfreshnessの限定**: 人間がallowlistへ明示登録したrepoだけを対象にする。Hermesは
   `aro proposals check --repo .` のexit codeだけでなくfindingsを読み、`source.stale` が1件でも付いた
   `accepted` proposalをすべて除外する。eligibleなacceptedがなければ自選改善へ進まず、何も実装しない。
   配布promptの変更はauthoritativeな `distribution/base/manifest.yaml` をsource proxyとして追跡し、
   managed copyである `.ai/**` はsourceにしない。
3. **決定的な自律選択**: eligible acceptedが複数ある場合、次を上から順に比較する辞書式優先順位とする:
   セキュリティ・データ保全、壊れたquality gate、他作業のブロック解除、ユーザー影響、テスト、保守性、
   待機期間、変更リスク。上位基準で差が付けば下位基準は選定を覆さず、全基準が同点ならschema検証済みの
   normalized proposal ID昇順を最終stable tie-breakerにする。実装前に全候補、除外と理由、各候補の各基準の
   評価、比較結果、tie-breaker使用有無をtask logへ記録し、Draft PRにも要約する。同一のeligible入力と
   evidenceからは同じproposalを選ぶ。
4. **1 run = 1 proposal**: 1回に1 repo・1 proposalだけを扱い、同一repoの並行 improveを禁止する。
   実行中またはレビュー待ちがあればschedulerは新規作業を投入しない。
5. **immutable base**: Hermesはremote default branchをfetchした直後に、その時点のexact full commitを
   `BASE_SHA`として固定し、専用worktreeとbranchをそのSHAから作る。実装diff、Codex/Opusのreview packet、
   `aro guard --base`、Draft PR作成時に期待するdefault branch revisionはすべて同じ `BASE_SHA` を使い、
   baseを混在させない。guard前にもbaseをfetchする。push/PR直前には直ちに再fetchしてremote default
   branchの現在OIDと `BASE_SHA` を比較する。異なれば停止し、新SHAへrebaseまたはworktree/branchを再作成
   した後、Codex review、Opus review、strict proposal check、guard、全quality gateを再実行するか、
   blockedのままにする。
6. **役割の分離**: Hermes supervisorだけが選定、`BASE_SHA`/worktree作成、監視、独立diff検証、検証後の
   `accepted` → `done`、commit、push、Draft PR、log、cleanupを所有する。Codexは専用workspace sandbox内の
   実装とtestにだけ書き込め、選定、status、commit、push、PR、merge、deploy、secret/credentialを扱わない。
   Claude Opus 5 reviewerは別contextでreview packetだけをread-onlyで読み、shell/write/network toolを持たない。
   人間だけがproposalの採否・再検証、promotion/credential設定、merge、本番deployを決定する。
7. **既存improve契約を継承**: scheduled trackでも `.ai/project.yaml` とrisk levelに対応するpolicyを適用し、
   `ai.max_loops`、`ai.max_changed_files` とpolicy `change_limits.max_changed_files` の小さい方、policyの
   `change_limits.max_added_lines`、`allowed_paths`、両方の`forbidden_paths`、`commands`、`quality_gates`を
   緩和しない。`.ai/managed/**`、workflow、project configの変更は禁止する。baseをfetchしてからguardを実行し、
   exit 0でもwarningがあれば停止する。proposalを変更した場合の `aro proposals check --repo . --strict` は
   必須とする。
8. **Draft PR境界**: 検証済み変更だけをDraft PRまで自動作成できる。credentialは対象repoかつ当該branchの
   push/Draft PR作成だけにscopeし、merge、deploy、release、workflow/secret変更、他repoへのwriteを許可しない。
   prompt上の禁止だけでなくGitHub App/token permissionsとbranch protection等の実権限で強制する。
   想定外、曖昧、stale、検証失敗時は実装を続けずblockedとして報告し、auto-mergeは行わない。
9. **段階導入**: 最初は読み取り専用dry-runで選定理由だけを観察し、その後ローカル変更、最後にDraft PR
   作成をrepo単位で有効化する。停止方法、実行履歴、worktree cleanup、権限失効手順も文書化する。

このトラックは従来の対話型ローカルループと人間起動cloudトラックを置き換えず、明示opt-inの第三の
実装経路として追加する。このproposal PRは契約だけを定義し、runtime実装を含まない。

## 想定する変更範囲

- `docs/local-improve-loop.md`: scheduled local improve track、安全境界、段階導入、停止手順
- `docs/proposal-loop.md`: accepted複数時の自律選択をopt-in時だけ許可する分岐
- `distribution/base/files/.ai/managed/prompts/improve.md`: authoritative improve promptへ実行モード、
  自律選択基準、Draft PR事前承認境界を追加
- `distribution/base/manifest.yaml`: managed prompt配布内容の更新
- `CHANGELOG.md`: 新しいopt-in運用契約の記録

5ファイルを想定し、`ai.max_changed_files: 10`に収まる。配布version更新や自己syncが別リリース手順を
必要とする場合は、実装PRとrelease/sync PRを分離する。

## リスク・見送る理由になりうる点

- **人間関与の縮小**: 現行設計が明示的に禁止した無人起動とAIによる順位付けを許可する方針変更である。
  acceptedは実装方針の包括承認とは限らず、proposal本文に曖昧さが残る場合に誤実装する可能性がある。
- **低品質PRの蓄積**: 自動mergeしなくてもDraft PRが増えるとレビュー待ちが負債になる。レビュー待ちを
  backpressureとして新規実行を止め、1 run 1 proposalを強制する必要がある。
- **同一モデル系統の監督**: Hermes監督者とCodex作業者が同じモデル系統を使う場合、プロセスと
  コンテキストは分離されても判断の独立性は限定的である。CIの決定的検証と人間mergeは外せない。
- **ローカル権限の広さ**: 開発者端末上のagentはGitHub資格情報や複数repoへアクセスできる。
  allowlist、専用worktree、sandbox、禁止操作、監査ログ、停止スイッチが不十分ならcloud Agentより
  blast radiusが大きくなりうる。
- **scheduler障害**: タイムアウト、再試行、端末再起動で重複タスクや孤立worktreeが生じうる。
  idempotency key、task lock、最大実行時間、cleanup、再開手順の実装とdogfoodingが必要である。
- **配布promptの複雑化**: 対話型、人間起動cloud、scheduled localの3モードを1つのimprove promptで
  扱うと条件分岐が増える。別promptへ分離した方が安全なら、実装前に構造を再検討する余地がある。
- **運用コスト**: acceptedの滞留が少ない場合、schedulerとKanbanの保守コストが手動起動を上回る。
  dry-run期間で実行頻度、eligible件数、選定の妥当性、レビュー滞留を測定してからDraft PRを有効化する。

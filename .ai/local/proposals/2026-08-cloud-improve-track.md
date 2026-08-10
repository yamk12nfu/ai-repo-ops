---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: cloud-agent-improve-track
status: accepted
decision:
  by: yamk12nfu
proposed_at_commit: a9b07f368eec404977ec1664d4c50a08661d2071
sources:
  - path: "docs/local-improve-loop.md"
  - path: "docs/proposal-loop.md"
---

## 課題

現行思想は「AI の実行はローカル、CI は決定的検証」（docs/local-improve-loop.md）であり、
その根拠は「安全性の設計」の節から 3 点に分解できる:

1. 従量課金 API キー・repo ごとの secrets を増やさない
2. 書き込み権限が増えない（PR は開発者自身の権限のみ）
3. 無人実行しない（起動・PR 作成・merge に必ず人間が挟まる）

しかし Proposal Loop の PR②（`accepted` 済み提案の実装）は、**採否という判断が既に人間に
よって済んでおり**、残る作業の多くは機械的である。実装は開発者の手元の時間に律速され、
accepted の滞留（実装待ち）が生じうる。現にこの repo の proposals は accepted 7 件が
実装待ちである。

cloud Agent（Claude Code のクラウド実行等。開発者のサブスクリプションに基づき、人間が
タスク単位で起動するもの）は「CI cron + API キー」とは別物であり、上記 1 と 3 を保った
まま実装を委譲できる可能性がある。現行 docs にはこの選択肢の位置づけがなく、やるなら
2 の原則改定を明示的に行う必要がある。

## 提案

docs に「cloud 実装トラック」を運用手順として定義する（機構・配布 prompt の変更はしない）:

1. **対象の限定**: `status: accepted` で stale でなく、紙上判定で採否が済み、実装が
   機械的な提案に限る。実測判定（スパイク）を経た提案はスパイクが手元にあるため
   ローカルで仕上げる。
2. **起動は常に人間が提案 id を 1 つ指定して行う**（cron 等の無人起動はしない）。
   improve.md の「実装可能な accepted が複数あるときは開発者が選ぶ」を、起動時の
   id 指定で満たす。
3. **想定外は実装せず停止**: 指定提案が stale・解釈が割れる・quality gates を通せない
   場合、cloud Agent は実装せず報告して終了する（improve.md の既存の停止規則と同じ
   倒し方）。
4. **検証レールは不変**: CI の `aro guard`・`aro proposals check`・人間 merge は一切
   変えない。cloud Agent の作る PR も同じレールを通る。
5. **原則改定の明記**: docs/local-improve-loop.md「安全性の設計」の「権限が増えない」を
   改定し、cloud Agent の GitHub App に write 権限を渡すこと・その代償と監視点を明記する。
   あわせて「CI cron で AI を実行しない」判断（計画 02 の注記）との境界（人間起動・
   サブスクリプション・タスク単位である点）を線引きする。

配布 improve.md の変更は本提案に含めない見込み（起動メッセージでの id 指定は既存の
「開発者が選ぶ」の実現形にあたる）。ただし improve.md の文言（「一覧を開発者に提示して
選択を仰ぐ」）は開発者の同席を前提に書かれており、同席しない cloud 実行で id の先渡しが
そのまま通るかは**未検証**である。初回の cloud 実行で検証し、prompt 側の追記（id 指定を
受け取る契約の明文化）が必要と判明したら別提案とする（distribution 変更は version bump と
リリース順序制約を伴うため、本提案には積まない）。

## 想定する変更範囲

- `docs/local-improve-loop.md`（「安全性の設計」の改定 + cloud 実装トラックの節の追加）
- `docs/proposal-loop.md`（手順 3 の実装経路として cloud トラックへの参照を追記）

2 ファイルで `max_changed_files: 10` に収まる。

## リスク・見送る理由になりうる点

- **権限の拡大そのもの**: 「ループ全体を通して書き込み権限が増えない」という現行の
  安全性保証が破れる。これが本提案の最大の代償である。採用の前提として最低限次を
  確認する（境界の詳細設計は採用後の実装 PR = docs 改定の仕事とする）:
  - GitHub App の権限を対象 repo だけに限定できること
  - 書き込みが branch 作成 + PR 作成に限られ、default branch への直接 push が
    branch protection で塞がれていること
  - `auto_merge` の封印（`review.auto_merge: false`）と人間 merge の運用を変えないこと
  - 権限の失効手順と、Agent の操作の追跡可能性（監査ログ相当）として cloud 側が
    何を提供するかを確認すること
- **実行環境が未検証**: cloud 環境で `corepack enable && pnpm install`・`aro guard`・
  quality gates（lint / typecheck / test / build）が完走することを確認していない。
  自己検証が回らなければ「CI guard 頼みの未検証 PR」が生まれ、ローカル実行より
  手戻りが増える恐れがある。
- **なし崩しの恐れ**: 人間起動という線引きを docs で明確にしても、運用が慣れると
  cron 化・無人化へ滑る誘惑が残る。「CI cron を採らない」と決めた経緯（計画 02）と
  矛盾しない記述を維持する規律が要る。
- **効果が限定的な可能性**: 実装が機械的な accepted はそもそも小さく、ローカルで
  済ませるコストも低い。委譲の段取り（起動・結果確認・レビュー）の方が高くつくなら
  見送りが妥当である。

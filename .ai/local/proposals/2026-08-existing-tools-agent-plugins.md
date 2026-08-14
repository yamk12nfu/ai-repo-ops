---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: existing-tools-agent-plugins-standard
status: rejected
proposed_at_commit: 2a834f25eec065acb4f67fbcc736a25707981647
sources:
  - path: "docs/existing-tools.md"
decision:
  by: "yamk12nfu"
  reason: "exisiting-toolは作る前の話で現存している以上対比する必要がないため"
---

## 課題

docs/existing-tools.md は「aro と同じ問題領域の既存ツール」として Copier / Cruft
（汎用テンプレートエンジン）だけを比較対象にしており、「再評価ポイント」の一覧
（3-way merge、テンプレート変数の再質問、migration 等）もテンプレートエンジン観点に
限られている。

2026-08-04 週に Agent Plugins 1.0.0 が公開された（spec: https://agent-plugins.org/specification 、
発表: https://vercel.com/changelog/introducing-agent-plugins-1-0-0 。確認元は 2026-08-10 の
weekly tech-digest）。skills / MCP servers / prompts といった「コードではないが実行権限を
持つ配布物」を AI クライアント横断で配布する標準であり、aro の配布対象
（`.ai/managed/prompts/**` / policies）と守備範囲が直接重なる。Copier / Cruft よりも
近い領域の標準が生まれたのに、「既存ツールとの関係を明記する」という本ドキュメントの
目的に対して比較対象として存在しない。

## 提案

docs/existing-tools.md に「Agent Plugins / skills 配布標準との関係」の節を追記する。
粒度は既存の Copier / Cruft 節と同じ「関係の整理 + 再評価トリガー」に留める:

1. **重なる問題**: AI 運用ファイル（prompts / skills / MCP 設定）の配布・更新追従・
   version pinning・trust source。
2. **aro 側にしかない要素**: canonical checksum による drift 検証と `aro guard` による
   強制、repo 単位の overlay と保護境界（`.ai/managed` / `.ai/local`）、knowledge /
   proposal loop との統合。
3. **再評価トリガー**: Agent Plugins が「repo 内 managed file の drift 検証・中央からの
   強制」に相当する仕様を持った段階で、配布層を標準に寄せるか自前を続けるかを再評価する。

実装時には spec の一次情報を確認してから書く（下記リスク参照）。

## 想定する変更範囲

- `docs/existing-tools.md` のみ（1 ファイル）。`ai.max_changed_files: 10` に余裕で収まる。

## リスク・見送る理由になりうる点

- **根拠が二次情報**: 本提案の根拠は weekly tech-digest 経由であり、spec の実体・成熟度を
  一次情報で確認していない。実装時の確認で「比較に値する実体がまだない」と判明したら、
  却下（時期尚早）が妥当。
- **腐りやすさ**: 出たばかりの 1.0.0 標準は変化が速い。詳細に書くほど早く陳腐化するため、
  節は「関係と再評価トリガー」の粒度を超えないこと。
- **構成の別解**: existing-tools.md のタイトル・導入文は Copier / Cruft 前提で書かれている。
  節追加ではなく別ファイルに切る方が構成として素直、という判断もありうる（その場合は
  Documentation 一覧の更新も伴い、変更範囲が 2 ファイルになる）。
- **即効性の薄さ**: owner 1 人の現状では判断材料ドキュメントの効果は限定的。fleet 展開
  （計画 05）を見据えた先行投資という位置づけでしか正当化できない。

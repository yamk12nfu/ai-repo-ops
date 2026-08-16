---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: safety-design-availability-rationale
status: open
proposed_at_commit: 6bd4d2ede327e71f5e7fba1121eb63c17e16e412
sources:
  - path: "docs/local-improve-loop.md"
  - path: "docs/plans/02-ai-review-commenter.md"
decision:
  by: ""
  reason: ""
---

## 課題

docs/local-improve-loop.md「安全性の設計」は「AI はローカル、CI は決定的検証」の根拠を
鍵を増やさない・書き込み権限・guard の二段構え・人間の関与の 4 点で説明し、計画 02 の
方向転換注記（2026-07-05）も課金・secrets 運用・自前基盤回避の観点のみを挙げる。
**可用性** — AI model / provider の障害が CI・merge レールの障害に直結しない — という
根拠は、どちらにも明文化されていない。

この観点は 2026-08-10 の GitHub Copilot model access 障害（GitHub status、RCA pending。
2026-08-11 の infra tech-digest で確認）で実例を得た: AI model を code review や automation
の gate に組み込んだ組織では、model 劣化がそのまま開発 platform incident になる。aro の
設計（required check は `aro guard` / `aro proposals check` 等の決定的検証のみで、AI は
ゲート外）はこの障害モードを構造的に回避しているが、その利点が記録されていないため、
将来「CI に AI を戻すか」を再検討するときにこの観点が落ちる恐れがある。

## 提案

「安全性の設計」に可用性の項目を 1 つ追記する:

- required check を構成する検証（guard / proposals check / knowledge check / quality gates）は
  AI model・provider の可用性に依存しないため、model 障害・劣化が merge レールを止めたり
  汚したりしない。
- あわせて、cloud 実装トラックの「想定外は実装せず停止」が silent partial output
  （障害・劣化時に不完全な成果物が静かに残ること）を防ぐ倒し方でもある旨を 1 文足す。

事例（Copilot 障害）は書き込みすぎず、「決定的検証は model 可用性に依存しない」という
一般論に留める。

## 想定する変更範囲

- `docs/local-improve-loop.md`（1 ファイル）。計画 02 注記への相互参照 1 行を含めても
  2 ファイルで、`ai.max_changed_files: 10` に余裕で収まる。

## リスク・見送る理由になりうる点

- **純粋な根拠追記**: 動作は何も変わらないため優先度は低い。「docs はすでに十分長い」
  という判断で見送っても実害はない。
- **記述の分散**: 「CI で AI を実行しない」経緯の正本は計画 02 の注記であり、安全性の
  設計にも足すと根拠の記述箇所が増える。どちらに寄せるかの構成判断が要る。
- **相互 stale**: `cloud-track-observation-items` と同じ docs/local-improve-loop.md を
  source に持つため、片方の実装がもう片方を stale 化させる（詳細は同提案のリスク欄）。
- **事例の鮮度**: 根拠事例は RCA pending の外部事象で、時間が経つと文書内では鮮度を失う。
  一般論に留める書き方を守らないと、追記自体が腐る。

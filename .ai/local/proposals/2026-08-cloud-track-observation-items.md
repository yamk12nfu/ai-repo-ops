---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: cloud-track-observation-items
status: open
proposed_at_commit: 6bd4d2ede327e71f5e7fba1121eb63c17e16e412
sources:
  - path: "docs/local-improve-loop.md"
decision:
  by: ""
  reason: ""
---

## 課題

docs/local-improve-loop.md の「cloud 実装トラック」節には**導入時**の検証（cloud 環境で
setup / guard / quality gates が完走するかの確認）はあるが、導入後にトラックを
**続けるか捨てるかを判断するための観測項目がない**。同じ文書のローカルループ側には
「dogfooding で記録すること（Stage 2-3）」節があり、指示の精度・1 周の手間などの記録項目が
定義済みで、cloud トラックだけが非対称になっている。

done で閉じた提案 `cloud-agent-improve-track` のリスク欄も「委譲の段取り（起動・結果確認・
レビュー）の方が高くつくなら見送りが妥当」と、このトラックの価値が実測でしか決まらないことを
明記していた。手順化（PR #56）はその実測の枠組みを持たないまま完了している。

なお業界的にも、agent 実行を workload 単位で費用・利用計測する流れが強まっている
（OpenAI API usage/cost の API key dimension、GitHub Copilot usage metrics API の
third-party agent 集計。2026-08-10 の weekly tech-digest で確認）。「委譲の価値は測って
判断する」という方向は外部の実務とも整合する。

## 提案

「cloud 実装トラック」節に、ローカルの Stage 2-3 と同じ粒度の「委譲で記録すること」を
追記する。項目案（3 つ程度に絞る）:

1. 1 件あたりの段取り時間（起動指示〜PR 確認完了）と、同規模の提案をローカルで
   実施した場合との比較所感
2. 停止・手戻りの発生（stale 停止 / 解釈割れ / guard・quality gates 失敗でローカルで
   やり直した回数）
3. 数件分の記録が溜まった時点で「トラック継続 / 縮小 / 廃止」を判断する、という出口

## 想定する変更範囲

- `docs/local-improve-loop.md` のみ（1 ファイル）。`ai.max_changed_files: 10` に余裕で収まる。

## リスク・見送る理由になりうる点

- **順序が逆の可能性**: cloud トラックはまだ 1 度も実行していない。観測項目を先に固定すると
  実態に合わない項目を作りがちで、「最初の 1〜2 回を回してから項目を決める」方が自然という
  判断が成立する（その場合は実行後の再提案が筋）。
- **記録コスト**: solo 運用では記録それ自体の手間が無視できず、「記録のための記録」に
  なる恐れがある。項目を絞っても、続かなければ意味がない。
- **相互 stale**: 本提案と `safety-design-availability-rationale` は同じ
  docs/local-improve-loop.md を source に持つため、片方の実装 PR がもう片方を stale 化させる
  （open 提案 `2026-08-improve-pr-cross-proposal-stale` が記録した構図）。両方 accept する
  場合は同一 PR での実装、または stale 復帰（`proposed_at_commit` 更新の同梱）を織り込むこと。

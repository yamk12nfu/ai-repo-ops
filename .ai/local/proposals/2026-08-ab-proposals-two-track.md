---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: ab-proposals-two-track-decision
status: accepted
decision:
  by: yamk12nfu
proposed_at_commit: a9b07f368eec404977ec1664d4c50a08661d2071
sources:
  # 注: 変更対象の正本は distribution/base/files/.ai/managed/prompts/propose.md だが、
  # source path の組み込み禁止パターン `**/.ai/**` が distribution 配下のコピーにも当たるため
  # source には指定できない（knowledge: distribution-ai-files-forbidden-as-sources）。
  # 同じ運用を記述する docs/proposal-loop.md と、配布変更に連動する manifest を代理にする。
  - path: "docs/proposal-loop.md"
  - path: "distribution/base/manifest.yaml"
---

## 課題

現行の Proposal Loop は「1 テーマにつき 1 提案」を暗黙の前提としており、次の 3 点が
欠けている（docs/proposal-loop.md の手順 1〜2、配布 propose.md の「進め方」が根拠）:

1. **同一目的に対する代替アプローチを並べる発想がない。** アプローチ選択に確度が
   持てないテーマでは、AI が単一案に絞ること自体が事実上の「選抜」になり、
   「AI は評価・順位付け・選抜をしない」という Loop の原則と緊張関係にある。
   人間が比較して判断するには、代替案が並んでいる必要がある。
2. **実測しないと優劣が決まらない提案の判定手順がない。** 採否は「提案文を読んで
   判断」だけが想定されているが、性能・DX・プロンプト文言の変更などは、読んだだけでは
   決められないことがある。
3. **比較判断の記録形式がない。** 却下理由は絶対評価（この提案は不採用）のみが想定され、
   「同目的の A を採り B を退けた」という比較評価を残す規約がない。却下理由が次の提案の
   入力になるという既存原則を、比較の文脈でも効かせたい。

## 提案

判定を「紙上判定」と「実測判定」の 2 トラックに整理し、運用規約として追記する。
機構（schema・`aro proposals check`・guard）の変更は**本提案に含めない**。

1. **配布 propose.md への追記**:
   - アプローチの確度が低いテーマでは、同一目的に対する代替アプローチを**別ファイルの
     `open` 提案として並べてよい**（1 回の実行で合計 3 件までの上限は不変）。代替案同士は
     本文で相互参照する。
   - 提案に**「判定方法」を書く**: 紙上で判定可能か、要実測（何をどう測れば決まるか）か。
     AI が書くのは測り方の提案までで、測って選ぶのは人間である。
2. **docs/proposal-loop.md の手順 2（採否）への追記**:
   - A/B の判定は勝者を `accepted`、敗者を `rejected` とし、敗者の `decision.reason` に
     比較理由（どの観点で勝者に劣ったか）を書く。
   - 要実測の提案は `open` のまま、捨てる前提のスパイク実装を worktree で作らせて人間が
     動かして測る。測定結果は**提案本文に追記**し（実装破棄の記録を本文に残す既存の
     流儀と同じ）、`decision.reason` には採否（status 変更）と同時に比較理由を書く。
     スパイクは merge しない（実験中は status を変えないため、guard は通常どおり通る）。
3. 代替案のグルーピングは本文相互参照の運用規約から始める。frontmatter への
   フィールド追加（`alternative_to` 等）と機械検証は、運用実績を見てから別提案とする。

## 想定する変更範囲

- `distribution/base/files/.ai/managed/prompts/propose.md`（A/B・判定方法の追記）
- `docs/proposal-loop.md`（採否手順への A/B 判定・スパイク運用の追記）
- `distribution/base/manifest.yaml`（version bump。番号は実装時点の最新に従う）
- `CHANGELOG.md`

4 ファイルで `max_changed_files: 10` に収まる。distribution 変更のため、自己導入 repo の
順序制約（knowledge: self-sync-must-follow-release。リリース後に別 PR で self-sync）に従う。

## リスク・見送る理由になりうる点

- **open 滞留の悪化**: 計画 06 は open の滞留を最大級のリスクと明記している。A/B を許すと
  1 テーマで複数の open が生まれ、判断待ちの件数が構造的に増える。敗者を `rejected` で
  閉じる規律が回らないと、滞留と重複がむしろ悪化する。
- **判断コストの増加**: 人間は 2 案を読み比べる必要があり、採否 1 件あたりのコストが上がる。
  要実測トラックはさらにスパイクの実行・計測の時間を要する。軽いテーマにまで A/B を
  乱発すると割に合わない。
- **「AI は選抜しない」との境界の曖昧化**: どのテーマを A/B にするか・どの 2 案を出すか
  自体に AI の裁量が入る。判定方法の宣言も、メトリクスの選び方次第で事実上の誘導になりうる
  （それでも単一案に絞る現状より人間の判断材料は増える、というのが本提案の立場）。
- **スパイク運用は機構で強制されない**: `open` のままのスパイクは guard / proposals check の
  管理外であり、「スパイクを merge しない・使い終わったら破棄する」は規約頼みになる。
- **判定方法は自由記述**: `aro proposals check` は判定方法の有無・妥当性を検証しない
  （形式化するかは運用実績を見ての将来判断）。

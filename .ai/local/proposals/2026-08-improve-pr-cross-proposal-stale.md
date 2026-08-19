---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: 2026-08-improve-pr-cross-proposal-stale
status: open
proposed_at_commit: 90ebed9e1cfc45b7c79492db92cc621e07549b6d
sources:
  - path: "packages/aro-cli/src/core/proposals-check.ts"
  - path: "docs/proposal-loop.md"
---

## 提案: 「stale 判定はファイル単位 — improve PR が同じ source を持つ他 proposal を stale 化させる」の knowledge entry

stale 判定は「source ファイルの内容が `proposed_at_commit` から変わったか」のファイル単位比較であり
（`packages/aro-cli/src/core/proposals-check.ts`）、提案の根拠となった**箇所**に触れたかどうかは見ない。
そのため improve PR の変更が、同じファイルを source に持つ別の open / accepted 提案を stale 化させ、
提案変更を含む PR は CI が `--strict` で検証するため required check が落ちる。復帰は人間が根拠を
現 HEAD で再確認して `proposed_at_commit` を更新し（`status` 不変のため guard は通る）、同じ PR に
同梱できる（2026-08-10 の PR #53 で、README.md を source に共有する `knowledge-check-guard-ordering`
が stale 化し、この手順で復帰した実例）。docs/proposal-loop.md「今後の観測ポイント」が挙げる
「stale 判定の妥当性（source が少し変わっただけで stale になり過ぎないか）」の最初の実データでもある。

---
schema_version: 1
id: distribution-ai-files-forbidden-as-sources
status: open
proposed_at_commit: de5e9992291d9b144bd8ebb0411dbcebd9e566e4
sources:
  - path: "packages/aro-cli/src/core/knowledge-check.ts"
  - path: "packages/aro-cli/src/core/proposals-check.ts"
---

## 提案: 「distribution 配下の `.ai/` コピーは knowledge / proposal の source に使えない」の knowledge entry

タイトル案: 「配布物の正本（`distribution/base/files/.ai/**`）は source 禁止パターンの巻き添えになる」

source path の組み込み禁止パターン（`knowledge-check.ts` の `FORBIDDEN_SOURCE_PATTERNS`、
proposals check も `forbiddenSourcePattern` を流用）に `**/.ai/**` が含まれるため、
path のどこかに `/.ai/` を含むファイルはすべて source に指定できない。対象 repo の
runtime 領域 `.ai/**` を弾くのが本来の意図だが、中央 repo では配布の正本
`distribution/base/files/.ai/managed/prompts/propose.md` 等の Git 追跡済み authoritative
ファイルも巻き添えで拒否される（2026-08 の propose 実行中に実際に FAIL で発覚）。

非自明な点: 通常の対象 repo ではこの巻き添えは起きず、「distribution の正本と
managed copy の path 構造が同じ」中央 repo（自己導入 repo）だけで顕在化する。
配布 prompt や配布 policy を根拠にしたい knowledge / proposal は、代理 source
（同じ内容を記述する `docs/**` や、配布変更に連動する `distribution/base/manifest.yaml`）
を使う必要がある。この回避パターンは既存 proposal
`propose-prompt-guard-command-drift` / `proposal-filename-convention-unenforced` の
frontmatter に実例がある。禁止パターン自体を精緻化する（repo root 相対の `.ai/**` だけ
弾く等）かどうかは別途の改善判断であり、まず制約として書き残す価値がある。

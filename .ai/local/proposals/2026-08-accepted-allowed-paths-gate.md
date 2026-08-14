---
# yaml-language-server: $schema=../../managed/schemas/proposal.schema.json
schema_version: 1
id: 2026-08-accepted-allowed-paths-gate
status: open
proposed_at_commit: fd23c4fa25ba814e9117990701afc57901359140
sources:
  - path: "docs/guard.md"
  - path: "docs/proposal-loop.md"
---

## 提案: 「accept の判断には対象 path が allowed_paths 内かの確認が要る」の knowledge entry

`aro proposals check` は提案の**実装対象 path** が `ai.allowed_paths` に収まるかを検証しないため、
人間が accept しても AI 改善ループから実装できない提案が生まれうる。guard の `outside_allowed_paths`
は `severity: warn` で人間の PR は通るが、improve ループの自己検証は warn も中止条件として扱うため
（docs/guard.md「severity」節）、AI は実装を破棄または保留せざるを得ない。実例: 2026-08-10、
accepted 提案 `readme-proposal-loop-missing` は README.md が allowed_paths 外だったため初回実装が
保留になり、設定専用 PR #52（`project_config` fail の override merge）で allowed_paths を広げてから
rebase して PR #53 で実装した。採否判断（PR①の accept）のチェック項目として「対象 path が
allowed_paths 内か」を knowledge に残す価値がある。

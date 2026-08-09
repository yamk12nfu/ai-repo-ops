---
schema_version: 1
id: self-sync-must-follow-release
status: accepted
decision:
  by: yamk12nfu
proposed_at_commit: bbb068ee0f453e519d8d6754f59bec6012f6999f
sources:
  - path: ".github/workflows/ai-review.reusable.yml"
  - path: "packages/aro-cli/src/core/sync-authentication.ts"
---

## 提案: 「自己導入 repo では distribution 変更と self-sync を同一 PR にできない」の knowledge entry

タイトル案: 「self-sync はリリース（v1 移動）後に別 PR で行う」

ai-repo-ops 自身に aro を導入した場合、distribution（`distribution/base/files/**`）を変更する
PR で自身の `.ai/managed/**` を同時に `aro sync` すると、CI の guard が managed_file violation で
fail する。CI の trusted sync 認証は `job.workflow_repository` / `job.workflow_sha`（= 呼び出した
reusable workflow の `v1` タグが指す commit）を checkout して authoritative source にするため
（`ai-review.reusable.yml` の「Checkout guard engine」step）、PR 内の**新しい** distribution 内容
とは content hash が一致せず、`authenticateSyncChange` が認証を拒否する。

非自明な点: 通常の対象 repo では「sync は常にリリース済み distribution から行う」ため
この問題は構造的に起きない。自己導入 repo だけが「distribution の正本と managed copy が
同居する」ため、変更 → リリース（v1 移動）→ self-sync の順序制約が生まれる。
将来 self の doctor が drift WARN を出したとき、同一 PR で直そうとする誘惑への防止線として
knowledge に残す価値がある。

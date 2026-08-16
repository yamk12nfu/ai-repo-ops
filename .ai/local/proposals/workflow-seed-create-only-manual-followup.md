---
schema_version: 1
id: workflow-seed-create-only-manual-followup
status: accepted
decision:
  by: yamk12nfu
proposed_at_commit: 8d024a6c25b019d9adc529c8d65a2c6ec5ccf096
sources:
  - path: "distribution/base/manifest.yaml"
  - path: "distribution/base/files/.github/workflows/ai-review.yml"
---

## 提案: 「workflow seed の変更は既存 repo に sync で届かない」の knowledge entry

タイトル案: 「ai-review.yml は create_only seed — 変更は既存 repo への手動追随が必要」

`distribution/base/files/.github/workflows/ai-review.yml` は manifest 上 `seed_files`
（`strategy: create_only`）であり、初回 `aro init` でしか書き込まれない。したがって
seed 側を変更しても（例: 0.1.8 で追加した default branch への push トリガーと
concurrency group の変更）、**導入済み repo には `aro sync` で届かず、repo ごとに
手動で追随する必要がある**（warikapp では sync PR に手動反映を同梱した）。

非自明な点: managed_overwrite のファイルは sync で自動追随するため、「配布物を変えれば
全 repo に届く」という直感が workflow seed には通用しない。seed を変更するリリースでは
「既存 repo への手動追随タスク」を配布側の作業として明示的に数える必要がある。
今後 seed 変更のたびに踏むポイントなので knowledge として残す価値がある。

# 計画 05: fleet 診断 + rollout — 複数 repo の一覧診断と一括同期 PR

優先度: 中（参加 repo 3 個超で発動） / 前提: 計画 04 / 規模: 大（2 段階に分割）

## できるようになること

### Stage 1: fleet（read-only）

| | Before（現状） | After（完了後） |
|---|---|---|
| 全体像の把握 | repo ごとに手で `aro doctor` / `aro diff` を叩くしかなく、艦隊全体の状態が見えない | **1 コマンドで全対象 repo の状態が一覧できる**: どの repo が正常か・更新待ちか・conflict か・doctor FAIL か |
| 自動化 | — | `--json` 出力により、CI・定期ジョブ・将来の telemetry から機械的に消費できる |

```bash
aro fleet doctor --registry registry/repos.yaml [--json]
aro fleet diff   --registry registry/repos.yaml [--json]
```

### Stage 2: rollout（write）

| | Before（現状） | After（完了後） |
|---|---|---|
| 中央更新の展開 | 各 repo で手動 `aro sync` → 手動 commit → 手動 PR | **1 コマンドで、差分のある全 repo へ同期 PR が一括で立つ**。conflict repo は自動でスキップされ、結果レポートに残る |

```bash
aro rollout --registry registry/repos.yaml [--dry-run]
```

## 現状とギャップ

- 単一 repo 向けの部品は完成している:
  - `aro doctor`: 読み取り専用、exit `0`=FAIL なし / `1`=FAIL あり / `3`=unexpected
  - `aro diff --detailed-exitcode`: `0`=差分なし / `1`=validation error / `2`=更新あり / `3`=conflict / `4`=unexpected
  - fleet はこの 2 つを registry でループして集計する薄い層として実装できる
- registry（対象 repo の一覧）が存在しない。実装計画書 v3 の Post-MVP Phase B で
  `registry/repos.yaml` として想定済み。
- rollout に必要な GitHub 操作（clone / branch / commit / push / PR 作成）は未実装。

## スコープ

- `registry/repos.yaml` の schema 設計と読み込み
- Stage 1: `aro fleet doctor` / `aro fleet diff`（read-only）
- Stage 2: `aro rollout`（Stage 1 の安定運用後に着手）

## 非スコープ

- conflict の自動解消（rollout は conflict repo をスキップして報告するのみ。解消は Post-MVP Phase A の領域）
- rollout PR の自動 merge
- telemetry への結果送信（レポートはまず標準出力 / JSON ファイルで十分）

## 実装タスク

### Stage 0: registry

1. `registry/repos.yaml` の schema を設計する。最小構成:

   ```yaml
   schema_version: 1
   repos:
     - name: your-repo            # 表示名
       github: yamk12nfu/your-repo # owner/repo（rollout で使用）
       path: ~/src/your-repo       # ローカル clone（fleet で使用。無ければ skip として報告）
   ```

2. schema 検証は既存の `core/yaml.ts` + zod のパターンに揃える。

### Stage 1: fleet（read-only）

1. `aro fleet doctor`: registry の各 repo に対し doctor を実行し、`PASS / WARN / FAIL / SKIP(clone なし)` を
   1 行 1 repo のテーブルで表示。exit code は「FAIL が 1 つでもあれば 1」（doctor の設計を艦隊に持ち上げる）
2. `aro fleet diff`: 各 repo の detailed-exitcode（0/2/3）を `clean / update / conflict` として集計表示
3. `--json`: repo ごとの結果と集計を機械可読出力
4. 実装は commands 層のループに留め、判定ロジックは一切複製しない（doctor / diff の core をそのまま呼ぶ）

### Stage 2: rollout

1. 実行フロー（repo ごと、fleet diff の結果を入力に）:
   - `update` の repo のみ対象。`conflict` はスキップし理由つきで報告
   - branch 作成（`chore/ai-repo-ops-sync-<version>`）→ `aro sync` → commit → push →
     `gh pr create`（タイトル: `chore(ai-repo-ops): sync ai repo ops files`、実装計画書 v3 の規約どおり）
2. `--dry-run`: fleet diff と同等の情報 + 「作られるはずの PR」の一覧を表示して終了
3. 結果レポート: repo / 結果（PR URL・スキップ理由・エラー）の一覧を最後に出力
4. 認証は `gh` CLI に委譲する（token 管理を自前でやらない）

## 受け入れ条件（DoD）

### Stage 1

- [ ] 3 repo 以上を registry に載せ、`aro fleet doctor` が 1 画面で全 repo の状態を表示する
- [ ] 1 repo に意図的な conflict を作り、`aro fleet diff` が当該 repo だけ `conflict` と報告する
- [ ] `--json` の出力を `jq` で加工して repo 名一覧が取れる
- [ ] fleet 実行が対象 repo のファイルを一切変更しない

### Stage 2

- [ ] distribution 更新後の `aro rollout` で、差分のある全 repo に PR が立つ
- [ ] conflict repo には PR が立たず、レポートにスキップ理由が出る
- [ ] `--dry-run` が書き込みゼロで実行計画を表示する

## リスク / 未決事項

- **ローカル clone 前提 vs 自動 clone**: MVP の fleet は「手元に clone がある repo だけ見る」で開始し、
  rollout 段階で fresh clone（一時ディレクトリ）方式を再検討する。stale な clone を診断すると
  誤報になるため、fleet 実行時に `git fetch` + default branch 一致チェックを入れるかは Stage 1 実装時に判断。
- rollout の並列実行は不要（repo 数十個までは逐次で十分）。まず逐次で実装する。
- 同一 repo に既存の sync PR が open のままの場合の挙動（更新 push か、スキップか）は Stage 2 設計時に決める。

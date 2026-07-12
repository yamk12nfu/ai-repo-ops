# aro guard（policies の機械的 enforcement）

`aro guard` は、base と HEAD の diff を `.ai/project.yaml` と適用 policy に照らして機械的に検証する
読み取り専用コマンドである（[計画 03](./plans/03-guard-and-improve-loop.md) Stage 1-1）。
プロンプトで AI に「守れ」と依頼するのではなく、違反をコードで検出する。AI・API キー・secrets は不要。

```bash
aro guard --repo /path/to/your-repo --base main          # 人間向け出力
aro guard --repo /path/to/your-repo --base main --json   # 機械可読出力
```

- `--base <ref>` は必須。ブランチ名・タグ・commit SHA を渡せる。
- 比較は **merge-base 比較**（`<base>...HEAD` 相当）。base branch が PR 作成後に進んでいても、
  PR 由来の変更だけが検証対象になる。
- 終了コード: `0`=違反なし / `1`=違反あり / `3`=unexpected error（検証に必要な入力が読めない場合を含む。
  `aro doctor` と同じ設計）。

## 検証項目

| violation kind | 内容 |
|---|---|
| `forbidden_path` | `ai.forbidden_paths`（`.ai/project.yaml`）∪ 適用 policy の `forbidden_paths` に一致する変更 |
| `managed_file` | `.ai/managed/**` / `.ai/ai-repo-ops.lock.yaml` への変更（managed file は直接編集禁止） |
| `workflow` | `.github/workflows/**` への変更（設定に依らない既定。workflow の自己書き換え禁止） |
| `project_config` | `.ai/project.yaml` 自体への変更（下記「project_config の扱い」参照） |
| `outside_allowed_paths` | `ai.allowed_paths` 定義時、そのいずれにも一致しない変更（未定義なら検査しない） |
| `too_many_files` | 変更ファイル数が上限超過（`ai.max_changed_files` と policy の `change_limits.max_changed_files` の厳しい方） |
| `too_many_added_lines` | 追加行数合計が policy の `change_limits.max_added_lines` を超過 |

glob 評価は `picomatch`（`dot: true, nocase: true`。distribution の保護 path 判定と同じ規約）。
`risk_level` → 適用 policy の対応は `low` → `low-risk.yaml` / `medium` → `default.yaml` /
`high` → `security.yaml`（`.ai/managed/policies/`）。

## 正規 `aro sync` bundle の認証

lock file の変更を含む PR では、guard は正規の `aro sync` が作る変更だけを限定的に認証する。
これは「CLI を実行した事実」の証明ではなく、次の入力から再現した最終状態との一致検証である。

```txt
merge-base の対象file + merge-base lock + authoritative distribution
  → buildSyncPlan / applyPlan を一時snapshot上で再実行
  → 期待される全writeをHEADのraw bytes + Git modeと比較
```

- distribution 名は PR HEAD や CLI の `--distribution` ではなく、merge-base lock から固定する。
- source は guard 実行者が与える信頼入力。中央 reusable workflow は同workflow commitのengineを
  `.aro-engine`へcheckoutし、`--source .aro-engine`を明示する。別revisionへのfallbackはしない。
- HEAD lockから入力に使うのは、正規ISO UTC形式の`updated_at`だけ。他のfieldはmerge-base lockと
  distributionから再生成し、lock全体をbytes単位で比較する。
- managed update/create、create_only seed、append patch、lock-only syncを同じbundleとして扱う。
- 期待fileの欠落、部分commit、余分なpatch内容、偽造lock、内容差、削除、実行bit差、symlink/gitlinkが
  1件でもあればbundle全体を不認証にする。部分的なpath認証はしない。
- bundle外の通常変更を同じPRへ含めることはできるが、従来どおり全guard ruleで検査する。

認証されたpathで免除するのは`managed_file`と`outside_allowed_paths`だけである。
`forbidden_path`、`workflow`、`project_config`、`too_many_files`、`too_many_added_lines`は免除しない。
したがって、中央syncがworkflow seedを新規作成した場合でもworkflow built-inはfailし、policy更新を
含むPR自身も必ずmerge-base側policyで検証される。

認証不一致はunexpected errorにせず、trusted pathを0件として通常のmanaged/allowed違反へ戻す。
sourceの読込不能やGit操作失敗など、検証基盤そのものが成立しない場合は従来どおりexit 3でfail-closedする。

## 検証ルールは merge-base 側から読む（自己改変の防止）

guard は `.ai/project.yaml` と policy を **PR HEAD（working tree）ではなく、`--base` と HEAD の
merge-base revision から読む**。diff の取得も同じ merge-base commit を基準にする。

PR HEAD から読むと、同じ PR 内で `risk_level` を下げる・`forbidden_paths` を空にする・
`allowed_paths` を `**` に広げる、といった変更でそのPR自身の検証を骨抜きにできてしまうため。
merge-base（= すでに base branch に merge 済みの、信頼できる設定）を読み取り元にすることで、
検証ルールは PR からは書き換えられない。

このため次の制約がある:

- **base に `.ai/project.yaml` が存在しない場合、guard は exit 3 で検証不能を報告する**。
  ai-repo-ops を導入する PR そのものは guard 対象にできない（base にまだルールが無い）。
  導入 PR の merge 後、次の PR から guard が効き始める。
- base に適用 policy（`.ai/managed/policies/<name>.yaml`）が無い場合も同様に exit 3。

## project_config の扱い（運用方針）

`.ai/project.yaml` の変更は**禁止ではない**（`risk_level` の見直し等、正当な変更はありうる）。
ただし guard の検証ルールそのものを定めるファイルであるため、`project_config` violation として
**必ず表面化し、他の違反と同様に exit 1（= CI の required check を fail）にする**。

運用: 設定変更を含む PR は required check が落ちた状態になり、**人間が変更内容を確認したうえで
明示的に override（admin merge / check の手動承認）して merge する**。「注意喚起だけで merge 可能」
にはしない（警告どまりだと設定変更が誰にも見られずに通りうるため）。警告レベル
（`severity: warn | fail`）の導入は、運用してこの扱いが厳しすぎると分かった時点で検討する。

## `--json` 出力

```json
{
  "command": "guard",
  "ok": false,
  "base": "main",
  "trustedSync": {
    "status": "rejected",
    "reason": "content_mismatch",
    "expectedPaths": [".ai/managed/prompts/review.md", ".ai/ai-repo-ops.lock.yaml"],
    "authority": {
      "distribution": "base",
      "version": "0.2.0",
      "contentSha256": "..."
    }
  },
  "report": {
    "violations": [
      { "kind": "forbidden_path", "path": "secrets/key.pem", "message": "..." }
    ],
    "summary": { "checkedFiles": 3, "addedLines": 120, "violationCount": 1 },
    "hasViolations": true
  }
}
```

違反一覧・件数とtrusted sync認証結果を機械可読で返す（CI の step summary 生成や将来の telemetry から
利用する想定）。`authenticated`だけが信頼済みの`paths`を持つ。`rejected`は再現時の
`expectedPaths`を持つが信頼済みpathは持たず、`not_applicable`は`status`と`reason`だけを返す。

## CI での利用

- checkout は base との merge-base が解決できる深さが必要（`fetch-depth: 0` が確実）。
- `--base` には **fetch 済みの ref** を渡す（例: `origin/main`、または
  `github.event.pull_request.base.sha`）。shallow clone で base が無いと
  `GIT_MERGE_BASE_FAILED`（exit 3）になる。
- 中央の reusable workflow（`ai-review.reusable.yml`）のエンジンは guard に**差し替え済み**
  （計画 03 Stage 1-2）。対象 repo で PR を開くと guard が実行され、違反時は job が fail し
  違反一覧が step summary と PR コメントに出る。guard は AI レビューと違い「PR を block する」
  検証なので、required check にしてよい。base に検証ルールが無い場合（導入 PR 等）は
  明示 skip で workflow は成功する。

同じ reusable workflow は、Repo Knowledge を導入済みの repo では `aro knowledge check` も実行する。
knowledge pathを変更しないPRは通常モード、`.ai/local/knowledge/**`を変更するPRはstrictモードで検証し、
結果を同じstep summaryへ出す。HEADとbaseのどちらにもindexが無いrepoだけをskipするため、既存indexを
PRで削除して検査を無効化することはできない。詳細は
[`repo-knowledge-loop.md`](./repo-knowledge-loop.md) を参照。

既存repoでknowledgeの書き込み範囲を追加する場合、`.ai/project.yaml`変更は従来どおり
`project_config` violationになる。設定専用PRを人間が確認・overrideして先にmergeし、次のPRから
`aro knowledge init --base origin/main`とknowledge更新を行う。同一PR内の設定緩和はinitの許可判定にも
使われない。

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
- 終了コード: `0`=`severity: fail` の違反なし（`warn` のみなら 0）/ `1`=`fail` の違反あり /
  `3`=unexpected error（検証に必要な入力が読めない場合を含む。`aro doctor` と同じ設計）。

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
| `proposal_decision` | 提案（`.ai/local/proposals/*.md`）の採否・状態の遷移のうち、人間のみが行えるもの（下記「proposal_decision の扱い」参照） |
| `execution_plan_promotion` | Execution Plan のpromotion、権限拡大、履歴変更、削除・判定不能を人間レビュー対象として表面化（下記参照） |

glob 評価は `picomatch`（`dot: true, nocase: true`。distribution の保護 path 判定と同じ規約）。
`risk_level` → 適用 policy の対応は `low` → `low-risk.yaml` / `medium` → `default.yaml` /
`high` → `security.yaml`（`.ai/managed/policies/`）。

## severity（`fail` / `warn`）

violation kind ごとの扱いは、適用 policy の `severity` で定義する。`fail` は exit 1（CI の
required check を落とす）、`warn` は報告のみで exit code に影響しない。**`severity` に無い kind と、
`severity` を持たない policy は `fail` 扱い**（緩める側を既定にすると policy の配布漏れが
検証の骨抜きに直結するため）。

```yaml
severity:
  managed_file: fail
  workflow: fail
  project_config: fail
  forbidden_path: fail
  outside_allowed_paths: warn
  too_many_files: warn
  too_many_added_lines: warn
```

分ける理由は、検証項目の性格が 2 種類あるためである。

- **不変条件**（`managed_file` / `workflow` / `project_config` / `forbidden_path` / `execution_plan_promotion`）— 誰が変更しても
  危険なので、行為者を問わず `fail` にする
- **AI の行動半径の制限**（`outside_allowed_paths` / `too_many_files` / `too_many_added_lines`）—
  `allowed_paths` は定義上「AI が変更してよい path」であり、人間が書いた feature PR に required check
  として課すのは定義の誤用である。実際、これが原因で override merge が常態化した（[issue #33]）

配布時の既定は `default.yaml` / `low-risk.yaml` が上記のとおり、`security.yaml`（`risk_level: high`）は
**すべて `fail`**。high リスク repo では変更範囲そのものが監査対象であり、人間の PR でも範囲逸脱は
明示的な override を経るべきという判断による。この摩擦を避けたい repo は `risk_level` を `medium` に
することで選択できる。

`severity` は managed file である policy 側にあり、`.ai/project.yaml` からは変更できない。これは
「project 設定は policy を緩められない」という既存の判断（`max_changed_files` は両者の厳しい方を採用）
と同じ方針である。

**AI に対する強制は CI ではなく AI の意思決定点で担保する。** 改善ループの AI は PR 作成前に
`aro guard` を自己実行する義務があり（`.ai/managed/prompts/improve.md`）、そこでは `warn` も
中止条件として扱う。加えて `review.require_human_review: true` により merge は常に人間が判断する。

[issue #33]: https://github.com/yamk12nfu/ai-repo-ops/issues/33

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
対象 repo 側から見た具体的な確認・override 手順は [`onboarding.md`](./onboarding.md) を参照。

## proposal_decision の扱い（運用方針）

提案（`.ai/local/proposals/*.md`。[計画 06](./plans/06-proposal-loop.md)）の採否を判断するのは
**常に人間**である。guard は merge-base 側と HEAD 側の frontmatter `status` を比較し
（**guard 初の、path ではなくファイル内容に基づく判定**）、人間のみが行える遷移を
`proposal_decision` violation として報告する。

違反に**しない**遷移（propose / improve ループの正常な出力がノイズで落ちない）:

- （なし）→ `open`: 新規提案の追加（propose プロンプトの正常な出力）
- `accepted` → `done`: 採用済み提案の実装完了（実装 PR の正常な出力）
- `status` が変わらない編集: 実装破棄の記録の追記など

違反に**する**遷移（`severity: fail`。人間が内容を確認して override する）:

- `open` → `accepted` / `rejected`、任意 → `superseded` などの status 変更: 採否は人間のみが行う
- （なし）→ `open` **以外**での新規追加: 最初から `accepted` のファイルを生やして採否検証を
  迂回する経路を塞ぐ
- 提案ファイルの削除: 「提案が消えないこと」の担保。提案は削除せず status で閉じる
- frontmatter から `status` を読めない変更: 遷移を判定できない

機械は「誰が編集したか」を判別できないため、これは**強制ではなく可視化**である。採否の変更を
含む PR は required check が落ちた状態になり、人間が内容を確認したうえで明示的に override して
merge する（`project_config` と同じ運用。緩めない理由も同じで、AI が自分に有利な状態変更を
人間に気づかれずに通す経路を塞ぐため）。frontmatter の schema 妥当性（`decision.by` の必須性等）は
`aro proposals check` の責務であり、guard は遷移の判定に必要な `status` だけを読む。

## `execution_plan_promotion` の扱い（運用方針）

Execution Plan（`.ai/local/execution-plans/*.md`）は、merge-base revision とコミット済み `HEAD` の
frontmatterを比較する。working treeやHEAD側のpolicyは読まないため、PR自身が計画・検証ルールを
書き換えてpromotion検出を迂回することはできない。判定対象は、`git diff <merge-base>...HEAD` に
含まれるPlanファイルだけである。

次の変更は `execution_plan_promotion`（policyにkindの記載がない場合も既定で `fail`）になる。

- Planの `proposed` / `blocked` → `active`、安全側の `active` → `blocked` を除くstatus変更、Planのterminal化
- Stageの `pending` / `blocked` → `active`、`active` → `completed` などの前進・再開
- `permissions.commit` / `push` / `draft_pr` の `false` → `true`
- `permissions.merge: true`（既存値のままでも常に拒否）
- 既存Stageの削除・IDまたは `proposal_id` の変更・並べ替え、末尾以外の追加、pending以外の追加
- Planファイルの削除、またはmerge-base / HEAD側のfrontmatterを読めず遷移を判定できない場合

次の変更はpromotion違反にしない。

- Plan/Stage/permissionの状態を変えない本文・evidence・`updated_at`・`next_action` の更新
- `active` → `blocked` の安全側への停止、permissionの `true` → `false`
- 新規Planの `status: proposed`、全Stage `pending`、全permission `false` での追加
- 既存Stageを保持したまま末尾へ `pending` Stageだけを追加

1ファイルに複数の対象がある場合は、Plan status、Stage履歴、Stage status、permission、merge拒否の
順で全件を決定的に返す。`execution_plan_promotion` は承認を自動化せず、人間が内容を確認して
required checkを明示的にoverrideする境界である。Planのschema・semantic invariantやevidence本文の
意味判定は `aro plans check` の責務で、guardは状態遷移と権限境界だけを扱う。

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

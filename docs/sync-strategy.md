# Sync Strategy

`aro init` / `aro diff` / `aro sync` は、対象 repo の現状と source distribution を比較して同じ **sync plan**（`SyncPlan`）を作り、そこから振る舞いを決める。このドキュメントは canonical text / checksum の仕様、conflict 判定アルゴリズム、plan 適用（apply）の atomicity、コマンドの終了コードをまとめる。実装は `packages/aro-cli/src/core/{canonical-text,checksum,conflict,planner,apply}.ts` にある。

## canonical text と checksum

MVP が扱う配布ファイルは UTF-8 テキストのみ（binary は対象外）。checksum 計算前に、必ず以下の正規化（canonical text 化）を行う。

```txt
1. bytes を UTF-8 として decode する
2. decode 後の先頭文字が U+FEFF（BOM）の場合だけ取り除く（途中の U+FEFF は内容として保持する）
3. CRLF を LF へ変換する
4. 単独 CR を LF へ変換する
5. canonical text を UTF-8 bytes に戻し、SHA-256 を計算する
```

checksum mode 名は `canonical_text_lf_utf8bom_strip_v1`（lock file の `checksum.mode` に記録）。この正規化は配布物・対象 repo 側の managed file・lock file の `installed_sha256` すべてで同じ関数（`canonicalizeText` / `canonicalSha256`）を使うため、**改行コードや先頭 BOM だけの差では conflict にも差分にもならない**。

`aro` がファイルを書き込むときは常に UTF-8 / LF / BOM なしで書く（`writeTextFileLf`）。source 側が CRLF や BOM 付きでも、書き込み内容は正規化済みになる。

`.gitattributes` には `aro init` で以下の行が追記され、対象 repo 側でも改行コードが揺れないようにする。

```gitattributes
.ai/managed/** text eol=lf
.ai/project.yaml text eol=lf
.ai/ai-repo-ops.lock.yaml text eol=lf
.github/workflows/ai-*.yml text eol=lf
```

## conflict 判定アルゴリズム

判定はすべて version ではなく canonical sha256 の比較で行う（`packages/aro-cli/src/core/conflict.ts`）。

### `managed_overwrite`

対象ファイル 1 件につき、target の現在 canonical sha・lock の `installed_sha256`・source の canonical sha を比較する。

```txt
target が存在しない
  → create

target が存在する & lock に記録がない
  → conflict（reason: "present in repo but not recorded in the lock file"）

target sha == lock installed_sha:
  source sha == lock installed_sha → noop
  source sha != lock installed_sha → update

target sha != lock installed_sha
  → conflict（reason: "locally modified since last sync"）
```

「lock に記録がない」conflict は、`aro init` 前から存在したファイルや lock 破損時に発生する。「locally modified」conflict は、前回同期後に人間が managed file を直接編集した場合に発生する。

### `create_only`

```txt
target が存在しない → create
target が存在する   → preserve（以後 aro は一切触らない）
```

### `append_unique_lines`

```txt
target が存在しない → 全 lines で新規作成
target が存在する   → まだ存在しない行だけを末尾に追記
```

行の一致判定は canonical 化（LF 正規化）した既存行と、追記候補の行を単純比較する。既存行の順序やコメントは保持し、`lines` にある行のうち欠けている行だけを元の並び順で末尾に追記する。

### orphaned managed file

lock file の `managed_files` にあるが、現在の source manifest の `files[].dest` に存在しない managed file は `orphaned` として扱う。MVP では自動削除しない（lock からも削除しない）。`aro diff` / `aro doctor` は WARN として表示する。

```txt
Orphaned managed files:
  ? .ai/managed/prompts/old-review.md
    reason: present in lock file but no longer present in source manifest
    action: not deleted in MVP
```

自動削除・rename migration は post-MVP（`ai-repo-ops-implementation-plan-v3.md` §22 Post-MVP Phase A）で扱う。

## sync plan と適用順序

`buildSyncPlan`（`packages/aro-cli/src/core/planner.ts`）は読み取り専用で、対象 repo の内容を読んで `SyncChange[]` を組み立てる。`kind` は次のいずれか。

```txt
create / update / append_unique_lines / preserve / orphaned / conflict / noop
```

`applyPlan`（`packages/aro-cli/src/core/apply.ts`）が実際の書き込みを行う。処理は 2 段階に分かれる。

1. **準備フェーズ**（メモリ上）: 全変更内容の path 検証・symlink 検査・書き込み内容の確定を行う。ここで path 安全性違反があれば、まだ何も書き込まずに throw する。
2. **書き込みフェーズ**: 通常ファイル（managed / seed）→ patch 対象 → lock file の順で書く。**lock file は必ず最後に書く。**

## atomicity（2 段階保証）

MVP のロールバック保証は、自前の backup/restore ではなく「conflict atomicity」と「手動復旧導線」の 2 段階に分ける。

### 1. conflict atomicity（必須保証）

conflict が 1 件でもあれば、`applyPlan` は呼び出される前に abort する（コマンド層が `plan.hasConflicts` を検査して `applyPlan` を呼ばない。`applyPlan` 自身も多重防御として conflict を検出したら throw する）。**対象 repo には一切書き込まれない。**

```txt
Sync aborted because conflicts were detected.
No files were modified.
```

### 2. I/O failure recovery（手動復旧、自動 rollback ではない）

書き込みフェーズでの I/O エラー（disk full・permission error 等）は稀だが、発生時に `aro` は書き込み済みの内容を元に戻す機構を持たない。代わりに `ApplyIoError` が `touchedPaths`（書き込みを試みた repo 相対 path）と `newPaths`（そのうち新規作成だった path）を保持し、CLI が復旧手順を表示する。

```txt
ERROR apply failed while writing .ai/managed/prompts/review.md

Touched paths:
  .ai/managed/prompts/review.md
  .gitattributes

Suggested recovery:
  git restore -- .ai/managed/prompts/review.md .gitattributes
  git clean -fd -- .ai/tmp/
```

既存ファイル（tracked）は `git restore`、新規作成ファイルは削除で復旧する。**`aro init` 直後は生成物を一度 commit してから次の `aro sync` を実行することを推奨する** — 未 commit のまま I/O 失敗が起きると `git restore` で戻せないことがある。

## managed file を直接編集してしまった場合の復旧

`.ai/managed/**` は `aro` が管理し、人間は直接編集しない。誤って編集すると conflict になる。復旧手順:

```bash
git restore -- .ai/managed/<path>
aro sync --repo .
```

`aro reset-managed` のような専用コマンドは MVP では実装しない。

## コマンドと終了コード

いずれのコマンドも `aro diff` / `aro sync` の内部で同じ `buildSyncPlan` を使うため、`aro doctor` の checksum/orphaned/patch 判定結果とも一致する。

### `aro init`

```txt
0: 成功
1: validation error（git repo でない / manifest 不正 / path 不正 / source 不在 など）
2: blocked（.ai/ai-repo-ops.lock.yaml が既にある / 既存ファイルが managed_overwrite 対象と衝突）
3: unexpected error（書き込み中の I/O 失敗など）
```

`aro init` は plan 内に conflict（= 既存ファイルとの衝突）があると **exit code 2** で abort し、一切書き込まない。lock file が既に存在する repo に対しては（衝突判定より前に）exit code 2 で reject し、`aro diff` / `aro sync` を使うよう案内する。`--force` は MVP では実装しない。

### `aro diff`

実ファイルは変更しない。

```txt
通常モード:
  0: plan 生成成功。差分なし、または差分ありだが conflict なし
  1: validation error
  2: conflict あり
  3: unexpected error

--detailed-exitcode 指定時:
  0: 差分なし、conflict なし
  1: validation error
  2: 更新あり、conflict なし
  3: conflict あり
  4: unexpected error
```

人間がローカルで確認する通常利用では、更新予定があるだけで command failure 扱いにしない（exit 0）。CI / rollout / drift 検出など automation 用途では `--detailed-exitcode` を使い、「差分なし」「更新あり」「conflict あり」を区別する。

### `aro sync`

```txt
0: 成功（適用済み / up to date / dry-run で conflict なし）
1: validation error
2: conflict（abort。ファイルは変更しない）/ dry-run で conflict 検出
3: unexpected error（書き込み中の I/O 失敗など）
```

「up to date」（lock file への書き込みも含め何もしない）と判定されるのは、実ファイル変更（create/update/append）が無く、かつ lock の `distribution_content_sha256` と source の distribution content hash が一致している場合だけ（`planRequiresSync`、`packages/aro-cli/src/core/plan-summary.ts`）。実ファイル変更が無くても distribution content hash がずれている場合（[distribution.md](./distribution.md) の「seed file変更の扱い」を参照）は「更新あり」として扱われ、`applyPlan` が呼ばれる。このとき managed/seed file の書き込みは発生しなくても、lock file だけは新しい `distribution_content_sha256` で更新される（**lock-only sync**）。`--dry-run` は書き込みを一切行わず、`aro diff` と同じ出力を表示したうえで conflict の有無だけを exit code に反映する。

### `aro doctor`

読み取り専用。

```txt
0: FAIL なし
1: FAIL が 1 件以上ある
3: unexpected error（repo path 不正・source/manifest/schema 読込失敗など、診断レポート自体を作れない場合）
```

診断項目・重大度の詳細は `packages/aro-cli/src/core/doctor.ts` と README の `aro doctor` セクションを参照。managed file の checksum mismatch（conflict 相当）は FAIL、`aro sync` で自動的に解消される drift（未追従の更新・未作成ファイル・orphaned managed file・patch 未追記）は WARN として区別される。

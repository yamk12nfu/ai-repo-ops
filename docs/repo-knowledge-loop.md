# Repo Knowledge Loop

Repo Knowledge Loop は、リポジトリ固有の知識を、追跡可能な根拠と一緒にローカルで育てる仕組みである。
本文は `.ai/local/knowledge/*.md`、機械的な索引は `.ai/local/knowledge/index.yaml` に置く。

重要な境界は次のとおり。

- コードと正式ドキュメントが正本。knowledge はそこから導いた索引・要約であり、正本を置き換えない。
- AI は開発者のローカル環境でだけ動かす。CLI と CI は決定的な検証だけを行う。
- CI で LLM API、外部ネットワーク、repo ごとの AI secret、自動 PR、自動 merge は使わない。
- `.ai/local/knowledge/**` は対象 repo の所有物。中央 distribution は上書きしない。

## ディレクトリと index

```txt
.ai/
  managed/
    prompts/knowledge-refresh.md       # 中央管理のローカルAI向け手順
    schemas/knowledge.schema.json      # エディタ向け配布コピー
  local/
    knowledge/
      index.yaml                       # entry・根拠・検証commit
      overview.md                      # repo固有knowledge本文
      architecture.md
```

```yaml
# yaml-language-server: $schema=../../managed/schemas/knowledge.schema.json
schema_version: 1
entries:
  - id: authentication-architecture
    document: architecture.md
    verified_at_commit: 0123456789abcdef0123456789abcdef01234567
    sources:
      - path: src/auth/service.ts
      - path: docs/authentication.md
```

- `id`: 小文字英数字の kebab-case。大文字小文字を区別せず一意。
- `document`: knowledge root からの正確な相対 Markdown path。glob は不可で、entry 間で一意。
- `verified_at_commit`: 根拠を確認した完全な lowercase Git SHA（SHA-1 の40桁または SHA-256 の64桁）。
- `sources[].path`: repo root からの正確な相対ファイル path。1件以上、glob と重複は不可。

1 entry は1つの Markdown document に対応する。複数の source は同じ
`verified_at_commit` 時点でまとめて検証する。

## 初期化

新規 repo では、まず `aro init` の結果を commit する。`knowledge init` は必須の `--base <ref>` と HEAD の
merge-base にある `.ai/project.yaml` を読み、feature branch や working tree 内の設定緩和を信用しない。
初期 commit 直後だけは、その commit 自体を明示的な基準にするため `--base HEAD` を指定する。

```bash
aro init --repo .
git add -A && git commit -m "chore: initialize ai-repo-ops"
aro knowledge init --repo . --base HEAD
```

`aro knowledge init` は `index.yaml` と `overview.md` を exclusive create し、既存ファイルを
上書きしない。実行前に次を確認する。

- `--base` と HEAD の merge-base にある `.ai/project.yaml` が `.ai/local/knowledge/**` を許可し、禁止していない。
- managed schema と refresh prompt が導入済み。
- 作成先と親 path に symlink が無い。
- 作成先がまだ存在しない。

既存 repo では、設定専用 PR を merge した後の branch で `--base origin/main` を指定する。`--dry-run` は
作成予定だけを表示し、`--json` は機械可読な結果を返す。

2ファイルの exclusive-create の途中で I/O error が発生した場合は、先に作成できた path と
失敗した path を `KNOWLEDGE_INIT_PARTIAL_WRITE` とともに human / JSON の両形式で報告する。JSON では、
成功済みで削除可能な path だけを `recovery.removePaths`、存在と内容を確認すべき失敗先を
`recovery.inspectPaths` として別に返す。`error.errno` が `EEXIST` の場合、失敗先は別 writer 所有の
可能性がある。それ以外で `error.failedPathMayBePartial` が `true` の場合、exclusive create 後の
空または部分ファイルが残った可能性がある。どちらも失敗先を自動削除せず、必ず確認してから
`removePaths` だけを削除して再実行する。

終了コード:

| code | 意味 |
|---:|---|
| `0` | 作成成功、または dry-run 成功 |
| `1` | repo・設定・schema 等の validation error |
| `2` | 未許可・managed artifact 未導入・作成先既存による blocked |
| `3` | 予期しない I/O error（部分生成時は作成済み path と復旧対象を報告） |

## 検証と鮮度

```bash
aro knowledge check --repo .
aro knowledge check --repo . --strict
```

`knowledge check` は次を検証する。

1. index が UTF-8 YAML で authoritative schema と意味制約に適合する。
2. document が knowledge root 内の UTF-8 Markdown で、symlink ではない。
3. source が許可された正確な相対 path の UTF-8 text file で、HEAD に追跡されている。
4. verification commit が存在し、HEAD の祖先である。
5. source が verification commit に存在する。
6. verification commit 以降、現在の working tree まで source 内容が変わっていない。

source が変わった場合だけが `stale` である。日数による失効は行わない。

| 状態 | 通常 | `--strict` |
|---|---|---|
| fresh | PASS / exit 0 | PASS / exit 0 |
| stale | WARN / exit 0 | FAIL / exit 1 |
| schema・path・provenance 不正 | FAIL / exit 1 | FAIL / exit 1 |
| checker 自体が実行不能 | exit 3 | exit 3 |

空の `entries` は導入直後の正常な状態として WARN にするが、strict でも blocking failure にはしない。
文章の意味的な正しさ、網羅性、文書間の矛盾は機械判定しない。そこはローカルAIと人間レビューの責務である。

## source の安全境界

次の source は内容を読む前に拒否する。

```txt
.env / .env.*
secrets/**
.git/**
.ai/**
node_modules/**
dist/**
build/**
```

これらの禁止patternは repo root だけでなく、すべての nested 階層に適用する。

さらに absolute path、`..`、glob、NUL、Windows予約名、symlink、binary、未追跡ファイルを拒否する。
外部 URL、Issue / PR、Slack、Notion、CI log 等は index の source にできない。許可された通常ファイルの
中に埋め込まれた secret の意味的検出までは行わないため、source 選定と本文差分は人間が確認する。

## ローカル更新ループ

対象 repo で `.ai/managed/prompts/knowledge-refresh.md` を Claude Code / Codex に読ませる。

```txt
.ai/managed/prompts/knowledge-refresh.md を読み、Repo Knowledge を1単位だけ更新して
```

AI は tracked source を調査し、`.ai/local/knowledge/**` だけを変更する。検証に使った current HEAD の
完全 SHA を index に記録し、`aro knowledge check --strict` と `aro guard` を通す。PR 作成と merge は
開発者が差分を確認した後に行う。

source code を同時に直すループではない。source が変更済みなら、その変更を先に commit し、その HEAD を
根拠として knowledge を別の小さな変更で更新する。

## CI

中央の reusable `ai-review` workflow は、HEAD または base に knowledge index がある repo だけ checker を
実行する。

- knowledge 未導入 repo: skip。
- knowledge path を変更しない PR: 通常 check。stale は summary に WARN として出す。
- `.ai/local/knowledge/**` を変更する PR: strict check。stale を含む failure で job を fail する。
- base にあった index を削除する PR: skip せず、index 欠落として fail する。

CI は中央 checkout の authoritative schema と checker を使う。PR 側の managed schema を改変しても検証を
緩められない。

## 既存 repo への導入

既存 repo の `.ai/project.yaml` は `create_only` なので `aro sync` では自動変更されない。次の順序で導入する。

1. 中央 source を更新し、`aro sync` で managed schema / prompt を導入する。
2. `.ai/project.yaml` の `ai.allowed_paths` に `.ai/local/knowledge/**` を追加する設定専用 PR を作る。
3. 設定変更を人間がレビューし、必要な required-check override を経て merge する。
4. 次の branch で `aro knowledge init --repo . --base origin/main` を実行し、最初の knowledge PR を作る。

同一 PR の先行 commit で許可設定を追加しても、`--base origin/main` と HEAD の merge-base 側では未許可の
ままなので `knowledge init` は blocked になる。これは、knowledge を作る側が同時に自分の書き込み境界を
広げる自己許可を防ぐための意図的な二段階設計である。

## MVPで行わないこと

- source の自動探索や glob 展開
- vector database / embedding / RAG service
- LLM API を使った CI 更新
- scheduler / cron による無人実行
- 自動 PR 作成、自動 approve、自動 merge
- knowledge の意味的真偽・網羅性・矛盾の自動証明

この境界を維持したまま運用実績を集め、必要性が確認できた機能だけを後続で追加する。

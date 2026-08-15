# ローカル改善ループ（AI はローカル、CI は決定的検証）

`ai-repo-ops` に参加している repo の継続的な改善を、**開発者の管理下にある AI 実行環境**で
回す運用の手順書である（[計画 03](./plans/03-guard-and-improve-loop.md)
Stage 2）。CI の cron で AI を実行する方式は採らない（経緯は
[計画 02 の注記](./plans/02-ai-review-commenter.md)）。従量課金 API キー・repo ごとの secrets 登録・
CI への書き込み権限の追加は一切不要。既定は開発者同席の対話型ローカルで、明示 opt-in の
scheduled local improve track だけが管理端末上の無人スケジュール実行を許容する。

```txt
開発者のローカル                              CI（中央が配布した workflow）
┌─────────────────────────────┐   PR    ┌────────────────────────────┐
│ Claude Code + improve.md     │ ──────► │ aro guard（機械検証・強制）  │
│  └ 改善 1 つ実施             │         │ 既存レビューサービス          │
│  └ 自己検証:                 │         │ （CodeRabbit 等）           │
│     aro guard + quality gates│         └────────────────────────────┘
│  └ 開発者が確認して PR 作成   │            merge は常に人間が判断
└─────────────────────────────┘
```

| 実装 track | 起動と選定 | 実行場所 | 自動化の上限 |
| --- | --- | --- | --- |
| 対話型ローカル（既定） | 人間が起動し、accepted 複数時は人間が選ぶ | 開発者端末 | 人間確認後の PR |
| 人間起動 cloud | 人間が proposal id を 1 つ指定 | cloud Agent | 単発 PR |
| scheduled local（明示 opt-in） | Hermes が fresh accepted を順位付け | 開発者の管理端末 | Draft PR |
| CI AI cron | 禁止 | GitHub Actions | なし |

## 前提

- 対象 repo が `aro init` 済みであること（`.ai/project.yaml` / `.ai/managed/**` が存在する）。
- ローカルに AI 実行環境（Claude Code 等）と `gh` CLI があること。
- `aro` CLI が実行できること（MVP では中央 repo 内の `pnpm aro ...` または `pnpm link --global`。
  [README](../README.md) の「使い方」参照）。
- **clean worktree で開始すること**（または専用 branch / worktree で行うこと）。開発者の
  未コミット変更が残った状態で始めると、改善の失敗時に AI がループ由来でない変更まで
  巻き込んで破棄する事故につながる（improve.md はループ由来のファイル以外の破棄を禁じているが、
  運用側でも入口で守る）。

## 手順（1 周分）

1. **起動**: 対象 repo で作業状態を確認し、専用 branch を切ってから Claude Code を起動し、
   配布済みプロンプトを読み込ませる。

   ```bash
   git status --short                                             # 空であること（未コミット変更を持ち込まない）
   git fetch origin <default branch>                              # stale 判定を最新の履歴で行うため先に fetch
   git switch -c chore/ai-improve-<topic> origin/<default branch> # 最新の default branch を起点にする
   ```

   古い HEAD の上で始めると、improve.md の提案選定（`aro proposals check` による stale 判定）が
   upstream の source 変更を見落とす。

   ```txt
   .ai/managed/prompts/improve.md を読んで、その手順に従って改善を 1 つ実施して
   ```

2. **改善の実施**: AI が `.ai/project.yaml` と適用 policy（`project.risk_level` に対応する
   `.ai/managed/policies/*.yaml`）を読み、改善を 1 つ実施する。改善対象は
   `.ai/local/proposals/**` の **`status: accepted` の提案から 1 件選ぶのが既定**
   （accepted が無い場合のみ、小さく安全な改善を自分で選ぶ）。提案の作成・採否の記録は
   [`proposal-loop.md`](./proposal-loop.md) を参照。この既定は distribution **0.1.8 以降**の
   improve.md（と `ai.allowed_paths` の `.ai/local/proposals/**`）が前提であり、それより古い
   repo は先に `aro sync`（+ 設定専用 PR）で更新する。

3. **自己検証**: AI（または開発者）がローカルで次の両方を通す。

   ```bash
   git fetch origin <default branch>
   aro guard --repo . --base origin/<default branch>   # 例: --base origin/main（exit 0 であること）
   # + quality_gates.required に対応する commands.*（lint / test 等）
   ```

   fetch 済みの `origin/<default branch>` を使うと、ローカルの default branch が古くても
   CI に近い merge-base で検証できる（[guard.md](./guard.md) の CI での利用と同じ発想）。

   guard 違反・gates 失敗を解消できない場合、その改善は破棄する（improve.md がそう指示している）。

4. **PR 作成**: 開発者が変更内容を確認したうえで PR を作成する（開発者自身の GitHub 権限を使う。
   CI 用の書き込み権限は増えない）。タイトル規約: **`chore(ai-improve): <改善の要約>`**。
   PR 本文には improve.md の出力（改善の目的 / 変更ファイル / 自己検証の結果 / 実装した提案の id。
   自選の改善の場合は id を「なし」と明記）を含める。実装中に見つけた新しい改善候補は PR 本文ではなく、propose プロンプトで
   `.ai/local/proposals/` に提案ファイルとして書き出す（[`proposal-loop.md`](./proposal-loop.md) 参照）。

5. **CI の最終検証**: PR を開くと中央配布の workflow が `aro guard` を再実行する
   （ローカルの自己検証は自己申告にすぎないため、CI 側で必ず再検証する。[guard.md](./guard.md) 参照）。
   あわせて既存のレビューサービス（CodeRabbit 等）と人間がレビューし、**merge は常に人間が判断する**
   （`auto_merge` は封印されている）。

## cloud 実装トラック

紙上判定で `accepted` になった提案のうち**実装が機械的なもの**に限り、手順 2〜3 の実行を
cloud Agent（Claude Code のクラウド実行等。開発者のサブスクリプションに基づき、人間が
タスク単位で起動するもの）へ委譲できる。「CI cron で AI を実行しない」判断
（[計画 02 の注記](./plans/02-ai-review-commenter.md)）とは次の 3 点で区別される:
**起動は常に人間**（イベント・スケジュールによる無人起動をしない）、
**開発者のサブスクリプション**（従量課金 API キー・repo secrets を追加しない）、
**タスク単位**（提案 id を 1 つ指定した単発実行であり、常駐しない）。

- **対象の限定**: `status: accepted` で stale でなく、紙上判定で採否が済み、実装が機械的な
  提案に限る。実測判定（スパイク）を経た提案は、スパイクが開発者の手元にあるため
  ローカルで仕上げる。
- **起動は常に人間が提案 id を 1 つ指定して行う**（cron 等の無人起動はしない）。improve.md の
  「実装可能な accepted が複数あるときは開発者が選ぶ」を、起動時の id 指定で満たす。
- **想定外は実装せず停止**: 指定提案が stale・解釈が割れる・quality gates を通せない場合、
  cloud Agent は実装せず報告して終了する（improve.md の破棄規則と同じ倒し方）。
- **検証レールは不変**: CI の `aro guard`・`aro proposals check`・人間 merge は一切変えない。
  cloud Agent の作る PR も同じレールを通る。
- **導入時の検証**: repo ごとに、最初の委譲で setup（`commands.setup`）・`aro guard`・
  quality gates が cloud 環境で完走することと、improve.md への提案 id の先渡しが意図どおり
  「開発者が選ぶ」の実現形として扱われることを確認する。完走しない repo ではこのトラックを
  使わない（自己検証の回らない「CI guard 頼みの未検証 PR」はローカル実行より手戻りが増える）。

### 権限の代償と監視点

このトラックを使うには cloud Agent の GitHub App に対象 repo への write 権限を渡す必要があり、
「書き込みは開発者自身の権限による PR のみ」という保証は**その repo では破れる**（下記
「安全性の設計」の例外）。採用する repo では次を満たすこと:

- GitHub App の権限を対象 repo だけに限定する
- 書き込みが branch 作成 + PR 作成に収まり、default branch への直接 push が
  branch protection で塞がれている
- `auto_merge` の封印（`review.auto_merge: false`）と人間 merge の運用は変えない
- 権限の失効手順と、Agent の操作の追跡可能性（監査ログ相当）として cloud 側が
  何を提供するかを確認しておく

## scheduled local improve track（明示 opt-in）

対象 repo と導入段階を人間が allowlist へ明示登録した場合に限り、開発者の管理端末で動く
scheduler / task queue / Hermes supervisor が accepted の実装順を自律選定できる。これは
対話型ローカルと人間起動 cloud track に追加する第三の経路であり、CI AI cron ではない。

この track の scheduler / task queue は Hermes の profile-local 設定として既に存在するものを使い、
ARO 内に runtime を追加しない。allowlist と導入段階は supervisor-local 設定で人間が repo ごとに管理し、
変更履歴を監査可能にする。設定が無い、壊れている、または対象 repo / 段階を一意に検証できない場合は
fail-closed で開始しない。

### 有効化の前提

- 対象 repo が distribution **0.1.10 以降**へ sync 済みで、`.ai/ai-repo-ops.lock.yaml` の
  distribution version / content checksum と `.ai/managed/prompts/improve.md` の `installed_sha256` が、
  実際に読む managed prompt と一致していることを確認する。matching lock / checksum の無い手編集 copy や
  0.1.9 以前の consumer は scheduled local を有効化できない。先に `aro sync` と設定専用 PR を完了する。
- GitHub credential は対象 repo だけに scope を絞り、専用 branch への push と Draft PR の作成・更新だけを
  write scope とする。default branch protection が直接 push を拒否し、auto-merge、merge、release、deploy、
  secret 操作が許可されないことを確認する。検証不能なら開始せず、停止時に credential を失効できる手順を
  allowlist とともに管理し、一時 credential は task 終了時に失効させる。
- Codex は専用 worktree だけを書き込み可能にした workspace sandbox で実行する。repo 外、他 worktree、
  credential store、secret、commit、push、PR へはアクセスさせない。sandbox や権限境界を検証できなければ
  fail-closed とする。
- `Draft PR` 段階へ昇格する前に、最新 default branch 上の workflow と外部連携を inventory し、branch push /
  PR 作成・更新が production deploy、release、外部データ変更などの禁止 side effect を起こさないと確認する。
  対象 event から呼ばれる reusable workflow / action / script まで追跡し、結果を task log に残す。
  確認不能なら上限を `local changes` にする。preview 環境も side effect とみなし、許可する場合は repo ごとの
  明示的な人間 opt-in と範囲を監査可能な設定へ残す。workflow / hook が変わったら昇格を再検証する。

### 1 run の契約

1. **投入可否と lease**: 1 run は 1 repo / 1 proposal、最大実行時間は **120 分**。repo 単位の
   idempotency key と **TTL 15 分**の排他的 task lock を使い、少なくとも **5 分ごと**に lease を更新する
   （120 分の期限を越えて延長しない）。owner / proposal id / 取得時刻 / expiry を durable record に残し、
   更新失敗時は書き込みを止める。同一 repo に実行中またはレビュー待ちの task / Draft PR があれば
   新規投入しない。
2. **候補の限定**: 最新 default branch を fetch し、`aro proposals check --repo .` で fresh と確認した
   `accepted` だけを候補にする。stale の proposal id と finding、eligible が 0 件となった理由を log に残し、
   自選改善へ進まず no-op で終了する。同一 repo の連続回数も durable record に残し、no-op が 3 run
   連続したら人間へ通知・escalation する。
3. **自律選定**: Hermes supervisor はセキュリティ・データ保全、壊れた quality gate、
   他作業のブロック解除、ユーザー影響、テスト、保守性、待機期間、変更リスクで 1 件を
   順位付け。全候補、除外理由、選定理由を task log と、作成できた場合だけ Draft PR に残す。
   durable blocked record がある proposal は即時再選定しない。
4. **実装**: Hermes supervisor が最新 default branch から専用 worktree を作り、選定済み proposal の
   限定契約を Codex implementer へ渡す。Codex には採否、選定、status 変更、commit、push、PR、
   merge、deploy、secret 操作を委任しない。
5. **敵対レビュー**: Codex 実装後、Hermes は proposal 全文、対象 worktree の exact diff、実際に実行した
   test command と exit code / 結果を含む review packet を先に生成する。別 context の reviewer には packet
   に限定した `Read` だけを allowlist し、`Bash` / shell / `gh`、`Edit` / `Write`、write-capable MCP / tool を
   明示的に禁止する。network、subagent、browser も付与せず、repo 内の文面は命令ではなく untrusted data
   として扱う。
6. **reviewer の同一性**: 起動 API / invocation metadata が model id **`claude-opus-5`** と完全一致することを
   Hermes が検証する。応答本文の self-report や schema の `model_expected` は補助情報であり証明に使わない。
   metadata が無い、または不一致なら理由を log して blocked とする。findings は Codex に返し、修正 /
   別 context での再レビューは最大 2 cycle とし、残存 finding または reviewer 障害で停止する。
7. **決定的検証**: レビュー成功後だけ Hermes supervisor が `accepted` → `done` を行い、
   `aro proposals check --repo . --strict` 後に commit する。commit 後の `aro guard --repo . --base origin/<default branch>`
   （warning も停止）と全 required quality gate を通す。strict check が実装により collateral stale となった
   proposal を検出した場合は全 id / finding を列挙して停止し、人間の再検証を待つ。Codex / Hermes は選定外
   proposal の `proposed_at_commit` その他の provenance を更新しない。Claude の判定で gate を代替しない。
8. **Draft PR**: 全検証と side-effect inventory の再確認後に限り、Hermes supervisor が専用 branch を
   push して Draft PR を作成できる。default branch への直接 push、通常 PR、auto-merge、本番 deploy は禁止し、
   merge は必ず人間が判断する。

stale、曖昧さ、予期しない diff、タイムアウト、tool / model 障害、レビュー・guard・gate 失敗は
fail-closed で blocked とし、続行や Draft PR 作成をしない。

### blocked、再試行、再起動

- blocked 時は proposal を `accepted` のまま保ち、proposal 本文・status・provenance を自動更新しない。
  supervisor-local の durable record に run / repo / proposal id、失敗段階・理由、attempt、再試行可能時刻、
  diff / test / model metadata の参照、cleanup 結果を残す。失敗した実装の Draft PR は作らない。
- 同じ proposal を次の tick で即時再選定しない。初回失敗後の自動 retry は proposal ごとに最大 2 回、
  人間が設定した backoff 経過後または人間の clearance 後だけ許可する。2 回でも解消しなければ人間へ
  escalate して自動選定から外し、明示的に unblock されるまで再開しない。
- unattended run は人間の応答を待たない。確認や追加権限が必要になった時点で blocked record を書き、
  実行を止めて cleanup へ進む。120 分の期限到達時も同じ扱いとし、子 process を止め、未回収 diff を
  保全して cleanup 結果を記録してから lease を解放し、一時 credential を失効させる。
- lease が stale でも、TTL 超過、旧 process / heartbeat の停止、durable record の状態を確認できた場合だけ
  recovery し、その判断を log に残す。端末再起動後は同じ idempotency key で記録を照合し、安全な checkpoint、
  最新 default branch、proposal の fresh 状態を再検証できる場合だけ resume する。不明なら blocked のまま
  cleanup または人間確認へ送り、新規 run として重複実行しない。

### 段階導入・停止・後始末

- repo ごとに **read-only dry-run**（候補と選定理由の観察）→ **local changes**（push なし）→
  **Draft PR** の順で人間が昇格する。段階は allowlist に明示して変更を監査可能にし、暗黙に昇格しない。
  `dry-run` は選定結果を log した時点で終了し、worktree 作成以降の write stage へ進まない。
- 停止時は scheduler を無効化して queue の新規取得を止め、実行中 task の終了・取消を記録する。
  続けて repo の allowlist 登録を外し、ローカル / GitHub 資格情報を失効させる。
- task log に run id、repo、proposal id、候補・選定理由、tool / model、commit / Draft PR、gate 結果、
  stale / no-op / blocked 理由、cleanup 結果を残す。worktree は未回収差分を保全または不要と確認してから
  task id / path / 所有権を検証して安全に片付け、判定不能なら削除せず人間へ escalate する。
  成功、no-op、blocked、timeout、`dry-run`、`local changes` の全終了経路で terminal state と cleanup 結果を先に
  durable record へ書き、所有権を検証してから lock を解放する。所有権が不明なら解放せず停止する。

## 安全性の設計

- **鍵を増やさない**: ループ全体を通して、対象 repo や CI に新しい secrets・API キー・
  従量課金の credential は追加されない。scheduled local は管理端末上で対象 repo に限定し、
  task 終了時に失効できる資格情報だけを使う。
- **書き込み権限は既定で増えない**: 書き込みは開発者自身の権限による PR のみ。例外は
  [cloud 実装トラック](#cloud-実装トラック)を採用した repo で、cloud Agent の GitHub App に
  write 権限を渡す（代償と監視点は同節に明記）。scheduled local は repo 限定 credential で
  Draft PR までを行うが、allowlist と段階導入で明示した repo 以外に使わない。
- **guard の二段構え**: ローカル（自己検証。手戻りを早く検出）と CI（強制。自己申告に依存しない）。
  検証ルールは merge-base 側から読まれるため、PR 内で設定を緩めても迂回できない。
- **人間が決定境界を持つ**: 対話型ローカルと cloud 実装 track は常に人間がタスクを起動する。
  scheduled local の無人起動は repo 単位の明示 opt-in 時だけ許容する。いずれも proposal の採否と
  merge は人間が判断し、auto-merge と本番 deploy は許可しない。

## Proposal Loop との関係

この文書のループは「改善を 1 件**実施する**」ためのもの。改善候補の**提案**と人間による
**採否の記録**は [`proposal-loop.md`](./proposal-loop.md) が担い、そこで `accepted` になった提案が
このループの既定の入力になる（improve.md 手順 1）。実装が完了した提案は同じ PR で `done` に
閉じる。scheduled local では Codex implementer は status に触れず、独立レビュー成功後に Hermes supervisor が閉じる。
提案の採否の変更は guard が `proposal_decision`（severity: fail）として required check を
落とし、人間の確認と明示的な override を要求する（機械は編集者そのものを判別できないため、
これは強制ではなく可視化である。[`proposal-loop.md`](./proposal-loop.md) の「限界」参照）。

## Repo Knowledge Loop との関係

この文書の `improve.md` ループは、source codeや設定の改善を1件実施するためのもの。repo固有の索引・
要約だけを更新する場合は、別の `.ai/managed/prompts/knowledge-refresh.md` を使う。

```txt
.ai/managed/prompts/knowledge-refresh.md を読み、Repo Knowledge を1単位だけ更新して
```

knowledge更新は `.ai/local/knowledge/**` だけを編集し、`aro knowledge check --strict` で根拠と鮮度を
検証する。source codeを変更する改善と同じPRへ混ぜず、source変更を先にcommitした後、そのHEADを根拠に
小さなknowledge更新を作る。形式・導入手順・安全境界は
[`repo-knowledge-loop.md`](./repo-knowledge-loop.md) を参照。

## トラブルシューティング

| 症状 | 対処 |
|---|---|
| ローカルの `aro guard` が exit 1 | 違反一覧を確認。改善対象を `allowed_paths` 内に収め直すか、その改善を破棄する |
| ローカルは通ったが CI の guard が fail | base branch が進んで merge-base が変わった可能性。branch を rebase して再実行 |
| `aro guard` が exit 3（`PROJECT_CONFIG_NOT_FOUND`） | base に `.ai/project.yaml` が無い（導入 PR 直後等）。導入 PR の merge 後から guard 対象になる |
| quality gates のコマンドが空で検証にならない | `.ai/project.yaml` の `commands.*` を repo に合わせて設定する（`aro doctor` が WARN で検出する） |

## dogfooding で記録すること（Stage 2-3）

- improve.md の指示の精度（意図しない改善・スコープ超過が起きないか）
- guard の誤検知 / 見逃し（`allowed_paths` の glob が実運用に合っているか）
- 1 周にかかる手間（自己検証の待ち時間、PR 規約の運用しやすさ）
- 気づきは [計画 03](./plans/03-guard-and-improve-loop.md) Stage 2-3 の判断材料として記録する

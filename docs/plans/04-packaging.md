# 計画 04: パッケージング — repo 外から `aro` を実行可能にする

優先度: 中 / 前提: 計画 01 / 規模: 小〜中 / 期限の目安: 計画 05（fleet）着手前まで

## できるようになること

| | Before（現状） | After（完了後） |
|---|---|---|
| 実行場所 | 中央 repo 内での `pnpm aro ...` のみが正式サポート。root を `pnpm pack` しても `commander` が解決できず起動しない（README 記載の既知の制約） | **中央 repo をクローンした任意のマシンで `aro` コマンドがグローバルに使える**。`pnpm pack` した tarball からのインストールでも起動する |
| 配布の検証 | パッケージング動作は手動確認のみ（実質未検証） | **CI が pack → install → 実行の smoke test を毎 PR で回す**ため、配布経路の退行が検出される |
| fleet / rollout への道 | 複数 repo を対象にした実行の足場がない | どこからでも `aro` を呼べるため、計画 05 の registry ループが素直に書ける |

## 現状とギャップ

- `bin` はルート package（`private: true` の workspace ルート）にあり、`bin/aro` は
  `../packages/aro-cli/dist/cli.js` を相対参照する。`commander` 等の依存は `@ai-repo-ops/aro-cli` 側に
  あるため、ルート単体を pack すると依存が同梱されず起動しない。
- README には対応方針が既に明記されている: 「`bin` を `@ai-repo-ops/aro-cli` 側へ寄せる、
  もしくはルートへ依存を持たせる」。本計画は前者を採る。
- もう 1 つの論点は **distribution content の所在**。`--source` 省略時、CLI は実行モジュール位置から
  `distribution/` を持つ source root を上方探索する。CLI package を単体配布すると
  `distribution/` が手元に無く、この探索が成立しない。

## スコープ

- `bin` の `@ai-repo-ops/aro-cli` への移設
- 配布チャネルの決定と、その形態での動作保証（CI smoke test）
- source 解決方針の明文化

## 非スコープ

- npm public registry への publish（配布チャネル判断で選ばれた場合のみ実施）
- distribution content の remote 取得（`--to` での tag 指定取得。実装計画書 v3 で将来対応と明記済み）

## 実装タスク

1. **配布形態を決定する**。推奨: **「中央 repo クローン + `pnpm link --global`」を第一級サポート**とし、
   npm publish は保留。理由:
   - source（`distribution/`）が常に手元にあり、上方探索がそのまま機能する
   - 利用者は当面自分だけであり、registry 運用のコストに見合わない
   - fleet / rollout（計画 05）も「中央 repo のクローンから実行する」モデルと整合する
2. **`bin` を `@ai-repo-ops/aro-cli` へ移す**:
   - `packages/aro-cli/bin/aro`（`./dist/cli.js` を import する thin wrapper、ビルド未実施時の
     案内メッセージは現 `bin/aro` から踏襲）を新設し、`package.json` に `"bin": {"aro": "bin/aro"}`
   - ルートの `bin` フィールドは削除。`pnpm aro` script は維持（`pnpm --filter @ai-repo-ops/aro-cli exec aro`
     相当か、現行の node 直呼びのままでも可）
   - `files` に `bin` を追加
3. **source 解決の仕様を明確化する**:
   - `pnpm link --global` 経由（= 実体は workspace 内）では現行の上方探索がそのまま機能することをテストで固定
   - workspace 外に置かれた場合（pack した tarball からの install）は、明確なエラーメッセージで
     `--source <path-to-ai-repo-ops>` の指定を要求する（黙って壊れないことが要件）
4. **CI に pack smoke test を追加する**:
   - `pnpm --filter @ai-repo-ops/aro-cli pack` → 一時ディレクトリで `npm install <tarball>`
   - `aro --help` が exit 0
   - fixture の git repo に対し `aro init --repo <fixture> --source <checkout の source root>` →
     `aro doctor` が exit 0
5. **README の Distribution boundary 節を更新する**（既知の制約の記述を、解消済みの新しい配布手順に差し替え）

## 受け入れ条件（DoD）

- [ ] クローンした中央 repo で `pnpm build && pnpm link --global` 後、**別ディレクトリの repo に対して**
      `aro init / diff / sync / doctor` が動く
- [ ] pack した tarball からインストールした `aro` が `--help` を表示し、`--source` 指定で init まで通る
- [ ] source が見つからない場合に、上方探索の失敗として分かりやすいエラー（`--source` の案内つき）が出る
- [ ] CI の pack smoke test が緑で、以後の PR で常時実行される

## リスク / 未決事項

- `@ai-repo-ops/aro-cli` の `private: true` を外すかどうか。pack は private でも可能
  （publish のみ拒否される）ため、npm publish を保留する間は `private: true` のままでよい。
- 将来 npm publish に進む場合、distribution content を package に同梱するか remote 取得
  （`--to` 実装）に進むかの分岐が生じる。本計画では決めない（fleet の運用実績を見て判断）。

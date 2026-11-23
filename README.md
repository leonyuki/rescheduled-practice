# 練習出欠調整サイト

練習ごとに「参加 / 未定 / 不参加」を回答して出欠を調整できるウェブサイトです。
**終了日時を過ぎた練習は自動でアーカイブ**に移動し、過去の練習として参照できます。

依存パッケージは不要です（Node.js 18 以上のみ）。

## 起動

```bash
npm start
# → http://localhost:3000
```

## Vercel で公開する

1. [vercel.com](https://vercel.com) に GitHub アカウントでログイン
2. **Add New… → Project** で このリポジトリを **Import**
   - Framework Preset は **Other** のまま、ビルド設定は変更不要（`vercel.json` で設定済み）
   - 公開したいブランチを本番にする場合は、先に `main` にマージしておく
3. **Deploy** を押す（この時点ではまだ DB が無いので API はエラーになります）
4. プロジェクトの **Storage** タブ → **Create Database** → **Upstash for Redis**（Marketplace）を選び、無料プランで作成してこのプロジェクトに **Connect**
   - 環境変数 `KV_REST_API_URL` / `KV_REST_API_TOKEN`（または `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`）が自動で追加されます
5. （任意）**Settings → Environment Variables** に `ADMIN_PASSWORD` を追加
6. **Deployments** タブで最新のデプロイの **⋯ → Redeploy**（環境変数を反映させるため）
7. 表示された `https://<プロジェクト名>.vercel.app` を開く

以後は GitHub に push するたびに自動でデプロイされます。
Vercel では常駐タイマーが使えないため、自動アーカイブは「ページを開いたとき（API アクセス時）」に判定されます。
誰かが開いた時点で過去の練習は必ずアーカイブ済みになるので、表示上の違いはありません。

## 主な機能

- **練習の登録・編集・削除**: タイトル、日付、開始/終了時刻、場所、メモ
- **出欠回答**: 名前と「参加 / 未定 / 不参加」、コメントを回答
  - 同じ名前で回答すると上書き（名前はブラウザに記憶されます）
  - 参加・未定・不参加の人数を一覧と詳細で表示
- **自動アーカイブ**
  - 練習の終了時刻（未入力なら開始時刻、どちらも無ければその日の 23:59）を過ぎると自動でアーカイブ
  - 各APIアクセス時にチェック（ローカル実行時は起動時と1分ごとのタイマーでも）
  - 過去の日付で登録した練習は即アーカイブとして保存（過去の記録の登録にも使えます）
  - アーカイブ済みの練習は回答の受付を締め切り、出欠結果を記録として保持
  - 手動で「アーカイブ」「予定に戻す」も可能（手動で戻した練習は日時を編集するまで再アーカイブされません）

## 設定（環境変数）

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `3000` | 待ち受けポート |
| `DATA_FILE` | `data/practices.json` | データの保存先（JSON、ローカル実行時） |
| `KV_REST_API_URL` / `KV_REST_API_TOKEN` | なし | 設定すると Upstash Redis に保存（Vercel では必須） |
| `ADMIN_PASSWORD` | なし | 設定すると練習の追加・編集・削除・アーカイブ操作にパスワードが必要 |
| `APP_TIME_ZONE` | `Asia/Tokyo` | 「過去」を判定するタイムゾーン |
| `ARCHIVE_INTERVAL_MS` | `60000` | 自動アーカイブのチェック間隔（ミリ秒） |

## テスト

```bash
npm test
```

## 構成

- `server.js` — HTTP サーバー / REST API / 自動アーカイブのタイマー
- `api/index.js` — Vercel 用の API エントリーポイント（`vercel.json` で `/api/*` をここへ）
- `lib/store.js` — 練習・回答の操作と自動アーカイブの判定
- `lib/backends.js` — 保存先（ローカル: JSON ファイル / Vercel: Upstash Redis）
- `public/` — 画面（HTML / CSS / JavaScript）

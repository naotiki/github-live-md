# GitHub Live MD

GitHub上のMarkdown 1ファイルを、複数人でリアルタイム共同編集するためのMVPです。本文とアップロード画像をコミットへまとめ、参加者を `Co-authored-by` に入れたDraft Pull Requestを作成します。PR作成後も同じセッションから追加コミットできます。

## 実装済み

- GitHub AppのWeb application flowによるログイン
- GitHubの検証済みメールを自動取得し、初回ログイン時にコミット用メールを選択
- GitHubファイルURLのドメイン置換によるMarkdownの直接オープン
- Appをインストール済みで、自分にwrite権限があるリポジトリ、ブランチ、既存 `.md` の選択
- 任意パスへの新規 `.md` 作成
- 自分が作成したセッションの一覧と再開
- 同じユーザー・リポジトリ・ブランチ・ファイルの重複セッション防止
- Yjs + CodeMirror 6による同時編集、共有カーソル、再接続
- 1セッション = 1 SQLite-backed Durable Object
- Hibernation WebSocket API
- GFM、YAML Frontmatter、相対画像のプレビュー
- PNG / JPEG / WebP / GIF（最大10 MB）のR2仮置き
- クリップボードからの画像貼り付け
- ヘッダーからのアップロード予定画像の確認・削除
- Assets画面からMarkdown基準で画像の追加先を変更（`./` にも対応、既定は `./images/`）
- アップロード予定画像のファイル名変更とMarkdown参照の自動更新
- 共有URL参加またはリポジトリwrite権限限定を選べる共有設定
- 7 / 14 / 21 / 28日のセッション保存期間（デフォルト14日）
- 期限切れ時の専用ブランチへの自動保存とセッション・仮画像削除
- Markdownと画像をGit Database APIで1コミット化
- 編集参加者の `Co-authored-by`
- Draft Pull Request作成
- Draft PR作成後も共同編集を続け、同じPRへ追加コミット
- 作成者による手動セッション削除
- Pull Requestのmerge webhookによるセッション自動削除
- セッション開始後に対象Markdownが更新された場合の競合検出
- 非公開リポジトリへの参加者ごとのGitHubアクセス確認
- 全セッションでGitHubログインとリポジトリアクセスを必須化
- Markdown本文2 MB、Yjs/WebSocket 8 MiB、HTTP本文種別ごとのサイズ制限

## 構成

```text
React + Vite
├── CodeMirror 6 + Yjs
├── Markdown preview
└── GitHub / session UI
        │ HTTP + WebSocket
        ▼
Cloudflare Worker
├── GitHub OAuth / REST API
├── repository access check
├── image API
└── publish orchestration
        │
        ├── Durable Object (1 editing session)
        │   ├── Hibernation WebSocket
        │   └── SQLite: Yjs snapshot, metadata, participants, assets
        │
        ├── Durable Object (global session registry)
        │   └── SQLite: owner session list and active-target reservation
        │
        └── R2: pending images
```

## ローカル起動

Node.js 22以上とpnpmを使用します。

```bash
pnpm install
pnpm dev
```

`http://localhost:5173` を開きます。ローカルのR2とDurable ObjectはWranglerが
エミュレートします。セッションを作成・参加するには、ローカル環境でもGitHub Appの
設定とGitHubログインが必要です。

## 入力サイズ制限

Workerのメモリ使用量と共同編集セッションの肥大化を抑えるため、次の上限を設けています。

| 入力 | 上限 |
|---|---:|
| Markdown本文（UTF-8） | 2,000,000 bytes |
| Yjsスナップショット / WebSocketメッセージ | 8 MiB |
| Awarenessメッセージ | 64 KiB |
| JSONリクエスト本文 | 32 KiB |
| 画像multipart本文 | 11 MiB（画像ファイル自体は10 MiB） |
| GitHub webhook本文 | 2 MiB |

Markdown上限を超えるエディタ操作はクライアントで止め、サーバー側でもYjs更新の適用後に
再検証します。制限超過時は直前の正常なスナップショットを維持し、画面へ理由を表示します。

### GitHub URLから直接開く

GitHub上のMarkdownファイルURLで、`github.com` の部分だけをこのアプリの
ドメインへ置き換えます。

```text
https://github.com/owner/repository/blob/main/docs/guide.md
↓
https://<LiveMDのドメイン>/owner/repository/blob/main/docs/guide.md
```

未ログイン時はGitHubログインへ進み、初回だけコミット用メールを選択します。
その後はURLからブランチとファイルを解決し、共同編集セッションを自動作成します。
`/` を含むブランチ名にも対応しています。

検証コマンド:

```bash
pnpm check
```

## GitHub App設定

GitHub Appを作成し、次を設定します。

| 項目 | 設定 |
|---|---|
| Homepage URL | `http://localhost:5173`（本番では本番URL） |
| Callback URL | `http://localhost:5173/api/auth/github/callback` |
| Webhook URL | `https://<本番ドメイン>/api/github/webhook` |
| Webhook secret | 十分に長いランダム値 |
| Webhook events | Pull requests |
| Repository permissions / Contents | Read and write |
| Repository permissions / Pull requests | Read and write |
| User permissions / Email addresses | Read |
| Install scope | 利用するアカウントとリポジトリ |

`Email addresses: Read` は、ユーザーアクセストークンで
`GET /user/emails` を呼び、GitHubで検証済みのメール候補を取得するために使います。
既存のGitHub Appへ後から権限を追加した場合は、いったんログアウトして再ログインし、
追加権限を承認してください。OAuth URLへ通常のOAuth App用 `scope=user:email` を
直接追加する構成ではありません。

初回ログイン後に、コミットのauthorと各参加者の `Co-authored-by` へ使うメールを
選択します。個人メールは公開リポジトリの履歴にも残るため、
画面ではGitHubの `@users.noreply.github.com` アドレスを推奨候補として先頭に表示します。
選択したメールはHttpOnly Cookieへ保存されますが、セッション参加時とPR作成時に
GitHub APIの候補一覧と再照合します。

ローカルでは [.dev.vars.example](./.dev.vars.example) を `.dev.vars` にコピーし、GitHub Appの値を入れます。

```dotenv
GITHUB_CLIENT_ID="..."
GITHUB_CLIENT_SECRET="..."
GITHUB_APP_SLUG="..."
GITHUB_APP_ID="..."
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET="..."
```

`GITHUB_APP_ID` はClient IDとは別にGitHub App設定画面へ表示される数値です。
`GITHUB_PRIVATE_KEY` は同じ画面の「Private keys」で生成したPEMを、改行を
`\n` に置き換えて設定します。OctokitがApp JWTと対象リポジトリ用の
installation access tokenを都度生成し、期限切れセッションの自動保存に使います。

`GITHUB_APP_SLUG` は現在ステータス表示用の任意項目です。秘密情報を含む `.dev.vars`
はコミットしないでください。App IDまたはprivate keyが未設定の場合、期限切れ時に
データを失わないよう削除せず、24時間後に自動保存を再試行します。

`GITHUB_WEBHOOK_SECRET` はGitHub App設定画面のWebhook secretと同じ値を設定します。
Workerは受信した生のpayloadと `X-Hub-Signature-256` をHMAC-SHA256で照合し、
正しい署名を持つmerge済みPull Requestイベントだけを処理します。ローカルの
`localhost` へGitHubから直接Webhookは送れないため、merge自動削除の実動確認には
本番URLまたはWebhook転送サービスが必要です。

## Cloudflareへデプロイ

### 1. 依存関係とCloudflare認証

Node.js 22以上とpnpmを用意し、依存関係をインストールしてCloudflareへログインします。

```bash
pnpm install
pnpm wrangler login
```

### 2. R2 bucketを作成

`wrangler.jsonc` の `ASSET_BUCKET` が参照する本番用bucketを、最初に1回だけ作成します。

```bash
pnpm wrangler r2 bucket create github-live-md-assets
```

すでに同名bucketがある場合は作り直さず、そのまま使います。R2 bucket自体を公開する
必要はありません。画像はWorkerの認可済みAPIを経由して配信されます。

### 3. 初回デプロイ

Worker、Static Assets、SQLite-backed Durable Objectsとmigrationをデプロイします。

```bash
pnpm deploy
```

完了時に表示される `https://github-live-md.<subdomain>.workers.dev` が本番URLです。
独自ドメインを使う場合は、Cloudflare Dashboardの
`Workers & Pages > github-live-md > Settings > Domains & Routes` から
Custom Domainを追加し、以後はそのURLを本番URLとして使います。

### 4. GitHub Appの本番URLを設定

GitHub App設定画面を開き、次の3項目を本番URLへ変更または追加します。

```text
Homepage URL: https://<本番ドメイン>
Callback URL: https://<本番ドメイン>/api/auth/github/callback
Webhook URL:  https://<本番ドメイン>/api/github/webhook
```

Webhook eventsで `Pull requests` を選び、Webhook secretには
十分に長いランダム値を設定します。

### 5. Worker secretsを登録

次のコマンドを1つずつ実行し、プロンプトへGitHub Appの値を入力します。

```bash
pnpm wrangler secret put GITHUB_CLIENT_ID
pnpm wrangler secret put GITHUB_CLIENT_SECRET
pnpm wrangler secret put GITHUB_APP_SLUG
pnpm wrangler secret put GITHUB_APP_ID
pnpm wrangler secret put GITHUB_PRIVATE_KEY
pnpm wrangler secret put GITHUB_WEBHOOK_SECRET
```

`GITHUB_PRIVATE_KEY` にはGitHub AppからダウンロードしたPEMの内容を入力します。
`.dev.vars` はローカル開発専用であり、Cloudflare本番環境へ自動転送されません。
`wrangler secret put` は暗号化されたWorker secretとして保存します。

### 6. 動作確認

```bash
curl https://<本番ドメイン>/api/health
```

すべて設定できていれば、次の3項目が `true` になります。

```json
{
  "githubConfigured": true,
  "automaticArchiveConfigured": true,
  "webhookConfigured": true
}
```

最後にGitHub Appを対象リポジトリへインストールし、本番URLからログイン、
セッション作成、画像アップロード、Draft PR作成まで確認します。コード更新時は
`pnpm deploy` を再実行します。Durable Objectの保存データとR2 bucket内の画像は、
通常のコード再デプロイでは削除されません。

## PR作成時の処理

1. ベースブランチ先端と対象Markdownのblob SHAを再取得
2. セッション開始時から対象ファイルが変わっていないことを確認
3. Markdownと各画像のblobを作成
4. 最新ベースtreeに全ファイルを追加したtreeを作成
5. 各参加者が選択したメールの `Co-authored-by` を含むcommitを作成
6. `collab/*` ブランチを新規作成
7. Draft Pull Requestを作成

ベースブランチ自体が進んでいても、対象Markdownが変わっていなければ最新のtreeを親にします。対象Markdownが変わっていた場合は `409 Conflict` で停止し、上書きやforce pushはしません。

Draft PR作成後もセッションは編集可能です。「Add commit」から同じPRブランチの
最新treeを親に新しいコミットを作り、refをfast-forward更新します。Markdown、
新しい画像、セッションから削除した既存画像をまとめて反映し、変更がない場合は
空コミットを作りません。任意の既存PRではなく、このセッションが作成したPRだけが
追記対象です。

## セッションの重複防止と期限

GitHubセッション作成時に、グローバルなSQLite-backed Durable Objectへ
次の組み合わせを原子的に予約します。

```text
GitHub user ID + repository + base branch + Markdown path
```

同じ組み合わせのセッションがある場合、新しいセッションを作らず既存IDを返します。
Draft PR作成後も追記編集を続けられるため、予約はセッション削除またはmergeまで
保持します。

各編集セッションにはDurable Object Alarmを設定します。7 / 14 / 21 / 28日から選択でき、
デフォルトは14日です。期限時にまだPRを作成していなければ、GitHub App installation
tokenで最新のベースブランチから次のような専用ブランチを作り、Markdownと画像を
保存します。

```text
collab/archive-<document>-<session-id>
```

保存に成功した後だけR2の仮画像、セッション台帳、Durable ObjectのSQLiteとAlarmを
削除します。GitHub API障害やApp認証未設定時は削除せず、24時間後に再試行します。
すでにDraft PRを作成済みで未反映の変更がある場合は、そのPRブランチへ最後の
コミットを追加してから削除します。

作成者はShareダイアログから任意の時点でセッションを手動削除できます。これは
Durable Object、台帳、R2仮画像だけを削除し、GitHub上のブランチやPull Requestは
残します。PRがmergeされた場合は、署名検証済みWebhookを受けて同じクリーンアップを
自動実行します。

## 現在のMVP境界

- `.md` のみ。MDXは未対応
- 1セッションにつき共同編集対象は1ファイル
- プレビューは汎用GFM。リポジトリ固有のAstro/Hugo/Jekyllビルドは実行しない
- フォーク経由PR、任意の既存PRへの参加、競合解消UIは未対応
- GitHub user access tokenのrefresh tokenは未実装。期限切れ時は再ログイン
- アップロード予定画像を削除しても、Markdown本文へ挿入済みの画像記法は自動削除しない
- セッション一覧は作成者本人のセッションのみ。参加しただけのセッション履歴は未対応

## 主要ファイル

- `worker/session.ts`: Durable Object、Yjs同期、SQLite永続化
- `worker/registry.ts`: セッション一覧、重複予約、PRとセッションの対応
- `worker/archive.ts`: 期限切れ時のGitHub自動保存
- `worker/index.ts`: API routing、R2、GitHub commit / PR
- `worker/github.ts`: OAuth、cookie、GitHub API client
- `src/lib/CollaborationProvider.ts`: ブラウザ側WebSocket provider
- `src/pages/SessionPage.tsx`: 共同編集UI
- `wrangler.jsonc`: Durable Object / R2 bindings

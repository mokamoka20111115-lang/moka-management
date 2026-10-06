# MOKAとChatGPTの読み取り連携（公開前の準備）

このPRはコード・テスト・設定手順のみです。追加データベース、Blaze変更、API有効化、IAM変更、デプロイを自動実行しません。GitHub PagesへMCPを公開するワークフローも追加していません。マージだけではChatGPTには接続できません。

今回の機能は `connection_check`（接続確認）と `read_business_day`（営業日を指定した読み取り）の2つです。営業データの追加・更新・削除・移行はできません。現在のWebアプリのGoogleログイン、計算、入力、バックアップ、月移動、Firestore Rulesは変更しません。

## 1. 費用を理解する（まだ設定しない）

- Cloud Functionsの公開にはFirebaseのBlazeプランとGoogle Cloud請求先が必要です。無料枠はありますが、ビルド・Artifact Registry保管・通信等は課金される場合があります。
- 既存の営業データは既存の `(default)` データベースを使い続けます。
- OAuthの接続情報は新しい `mcp-auth` データベース（Firestore Native、Tokyo / asia-northeast1）へ分離します。追加データベースには無料枠がなく、認証情報の読み書き・保管も従量課金です。
- アクセストークンは1時間、連携の有効期間は最長30日です。期限切れは保存情報を削除しなくても拒否します。期限切れ情報の削除は別途必要です。Firestore TTLを使う場合、削除にも課金されます。
- 待機インスタンス0、最大1インスタンス、認証処理60回/分/インスタンス、認証済みリクエスト120回/分/UIDを設定しています。再起動や無効なリクエストの到達等でも費用は発生し得ます。これらは支出の上限保証ではありません。請求通知も自動停止の上限ではありません。
- この方式はOpenAI APIを呼ばないため、別途OpenAI APIキーは不要です。ChatGPT側のプラン料金は別です。

公式資料：[Firebase料金](https://firebase.google.com/pricing)、[Firestore無料枠と追加DB](https://firebase.google.com/docs/firestore/pricing)、[Functionsの運用](https://firebase.google.com/docs/functions/manage-functions)。

## 2. 現時点で用意するもの

許可するFirebase UIDは `JR8vRpF9uyaOnNONszt4vYcYBWd2` です。このリリースではコードと設定の両方でこのUIDに限定し、未設定・別UIDは拒否します。UIDは秘密鍵ではありません。

ChatGPTのMCP作成画面のOAuth詳細設定で、既定のクライアントIDを指定できるか、クライアントシークレットなしのPKCE方式を選択できるか確認してください。認証方式はOAuth、トークンエンドポイントのクライアント認証方式は `none` です。これは**本人認証なし**という意味ではなく、Google本人確認とPKCEを使う公開クライアント方式です。

ChatGPTに表示される正確な「リダイレクトURL／コールバックURL」を確認します。URLは推測せず、ワイルドカードも使いません。この実装は以下の形式のうち、設定で指定した完全一致URLだけを許可します。

- `https://chatgpt.com/connector/oauth/接続固有のID`
- `https://chatgpt.com/connector_platform_oauth_redirect`

個人用MCPの画面でクライアント設定やコールバックが分からない場合は、その項目名・表示値を確認してから公開設定を進めます。シークレットが必須の画面に仮の秘密値を入れて進めないでください。この実装は `client_secret_post` / `client_secret_basic` / 自動クライアント登録には対応しません。

公式資料：[ChatGPTのMCP接続](https://developers.openai.com/plugins/quickstart)、[OAuth・PKCE仕様](https://developers.openai.com/plugins/build/auth)。

## 3. 後日、公開することを決めた場合のGoogle Cloud設定

**ここからは課金・クラウド変更を伴います。現在は実行しません。** iPhoneだけでコマンドを入力する必要はありません。Cloud Shell等の作業環境を用意し、担当者が手順を確認して実行します。公開前に現在のMOKAでJSONバックアップを「ファイル」に保存してください。

1. 対象プロジェクトが `moka-management` であることを確認し、Blazeと請求通知を設定します。
2. Cloud Functions、Cloud Run、Cloud Build、Artifact Registry、Firestore、Identity Toolkitの必要なAPIを有効化します。既存APIを無効化しないでください。
3. Firestore Nativeの追加DB `mcp-auth` をTokyoに作成します。営業データの `(default)` は変更・移動しません。
4. **`mcp-auth` を選択してから** `functions/auth.firestore.rules` を公開します。これは全件拒否のルールです。営業データDBに貼り付けないでください。
5. 専用サービスアカウント `moka-mcp-reader@moka-management.iam.gserviceaccount.com` を作成します。鍵JSONを生成しません。
6. 実行アカウントには次の権限だけを付与します。Owner / Editor / Firebase Adminや無条件のDatastore Userは付与しません。組織・フォルダ・プロジェクトから余分な権限が継承されていないかも確認します。

| 役割 | 条件・対象 |
| --- | --- |
| `roles/datastore.viewer` | `resource.name == "projects/moka-management/databases/(default)"` |
| `roles/datastore.user` | `resource.name == "projects/moka-management/databases/mcp-auth"` |
| `roles/firebaseauth.viewer` | 本人の無効化・セッション失効を確認するための読み取り権限 |

FirestoreのIAM条件はDB単位です。UID単位の制限はサーバーが行います。Admin SDKはFirestore Security Rulesを迂回するため、上記IAM条件が必須です。公開後に実際の実行アカウントで営業データDBへの書き込み権限がないことを確認します。実データへ書き込みを試すテストはしません。Google CloudのPolicy Troubleshooter等で権限を確認します。

公式資料：[DB単位のIAM条件](https://firebase.google.com/docs/firestore/manage-databases)、[Admin SDKとGoogle実行環境の認証](https://firebase.google.com/docs/admin/setup)。

## 4. 後日の初回公開とURLの取得

公開にはNode.js 22とFirebase CLIが必要です。Firebase CLIへのログインはGoogleの画面で行い、パスワードやサービスアカウントJSONを会話・GitHubに貼り付けません。公開担当者には必要なデプロイ権限と、専用実行アカウントのService Account User権限が必要です。実行アカウントへデプロイ管理者権限を付けないでください。

1. `functions/.env.example` をローカルの `functions/.env.moka-management` にコピーします。この実ファイルはGitHubにコミットしません。
2. UIDと専用サービスアカウントを設定します。最初はBASE_URLを空、REDIRECT_URISを `[]` にします。サーバーは接続を拒否する状態で公開します。
3. 承認された後に、以下をリポジトリのルートで実行します（今は実行しない）。既存Pages、既存Rules、他のFunctionsをまとめて公開するコマンドは使いません。

```sh
npm ci --prefix functions --ignore-scripts
npm test
npm run test:mcp
firebase deploy --project moka-management --config firebase.mcp.json --only functions:moka-mcp-readonly
```

4. 公開後、Google CloudのFunctions `mokaMcp` に対応するCloud Runサービスの実際のURLを取得します。必要なら次の読み取りコマンドで確認します。

```sh
gcloud functions describe mokaMcp --gen2 --region asia-northeast1 --project moka-management --format='value(serviceConfig.uri)'
```

5. `https://実際のサービス名…run.app` の**ルートURL**（末尾スラッシュなし）を `MOKA_MCP_BASE_URL` に設定します。`cloudfunctions.net/mokaMcp` のようなパス付きURLは、この実装のOAuth discoveryには使いません。
6. Firebase Authentication → 設定 → 承認済みドメインに、そのCloud Run URLのホスト名だけを追加します。既存ドメインは削除しません。Googleプロバイダの設定も維持します。
7. コールバックURLが作成後に表示される画面の場合、BASE_URLだけ設定して限定デプロイし、REDIRECT_URISは `[]` のままにします。この段階は公開メタデータの取得だけが可能で、OAuth認証・データ読み取りは拒否されます。ChatGPTにサーバー情報を入力してコールバック表示まで進みます。次にChatGPTに表示された正確なコールバックURLを `MOKA_OAUTH_REDIRECT_URIS` にJSON配列で設定します。この配列は例のURLをコピーして決めず、画面の実値から作ります。
8. 同じ限定デプロイコマンドで更新します。Artifact Registryの古い配布ファイル削除方針も設定します。

URLは未公開のため現時点では存在しません。このPRに推測した公開URLは含めていません。権限・Googleドメイン・コールバックが未設定の場合は、接続成功とは扱いません。

## 5. ChatGPT画面へ入力する値

以下の `BASE` は上記で取得した実際のCloud RunルートURLです。文字列 `BASE` のまま入力しないでください。

| ChatGPTの項目 | 入力値 |
| --- | --- |
| 名前 | `MOKA Management（読み取り専用）` |
| 説明 | `本人の営業データの接続確認・営業日ごとの読み取り。追加・更新・削除はできません。` |
| 接続タイプ | サーバーURL |
| サーバーURL | `BASE/mcp` |
| 認証 | OAuth |
| クライアントID | `moka-chatgpt-readonly` |
| クライアントシークレット | 空欄（公開クライアント／PKCE） |
| クライアント認証方式 | `none` |
| 認可URL | `BASE/oauth/authorize` |
| トークンURL | `BASE/oauth/token` |
| スコープ | `entries:read offline_access` |
| PKCE | 有効・`S256` |
| Resource / Audience欄がある場合 | `BASE/mcp` |
| Discovery / Issuer欄がある場合 | `BASE`（メタデータは `BASE/.well-known/oauth-authorization-server`） |

各リクエストで同じresourceを使用することが必要です。UIの項目名が異なる場合は実画面に合わせて確認します。機能スキャン時にもOAuthを完了しないとMCPは401を返します。公開サーバーURLへ到達できても、未認証で営業データは読めません。

## 6. 公開後の接続確認（まだ未実施）

1. SafariのChatGPT Webからプラグインを接続します。Googleで本人確認し、アカウントと読み取り許可の内容を確認して承認します。
2. 「MOKAの接続を確認して」と依頼します。`connected: true`、`mode: read_only`、`writesEnabled: false` と更新番号が返ることを確認します。
3. 「2026-10-06の営業データを読み取って」のように日付を指定します。登録済みなら全項目と更新番号、未登録なら `exists: false` を返します。サンプルデータは生成しません。
4. MOKAアプリで同日を表示し、金額・更新番号に変化がないことを確認します。
5. 「売上を登録して」と依頼しても、この段階では保存できないことを確認します。

この会話で利用するには、完成したプラグインを同じChatGPTアカウントに接続し、この会話のツールとして有効にする必要があります。GitHub接続だけではFirestore連携は有効になりません。アカウント・画面により同じ会話へ追加できない場合は、プラグインを選択できるWork会話で確認します。iOSアプリ・iPhone実機・実際のChatGPT OAuth接続は、未公開なので未検証です。

## 7. 失敗・停止・保守

- 通信やFirestore取得に失敗した場合はエラーを返し、未登録や0円に置き換えません。
- トークン・認証コードはハッシュをキーに保存します。BearerトークンをGitHub、ログ、会話に貼り付けません。OAuthのstate、リダイレクトURL、PKCE、resourceも照合します。
- トークン更新はローテーションし、旧refresh tokenの再利用を検知するとその連携を失効させます。並列更新や応答喪失時に安全側で再接続が必要になる場合があります。
- OAuth revocation endpointは `BASE/oauth/revoke` です。ChatGPTの接続解除がこれを呼ぶかは公開後確認します。接続解除だけでサーバーの失効が保証されるとは扱いません。
- 即時停止は `MOKA_ALLOWED_UID` を空にして再公開するか、MCP用Cloud Runサービスの公開呼び出しを停止します。現在のWebアプリには影響しません。特定の連携を失効させる場合は `mcp-auth` の該当grantsの `revoked` をtrueにします。
- Firebaseでユーザーを無効化した場合やFirebaseセッションを失効した場合も読み取りを拒否します。単なるWebアプリのログアウトでは、この別連携は失効しません。
- TTLを使う場合、`mcp-auth` のrequests/codes/access/refresh/grants/limitsの `expiresAt` が対象です。削除の遅延は認証の有効期限に影響しません。削除料金を確認してから有効化します。
- 売上・経費データは読み取り時にChatGPTへ送られます。ChatGPTのデータ設定も確認してください。プラグインは本人用で運用し、一般公開しません。

## 開発・テスト

```sh
npm ci --prefix functions --ignore-scripts
npm test
npm run test:mcp
npm --prefix functions run check
npm run build
```

`npm test` は既存47ケースと認証等の13ケース。`npm run test:mcp` はその13ケースに加えて、実際のSDKクライアント・HTTPサーバーでの4ケースを実行します（重複分を除く合計64ケース）。Firebaseはメモリ上のテスト用アダプターへ置き換えており、テストは本番クラウドへ接続・書き込みしません。IAM・実際のGoogle本人確認・ChatGPTのcallbackは公開後の別検証です。

Node.js 22が公開・CIの対象です。SDKとlockfileを固定し、gaxios配下のuuidは互換のある11.1.1へ固定して既知のバッファ境界問題を回避しています。依存更新時には監査と全テストを再実行します。

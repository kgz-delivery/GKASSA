# Optima payment automation

The existing QR upload, decoding, and sending path remains in use. When the device integration is configured, a payment order reserves an Optima amount with kopeks before that QR is sent. The requested whole-som amount is still sent to the bookmaker.

## Render configuration

The repository already has a Render Blueprint in `render.yaml`. It defines the `flash-gkassa-web` Node web service, `/health` check, `/var/data` persistent disk, and `DB_PATH=/var/data/gkassa.db`.

### Deploy or update the backend

1. Push this repository to the Git provider connected to Render. Keep `render.yaml` in the repository root.
2. For a new Render service, choose **New + → Blueprint**, connect the repository and deploy the Blueprint. For the current service, open its Blueprint and sync the changes, or set the same values in the service dashboard if it is not Blueprint-managed.
3. Confirm the service uses the repo root, `npm ci` as the build command, and `npm start` as the start command. The service reads Render's `PORT` and binds to `0.0.0.0`.
4. Attach a persistent disk mounted at `/var/data`; use `DB_PATH=/var/data/gkassa.db`. SQLite data outside the disk can disappear on a restart or deploy. Keep one service instance with this SQLite database.
5. In **Environment**, fill the secret values listed below. Keep `AUTO_CONFIRM_MAX_SOM` empty until you choose a safe limit. `MOBCASH_DRY_RUN` defaults to `1` in the Blueprint.
6. Deploy and wait for the deploy to finish. Check **Logs** for `[App] Database initialized` and `[Web] FreeSpin Mini App listening`. Set the service's health check path to `/health`.
7. Open `https://<your-service>.onrender.com/health`; the response should be `ok`. Render provides TLS for its `onrender.com` address and redirects public HTTP requests to HTTPS.

Render supports deploying from a Git provider or a Blueprint, and its dashboard has environment variables, persistent disk, and health check settings in the service configuration.[^render-service] A persistent disk preserves files under its mount path across restarts and deploys; Render requires a paid web service for a disk.[^render-disk] Render provisions TLS for `onrender.com` and redirects HTTP to HTTPS.[^render-tls]

The repository's service settings are:

- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/health`
- Keep one running instance while the database is SQLite.
- Payment API requests reject non-HTTPS traffic when `NODE_ENV=production`.

Set these environment variables in the Render service settings; do not commit device tokens or bookmaker credentials:

| Variable | Value |
| --- | --- |
| `PAYMENT_DEVICE_TOKEN` | A long random shared token used by the Android app and bot server. |
| `OPTIMA_PACKAGE_NAME` | `kz.optimabank.optima24` |
| `ORDER_TTL_MINUTES` | `10` |
| `ORDER_GRACE_MINUTES` | `30` |
| `AUTO_CONFIRM_MAX_SOM` | The maximum whole-som order amount eligible for automatic bookmaker credit. Leave empty to route all matched payments to manual review. |
| `OPERATOR_MANUAL_MAX_SOM` | Optional fallback per-operation limit for operators without an individual limit. |
| `OPERATOR_DAILY_LIMIT_SOM` | Optional fallback daily limit for operators without an individual limit. |

Generate a token locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, then enter the same value in Render and the Android app's secure settings.

For each bookmaker that should receive automatic or manual credits, configure its existing `MOBCASH_<BOOKMAKER>_CASHBOX_CODE`, `LOGIN`, `PASSWORD`, and `MOBCASH_BOOKMAKERS` values. Keep `MOBCASH_DRY_RUN=1` while checking configuration; set it to `0` only when live deposits are intended.

## Android endpoints

All endpoints require `X-Device-Id` and `X-Token`. For `/api/payments`, the JSON `device_id` must equal `X-Device-Id`.

- `GET /api/templates` returns active bank parsers. The Optima parser is seeded from the supplied notification examples and can be edited in the bot's **Optima: шаблон push** admin screen. The Android app should refresh this endpoint to pick up template changes without an APK update.
- `POST /api/payments` accepts the agreed contract. `amount` must be a decimal string, such as `100.37`; `hash` is unique. A repeated hash returns `{ "status": "duplicate" }` without another credit.
- `POST /api/heartbeat` accepts `device_id`, `battery`, and `app_version`. A device that previously checked in and then misses heartbeats for over three minutes triggers an admin alert.
- `POST /api/raw-logs` stores unparsed notification text for diagnosis.

The bot returns `matched` for a unique eligible order and `unmatched` when no safe automatic match exists. Those payments appear in **Проверка оплат** for review. Payments received after expiry remain associated with the expired-order note during the 30-minute grace period.

### Configure and install the Android reader

The Android reader source code and APK are not part of this repository; only the bot backend is here. The Optima package name `kz.optimabank.optima24` identifies the banking app that posts notifications, not the reader app.

In the Android reader project, configure:

1. Backend base URL: `https://<your-service>.onrender.com` (no trailing route suffix).
2. A stable `device_id`, and the same `PAYMENT_DEVICE_TOKEN` value as Render.
3. Notification package routing: Optima notifications use `bank_code=optima` and `package_name=kz.optimabank.optima24`.
4. Fetch `GET /api/templates` with `X-Device-Id` and `X-Token`; apply the returned regexes to the raw notification text. The amount and sender are capture group 1 in the seeded Optima regexes.
5. Send a payment's parsed amount as a string, for example `"100.37"`. Keep its `hash` stable across retries so the backend can deduplicate it. Send the same `device_id` in the body and header.
6. Send a heartbeat every minute or two. Send unparsed notification text to `/api/raw-logs` when the parser cannot recognize it.

Build and sign the reader APK from its Android project in Android Studio, install the release APK on the phone, then enable Android's **Notification access** for the reader. Also grant any Android notification permission the app requests and allow the reader to run in the background. The Render URL and token are app configuration; the APK itself does not run on Render.

Before sending real payments, verify `/health`, `GET /api/templates`, and `POST /api/heartbeat` over HTTPS. Confirm the bank notification reaches `/api/payments` once and that duplicate hashes are ignored. With `MOBCASH_DRY_RUN=1`, bookmaker credit is not sent; the order is routed to review. Only after you have verified the integration should you set `MOBCASH_DRY_RUN=0` and enter the chosen `AUTO_CONFIRM_MAX_SOM` limit.

## Admin operations

- **Проверка оплат** shows the raw notification, sender, amount, and candidate orders. An admin can assign it to a matching order or reject it. A rejection records the decision; any bank refund is handled outside the bot.
- **Optima: шаблон push** edits the package name and regexes immediately in SQLite.
- **Роли и лимиты** lets a superadmin switch an admin to operator and set per-operation and daily limits. Existing `admin` accounts retain superadmin access.
- **Ручное / массовое пополнение** accepts one or more CSV/text lines in the form `bookmaker, player_id, amount, reason`, previews them, and runs each line through the existing bookmaker API after one confirmation.

## Deposit retry safety

The current Mob-Cash JSON-RPC `deposit` request has no provider-side idempotency-key field. The bot stores a unique local key and prevents a second local request for the same order; an unknown network outcome goes to manual review instead of being retried automatically. Safe automatic retries after an ambiguous timeout require an idempotency feature from the bookmaker API or a provider-side status lookup before retrying.

[^render-service]: [Render Web Services documentation](https://render.com/docs/web-services)
[^render-disk]: [Render Persistent Disks documentation](https://render.com/docs/disks)
[^render-tls]: [Render TLS documentation](https://render.com/docs/tls)

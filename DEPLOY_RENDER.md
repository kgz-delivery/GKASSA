# Deploy the bot and FreeSpin Mini App on Render

The `render.yaml` Blueprint creates a **web service** named `flash-gkassa-web`. It serves the FreeSpin Mini App at the service's public HTTPS URL and runs the Telegram bot in the same process when `BOT_ENABLED=1`. SQLite is stored on the attached persistent disk at `/var/data/gkassa.db`.

## First deployment

1. Commit and push the project to GitHub.
2. In Render choose **New → Blueprint**, connect the repository, and apply `render.yaml`.
3. Set the prompted secrets/configuration: `BOT_TOKEN`, `CHANNEL_TOPUP_ID`, `CHANNEL_WITHDRAW_ID`, `ADMIN_TELEGRAM_IDS`, `REQUIRED_SUBSCRIPTION_CHANNEL_ID`, and `REQUIRED_SUBSCRIPTION_GROUP_ID`.
4. Add the bot as an administrator to **FLASH | ИНФО** and **FLASH | CHAT** so Telegram allows it to check each user's membership. Set the channel and group numeric chat IDs in the two `REQUIRED_SUBSCRIPTION_*_ID` variables; invite links alone cannot be used by Telegram's membership-check API.
5. Before the new service starts, stop any other running service polling with the same `BOT_TOKEN`.
6. The Blueprint starts both the Telegram bot and the FreeSpin web app (`BOT_ENABLED=1`). Check `/health`; `/` redirects to `/freespin/`.
7. Open the bot in Telegram. Users must join both chats and press **Проверить подписку** before the welcome menu appears. Tap **Free Spin⚡** under the welcome message to open the Mini App. The bot uses its Render URL for the Web App button automatically. Optionally set `FREESPIN_URL` to the exact public URL if you use a custom domain.

## If an existing Render worker already runs this bot

Render cannot convert an existing Background Worker into a Web Service. The Blueprint uses a new service and a new disk intentionally; do not try to change the old worker's type in place. The old and new services must not poll the same Telegram bot token at the same time.

For a fresh database, stop the old worker before the new web service starts. For keeping existing users, balances, transactions, and settings:

1. Before deploying, temporarily set `BOT_ENABLED=0` for the new web service while the old worker is still running.
2. Back up the old SQLite database from its persistent disk. Use Render Shell/SSH or Render's supported SCP connection for that service. Do not copy a live SQLite file while the old bot is writing to it.
3. Stop the old worker so it can no longer change the database.
4. Stop the new web service, replace `/var/data/gkassa.db` on its disk with the backup, then start the web service again. Render disks are exclusive to one service; the two services cannot mount the same disk.
5. Once the web service is healthy and using the migrated database, set `BOT_ENABLED=1`. Keep the old worker stopped to avoid Telegram polling conflicts.

If the current worker uses a different bot token, it can continue running independently. Keep a separate backup of the database before migration.

## Run locally

```sh
npm install
```

Create `.env` from `.env.example`, set `BOT_TOKEN` and the channel/admin values, then run:

```sh
npm run dev
```

The Mini App is served at `http://localhost:3000/freespin/`. Telegram Web Apps need a public HTTPS URL for real Telegram testing, so use the deployed Render URL for that.

Every code change must be committed and pushed to the GitHub branch connected to the Render service; Render then needs to finish a new deploy before the change appears in Telegram or the Mini App. The web service and persistent disk require a paid Render plan. See [Render service types](https://render.com/docs/service-types), [web services](https://render.com/docs/web-services), [Blueprint specification](https://render.com/docs/blueprint-spec), [persistent disks](https://render.com/docs/disks), and [SSH/SCP](https://render.com/docs/ssh).

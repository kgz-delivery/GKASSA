# GKASSA - Telegram Payment Bot

## Quick Start

1. Install dependencies:
 ```
 npm install
 ```

2. Create `.env` from `.env.example`:
 ```
 copy .env.example .env
 ```
 Edit `.env` and set your `BOT_TOKEN` (from @BotFather), channel IDs, and admin Telegram IDs.

3. Set admin Telegram user IDs:
 - Get your Telegram user ID from [@userinfobot](https://t.me/userinfobot)
 - In `.env` set `ADMIN_TELEGRAM_IDS`:
 ```
 ADMIN_TELEGRAM_IDS=123456789,987654321,111222333,444555666
 ```

4. Add the bot as admin to both channels (top-up and withdraw).

5. Run the bot:
 ```
 npm run dev
 ```
 Or for production:
 ```
 npm start
 ```

## Services

- **Telegram Bot** — long-polling. Admin panel is inside the bot (`/admin`).

## How it works

### Client flow
1. `/start` shows: QR banks (МБанк / ELQR / Bakai), crypto (TRC-20 / BEP-20 / TON), withdraw, balance, transactions.
2. **QR / crypto**: choose provider → enter payment ID → enter amount → see requisites (QR, crypto also shows wallet address) → send photo/PDF receipt → confirm → waiting.
3. Requests go to the top-up channel; withdrawals go to the withdraw channel.
4. After admin confirms, balance updates and the user is notified.

### Admin flow
- Command `/admin` or the admin button in the menu (only for IDs in `ADMIN_TELEGRAM_IDS`).
- Upload/replace QR photos (and crypto addresses), view stats, users, transactions.
- In channels: ✅/❌ on requests; top-up requires double-confirm.

## Project structure
```
index.js # Entry point
src/
 config.js
 database.js
 models.js
 providers.js
 bots.js
 bot/
  adminAuth.js
  handlers/
  keyboards/
  state.js
uploads/   # optional local files
data/
 gkassa.db
```

## Commands
- `npm run dev` — nodemon
- `npm start` — production

## Lint & typecheck
```
node -c index.js
```

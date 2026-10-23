const { initDatabase } = require('./src/database');
const config = require('./src/config');

function main() {
  initDatabase();
  console.log('[App] Database initialized');

  if (config.bot.enabled) {
    if (!config.bot.token) {
      console.error('[App] BOT_ENABLED is on, but BOT_TOKEN is not set.');
      process.exit(1);
    }
    const { setupBot } = require('./src/bots');
    setupBot();
  } else {
    console.log('[App] Telegram polling is disabled (BOT_ENABLED=0).');
  }

  const { startFreeSpinServer } = require('./src/freespinServer');
  startFreeSpinServer();
}

main();

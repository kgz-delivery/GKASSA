const { Admins } = require('../models');
const config = require('../config');

function isAdmin(userId) {
  if (!userId) return false;
  if (config.admin.telegramIds.includes(userId)) return true;
  const admin = Admins.getByUserId(userId);
  return Boolean(admin && admin.active === 1);
}

function getAdminRecord(userId) {
  return Admins.getByUserId(userId) || Admins.getByTelegramId(userId) || null;
}

module.exports = { isAdmin, getAdminRecord };

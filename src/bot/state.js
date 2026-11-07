const userStates = new Map();

function setUserState(userId, state) {
  let existing = userStates.get(userId) || {};
  userStates.set(userId, { ...existing, ...state });
}

function getUserState(userId) {
  return userStates.get(userId) || {};
}

function clearUserState(userId) {
  userStates.delete(userId);
}

function clearStateField(userId, field) {
  let existing = userStates.get(userId);
  if (existing && existing[field]) {
    delete existing[field];
    userStates.set(userId, existing);
  }
}

module.exports = { setUserState, getUserState, clearUserState, clearStateField };

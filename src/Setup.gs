/**
 * One-off utilities you run manually from the Apps Script editor during setup.
 * None of these are called by the bot at runtime.
 */

/** Switch the bot to long-polling: drop any webhook and reset the offset. */
function enablePolling() {
  unregisterWebhook();
  props_().deleteProperty('TG_OFFSET');
  console.log('Webhook removed. Now add a 1-minute time-driven trigger for ' +
              'pollUpdates (Apps Script editor → clock icon → Add Trigger).');
}

/** Revert to webhook mode (not recommended — see README on the 302 retry storm). */
function disablePolling() {
  registerWebhook();
  console.log('Webhook re-registered. Delete the pollUpdates trigger so updates ' +
              'are not double-processed.');
}

function registerWebhook() {
  var token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  var url = props_().getProperty('WEBHOOK_URL');
  if (!token) throw new Error('Set TELEGRAM_BOT_TOKEN in Script Properties');
  if (!url) throw new Error('Set WEBHOOK_URL in Script Properties (the /exec URL)');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/setWebhook', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ url: url, drop_pending_updates: true, allowed_updates: ['message'] }),
    muteHttpExceptions: true
  });
  console.log(res.getContentText());
}

function unregisterWebhook() {
  var token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/deleteWebhook', {
    method: 'post', muteHttpExceptions: true
  });
  console.log(res.getContentText());
}

function getWebhookInfo() {
  var token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  var res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/getWebhookInfo', {
    muteHttpExceptions: true
  });
  console.log(res.getContentText());
}

/**
 * Smoke-test Gemini + the profile math without touching Telegram.
 * Run this from the editor; check View → Logs.
 */
function testProfile() {
  var profile = callGeminiProfile_('male 30 175cm 72kg moderately active lose weight');
  console.log('Parsed profile: ' + JSON.stringify(profile));
  var targets = computeTargets_(profile);
  console.log('Targets: ' + JSON.stringify(targets));
}

/**
 * Smoke-test Gemini food parsing + the sheet. Appends a row for chat_id "TEST"
 * to the food log. Delete the row afterwards.
 */
function testParseFood() {
  var food = callGeminiFood_({ text: 'chicken rice bowl with a fried egg' });
  console.log('Parsed food: ' + JSON.stringify(food));
  appendFood_('TEST', food);
  console.log("Today's totals for TEST: " + JSON.stringify(computeTodayTotals_('TEST')));
}

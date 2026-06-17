/**
 * Long-polling entry point. Wired to a 1-minute time-driven trigger.
 *
 * Apps Script Web Apps return a 302 redirect for /exec URLs, which
 * Telegram's webhook system treats as a failed delivery. To avoid the
 * resulting retry storms we invert the flow: Apps Script calls
 * Telegram's getUpdates instead of receiving webhooks.
 *
 * Setup:
 *   1. Run enablePolling() once (drops the webhook).
 *   2. Add a time-driven trigger for pollUpdates, every 1 minute.
 *
 * Latency: up to ~60 s between user message and bot reply.
 */
function pollUpdates() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    console.log('pollUpdates: previous run still active, skipping');
    return;
  }
  try {
    var token = props_().getProperty('TELEGRAM_BOT_TOKEN');
    if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

    var offset = Number(props_().getProperty('TG_OFFSET') || 0);
    var url = 'https://api.telegram.org/bot' + token + '/getUpdates' +
              '?timeout=0' +
              '&offset=' + offset +
              '&allowed_updates=' + encodeURIComponent('["message"]');

    var res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code < 200 || code >= 300) {
      console.error('getUpdates ' + code + ': ' + text);
      return;
    }

    var data = JSON.parse(text);
    if (!data.ok) {
      console.error('getUpdates not ok: ' + text);
      return;
    }

    var updates = data.result || [];
    if (!updates.length) return;

    for (var i = 0; i < updates.length; i++) {
      var update = updates[i];
      try {
        processUpdate_(update);
      } catch (err) {
        // processUpdate_ already handles its own errors; this is just a
        // belt-and-braces guard so one bad update can't stop the loop.
        console.error('processUpdate_ threw: ' +
                      (err && (err.stack || err.message) || String(err)));
      }
      // Advance offset per-update so a partial run doesn't reprocess
      // the survivors on the next poll.
      props_().setProperty('TG_OFFSET', String(update.update_id + 1));
    }
  } finally {
    lock.releaseLock();
  }
}

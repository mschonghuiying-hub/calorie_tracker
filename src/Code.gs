/**
 * Calorie tracker Telegram bot — main router.
 *
 * Flow (shared by the poller in Poller.gs and the webhook fallback doPost):
 *   /profile <text>  -> Gemini parse -> Mifflin-St Jeor targets -> save + reply
 *   /today | /status -> sum today's food vs targets -> table + AI nudge
 *   text / photo      -> Gemini macro estimate -> append row -> confirm + status
 *
 * Everything runs serverless on Apps Script: no VM, no host, free tier.
 */

function doPost(e) {
  try {
    var update = JSON.parse(e.postData.contents);
    processUpdate_(update);
  } catch (err) {
    console.error((err && (err.stack || err.message)) || String(err));
  }
  return ContentService.createTextOutput('ok');
}

function doGet() {
  return ContentService.createTextOutput('calorie bot up');
}

function processUpdate_(update) {
  var chatId = null;
  var updateId = null;
  try {
    var msg = update && (update.message || update.edited_message);
    if (!msg) return;

    chatId = msg.chat && msg.chat.id;
    if (!isAllowedChat_(chatId)) return;

    updateId = update.update_id;
    if (wasUpdateProcessed_(updateId)) {
      console.log('Skipping duplicate update_id=' + updateId);
      return;
    }

    var text = msg.text || '';

    if (isCommand_(text, 'start') || isCommand_(text, 'help')) {
      sendMessage_(chatId, helpText_());
      markUpdateProcessed_(updateId);
      return;
    }

    if (isCommand_(text, 'profile')) {
      handleProfileCommand_(chatId, text);
      markUpdateProcessed_(updateId);
      return;
    }

    if (isCommand_(text, 'today') || isCommand_(text, 'status')) {
      handleTodayCommand_(chatId);
      markUpdateProcessed_(updateId);
      return;
    }

    if (isCommand_(text, 'undo')) {
      handleUndoCommand_(chatId);
      markUpdateProcessed_(updateId);
      return;
    }

    // Otherwise treat the message as a food entry (photo or free text).
    handleFood_(chatId, msg);
    markUpdateProcessed_(updateId);
  } catch (err) {
    var detail = (err && (err.stack || err.message)) || String(err);
    console.error(detail);
    if (chatId) {
      try {
        sendMessage_(chatId, '⚠️ ' + detail.substring(0, 3500));
      } catch (notifyErr) {
        console.error('Notify failed: ' + (notifyErr && notifyErr.stack || notifyErr));
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleProfileCommand_(chatId, text) {
  var args = stripCommand_(text, 'profile');

  // No args: show current profile, or prompt to set one.
  if (!args) {
    var existing = readProfile_(chatId);
    if (existing) {
      sendMessage_(chatId, formatProfileReply_(existing, existing, /*saved=*/false), 'HTML');
    } else {
      sendMessage_(chatId,
        'No profile yet. Send e.g.:\n' +
        '/profile male 30 175cm 72kg moderately active lose weight');
    }
    return;
  }

  var profile = callGeminiProfile_(args); // throws a friendly message if incomplete
  var targets = computeTargets_(profile);
  writeProfile_(chatId, profile, targets);
  sendMessage_(chatId, formatProfileReply_(profile, targets, /*saved=*/true), 'HTML');
}

function handleFood_(chatId, msg) {
  var food;
  if (msg.photo && msg.photo.length) {
    var largest = msg.photo[msg.photo.length - 1];
    var blob = downloadTelegramFile_(largest.file_id);
    food = callGeminiFood_({
      text: msg.caption || '',
      imageBytes: blob.getBytes(),
      mimeType: 'image/jpeg'
    });
  } else if (msg.text) {
    food = callGeminiFood_({ text: msg.text });
  } else {
    sendMessage_(chatId, 'Send a food photo or text like "chicken rice bowl".');
    return;
  }

  appendFood_(chatId, food);

  var confirmation = formatFoodConfirmation_(food);
  var profile = readProfile_(chatId);
  if (!profile) {
    sendMessage_(chatId, confirmation +
      '\n\nSet up your daily targets with /profile to see your status.');
    return;
  }

  var totals = computeTodayTotals_(chatId);
  var reply = escapeHtml_(confirmation) + '\n\n' + formatStatusTable_(totals, profile);
  sendMessage_(chatId, reply, 'HTML');
}

function handleTodayCommand_(chatId) {
  var profile = readProfile_(chatId);
  if (!profile) {
    sendMessage_(chatId,
      'No profile yet. Send e.g.:\n' +
      '/profile male 30 175cm 72kg moderately active lose weight');
    return;
  }

  var totals = computeTodayTotals_(chatId);
  var reply = formatStatusTable_(totals, profile);
  if (totals.count === 0) {
    reply += '\n\nNothing logged yet today — send a food photo or description.';
  } else {
    var nudge = callGeminiNudge_(totals, profile, profile);
    if (nudge) reply += '\n\n💬 ' + escapeHtml_(nudge);
  }
  sendMessage_(chatId, reply, 'HTML');
}

function handleUndoCommand_(chatId) {
  var removed = deleteLastFood_(chatId);
  if (!removed) {
    sendMessage_(chatId, 'Nothing to undo — no food logged yet.');
    return;
  }
  var line = '🗑 Removed: ' + capitalize_(removed.meal) + ' · ' + removed.description +
             ' (' + Math.round(removed.calories) + ' kcal)';

  var profile = readProfile_(chatId);
  if (!profile) {
    sendMessage_(chatId, line);
    return;
  }
  var totals = computeTodayTotals_(chatId);
  sendMessage_(chatId, escapeHtml_(line) + '\n\n' + formatStatusTable_(totals, profile), 'HTML');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatFoodConfirmation_(food) {
  return '✅ ' + capitalize_(food.meal) + ' · ' + food.description + '\n' +
         Math.round(food.calories) + ' kcal · P ' + Math.round(food.protein_g) +
         'g · C ' + Math.round(food.carbs_g) + 'g · F ' + Math.round(food.fat_g) + 'g';
}

function formatProfileReply_(profile, targets, saved) {
  var head = saved ? '✅ Profile saved' : '👤 Your profile';
  return head + '\n<pre>' +
    'Daily target: ' + targets.target_calories + ' kcal\n' +
    'Protein ' + targets.target_protein_g + 'g · Carbs ' + targets.target_carbs_g +
    'g · Fat ' + targets.target_fat_g + 'g</pre>' +
    '(Mifflin-St Jeor · ' + profile.activity + ' activity · goal: ' + profile.goal + ')';
}

/**
 * Monospace progress-bar table: one row each for Calories/Protein/Carbs/Fat,
 * a 10-segment █/░ bar, and "actual/target". Wrapped in <pre> for Telegram.
 */
function formatStatusTable_(totals, targets) {
  var BAR_LEN = 10;
  var spec = [
    { label: 'Calories', actual: Math.round(totals.calories),  target: targets.target_calories },
    { label: 'Protein',  actual: Math.round(totals.protein_g), target: targets.target_protein_g },
    { label: 'Carbs',    actual: Math.round(totals.carbs_g),   target: targets.target_carbs_g },
    { label: 'Fat',      actual: Math.round(totals.fat_g),     target: targets.target_fat_g }
  ];

  var rows = spec.map(function (r) {
    return {
      label: r.label,
      bar: makeBar_(r.actual, r.target, BAR_LEN),
      actual: String(r.actual),
      target: String(r.target)
    };
  });

  var labW = Math.max.apply(null, rows.map(function (r) { return r.label.length; }));
  var actW = Math.max.apply(null, rows.map(function (r) { return r.actual.length; }));
  var tgtW = Math.max.apply(null, rows.map(function (r) { return r.target.length; }));

  var body = rows.map(function (r) {
    return padRight_(r.label, labW) + '  ' + r.bar + ' ' +
           padLeft_(r.actual, actW) + '/' + padLeft_(r.target, tgtW);
  }).join('\n');

  return '📊 Today ' + todayIso_() + '\n<pre>' + body + '</pre>';
}

function makeBar_(actual, target, len) {
  if (!target || target <= 0) return repeat_('░', len);
  var ratio = actual / target;
  var filled = Math.min(len, Math.max(0, Math.round(ratio * len)));
  return repeat_('█', filled) + repeat_('░', len - filled);
}

function helpText_() {
  return [
    '🍎 Calorie tracker',
    '',
    '1) Set your targets:',
    '   /profile male 30 175cm 72kg moderately active lose weight',
    '2) Log food: send a photo or text like "chicken rice bowl".',
    '3) Check the day: /today',
    '',
    '/undo removes your last entry.',
    '/profile (no text) shows your current targets.'
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Command parsing + access control
// ---------------------------------------------------------------------------

function isCommand_(text, name) {
  var t = String(text || '').trim().toLowerCase();
  return t === '/' + name ||
         t.indexOf('/' + name + ' ') === 0 ||
         t.indexOf('/' + name + '@') === 0;
}

// Returns the text after "/name" (and an optional @botname), trimmed.
function stripCommand_(text, name) {
  var t = String(text || '').trim();
  var re = new RegExp('^/' + name + '(@\\S+)?', 'i');
  return t.replace(re, '').trim();
}

function isAllowedChat_(chatId) {
  if (chatId == null) return false;
  var raw = props_().getProperty('ALLOWED_CHAT_ID');
  if (!raw) return false;
  var target = String(chatId);
  var parts = String(raw).split(/[\s,]+/);
  for (var i = 0; i < parts.length; i++) {
    if (parts[i] && parts[i] === target) return true;
  }
  return false;
}

// Two-phase dedup: a Telegram retry is only ignored once the original run has
// fully replied (markUpdateProcessed_ is called at the end of each handler).
// TTL is CacheService max (6 h), covering Telegram's retry window.
function wasUpdateProcessed_(updateId) {
  if (updateId == null) return false;
  return Boolean(CacheService.getScriptCache().get('tg_upd_' + updateId));
}

function markUpdateProcessed_(updateId) {
  if (updateId == null) return;
  CacheService.getScriptCache().put('tg_upd_' + updateId, '1', 21600);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml_(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function capitalize_(s) {
  s = String(s || '');
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function padLeft_(s, n) { while (s.length < n) s = ' ' + s; return s; }
function padRight_(s, n) { while (s.length < n) s = s + ' '; return s; }
function repeat_(ch, n) { var o = ''; for (var i = 0; i < n; i++) o += ch; return o; }

function props_() {
  return PropertiesService.getScriptProperties();
}

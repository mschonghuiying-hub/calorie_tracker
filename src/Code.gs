/**
 * Calorie tracker Telegram bot — main router.
 *
 * Flow (shared by the poller in Poller.gs and the webhook fallback doPost):
 *   /profile <text>  -> Gemini parse -> Mifflin-St Jeor targets -> save + reply
 *   /move <text>     -> Gemini burn estimate -> append row -> raises today's kcal
 *   /today | /status -> sum today's food vs (targets + activity) -> table + nudge
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

    if (isCommand_(text, 'week')) {
      handleWeekCommand_(chatId);
      markUpdateProcessed_(updateId);
      return;
    }

    if (isCommand_(text, 'move')) {
      handleMoveCommand_(chatId, text);
      markUpdateProcessed_(updateId);
      return;
    }

    if (isCommand_(text, 'undo')) {
      handleUndoCommand_(chatId);
      markUpdateProcessed_(updateId);
      return;
    }

    // Any other text starting with "/" is an unknown command — never log it
    // as food (that's how the "Invalid command" 0-kcal rows happened).
    if (text.trim().charAt(0) === '/') {
      sendMessage_(chatId, 'Unknown command. Try /help.');
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
  var burn = computeTodayBurn_(chatId);
  var reply = escapeHtml_(confirmation) + '\n\n' + formatStatusTable_(totals, profile, burn);
  sendMessage_(chatId, reply, 'HTML');
}

function handleMoveCommand_(chatId, text) {
  var profile = readProfile_(chatId);
  if (!profile) {
    sendMessage_(chatId,
      'Set up your profile first so I can estimate burn from your weight:\n' +
      '/profile male 30 175cm 72kg sedentary lose weight');
    return;
  }

  var args = stripCommand_(text, 'move');
  if (!args) {
    var b = computeTodayBurn_(chatId);
    var msg = 'Tell me your activity, e.g.:\n/move 8000 steps and a 30 min run';
    if (b.count) {
      msg += '\n\nToday so far: ' + Math.round(b.calories) + ' kcal burned' +
             (b.steps ? ' (' + formatInt_(b.steps) + ' steps)' : '');
    }
    msg += '\n\nTip: for the most accurate numbers, set your /profile activity to ' +
           '"sedentary" and log all your movement here.';
    sendMessage_(chatId, msg);
    return;
  }

  var ex = callGeminiMove_(args, profile);
  appendExercise_(chatId, ex);

  var line = '🔥 Logged: ' + ex.description + '\n~' +
             Math.round(ex.calories_burned) + ' kcal burned';
  var totals = computeTodayTotals_(chatId);
  var burn = computeTodayBurn_(chatId);
  sendMessage_(chatId, escapeHtml_(line) + '\n\n' + formatStatusTable_(totals, profile, burn), 'HTML');
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
  var burn = computeTodayBurn_(chatId);
  var reply = formatStatusTable_(totals, profile, burn);
  if (totals.count === 0) {
    reply += '\n\nNothing logged yet today — send a food photo or description.';
  } else {
    var nudge = callGeminiNudge_(totals, effectiveTargets_(profile, burn.calories), profile);
    if (nudge) reply += '\n\n💬 ' + escapeHtml_(nudge);
  }
  sendMessage_(chatId, reply, 'HTML');
}

function handleWeekCommand_(chatId) {
  var profile = readProfile_(chatId);
  if (!profile) {
    sendMessage_(chatId,
      'No profile yet. Send e.g.:\n' +
      '/profile male 30 175cm 72kg moderately active lose weight');
    return;
  }
  var wk = computeWeekSummary_(chatId);
  if (!wk || !wk.days) {
    sendMessage_(chatId, 'No food logged in the last 7 days yet.');
    return;
  }
  var reply = formatWeekTable_(wk, profile);
  var wb = computeWeekBurn_(chatId);
  if (wb.days) {
    reply += '\n🔥 avg ' + Math.round(wb.avgCalories) + ' kcal/day burned over ' +
             wb.days + ' active day' + (wb.days === 1 ? '' : 's');
  }
  sendMessage_(chatId, reply, 'HTML');
}

function handleUndoCommand_(chatId) {
  var foodMs = peekLastFoodMs_(chatId);
  var exMs = peekLastExerciseMs_(chatId);
  if (foodMs == null && exMs == null) {
    sendMessage_(chatId, 'Nothing to undo — nothing logged yet.');
    return;
  }

  var line;
  // Remove whichever log has the most recent entry.
  if (exMs != null && (foodMs == null || exMs >= foodMs)) {
    var rex = deleteLastExercise_(chatId);
    line = '🗑 Removed activity: ' + rex.description +
           ' (~' + Math.round(rex.calories) + ' kcal burned)';
  } else {
    var rf = deleteLastFood_(chatId);
    line = '🗑 Removed: ' + capitalize_(rf.meal) + ' · ' + rf.description +
           ' (' + Math.round(rf.calories) + ' kcal)';
  }

  var profile = readProfile_(chatId);
  if (!profile) {
    sendMessage_(chatId, line);
    return;
  }
  var totals = computeTodayTotals_(chatId);
  var burn = computeTodayBurn_(chatId);
  sendMessage_(chatId, escapeHtml_(line) + '\n\n' + formatStatusTable_(totals, profile, burn), 'HTML');
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

// Today's calorie target rises by calories burned (macros stay fixed); burn is
// the optional { calories, steps, count } from computeTodayBurn_.
function effectiveTargets_(profile, burnKcal) {
  return {
    target_calories: profile.target_calories + Math.round(burnKcal || 0),
    target_protein_g: profile.target_protein_g,
    target_carbs_g: profile.target_carbs_g,
    target_fat_g: profile.target_fat_g
  };
}

function formatStatusTable_(totals, profile, burn) {
  var burnKcal = (burn && burn.calories) || 0;
  var header = '📊 Today ' + todayIso_();
  if (burnKcal > 0) {
    header += '\n🔥 +' + Math.round(burnKcal) + ' kcal from activity';
  }
  return barTable_(header, totals, effectiveTargets_(profile, burnKcal));
}

function formatWeekTable_(wk, targets) {
  return barTable_('📅 Last 7 days · avg/day (' + wk.days +
                   ' day' + (wk.days === 1 ? '' : 's') + ' logged)', wk.avg, targets);
}

/**
 * Monospace progress-bar table: one row each for Calories/Protein/Carbs/Fat,
 * a 10-segment █/░ bar, and "actual/target". Wrapped in <pre> for Telegram.
 */
function barTable_(header, totals, targets) {
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

  return header + '\n<pre>' + body + '</pre>';
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
    '3) Log activity: /move 8000 steps and a 30 min run',
    '   (earns back calories for the day)',
    '4) Check the day: /today · the week: /week',
    '',
    '/undo removes your last entry (food or activity).',
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

function formatInt_(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function padLeft_(s, n) { while (s.length < n) s = ' ' + s; return s; }
function padRight_(s, n) { while (s.length < n) s = s + ' '; return s; }
function repeat_(ch, n) { var o = ''; for (var i = 0; i < n; i++) o += ch; return o; }

function props_() {
  return PropertiesService.getScriptProperties();
}

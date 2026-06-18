/**
 * Google Sheets storage.
 *
 * Two tabs, both auto-created with a header row on first use:
 *
 *   food log:  A date  B chat_id  C meal  D description
 *              E calories  F protein_g  G carbs_g  H fat_g  I logged_at
 *
 *   profile:   A chat_id  B sex  C age  D height_cm  E weight_kg
 *              F activity  G goal  H target_calories  I target_protein_g
 *              J target_carbs_g  K target_fat_g  L updated_at
 *
 * Multi-user: every food row and profile row is keyed by Telegram chat_id, so
 * several people can share one bot + sheet and each get their own targets.
 */

var FOOD_HEADERS_ = [
  'date', 'chat_id', 'meal', 'description',
  'calories', 'protein_g', 'carbs_g', 'fat_g', 'logged_at'
];
var PROFILE_HEADERS_ = [
  'chat_id', 'sex', 'age', 'height_cm', 'weight_kg', 'activity', 'goal',
  'target_calories', 'target_protein_g', 'target_carbs_g', 'target_fat_g', 'updated_at'
];
var EXERCISE_HEADERS_ = [
  'date', 'chat_id', 'description', 'calories_burned', 'steps', 'logged_at'
];

function foodSheet_() {
  var name = props_().getProperty('SHEET_NAME') || 'food log';
  return getOrCreateSheet_(name, FOOD_HEADERS_);
}

function profileSheet_() {
  var name = props_().getProperty('PROFILE_SHEET_NAME') || 'profile';
  return getOrCreateSheet_(name, PROFILE_HEADERS_);
}

function exerciseSheet_() {
  var name = props_().getProperty('EXERCISE_SHEET_NAME') || 'exercise log';
  return getOrCreateSheet_(name, EXERCISE_HEADERS_);
}

function getOrCreateSheet_(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function tz_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
}

function todayIso_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

// A date cell may come back as a Date object or a string depending on how
// Sheets stored it — normalize both to yyyy-MM-dd.
function asYmd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, tz_(), 'yyyy-MM-dd');
  return String(v).trim();
}

// A logged_at cell may be a Date or a string — normalize to epoch ms for
// chronological comparison (used by /undo across the food + exercise logs).
function loggedAtMs_(v) {
  if (v instanceof Date) return v.getTime();
  return Date.parse(String(v)) || 0;
}

// Returns { rowIndex, row } of the last row matching chatId (column B) in
// append order, or null. Shared by the delete/peek helpers below.
function lastUserRow_(sheet, width, chatId) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  var values = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  var target = String(chatId);
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][1]).trim() === target) return { rowIndex: i + 2, row: values[i] };
  }
  return null;
}

/**
 * Appends one food row for the given user, dated today (script timezone).
 * food: { meal, description, calories, protein_g, carbs_g, fat_g }
 */
function appendFood_(chatId, food) {
  var sheet = foodSheet_();
  var now = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([
    todayIso_(),
    String(chatId),
    food.meal,
    food.description,
    Math.round(food.calories),
    Math.round(food.protein_g),
    Math.round(food.carbs_g),
    Math.round(food.fat_g),
    now
  ]);
  SpreadsheetApp.flush();
}

/**
 * Sums today's food rows for one user.
 * Returns { calories, protein_g, carbs_g, fat_g, count }.
 */
function computeTodayTotals_(chatId) {
  var totals = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, count: 0 };
  var sheet = foodSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return totals;

  var values = sheet.getRange(2, 1, lastRow - 1, FOOD_HEADERS_.length).getValues();
  var today = todayIso_();
  var target = String(chatId);

  for (var i = 0; i < values.length; i++) {
    if (asYmd_(values[i][0]) !== today) continue;
    if (String(values[i][1]).trim() !== target) continue;
    totals.calories  += Number(values[i][4]) || 0;
    totals.protein_g += Number(values[i][5]) || 0;
    totals.carbs_g   += Number(values[i][6]) || 0;
    totals.fat_g     += Number(values[i][7]) || 0;
    totals.count++;
  }
  return totals;
}

/**
 * Averages this user's daily intake over the last 7 calendar days (script tz).
 * Averages across days that actually have entries, so a missed day doesn't drag
 * the average to zero. Returns { days, avg: {calories, protein_g, carbs_g, fat_g} }
 * with days === 0 when nothing was logged in the window.
 */
function computeWeekSummary_(chatId) {
  var sheet = foodSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { days: 0 };

  var values = sheet.getRange(2, 1, lastRow - 1, FOOD_HEADERS_.length).getValues();
  var target = String(chatId);

  var tz = tz_();
  var now = new Date();
  var validDates = {};
  for (var d = 0; d < 7; d++) {
    var dt = new Date(now.getTime() - d * 86400000);
    validDates[Utilities.formatDate(dt, tz, 'yyyy-MM-dd')] = true;
  }

  var perDay = {};
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1]).trim() !== target) continue;
    var ymd = asYmd_(values[i][0]);
    if (!validDates[ymd]) continue;
    if (!perDay[ymd]) perDay[ymd] = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
    perDay[ymd].calories  += Number(values[i][4]) || 0;
    perDay[ymd].protein_g += Number(values[i][5]) || 0;
    perDay[ymd].carbs_g   += Number(values[i][6]) || 0;
    perDay[ymd].fat_g     += Number(values[i][7]) || 0;
  }

  var keys = Object.keys(perDay);
  var n = keys.length;
  if (n === 0) return { days: 0 };

  var sum = { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 };
  for (var k = 0; k < n; k++) {
    var t = perDay[keys[k]];
    sum.calories += t.calories;
    sum.protein_g += t.protein_g;
    sum.carbs_g += t.carbs_g;
    sum.fat_g += t.fat_g;
  }
  return {
    days: n,
    avg: {
      calories: sum.calories / n,
      protein_g: sum.protein_g / n,
      carbs_g: sum.carbs_g / n,
      fat_g: sum.fat_g / n
    }
  };
}

/**
 * Returns this user's stored profile + targets, or null if none yet.
 * Shape: { rowIndex, sex, age, height_cm, weight_kg, activity, goal,
 *          target_calories, target_protein_g, target_carbs_g, target_fat_g }
 */
function readProfile_(chatId) {
  var sheet = profileSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var values = sheet.getRange(2, 1, lastRow - 1, PROFILE_HEADERS_.length).getValues();
  var target = String(chatId);
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim() !== target) continue;
    var r = values[i];
    return {
      rowIndex: i + 2,
      sex: r[1], age: Number(r[2]), height_cm: Number(r[3]), weight_kg: Number(r[4]),
      activity: r[5], goal: r[6],
      target_calories: Number(r[7]), target_protein_g: Number(r[8]),
      target_carbs_g: Number(r[9]), target_fat_g: Number(r[10])
    };
  }
  return null;
}

/**
 * Upserts a user's profile row (one row per chat_id).
 * profile: { sex, age, height_cm, weight_kg, activity, goal }
 * targets: from computeTargets_()
 */
function writeProfile_(chatId, profile, targets) {
  var sheet = profileSheet_();
  var now = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
  var row = [
    String(chatId), profile.sex, profile.age, profile.height_cm, profile.weight_kg,
    profile.activity, profile.goal,
    targets.target_calories, targets.target_protein_g,
    targets.target_carbs_g, targets.target_fat_g, now
  ];

  var existing = readProfile_(chatId);
  if (existing) {
    sheet.getRange(existing.rowIndex, 1, 1, row.length).setValues([row]);
  } else {
    sheet.appendRow(row);
  }
  SpreadsheetApp.flush();
}

/**
 * Deletes this user's most recently logged food row (the last matching row in
 * append order). Returns the removed entry { meal, description, calories,
 * protein_g, carbs_g, fat_g, date } or null if the user has nothing logged.
 */
function deleteLastFood_(chatId) {
  var sheet = foodSheet_();
  var hit = lastUserRow_(sheet, FOOD_HEADERS_.length, chatId);
  if (!hit) return null;
  var r = hit.row;
  var removed = {
    date: asYmd_(r[0]),
    meal: r[2],
    description: r[3],
    calories: Number(r[4]) || 0,
    protein_g: Number(r[5]) || 0,
    carbs_g: Number(r[6]) || 0,
    fat_g: Number(r[7]) || 0
  };
  sheet.deleteRow(hit.rowIndex);
  SpreadsheetApp.flush();
  return removed;
}

// Last food logged_at (epoch ms) for this user, or null — used by /undo.
function peekLastFoodMs_(chatId) {
  var hit = lastUserRow_(foodSheet_(), FOOD_HEADERS_.length, chatId);
  return hit ? loggedAtMs_(hit.row[8]) : null;
}

// ---------------------------------------------------------------------------
// Exercise / activity log
// ---------------------------------------------------------------------------

/**
 * Appends one activity row for the given user, dated today (script timezone).
 * ex: { description, calories_burned, steps }
 */
function appendExercise_(chatId, ex) {
  var sheet = exerciseSheet_();
  var now = Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd HH:mm:ss');
  sheet.appendRow([
    todayIso_(),
    String(chatId),
    ex.description,
    Math.round(ex.calories_burned),
    Math.round(ex.steps) || 0,
    now
  ]);
  SpreadsheetApp.flush();
}

/**
 * Sums today's activity for one user.
 * Returns { calories, steps, count } (calories = total kcal burned today).
 */
function computeTodayBurn_(chatId) {
  var burn = { calories: 0, steps: 0, count: 0 };
  var sheet = exerciseSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return burn;

  var values = sheet.getRange(2, 1, lastRow - 1, EXERCISE_HEADERS_.length).getValues();
  var today = todayIso_();
  var target = String(chatId);
  for (var i = 0; i < values.length; i++) {
    if (asYmd_(values[i][0]) !== today) continue;
    if (String(values[i][1]).trim() !== target) continue;
    burn.calories += Number(values[i][3]) || 0;
    burn.steps    += Number(values[i][4]) || 0;
    burn.count++;
  }
  return burn;
}

/**
 * Average kcal burned per day over the last 7 days, across days with activity.
 * Returns { days, avgCalories } with days === 0 when none logged.
 */
function computeWeekBurn_(chatId) {
  var sheet = exerciseSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { days: 0, avgCalories: 0 };

  var values = sheet.getRange(2, 1, lastRow - 1, EXERCISE_HEADERS_.length).getValues();
  var target = String(chatId);
  var tz = tz_();
  var now = new Date();
  var validDates = {};
  for (var d = 0; d < 7; d++) {
    validDates[Utilities.formatDate(new Date(now.getTime() - d * 86400000), tz, 'yyyy-MM-dd')] = true;
  }

  var perDay = {};
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1]).trim() !== target) continue;
    var ymd = asYmd_(values[i][0]);
    if (!validDates[ymd]) continue;
    perDay[ymd] = (perDay[ymd] || 0) + (Number(values[i][3]) || 0);
  }

  var keys = Object.keys(perDay);
  if (!keys.length) return { days: 0, avgCalories: 0 };
  var sum = 0;
  for (var k = 0; k < keys.length; k++) sum += perDay[keys[k]];
  return { days: keys.length, avgCalories: sum / keys.length };
}

/**
 * Deletes this user's most recently logged activity row. Returns the removed
 * entry { date, description, calories, steps } or null if nothing logged.
 */
function deleteLastExercise_(chatId) {
  var sheet = exerciseSheet_();
  var hit = lastUserRow_(sheet, EXERCISE_HEADERS_.length, chatId);
  if (!hit) return null;
  var r = hit.row;
  var removed = {
    date: asYmd_(r[0]),
    description: r[2],
    calories: Number(r[3]) || 0,
    steps: Number(r[4]) || 0
  };
  sheet.deleteRow(hit.rowIndex);
  SpreadsheetApp.flush();
  return removed;
}

// Last activity logged_at (epoch ms) for this user, or null — used by /undo.
function peekLastExerciseMs_(chatId) {
  var hit = lastUserRow_(exerciseSheet_(), EXERCISE_HEADERS_.length, chatId);
  return hit ? loggedAtMs_(hit.row[5]) : null;
}

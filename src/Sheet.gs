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

function foodSheet_() {
  var name = props_().getProperty('SHEET_NAME') || 'food log';
  return getOrCreateSheet_(name, FOOD_HEADERS_);
}

function profileSheet_() {
  var name = props_().getProperty('PROFILE_SHEET_NAME') || 'profile';
  return getOrCreateSheet_(name, PROFILE_HEADERS_);
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
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var values = sheet.getRange(2, 1, lastRow - 1, FOOD_HEADERS_.length).getValues();
  var target = String(chatId);
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][1]).trim() !== target) continue;
    var r = values[i];
    var removed = {
      date: asYmd_(r[0]),
      meal: r[2],
      description: r[3],
      calories: Number(r[4]) || 0,
      protein_g: Number(r[5]) || 0,
      carbs_g: Number(r[6]) || 0,
      fat_g: Number(r[7]) || 0
    };
    sheet.deleteRow(i + 2);
    SpreadsheetApp.flush();
    return removed;
  }
  return null;
}

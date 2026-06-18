/**
 * Gemini client.
 *   callGeminiFood_    : text and/or food photo -> { meal, description, calories, protein_g, carbs_g, fat_g }
 *   callGeminiProfile_ : free text              -> { sex, age, height_cm, weight_kg, activity, goal }
 *   callGeminiNudge_   : day's totals + targets -> short plain-text coaching line
 *
 * Food/profile calls use Gemini's JSON-schema-constrained output so no regex
 * parsing is needed.
 */

var GEMINI_MODEL_ = 'gemini-2.5-flash';

var MEALS_ = ['breakfast', 'lunch', 'dinner', 'snack'];
var SEXES_ = ['male', 'female'];
var ACTIVITIES_ = ['sedentary', 'light', 'moderate', 'active', 'very_active'];
var GOALS_ = ['lose', 'maintain', 'gain'];

// ---------------------------------------------------------------------------
// Food estimation
// ---------------------------------------------------------------------------

function callGeminiFood_(input) {
  var tz = Session.getScriptTimeZone() || 'Australia/Melbourne';
  var nowHm = Utilities.formatDate(new Date(), tz, 'HH:mm');

  var parts = [{ text: buildFoodPrompt_(input.text || '', nowHm) }];
  if (input.imageBytes) {
    parts.push({
      inline_data: {
        mime_type: input.mimeType || 'image/jpeg',
        data: Utilities.base64Encode(input.imageBytes)
      }
    });
  }

  var body = {
    contents: [{ role: 'user', parts: parts }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'OBJECT',
        properties: {
          meal:        { type: 'STRING', enum: MEALS_ },
          description: { type: 'STRING' },
          calories:    { type: 'NUMBER' },
          protein_g:   { type: 'NUMBER' },
          carbs_g:     { type: 'NUMBER' },
          fat_g:       { type: 'NUMBER' }
        },
        required: ['meal', 'description', 'calories', 'protein_g', 'carbs_g', 'fat_g']
      },
      temperature: 0
    }
  };

  var jsonText = geminiJson_(body);
  var food = JSON.parse(jsonText);
  validateFood_(food);
  return food;
}

function buildFoodPrompt_(userText, nowHm) {
  return [
    'You estimate the nutrition of a single meal or food item from the user',
    'input and/or the attached food photo, and return strict JSON.',
    '',
    'Rules:',
    '- meal: exactly one of ' + MEALS_.join(', ') + '. Infer from the user\'s',
    '  words, or from the current local time (' + nowHm + ') if not stated.',
    '- description: short human-readable name, max ~60 chars (e.g. "Chicken rice bowl").',
    '- calories: best estimate of the TOTAL kcal for the whole portion shown or',
    '  described (not per 100g). Number, not string.',
    '- protein_g, carbs_g, fat_g: best estimate in grams for the whole portion.',
    '  Numbers, not strings.',
    '- If the portion size is ambiguous, assume one typical single serving.',
    '- If multiple items are present, sum them into one entry.',
    '',
    'User text: ' + JSON.stringify(userText || '(none)')
  ].join('\n');
}

function validateFood_(x) {
  if (!x || typeof x !== 'object') throw new Error('Food not an object');
  if (MEALS_.indexOf(x.meal) === -1) throw new Error('Bad meal: ' + x.meal);
  if (!x.description) throw new Error('Missing description');
  ['calories', 'protein_g', 'carbs_g', 'fat_g'].forEach(function (k) {
    if (typeof x[k] !== 'number' || !isFinite(x[k]) || x[k] < 0) {
      throw new Error('Bad ' + k + ': ' + x[k]);
    }
  });
}

// ---------------------------------------------------------------------------
// Activity / exercise estimation
// ---------------------------------------------------------------------------

function callGeminiMove_(text, profile) {
  var body = {
    contents: [{ role: 'user', parts: [{ text: buildMovePrompt_(text || '', profile) }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'OBJECT',
        properties: {
          description:     { type: 'STRING' },
          calories_burned: { type: 'NUMBER' },
          steps:           { type: 'NUMBER' }
        },
        required: ['description', 'calories_burned', 'steps']
      },
      temperature: 0
    }
  };

  var ex = JSON.parse(geminiJson_(body));
  validateMove_(ex);
  return ex;
}

function buildMovePrompt_(text, profile) {
  var kg = (profile && profile.weight_kg) || 70;
  return [
    'You estimate the calories a person burned from the activity they describe',
    '(steps and/or workouts) and return strict JSON. The person weighs ' + kg + ' kg.',
    '',
    'Rules:',
    '- calories_burned: total kcal burned across everything mentioned. Number.',
    '  Steps: estimate as steps × ' + kg + ' × 0.0005 kcal.',
    '  Named workouts: METs × ' + kg + ' × hours (walking ~3.5, brisk walk ~4.3,',
    '  jog/run ~8-11, cycling ~8, swimming ~7, strength training ~4-6, yoga ~3).',
    '- steps: total step count mentioned, else 0. Number.',
    '- description: short summary of the activity, e.g. "8,000 steps + 30 min run".',
    '- Only count active exercise/steps, not normal resting time.',
    '',
    'User text: ' + JSON.stringify(text || '(none)')
  ].join('\n');
}

function validateMove_(x) {
  if (!x || typeof x !== 'object') throw new Error('Activity not an object');
  if (!x.description) throw new Error('Missing description');
  if (typeof x.calories_burned !== 'number' || !isFinite(x.calories_burned) || x.calories_burned < 0) {
    throw new Error('Bad calories_burned: ' + x.calories_burned);
  }
  if (typeof x.steps !== 'number' || !isFinite(x.steps) || x.steps < 0) {
    throw new Error('Bad steps: ' + x.steps);
  }
}

// ---------------------------------------------------------------------------
// Profile parsing
// ---------------------------------------------------------------------------

function callGeminiProfile_(text) {
  var body = {
    contents: [{ role: 'user', parts: [{ text: buildProfilePrompt_(text || '') }] }],
    generationConfig: {
      response_mime_type: 'application/json',
      response_schema: {
        type: 'OBJECT',
        properties: {
          sex:       { type: 'STRING', enum: SEXES_ },
          age:       { type: 'NUMBER' },
          height_cm: { type: 'NUMBER' },
          weight_kg: { type: 'NUMBER' },
          activity:  { type: 'STRING', enum: ACTIVITIES_ },
          goal:      { type: 'STRING', enum: GOALS_ }
        },
        required: ['sex', 'age', 'height_cm', 'weight_kg', 'activity', 'goal']
      },
      temperature: 0
    }
  };

  var jsonText = geminiJson_(body);
  var profile = JSON.parse(jsonText);
  validateProfile_(profile);
  return profile;
}

function buildProfilePrompt_(text) {
  return [
    'You extract a person\'s fitness profile from their message and return',
    'strict JSON. Convert all units to metric.',
    '',
    'Rules:',
    '- sex: "male" or "female".',
    '- age: years (number).',
    '- height_cm: centimeters. Convert from feet/inches if given (1 in = 2.54 cm).',
    '- weight_kg: kilograms. Convert from pounds if given (1 lb = 0.4536 kg).',
    '- activity: one of ' + ACTIVITIES_.join(', ') + '. Map phrases:',
    '  "sit all day"/"no exercise" -> sedentary; "light"/"1-3 days" -> light;',
    '  "moderately active"/"3-5 days" -> moderate; "very active"/"gym 6-7 days" ->',
    '  active; "athlete"/"physical job"/"twice a day" -> very_active.',
    '- goal: one of ' + GOALS_.join(', ') + '. Map "lose weight"/"cut"/"deficit" ->',
    '  lose; "maintain"/"stay the same" -> maintain; "gain"/"bulk"/"build muscle" -> gain.',
    '- If a value is genuinely not stated and cannot be inferred, use 0 so the',
    '  caller can detect it and ask the user.',
    '',
    'User text: ' + JSON.stringify(text || '(none)')
  ].join('\n');
}

// Plausibility bounds — also catches "0" sentinels from missing input.
function validateProfile_(p) {
  if (!p || typeof p !== 'object') throw new Error('Profile not an object');
  var missing = [];
  if (SEXES_.indexOf(p.sex) === -1) missing.push('sex (male/female)');
  if (!(p.age >= 10 && p.age <= 100)) missing.push('age');
  if (!(p.height_cm >= 100 && p.height_cm <= 250)) missing.push('height');
  if (!(p.weight_kg >= 30 && p.weight_kg <= 300)) missing.push('weight');
  if (ACTIVITIES_.indexOf(p.activity) === -1) missing.push('activity level');
  if (GOALS_.indexOf(p.goal) === -1) missing.push('goal (lose/maintain/gain)');
  if (missing.length) {
    throw new Error(
      'I couldn\'t read your ' + missing.join(', ') + '. Try e.g.:\n' +
      '/profile male 30 175cm 72kg moderately active lose weight'
    );
  }
}

// ---------------------------------------------------------------------------
// Coaching nudge (plain text, best-effort — returns '' on any failure)
// ---------------------------------------------------------------------------

function callGeminiNudge_(totals, targets, profile) {
  try {
    var remCal = targets.target_calories - totals.calories;
    var remPro = targets.target_protein_g - totals.protein_g;

    var prompt = [
      'You are a friendly nutrition coach writing a 1-2 sentence nudge shown',
      'beneath a daily calorie/macro table in a Telegram bot. Warm, concrete tone.',
      '',
      'Goal: ' + profile.goal + '.',
      'Today so far -> calories ' + totals.calories + '/' + targets.target_calories +
        ', protein ' + totals.protein_g + '/' + targets.target_protein_g + 'g' +
        ', carbs ' + totals.carbs_g + '/' + targets.target_carbs_g + 'g' +
        ', fat ' + totals.fat_g + '/' + targets.target_fat_g + 'g.',
      'Remaining: ' + remCal + ' kcal and ' + remPro + 'g protein.',
      '',
      'Mention how much room is left and give one concrete, realistic food',
      'suggestion that fits the remaining calories and protein. If they are over',
      'on calories, gently say so. Plain text only, no markdown, 150-280 chars.'
    ].join('\n');

    var body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 300,
        thinkingConfig: { thinkingBudget: 0 }
      }
    };
    var out = geminiText_(body);
    return out ? String(out).trim() : '';
  } catch (err) {
    console.warn('Nudge failed: ' + (err && err.stack || err));
    return '';
  }
}

// ---------------------------------------------------------------------------
// Low-level transport
// ---------------------------------------------------------------------------

function geminiResponse_(body) {
  var apiKey = props_().getProperty('GEMINI_API_KEY');
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
            GEMINI_MODEL_ + ':generateContent?key=' + encodeURIComponent(apiKey);
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };

  // Gemini's free tier intermittently returns 429/500/503 under load. These
  // are recoverable, so retry with exponential backoff before surfacing an
  // error to the user (worst case ~7s of waiting across 4 attempts).
  var MAX_ATTEMPTS = 4;
  var lastText = '';
  for (var attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    var res = UrlFetchApp.fetch(url, options);
    var code = res.getResponseCode();
    lastText = res.getContentText();
    if (code >= 200 && code < 300) return JSON.parse(lastText);

    var transient = (code === 429 || code === 500 || code === 503);
    if (!transient || attempt === MAX_ATTEMPTS) {
      throw new Error('Gemini ' + code + ': ' + lastText);
    }
    console.warn('Gemini ' + code + ' (attempt ' + attempt + '/' + MAX_ATTEMPTS + '), retrying');
    Utilities.sleep(Math.pow(2, attempt) * 500); // 1s, 2s, 4s
  }
  throw new Error('Gemini failed after retries: ' + lastText);
}

function geminiText_(body) {
  var data = geminiResponse_(body);
  var candidate = data.candidates && data.candidates[0];
  var out = candidate && candidate.content && candidate.content.parts &&
            candidate.content.parts[0] && candidate.content.parts[0].text;
  if (candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
    console.warn('finishReason=' + candidate.finishReason);
  }
  return out || '';
}

function geminiJson_(body) {
  var out = geminiText_(body);
  if (!out) throw new Error('Gemini returned no content');
  return out;
}

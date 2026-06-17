/**
 * Daily calorie + macro target math.
 *
 * Uses the Mifflin-St Jeor equation (current best-practice standard for BMR),
 * an activity multiplier for TDEE, and a goal delta for the calorie target.
 * Macros: protein scaled to bodyweight, fat at 25% of calories, carbs as the
 * remainder. All pure functions — no I/O — so they're easy to reason about.
 */

var ACTIVITY_FACTORS_ = {
  sedentary: 1.2,    // little/no exercise
  light: 1.375,      // light exercise 1-3 days/week
  moderate: 1.55,    // moderate exercise 3-5 days/week
  active: 1.725,     // hard exercise 6-7 days/week
  very_active: 1.9   // physical job or 2x/day training
};

// Calorie adjustment per day for each goal.
//   lose: ~0.5 kg/week deficit · maintain: none · gain: lean surplus
var GOAL_DELTAS_ = { lose: -500, maintain: 0, gain: 350 };

var PROTEIN_G_PER_KG_ = 1.8; // grams of protein per kg bodyweight
var FAT_CALORIE_SHARE_ = 0.25; // fraction of target calories from fat

/**
 * profile: { sex, age, height_cm, weight_kg, activity, goal }
 * Returns { bmr, tdee, target_calories, target_protein_g, target_carbs_g, target_fat_g }
 */
function computeTargets_(profile) {
  var kg = Number(profile.weight_kg);
  var cm = Number(profile.height_cm);
  var age = Number(profile.age);

  // Mifflin-St Jeor
  var bmr = 10 * kg + 6.25 * cm - 5 * age + (profile.sex === 'male' ? 5 : -161);

  var factor = ACTIVITY_FACTORS_[profile.activity] || ACTIVITY_FACTORS_.sedentary;
  var tdee = bmr * factor;

  var delta = GOAL_DELTAS_[profile.goal] || 0;
  var calories = Math.round(tdee + delta);

  var protein = Math.round(PROTEIN_G_PER_KG_ * kg);
  var fat = Math.round((calories * FAT_CALORIE_SHARE_) / 9);
  // Carbs take whatever calories remain after protein (4 kcal/g) and fat (9 kcal/g).
  var carbs = Math.round((calories - protein * 4 - fat * 9) / 4);
  if (carbs < 0) carbs = 0;

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    target_calories: calories,
    target_protein_g: protein,
    target_carbs_g: carbs,
    target_fat_g: fat
  };
}

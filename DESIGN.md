# Calorie Tracker — Design Blueprint

A serverless calorie + macro tracking Telegram bot, modeled directly on the
[`auto_record_expense`](https://github.com/mschonghuiying-hub/auto_record_expense)
project. Send the bot a text message or a food photo; Gemini estimates the
calories and macros and appends a row to a Google Sheet; the bot replies with a
confirmation and a progress-bar status for the day. The goal is the **most
cost-effective, launchable MVP**.

## Goals

1. Capture user info → compute a recommended daily calorie + macro intake.
2. Photograph or describe food → analyze macros → save it.
3. Show the user their latest daily status.

## Confirmed product decisions

- **Multi-user**: shared bot + sheet, with per-person profile/targets keyed by `chat_id`.
- Profile entered via a **`/profile` free-text command** (Gemini parses it).
- Track **calories + full macros** (protein / carbs / fat).

---

## Recommended stack — clone the `auto_record_expense` architecture

Already the most cost-effective option, and the user knows how to deploy it.

| Layer | Choice | Cost |
|---|---|---|
| Runtime | **Google Apps Script** bound to a Sheet (no server, no VM, no cron host) | Free |
| Database | **Google Sheets** | Free |
| Messaging UI | **Telegram Bot API** (long-polling via 1-min trigger) | Free |
| AI (parse text + vision for photos) | **Gemini 2.5 Flash**, JSON-schema-constrained output | Free tier |

**Why not alternatives:** a custom web/mobile app + hosted DB + a paid
food-database API (Nutritionix, Edamam) is more accurate but adds hosting +
subscription cost and a much larger build. For a personal / small-group
launchable MVP, the Apps-Script stack wins on cost and time-to-launch. Most OSS
calorie bots on GitHub require a hosted server and do **not** beat this stack on
cost.

**Accuracy caveat (document for users):** Gemini-vision macro estimates from a
photo are approximate — portion size is the main error source. Good enough for
trend tracking; users can correct a value by editing the sheet row or re-sending
with a clarifying caption (e.g. "200g cooked").

---

## Architecture (same shape as the expense bot)

```
Apps Script (1-min trigger) ──getUpdates──▶ Telegram
        │
        ├─ /profile <free text> ─▶ Gemini (parse profile) ─▶ Mifflin-St Jeor
        │                                  ─▶ save profile+targets (per chat_id)
        │
        ├─ food text / photo ────▶ Gemini 2.5 Flash (→ macro JSON)
        │                          ─▶ append row to "food log" (with chat_id)
        │                          ─▶ reply: confirmation + today's status bars
        │
        └─ /today ───────────────▶ sum today's rows vs targets
                                   ─▶ Gemini (nutrition nudge) ─▶ reply
```

Reuse the expense bot's proven mechanics verbatim:
- **Long-polling** over webhook (avoids the Apps Script `/exec` 302 retry storm)
  — `Poller.gs::pollUpdates` + `TG_OFFSET` property + `LockService`.
- **Two-phase dedup** via `CacheService` (`wasUpdateProcessed_` / `markUpdateProcessed_`).
- **`ALLOWED_CHAT_ID`** allowlist (comma-separated) — already multi-user friendly.
- Secrets in **Script Properties**, never in source.
- Schema-constrained Gemini output (`response_schema`), `temperature: 0`.

---

## Data model (Google Sheets)

### Tab `food log` (bot appends)
| Col | Field | Notes |
|---|---|---|
| A | date | `YYYY-MM-DD` |
| B | chat_id | which user logged it (multi-user key) |
| C | meal | `breakfast / lunch / dinner / snack` (enum) |
| D | description | short, e.g. "Chicken rice bowl" |
| E | calories | number (kcal) |
| F | protein_g | number |
| G | carbs_g | number |
| H | fat_g | number |
| I | logged_at | timestamp |

### Tab `profile` (one row per user — `/profile` writes, bot reads)
| Col | Field |
|---|---|
| A | chat_id |
| B | sex (`male`/`female`) |
| C | age |
| D | height_cm |
| E | weight_kg |
| F | activity (`sedentary/light/moderate/active/very_active`) |
| G | goal (`lose/maintain/gain`) |
| H | target_calories |
| I | target_protein_g |
| J | target_carbs_g |
| K | target_fat_g |
| L | updated_at |

> Daily totals are **computed in code** by summing `food log` rows where
> `date == today AND chat_id == user` — so there is **no** manually maintained
> insights tab (an improvement over the expense bot: less setup friction).

---

## The calorie math (best-practice standard)

**BMR — Mifflin-St Jeor** (current gold standard, more accurate than Harris-Benedict):
- Male:   `BMR = 10·kg + 6.25·cm − 5·age + 5`
- Female: `BMR = 10·kg + 6.25·cm − 5·age − 161`

**TDEE = BMR × activity factor:**
`sedentary 1.2 · light 1.375 · moderate 1.55 · active 1.725 · very_active 1.9`

**Goal adjustment (target calories):**
`lose = TDEE − 500` (~0.5 kg/week) · `maintain = TDEE` · `gain = TDEE + 350`

**Macro targets:**
- Protein: `1.8 g per kg bodyweight` (supports goals; clearer than a flat %)
- Fat: `25% of target calories ÷ 9`
- Carbs: remaining calories `÷ 4`

Computed once on `/profile`, stored in the `profile` tab, and editable there.

---

## Gemini schemas

**Food parse** (`callGeminiFood_`), constrained output:
```
{ meal: STRING(enum breakfast/lunch/dinner/snack),
  description: STRING,
  calories: NUMBER, protein_g: NUMBER, carbs_g: NUMBER, fat_g: NUMBER }
```
Prompt rules: estimate the total plate; infer meal from time-of-day / caption
if not stated; numbers not strings; note when a portion assumption was made.

**Profile parse** (`callGeminiProfile_`), constrained output:
```
{ sex: STRING(enum), age: NUMBER, height_cm: NUMBER,
  weight_kg: NUMBER, activity: STRING(enum), goal: STRING(enum) }
```
Handles unit hints (ft/in → cm, lb → kg). Missing fields → the bot asks the
user to resend with the missing piece (no partial profile saved).

---

## Commands & replies

- **`/profile male 30 175cm 72kg moderately active, lose weight`** →
  parse → compute → save → reply:
  ```
  ✅ Profile saved
  Daily target: 2087 kcal · P 130g · C 261g · F 58g
  (Mifflin-St Jeor, moderate activity, lose ~0.5kg/week)
  ```
- **`/profile`** (no args) → show current profile + targets.
- **food text / photo** → append + reply confirmation + today's status:
  ```
  ✅ Lunch · Chicken rice bowl
  520 kcal · P 42g · C 55g · F 12g

  📊 Today 2026-06-17
  Calories ███████░░░ 1450/2087
  Protein  ████████░░   98/ 130
  Carbs    █████░░░░░  120/ 261
  Fat      ███████░░░   40/  58
  ```
  (Reuse `makeBar_` and the `formatSummaryTable_`-style monospace `<pre>` rendering.)
- **`/today`** (analogous to the expense bot's `/summary`) → status bars + a
  💬 Gemini nutrition nudge (e.g. "You've got 600 kcal and 32g protein left — a
  chicken + yogurt snack would round out the day nicely.").
- No profile yet → any food log still records, but the bot prompts the user to
  run `/profile` so targets can be shown.

---

## File-level build plan (for the implementation phase)

Mirror the expense repo's `src/` layout:
- `Code.gs` — `processUpdate_` router (profile cmd / today cmd / food), dedup,
  allowlist, confirmation + bar formatting helpers.
- `Gemini.gs` — `callGeminiFood_`, `callGeminiProfile_`, `callGeminiNudge_`.
- `Sheet.gs` — `appendFood_`, `readProfile_(chatId)`, `writeProfile_`,
  `computeTodayTotals_(chatId)`.
- `Targets.gs` — Mifflin-St Jeor BMR / TDEE / macro math (pure, unit-testable functions).
- `Telegram.gs` — `sendMessage_`, `downloadTelegramFile_` (verbatim reuse).
- `Poller.gs` — `pollUpdates` (verbatim reuse).
- `Setup.gs` — `enablePolling`, `getWebhookInfo`, `testParseFood`, `testProfile`.
- `appsscript.json` — same OAuth scopes + V8 runtime.
- `README.md` — zero-knowledge setup guide adapted from the expense bot
  (BotFather → chat ID → Gemini key → paste files → Script Properties:
  `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `ALLOWED_CHAT_ID`, `SHEET_NAME`).

## Free-tier headroom

1 Gemini call per food log + 1 per `/today`; ~1440 polling fetches/day plus
2–3 fetches per food entry. Comfortably under Apps Script limits (90 min/day,
20k `UrlFetch`/day) and the Gemini 2.5 Flash free tier for a small group.

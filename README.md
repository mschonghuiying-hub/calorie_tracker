# calorie_tracker

A serverless calorie + macro tracking Telegram bot. Tell it your stats once and
it computes your daily calorie/macro targets; then send a food photo or a short
description and it estimates the calories, protein, carbs, and fat, logs a row
to your Google Sheet, and replies with your progress for the day.

- Apps Script polls Telegram → Gemini → Google Sheet. **No server, no VM, no
  cron host** — runs entirely on Google's free tier.
- **Multi-user**: several people can share one bot + sheet; each gets their own
  profile and targets (rows are keyed by Telegram `chat_id`).
- Calorie targets use the **Mifflin-St Jeor** equation (BMR) × an activity
  factor (TDEE), adjusted for your goal. See `src/Targets.gs`.

> ⚠️ Photo-based macro estimates are approximate — portion size is the main
> source of error. Great for tracking trends; for accuracy add a caption like
> "200g cooked", or edit the row in the sheet.

## How it works

```
Apps Script (1-min trigger) ──getUpdates──▶ Telegram
        │
        ├─ /profile <text> ─▶ Gemini parse ─▶ Mifflin-St Jeor ─▶ save targets
        ├─ food text/photo ─▶ Gemini macros ─▶ append row ─▶ confirm + status
        └─ /today ──────────▶ sum today vs targets ─▶ table + AI nudge
```

Why polling instead of a webhook? Apps Script `/exec` URLs return a 302 redirect
that Telegram's webhook won't follow, so it retries forever and burns quota.
Long-polling inverts the flow (we call Telegram), at the cost of up to ~60 s
reply latency — fine for a food logger.

## What the bot does

**Set your targets once:**
```
/profile male 30 175cm 72kg moderately active lose weight
→ ✅ Profile saved
  Daily target: 2087 kcal
  Protein 130g · Carbs 261g · Fat 58g
```
It understands natural phrasing and units (e.g. `5ft9 160lb`, `gym 5x/week`,
`cutting`). Run `/profile` with no text to see your current targets.

**Log food** — send a photo (optionally captioned) or text like `chicken rice
bowl with a fried egg`:
```
✅ Lunch · Chicken rice bowl
520 kcal · P 42g · C 55g · F 12g

📊 Today 2026-06-17
Calories ███████░░░ 1450/2087
Protein  ████████░░   98/ 130
Carbs    █████░░░░░  120/ 261
Fat      ███████░░░   40/  58
```

**Check the day** — `/today` (or `/status`) shows the table plus a 💬 AI nudge
about what's left and what to eat.

---

## Setup (zero-knowledge, ~15 min, all in a browser)

### 1. Create a Telegram bot
1. In Telegram, message **@BotFather** → `/newbot`.
2. Pick a name and a username ending in `bot`.
3. Save the **HTTP API token** it gives you (`12345:ABC...`).

### 2. Get your chat ID
1. Send any message (e.g. "hi") to your new bot.
2. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser.
3. Find `"chat":{"id":123456789,...}` — that number is your chat ID.

### 3. Get a Gemini API key
1. Open [aistudio.google.com](https://aistudio.google.com/) → **Get API key** →
   **Create API key**. Copy it.

### 4. Create the sheet + open Apps Script
1. Create a new Google Sheet (any name). The bot creates the `food log` and
   `profile` tabs automatically on first use — you don't add them manually.
2. **Extensions → Apps Script**. Rename the project to `calorie_tracker`.

### 5. Paste the code
In the Apps Script editor, recreate each file from this repo's `src/` folder:
- For each of `Code.gs`, `Telegram.gs`, `Gemini.gs`, `Sheet.gs`, `Targets.gs`,
  `Setup.gs`, `Poller.gs`: click **+ → Script**, name it exactly (e.g.
  `Targets`), and paste the file contents. Paste `Code.gs` into the existing one.
- **Project Settings** (gear) → check **"Show appsscript.json manifest file"**.
  Open `appsscript.json` and replace it with this repo's version. Save.

### 6. Add your secrets
**Project Settings → Script Properties → Add script property:**

| Property             | Value |
| -------------------- | ----- |
| `TELEGRAM_BOT_TOKEN` | token from step 1 |
| `GEMINI_API_KEY`     | key from step 3 |
| `ALLOWED_CHAT_ID`    | your chat ID from step 2 (comma-separate to allow several people, e.g. `123,456`) |

Optional: `SHEET_NAME` (food tab, default `food log`), `PROFILE_SHEET_NAME`
(default `profile`).

### 7. Smoke-test before touching Telegram
1. Editor → open `Setup.gs`, choose **`testProfile`** from the function
   dropdown → **Run**. Approve the permission prompts on first run.
2. View → **Logs**: you should see a parsed profile and computed targets.
3. Then run **`testParseFood`** → it logs a test row (chat_id `TEST`) and prints
   today's totals. Delete that row from the `food log` tab afterward.

If these fail, fix them here first — Telegram just sits on top.

### 8. Switch the bot to long-polling
1. Open `Setup.gs`, run **`enablePolling`**. Logs should show `{"ok":true,...}`.
2. Click the **clock icon (Triggers)** → **+ Add Trigger**:
   - Function: `pollUpdates` · Event source: **Time-driven** ·
     **Minutes timer → Every 1 minute**. Save.
3. Sanity check: run `getWebhookInfo` — the `url` field should be empty.

### 9. Try it from Telegram
- `/profile male 30 175cm 72kg moderately active lose weight` → targets reply.
- Send `chicken rice bowl` or a food photo → row appears + status table (~60 s).
- `/today` → table + AI nudge.
- A chat ID not in `ALLOWED_CHAT_ID` gets ignored.

### Adding another user
Have them message the bot, find their chat ID via `getUpdates`, and append it to
`ALLOWED_CHAT_ID` (comma-separated). No redeploy needed — the next poll picks it
up. They run their own `/profile`; their rows and targets stay separate.

---

## Customizing
- **Targets math** — edit `src/Targets.gs` (activity factors, goal deltas,
  `1.8 g/kg` protein, `25%` fat share). It also guards against extreme targets:
  the deficit is capped at 25% of TDEE and calories never drop below a floor
  (1200 women / 1500 men) — adjust `MAX_DEFICIT_FRACTION_` / `MIN_CALORIES_`.
- **Meals / estimation behavior** — edit the prompt in `callGeminiFood_`
  (`src/Gemini.gs`).
- **Model** — `GEMINI_MODEL_` in `src/Gemini.gs` (`gemini-2.5-flash`).

## Troubleshooting
- **No reply.** Apps Script → **Executions** → check `pollUpdates` runs every
  minute; click a failed run for the error.
- **Runs but does nothing.** `getWebhookInfo`; if `url` is set, run
  `enablePolling` again to clear the webhook.
- **Message ignored.** Your `chat.id` isn't in `ALLOWED_CHAT_ID` (verify via
  `getUpdates`).
- **Gemini 400/403.** Bad/disabled key or quota — regenerate in AI Studio.
- **No status table after logging.** You haven't run `/profile` yet.

## Free-tier limits
Apps Script: 90 min/day runtime, 20k `UrlFetch`/day. Polling at 1/min is ~1440
fetches/day baseline + 2–3 per food entry; one Gemini call per food log and per
`/today`. Comfortably under both, plus the Gemini 2.5 Flash free tier, for
personal / small-group use. Telegram Bot API is free.

# TRMNL Apps

This repository contains four TRMNL webhook apps and one terminal monitoring app:

1. **Next Lunch (SAGE Dining)** - fetches St. Mark's lunch data and formats it for TRMNL.
2. **Arborism Exam Fact** - rotates one arborism study fact per day for exam prep.
3. **WTA Tournament Scores** - shows the most important active WTA tournament with live score lines and upcoming match times.
4. **Transit Delays (CLI + TRMNL)** - tracks live delays and reasons for NYC Subway and London Tube.

## Repo Structure

```
.
├─ package.json
├─ package-lock.json
├─ .gitignore
├─ .env.example
├─ README.md
├─ data/
│  └─ arborism_facts.json
├─ trmnl_markup/
│  ├─ full.liquid
│  ├─ arborism_exam_fact.liquid
│  ├─ wta_scores.liquid
│  └─ transit_delays.liquid
├─ scripts/
│  ├─ push_next_lunch.mjs
│  ├─ push_arborism_fact.mjs
│  ├─ push_wta_scores.mjs
│  ├─ transit_delays.mjs
│  └─ push_transit_delays.mjs
└─ .github/
   └─ workflows/
      ├─ update-trmnl-lunch.yml
      ├─ update-trmnl-arborism.yml
      ├─ update-trmnl-wta-scores.yml
      └─ update-trmnl-transit.yml
```

## Webhook Secret Naming

Use plugin-specific names so all apps can live in the same repo safely:

- `TRMNL_WEBHOOK_URL_LUNCH_SM` for the lunch plugin.
- `TRMNL_WEBHOOK_URL_ARBORISM` for the arborism plugin.
- `TRMNL_WEBHOOK_URL_WTA_SCORES` for the WTA scores plugin.
- `TRMNL_WEBHOOK_URL_TRANSIT` for the transit delays plugin.

## Local Env Setup

1. Copy the example file:
   - `cp .env.example .env.local`
2. Fill in your webhook values in `.env.local`.
3. Load env vars before running scripts:
   - `set -a; source .env.local; set +a`

## App 1: Next Lunch (SAGE Dining)

### What It Does

- Scrapes SAGE JSON via Playwright.
- Finds the first lunch starting tomorrow (`America/Chicago` by default).
- Groups output by food categories (for example `Entrees`, `Soups`, `Deli`) instead of branded station names.
- Sends `status=ok` or `status=error` payloads to TRMNL.
- Shrinks payload automatically to stay below webhook size limits.

### TRMNL Setup

1. In TRMNL, create a **Private Plugin** using the **Webhook** strategy.
2. Save the plugin and copy its webhook URL.
3. Open `trmnl_markup/full.liquid` and paste it into your plugin **Full** tab.
4. Save the plugin.

### GitHub Setup

1. Push this repo to GitHub.
2. In your GitHub repo, go to `Settings -> Secrets and variables -> Actions`.
3. Add secret:
   - `TRMNL_WEBHOOK_URL_LUNCH_SM` = your lunch plugin webhook URL.
4. Run the workflow manually once from the `Actions` tab:
   - `Update TRMNL - Next Lunch`

### Local Run

1. Install dependencies:
   - `npm install`
2. Install Playwright browser:
   - `npx playwright install --with-deps chromium`
3. Validate script syntax:
   - `npm run check`
4. Dry run (prints payload only):
   - `npm run update:dry`
5. Real webhook run:
   - `TRMNL_WEBHOOK_URL_LUNCH_SM="https://trmnl.com/api/custom_plugins/<id>" npm run update`

### Optional Local Overrides

- `TIMEZONE` (default `America/Chicago`)
- `MENU_URL` (default St. Mark's SAGE URL)
- `MEAL_REGEX` (default `\\blunch\\b`)
- `START_DATE_ISO` (override start date; default behavior starts from tomorrow)

### Scheduled Workflow

`/.github/workflows/update-trmnl-lunch.yml`

- Manual: `workflow_dispatch`
- Scheduled:
  - `0 18 * * *`
  - `0 19 * * *`
- Uses concurrency group `trmnl-next-lunch` to avoid overlap.
- Gate logic ensures only the trigger that falls at `1:00 PM America/Chicago` runs the update.

## App 2: Arborism Exam Fact

### What It Does

- Reads a local fact bank from `data/arborism_facts.json`.
- Picks one deterministic fact per local date (so the fact remains stable all day).
- Sends compact `merge_variables` to a TRMNL webhook plugin.
- Includes topic, exam tip, and memory hook on the card.

### TRMNL Setup

1. Open your existing arborism webhook plugin in TRMNL.
2. Open `trmnl_markup/arborism_exam_fact.liquid` and paste it into your plugin **Full** tab.
3. Save the plugin (same webhook URL can stay in place).

### GitHub Setup

1. In your GitHub repo, go to `Settings -> Secrets and variables -> Actions`.
2. Add secret:
   - `TRMNL_WEBHOOK_URL_ARBORISM` = your arborism plugin webhook URL.
3. Run the workflow manually once from the `Actions` tab:
   - `Update TRMNL - Arborism Exam Fact`

### Local Run

1. Validate script syntax:
   - `npm run arborism:check`
2. Dry run (prints payload only):
   - `npm run arborism:update:dry`
3. Real webhook run:
   - `TRMNL_WEBHOOK_URL_ARBORISM="https://trmnl.com/api/custom_plugins/<id>" npm run arborism:update`

### Optional Local Overrides

- `TIMEZONE` (default `America/Chicago`)
- `FACTS_FILE` (path to JSON fact bank; default `../data/arborism_facts.json` from script directory)
- `FACT_OFFSET` (integer offset to shift daily rotation forward/backward)

### Scheduled Workflow

`/.github/workflows/update-trmnl-arborism.yml`

- Manual: `workflow_dispatch`
- Scheduled:
  - `0 18 * * *`
  - `0 19 * * *`
- Uses concurrency group `trmnl-arborism-fact` to avoid overlap.
- Gate logic ensures only the trigger that falls at `1:00 PM America/Chicago` runs the update.

## App 3: WTA Tournament Scores

### What It Does

- Pulls tournaments and match data from the public WTA tennis API.
- Selects the most important tournament currently underway (for example WTA 1000 over WTA 125).
- Shows live/in-progress score lines first, then recent finals.
- Shows the next few upcoming match times in your local timezone.
- Sends compact `merge_variables` to a TRMNL webhook plugin.

### TRMNL Setup

1. In TRMNL, create a **Private Plugin** using the **Webhook** strategy.
2. Save the plugin and copy its webhook URL.
3. Open `trmnl_markup/wta_scores.liquid` and paste it into your plugin **Full** tab.
4. Save the plugin.

### GitHub Setup

1. In your GitHub repo, go to `Settings -> Secrets and variables -> Actions`.
2. Add secret:
   - `TRMNL_WEBHOOK_URL_WTA_SCORES` = your WTA scores plugin webhook URL.
3. Run the workflow manually once from the `Actions` tab:
   - `Update TRMNL - WTA Tournament Scores`

### Local Run

1. Validate script syntax:
   - `npm run wta:check`
2. Dry run (prints payload only):
   - `npm run wta:update:dry`
3. Real webhook run:
   - `TRMNL_WEBHOOK_URL_WTA_SCORES="https://trmnl.com/api/custom_plugins/<id>" npm run wta:update`

### Optional Local Overrides

- `TIMEZONE` (default `America/Chicago`)
- `WTA_TENNIS_API_BASE` (default `https://api.wtatennis.com/tennis`)
- `WTA_LOOKBACK_DAYS` (default `1`)
- `WTA_LOOKAHEAD_DAYS` (default `6`)
- `WTA_MAX_SCORE_MATCHES` (default `4`)
- `WTA_MAX_NEXT_MATCHES` (default `6`)

### Scheduled Workflow

`/.github/workflows/update-trmnl-wta-scores.yml`

- Manual: `workflow_dispatch`
- Scheduled:
  - `*/30 * * * *`
- Uses concurrency group `trmnl-wta-scores` to avoid overlap.

## App 4: Transit Delays (NYC Subway + London Tube)

### What It Does

- Pulls live alert/status data from:
  - MTA GTFS-RT alerts feed (NYC Subway)
  - TfL line status endpoint (London Tube)
- Shows only active delay/disruption entries.
- Prints the reason text for each delay when provided by the upstream feed.
- Supports both:
  - terminal CLI view
  - TRMNL webhook push mode

### TRMNL Setup

1. In TRMNL, create a **Private Plugin** using the **Webhook** strategy.
2. Save the plugin and copy its webhook URL.
3. Open `trmnl_markup/transit_delays.liquid` and paste it into your plugin **Full** tab.
4. Save the plugin.

### GitHub Setup

1. In your GitHub repo, go to `Settings -> Secrets and variables -> Actions`.
2. Add secret:
   - `TRMNL_WEBHOOK_URL_TRANSIT` = your transit plugin webhook URL.
3. Run the workflow manually once from the `Actions` tab:
   - `Update TRMNL - Transit Delays`

### Local Run (CLI)

1. Validate CLI syntax:
   - `npm run transit:delays:check`
2. Run once in terminal:
   - `npm run transit:delays`
3. Watch mode:
   - `npm run transit:delays:watch`

### Local Run (TRMNL Webhook Push)

1. Validate push script syntax:
   - `npm run transit:push:check`
2. Dry run (prints payload only):
   - `npm run transit:push:dry`
3. Real webhook run:
   - `TRMNL_WEBHOOK_URL_TRANSIT="https://trmnl.com/api/custom_plugins/<id>" npm run transit:push`

### CLI Options

- `--watch` keep refreshing output
- `--interval <seconds>` refresh interval in watch mode (default `120`)
- `--json` emit JSON output
- `--include-planned` include planned-work subway alerts from MTA
- `--help` show usage

### Optional Env Overrides

- `MTA_ALERTS_URL` (override NYC alerts endpoint)
- `TFL_STATUS_URL` (override London status endpoint)
- `FETCH_TIMEOUT_MS` (HTTP timeout for each request)
- `TRANSIT_INCLUDE_PLANNED` (`true` to include planned-work rows)
- `TRANSIT_MAX_NYC_ITEMS` (default `3`)
- `TRANSIT_MAX_LONDON_ITEMS` (default `4`)

### Scheduled Workflow

`/.github/workflows/update-trmnl-transit.yml`

- Manual: `workflow_dispatch`
- Scheduled:
  - `*/15 * * * *`
- Uses concurrency group `trmnl-transit-delays` to avoid overlap.

## Troubleshooting

### Next Lunch

- `Captured 0 JSON responses`
  - The site may have changed, blocked headless, or timed out.
  - Re-run locally and inspect logs for `Best JSON candidate`.
- `Could not locate a next Lunch payload`
  - Data format likely changed.
  - Check `MEAL_REGEX` and inspect current JSON shape.
- Webhook returns non-2xx
  - Confirm `TRMNL_WEBHOOK_URL_LUNCH_SM` is correct and plugin is active.
- Payload too large
  - Script auto-compacts by reducing sections/items and truncating strings.
  - Check reported `Webhook payload bytes` in logs.

### Arborism Exam Fact

- `Facts file must contain a non-empty array`
  - Confirm `data/arborism_facts.json` exists and has at least one object.
- `Fact <n> is missing required field`
  - Each fact requires `topic`, `fact`, `exam_tip`, and `memory_hook`.
- Webhook returns non-2xx
  - Confirm `TRMNL_WEBHOOK_URL_ARBORISM` is correct and plugin is active.

### WTA Tournament Scores

- `No WTA tournaments returned for date range ...`
  - Date window may not include active events.
  - Increase `WTA_LOOKAHEAD_DAYS` and rerun.
- `No matches found for tournament ...`
  - API may have delayed score ingestion for that event.
  - Retry in a few minutes.
- Webhook returns non-2xx
  - Confirm `TRMNL_WEBHOOK_URL_WTA_SCORES` is correct and plugin is active.

### Transit Delays

- `Request failed via fetch and curl ...`
  - Confirm your network can reach MTA and TfL API hosts.
- Empty delay list
  - This is expected when both systems are reporting no current delays.
- Watch mode seems slow
  - Lower interval with `--interval`, for example `--interval 60`.
- Webhook returns non-2xx
  - Confirm `TRMNL_WEBHOOK_URL_TRANSIT` is correct and plugin is active.

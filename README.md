# TRMNL Apps

This repository contains two TRMNL webhook apps in one project:

1. **Next Lunch (SAGE Dining)** - fetches St. Mark's lunch data and formats it for TRMNL.
2. **Arborism Exam Fact** - rotates one arborism study fact per day for exam prep.

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
│  └─ arborism_exam_fact.liquid
├─ scripts/
│  ├─ push_next_lunch.mjs
│  └─ push_arborism_fact.mjs
└─ .github/
   └─ workflows/
      ├─ update-trmnl-lunch.yml
      └─ update-trmnl-arborism.yml
```

## Webhook Secret Naming

Use plugin-specific names so both apps can live in the same repo safely:

- `TRMNL_WEBHOOK_URL_LUNCH_SM` for the lunch plugin.
- `TRMNL_WEBHOOK_URL_ARBORISM` for the arborism plugin.

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

1. In TRMNL, create a **second Private Plugin** using the **Webhook** strategy.
2. Save the plugin and copy its webhook URL.
3. Open `trmnl_markup/arborism_exam_fact.liquid` and paste it into your plugin **Full** tab.
4. Save the plugin.

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
  - `0 12 * * *`
  - `0 13 * * *`
- Uses concurrency group `trmnl-arborism-fact` to avoid overlap.
- Gate logic ensures only the trigger that falls at `7:00 AM America/Chicago` runs the update.

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

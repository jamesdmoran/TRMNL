# TRMNL Next Lunch (SAGE Dining)

This project fetches St. Mark's SAGE Dining data, computes the next lunch, and posts compact `merge_variables` to your TRMNL webhook plugin.

## What It Does

- Scrapes SAGE JSON via Playwright.
- Finds the first lunch at or after today (`America/Chicago` by default).
- Groups output by food categories (for example `Entrees`, `Soups`, `Deli`) instead of branded station names.
- Sends `status=ok` or `status=error` payloads to TRMNL.
- Shrinks payload automatically to stay below webhook size limits.

## Repo Structure

```
.
├─ package.json
├─ package-lock.json
├─ .gitignore
├─ README.md
├─ trmnl_markup/
│  └─ full.liquid
├─ scripts/
│  └─ push_next_lunch.mjs
└─ .github/
   └─ workflows/
      └─ update-trmnl-lunch.yml
```

## TRMNL Setup

1. In TRMNL, create a **Private Plugin** using the **Webhook** strategy.
2. Save the plugin and copy its webhook URL.
3. Open `trmnl_markup/full.liquid` and paste it into your plugin **Full** tab.
4. Save the plugin.

## GitHub Setup

1. Push this repo to GitHub.
2. In your GitHub repo, go to `Settings -> Secrets and variables -> Actions`.
3. Add secret:
   - `TRMNL_WEBHOOK_URL` = your TRMNL webhook URL.
4. Run the workflow manually once from the `Actions` tab:
   - `Update TRMNL - Next Lunch`

## Local Run

1. Install dependencies:
   - `npm install`
2. Install Playwright browser:
   - `npx playwright install --with-deps chromium`
3. Validate script syntax:
   - `npm run check`
4. Dry run (prints payload only):
   - `npm run update:dry`
5. Real webhook run:
   - `TRMNL_WEBHOOK_URL="https://trmnl.com/api/custom_plugins/<id>" npm run update`

### Optional Local Overrides

- `TIMEZONE` (default `America/Chicago`)
- `MENU_URL` (default St. Mark's SAGE URL)
- `MEAL_REGEX` (default `\\blunch\\b`)
- `START_DATE_ISO` (for testing from a specific date, example `2026-02-09`)

## Scheduled Workflow

`/.github/workflows/update-trmnl-lunch.yml`

- Manual: `workflow_dispatch`
- Scheduled:
  - `15 12 * * *`
  - `15 13 * * *`
- Uses concurrency group `trmnl-next-lunch` to avoid overlap.

## Troubleshooting

- `Captured 0 JSON responses`
  - The site may have changed, blocked headless, or timed out.
  - Re-run locally and inspect logs for `Best JSON candidate`.
- `Could not locate a next Lunch payload`
  - Data format likely changed.
  - Check `MEAL_REGEX` and inspect current JSON shape.
- Webhook returns non-2xx
  - Confirm `TRMNL_WEBHOOK_URL` is correct and plugin is active.
- Payload too large
  - Script auto-compacts by reducing sections/items and truncating strings.
  - Check reported `Webhook payload bytes` in logs.

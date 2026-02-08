# TRMNL Sage Lunch Plugin

This project fetches the Sage Dining menu and posts the next available lunch to your TRMNL custom plugin webhook.

## GitHub setup

1. In GitHub, open `Settings` -> `Secrets and variables` -> `Actions`.
2. Add secret:
   - `TRMNL_WEBHOOK_URL`: your TRMNL custom plugin webhook URL.

## Scheduled workflow

- File: `.github/workflows/update-trmnl-lunch.yml`
- Triggers:
  - Daily schedule (`15 12 * * *`, UTC)
  - Manual run (`workflow_dispatch`)
- Job behavior:
  - Installs Node + Playwright Chromium
  - Scrapes the Sage menu JSON
  - Extracts the next lunch at/after today (`America/Chicago`)
  - Posts `merge_variables` to TRMNL

## Local run

1. Set env var in your shell:
   - `export TRMNL_WEBHOOK_URL="https://trmnl.com/api/custom_plugins/<your-id>"`
2. Install deps:
   - `npm install`
3. Install browser once:
   - `npx playwright install chromium`
4. Dry run (no webhook POST):
   - `DRY_RUN=true npm run update`
5. Real run (posts to TRMNL):
   - `npm run update`

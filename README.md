# TRMNL

This repository is set up to notify your TRMNL webhook from GitHub Actions whenever you push to `main`/`master`, or when you run the workflow manually.

## Setup

1. In GitHub, open `Settings` -> `Secrets and variables` -> `Actions`.
2. Add this secret:
   - `TRMNL_WEBHOOK_URL`: Your TRMNL webhook endpoint URL.
3. Optional secret:
   - `TRMNL_WEBHOOK_BEARER`: Bearer token if your webhook is protected.

## Workflow

- File: `.github/workflows/trmnl-webhook.yml`
- Triggers:
  - `push` to `main` or `master`
  - `workflow_dispatch` (manual run)
- Behavior:
  - Builds a JSON payload with repository, commit, actor, event, and run URL metadata.
  - Sends that payload to `TRMNL_WEBHOOK_URL`.

## Manual test

1. Open the `Actions` tab in GitHub.
2. Select `TRMNL Webhook`.
3. Click `Run workflow`.
4. Verify your TRMNL endpoint received the payload.

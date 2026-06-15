# Everest PeopleStrong Claims Sync Worker

Standalone Playwright service that logs into PeopleStrong, scrapes every
"Finance Manager Approval" reimbursement claim (header + expense heads + attachment files),
and stores structured rows + files in the shared Everest Supabase project. No UI — the Next.js
platform calls it and renders results. Scrape-only today; approve/reject is a planned extension.

## Endpoints (all except /health require header `X-Worker-Secret`)

- `GET /health` → `{ "status": "ok" }`
- `POST /sync-claims` body `{ "stageFilter"?: "Finance Manager Approval", "limit"?: number }` → `202 { "jobId" }`
- `GET /job/:id` → `{ "status", "progress", "results"?, "error"? }`

```bash
curl -s localhost:8080/health
curl -s -X POST localhost:8080/sync-claims \
  -H "X-Worker-Secret: $WORKER_SECRET" -H 'content-type: application/json' \
  -d '{"limit":5}'
curl -s localhost:8080/job/<jobId> -H "X-Worker-Secret: $WORKER_SECRET"
```

## Data model (Supabase)

`sync_jobs` (job status/progress/results) → `claims` (per employee) → `expense_heads` (14 fields) →
`attachments` (filename, storage_path, ocr_status='pending'). Files live in the private
`peoplestrong-claims` Storage bucket at `{run_id}/{employee_code}/{expense_head}/{filename}`.
Dedupe: claims unique on (run_id, employee_code); expense_heads on (claim_id, expense_head, bill_number);
attachments on (expense_head_id, filename).

## Local run

1. `npm install`
2. `npx playwright install chromium`
3. Apply the migration to the shared Supabase project and create the bucket:
   run `migrations/0001_peoplestrong_worker.sql` in the Supabase SQL editor (or via the platform repo's
   `node --env-file=.env.local supabase/migrate.mjs`), then confirm a private bucket `peoplestrong-claims`.
4. Fill the **login selectors** in `config/peoplestrong.yml` (the only true unknowns — `USERNAME_SELECTOR`,
   `PASSWORD_SELECTOR`, `LOGIN_BUTTON_SELECTOR`, `BASE_URL`, `LOGIN_URL`) by inspecting the live login page.
5. `cp .env.example .env` and fill secrets.
6. `npm run dev` then call the endpoints above. Set `HEADLESS=false` to watch the browser while debugging.

## Tests

`npm test` runs the vitest suite (parsing, retry, config, jobs, storage, server). The Playwright
modules are verified by a live smoke run (`POST /sync-claims` with `{"limit":1}` against the real portal).

## Render deploy

Push the repo; create a Render Web Service from `render.yaml` (Docker runtime, 1 GB disk mounted at
`/app/storage` for the persisted session + downloads). Set the 5 secrets
(`WORKER_SECRET`, `PEOPLESTRONG_USER`, `PEOPLESTRONG_PASS`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`) as
env vars in the dashboard. Health check path `/health`.

## How the new-tab + PrimeFaces AJAX handling works

The dashboard is an Angular SPA; clicking the Tasks icon opens a **new browser tab** rendered as
PrimeFaces/JSF. We capture it with `const [taskTab] = await Promise.all([context.waitForEvent('page'), click])`
and do all task work on `taskTab`. PrimeFaces uses AJAX partial page updates, so after every click we
**wait on a DOM marker** (e.g. the "Total Claimed Amount" label, the "Accounting Information" section, the
first task link) — never a blind timeout. Attachment clicks return session-bound files, so we download the
bytes immediately via the download event plus a `response` listener.

## Updating selectors when PeopleStrong changes its UI

All selectors live in `config/peoplestrong.yml`. Use **substring id selectors**
(`a[id*=ApproveRejectButton]`, `a[id*=tableId]`, `a[id*=headAttachmentsList]`) because PrimeFaces row
ids contain changing row numbers — never hardcode indices like `myTaskList:0`. If the claim-detail labels
change, update the label strings; field reads are centralised in `fieldValue()` in `src/claims.ts`.

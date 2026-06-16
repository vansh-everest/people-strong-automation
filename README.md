# Everest PeopleStrong Claims Sync Worker

Standalone Playwright service that logs into the Everest PeopleStrong portal, scrapes every
"Finance Manager Approval" reimbursement claim, and returns them as JSON. **No UI, no database** —
the Everest platform (`all-in-one-tool`) calls this worker, polls the job, and ingests the results
into its own Supabase (`reimbursement_rows`). Scrape-only today; approve/reject is a planned extension
(the detail page exposes APPROVE/REJECT/BACK).

## Endpoints (all except `/health` require header `X-Worker-Secret`)

- `GET /health` → `{ "status": "ok" }`
- `POST /sync-claims` body `{ "stageFilter"?: string, "limit"?: number }` → `202 { "jobId" }`
- `GET /job/:id` → `{ "status": "running"|"done"|"error", "processed", "total", "results"?, "error"? }`

`results` is a flat array of `ClaimRecord` (one entry **per expense head**, claim-level fields repeated),
matching the platform's `lib/reimbursement/types.ts`:

```jsonc
{
  "employee_code": "EF6069", "employee_name": "Nitish Balwant Hedavkar",
  "total_claimed_amount": 2040, "expense_head": "Local travel costs",
  "bill_period": "May 2026", "bill_number": "01", "bill_date": "May 16, 2026",
  "eligible_amount": 999999, "approval_amount": 2040, "claim_amount": 2040,
  "employee_comment": "…", "approver_comments": null,
  "attachment_filename": null, "attachment_url": null
}
```

## How the portal flow works (important)

1. **Login** is a classic HTML/JSF form at `everestfleet.peoplestrong.com` (`/altLogin.jsf`).
2. After login the landing app is a **Flutter/CanvasKit SPA** (`/oneweb/#/home`) — *not scrapable* (it
   paints to a canvas; the DOM is empty). We ignore it.
3. The scrapable **legacy PrimeFaces task app is `home.jsf`**, but it needs the JSF session established
   first. We open the **deeplink bridge** `secureSloginDeeplinkKeycloak.jsf` in a new tab, which hands the
   Keycloak session into the JSF app and redirects to `home.jsf?cid=<n>#/home`. (Opening `home.jsf?cid=N`
   directly, without the bridge, returns "Session Expired".)
4. On `home.jsf`: click the **Tasks** badge (an Angular widget) → the **"Reimbursement Claim Requests"**
   queue → a PrimeFaces table of task rows (`a[id*=ApproveRejectButton]`).
5. Click a row → the claim **detail** replaces the list (employee block, "Claim Detail" table of expense
   heads, "Total Claimed Amount"). Extract, then click **BACK** (`button[id*=cancel]`) to return to the
   list for the next row.

All waits are on DOM markers (PrimeFaces AJAX), never blind sleeps.

## Pagination & resilience

The queue is paginated (~14 rows/page). Opening a claim replaces the list and **BACK resets the paginator
to page 1**, so for every claim the worker re-navigates to its page (`gotoPage`) before opening it. A full
run walks all pages (verified live: 49 claims → 66 records across 4 pages). One bad/slow claim is logged
and skipped — it never aborts the job (the live portal occasionally times out a row click; a rare run may
return a slightly low count, so re-run if the total looks short).

## Known limitations / follow-ups

- **Attachments:** `attachment_filename` is captured when present; `attachment_url` is `null`. PrimeFaces
  attachment downloads are session-bound POSTs, not durable URLs — producing a durable URL needs a storage
  decision (e.g. upload bytes somewhere and return that URL).
- **start_date / end_date / payment_mode / vendor:** not columns in the Claim Detail table; left `null`
  unless they surface in the per-expense-head modal (follow-up).

## Local run

```bash
npm install
npx playwright install chromium
npm run build
cp .env.example .env     # fill PEOPLESTRONG_USER/PASS + WORKER_SECRET
HEADLESS=false node --env-file=.env dist/server.js
```

The code reads `process.env` directly; npm scripts do **not** auto-load `.env`, so run with
`node --env-file=.env` (or export the vars). `HEADLESS=false` lets you watch the browser.

```bash
curl -s localhost:8080/health
curl -s -X POST localhost:8080/sync-claims \
  -H "X-Worker-Secret: $WORKER_SECRET" -H 'content-type: application/json' -d '{"limit":2}'
curl -s localhost:8080/job/<jobId> -H "X-Worker-Secret: $WORKER_SECRET"   # poll until status=done
```

## Tests

`npm test` runs the vitest suite (config, parsing, retry, in-memory job store, server contract). The
Playwright scraping is verified by running a real `limit` sync against the portal.

## Render deploy

Deploys from `render.yaml` (Docker). Set `WORKER_SECRET`, `PEOPLESTRONG_USER`, `PEOPLESTRONG_PASS` in the
dashboard. The platform's `WORKER_URL` env var must point at this service's URL, and both sides must share
the same `WORKER_SECRET`.

## Updating selectors when PeopleStrong changes its UI

All selectors live in `config/peoplestrong.yml`. Use **substring id selectors**
(`a[id*=ApproveRejectButton]`, `a[id*=tableId]`) — PrimeFaces ids contain changing numbers. Field reads on
the detail page are centralised in `extractClaimRecords()` in `src/claims.ts` (it reads each table cell by
its `div.m-data-header` label and each form field by its `<dt><label>…</dt><dd>value</dd>` pair, so column
re-ordering is tolerated). Login selectors and the bridge URL are in the config's top section.

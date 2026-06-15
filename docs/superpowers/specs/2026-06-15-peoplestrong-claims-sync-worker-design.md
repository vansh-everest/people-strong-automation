# PeopleStrong Claims Sync Worker — Design

**Date:** 2026-06-15
**Repo:** `everest-peoplestrong-worker` (built in `/Users/vanshsood/Projects/everest/peoplestrong-tool`)
**Status:** Approved — ready for implementation plan

## Purpose

A standalone Playwright scrape service that logs into the PeopleStrong portal, scrapes every
"Finance Manager Approval" reimbursement claim end to end, downloads each attachment, and stores
structured results + files in Supabase. No UI. The Everest Next.js platform is the only caller and
displays the results. Scrape-only for now; approve/reject is deliberately deferred behind a clean seam.

## Stack

Node.js + TypeScript + Playwright (Chromium) + Express. Dockerfile + docker-compose. Supabase JS
client with the **service-role** key, server-side only. Deployed on **Render** via Docker.

## Architecture

- No UI. Every endpoint authed via an `X-Worker-Secret` header.
- Scraping is **async**: `POST /sync-claims` writes a `queued` `sync_jobs` row and returns `{ jobId }`
  immediately. The Playwright run executes in-process; progress/results/errors are written to the
  `sync_jobs` row. The platform polls `GET /job/:id`.
- **One job at a time.** Chromium is memory-heavy and the portal is a single authenticated session, so
  concurrent jobs would cause session contention. An in-process guard rejects/queues a second run while
  one is active.
- **Jobs are Supabase-backed**, not in-memory — Render free instances spin down/restart, so job state
  must survive process death and `GET /job/:id` must work across a redeploy.

## Endpoints

- `GET /health` → `{ status: "ok" }` (no auth).
- `POST /sync-claims` body `{ stageFilter?: "Finance Manager Approval", limit?: number }` → `{ jobId }` (async).
- `GET /job/:id` → `{ status: "queued"|"running"|"done"|"failed", progress, results?, error? }`.

## Modules (`src/`)

- **`config.ts`** — load `config/peoplestrong.yml` (URLs + selector map) and env secrets; validate at boot
  (fail fast if a required secret/selector is missing).
- **`session.ts`** — open `LOGIN_URL`, fill `USERNAME_SELECTOR`/`PASSWORD_SELECTOR`, click
  `LOGIN_BUTTON_SELECTOR`. Persist Playwright `storageState` to `storage/state.json`; reuse across runs;
  detect session expiry and re-login only when needed.
- **`navigation.ts`** — click the clickable ancestor of `span.mytasks_icon.iconsize-20`; handle the
  **new tab** via `Promise.all([context.waitForEvent('page'), click])`; open the
  "Reimbursement Claim Requests" queue; read `span.pending-counts`. Owns the shared
  **PrimeFaces-AJAX wait helpers** (wait on DOM markers, never blind `waitForTimeout`).
- **`claims.ts`** — loop task rows (`a[id*="ApproveRejectButton"]`); for each, first capture the row's
  employee name/code, then click and wait for the detail panel (DOM marker: the "Total Claimed Amount"
  label). Capture Total Claimed Amount + status. Loop expense heads (`a[id*="tableId"]`), extract the 14
  fields. Exposes the row locator + panel context so a future `actions.ts` can act without rework.
- **`attachments.ts`** — per attachment (`a[id*="headAttachmentsList"]`): capture filename (link text) and
  download bytes via `Promise.all([taskTab.waitForEvent('download'), click])` plus a
  `taskTab.on('response', …)` listener to grab bytes + response URL. Always download — PrimeFaces
  attachment URLs are session-bound and not reusable later.
- **`storage.ts`** — Supabase service-role client; upsert `claims`/`expense_heads`/`attachments` with
  dedupe keys; upload files to the `peoplestrong-claims` Storage bucket (record storage path); upload
  failure screenshots to `errors/`.
- **`jobs.ts`** — `sync_jobs` CRUD, status/progress transitions, in-process single-job queue guard.
- **`scrape.ts`** — orchestrates the full flow: retry-with-backoff (3×) per navigation step, per-task
  try/catch so one bad task never aborts the job, session-expiry → re-login → resume.
- **`server.ts`** — Express app, the 3 endpoints, `X-Worker-Secret` auth middleware.

## Concrete scrape flow

1. **Login** (config-driven): reuse persisted cookies; only re-login on expiry.
2. **Open Tasks** on the Angular dashboard via the clickable ancestor of `.mytasks_icon`.
3. **New tab**: capture with `context.waitForEvent('page')`; `await taskTab.waitForLoadState()`; all
   subsequent work on `taskTab` (PrimeFaces/JSF classic DOM).
4. **Open queue**: click `div.task-list-title` containing "Reimbursement Claim Requests"; read
   `span.pending-counts` for progress total.
5. **Loop tasks**: for each `a[id*="ApproveRejectButton"]` (text "Finance Manager Approval") capture
   employee name/code first, then click; wait for the AJAX partial update by waiting on the
   "Total Claimed Amount" label DOM marker.
6. **Claim header**: read Total Claimed Amount (value adjacent to the "Total Claimed Amount:" label) and
   status "Pending for Finance Manager Approval".
7. **Loop expense heads**: each `a[id*="tableId"]`; wait for the "Reimbursement Claim" /
   "Accounting Information" section; extract Expense Head, Expense Category, Bill Period, Bill Number,
   Start Date, End Date, Bill Date, Payment Mode, Vendor, Eligible Amount, Approval Amount, Claim Amount,
   Employee Comment, Approver Comments.
8. **Attachments**: per `a[id*="headAttachmentsList"]` capture filename + download bytes.
9. **Store** in Supabase + upload files; dedupe by (employee_code, expense_head, bill_number/filename).
10. Put all records in the job's `results`.

## Data model (Supabase, same project `hbspmyossvwiueshvqjp`, RLS on, no public policies)

- **`sync_jobs`**: `id` (uuid pk), `status` (queued|running|done|failed), `progress` (jsonb:
  `{ processed, total, currentEmployee }`), `results` (jsonb), `error` (text), `stage_filter` (text),
  `limit` (int), `created_at`, `updated_at`.
- **`claims`**: `id` (uuid pk), `run_id` (= job id), `employee_code`, `employee_name`,
  `total_claimed_amount`, `status`, `scraped_at`. Unique (`run_id`, `employee_code`).
- **`expense_heads`**: `id` (uuid pk), `claim_id` (fk → claims), `expense_head`, `expense_category`,
  `bill_period`, `bill_number`, `start_date`, `end_date`, `bill_date`, `payment_mode`, `vendor`,
  `eligible_amount`, `approval_amount`, `claim_amount`, `employee_comment`, `approver_comments`.
  Unique (`claim_id`, `expense_head`, `bill_number`).
- **`attachments`**: `id` (uuid pk), `expense_head_id` (fk → expense_heads), `filename`, `storage_path`,
  `source_response_url`, `ocr_status` default `'pending'`. Unique (`expense_head_id`, `filename`).
- **Storage bucket** `peoplestrong-claims` (private): files at
  `{run_id}/{employee_code}/{expense_head}/{filename}`; error screenshots under `errors/{job_id}/`.

RLS enabled with no public policies — service-role bypasses RLS. All reads/writes are server-side
(worker via service key; platform via its own service-role client, which also mints durable signed URLs).
The worker repo owns a standalone migration SQL file; it is applied to the shared platform project.

## Resilience & logging

- Retry each navigation step 3× with backoff.
- Screenshot-on-failure to `storage/errors/`, then upload to the bucket.
- Per-task try/catch records the error into that task's `results[]` entry so the job completes partial
  rather than aborting.
- All waits are on DOM markers (PrimeFaces AJAX) — no blind sleeps.
- On session expiry → re-login → resume the loop.

## Config (the only true unknowns)

`config/peoplestrong.yml`:
- Fill from the live login page: `BASE_URL`, `LOGIN_URL`, `USERNAME_SELECTOR`, `PASSWORD_SELECTOR`,
  `LOGIN_BUTTON_SELECTOR` (left as placeholders).
- Pre-filled, override-able: `TASKS_ICON: ".mytasks_icon"`,
  `QUEUE_TITLE_TEXT: "Reimbursement Claim Requests"`, `TASK_LINK: "a[id*=ApproveRejectButton]"`,
  `EXPENSE_HEAD_LINK: "a[id*=tableId]"`, `ATTACHMENT_LINK: "a[id*=headAttachmentsList]"`,
  `TOTAL_CLAIMED_LABEL: "Total Claimed Amount:"`.

## Secrets (Render env vars, never in repo/client)

`WORKER_SECRET`, `PEOPLESTRONG_USER`, `PEOPLESTRONG_PASS`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

## Extensibility seam — approve/reject (later)

`claims.ts` exposes the row's `ApproveRejectButton` locator and the detail-panel context. The scrape path
only reads. A future `actions.ts` plugs into the same per-task loop to click approve/reject — no change to
`session.ts`/`navigation.ts`.

## Deliverables

`src/` (session, navigation, claims, attachments, storage, jobs, scrape, server, config),
`config/peoplestrong.yml`, `storage/`, a Supabase migration SQL, Dockerfile, docker-compose.yml, README
(local run, Render deploy, the new-tab + PrimeFaces-AJAX handling, and how to update selectors when
PeopleStrong changes its UI).

## Out of scope (YAGNI)

- Approve/reject actions (deferred, seam left).
- OCR of attachments (`ocr_status` stored as `'pending'` only).
- Any UI in this repo (the platform renders results).
- Concurrent/multiple simultaneous jobs.

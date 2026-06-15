# PeopleStrong Claims Sync Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone Node + TypeScript + Playwright Express service that logs into PeopleStrong, scrapes every "Finance Manager Approval" reimbursement claim (header + expense heads + attachment files), and stores structured rows + files in the shared Everest Supabase project, exposed via 3 authed HTTP endpoints with async Supabase-backed jobs.

**Architecture:** No UI. `POST /sync-claims` writes a `queued` `sync_jobs` row and returns `{ jobId }`; an in-process single-job runner executes the Playwright flow and writes progress/results/errors back to that row; the platform polls `GET /job/:id`. Pure logic (config, parsing, dedupe keys, job-state, auth middleware) is unit-tested with vitest; Supabase access is dependency-injected so it can be mocked; the Playwright modules are structured for isolation and verified by a documented live smoke run. Scrape-only now, with a clean seam for approve/reject later.

**Tech Stack:** Node 20, TypeScript (ESM), Express, Playwright (Chromium), @supabase/supabase-js, js-yaml, zod, vitest, supertest. Docker + docker-compose, deploy on Render.

---

## File Structure

```
peoplestrong-tool/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── Dockerfile
├── docker-compose.yml
├── render.yaml
├── .dockerignore
├── .env.example
├── README.md
├── config/
│   └── peoplestrong.yml          # URLs + selector map (login selectors are placeholders)
├── migrations/
│   └── 0001_peoplestrong_worker.sql
├── src/
│   ├── types.ts                  # shared interfaces (Claim, ExpenseHead, Attachment, Job, Progress)
│   ├── config.ts                 # load + zod-validate yaml & env secrets
│   ├── logger.ts                 # tiny structured logger
│   ├── util/
│   │   ├── parse.ts              # parseAmount, dedupe-key builders, storage-path builder
│   │   └── retry.ts              # withRetry(fn, attempts, baseDelayMs)
│   ├── supabase.ts               # createSupabase() service-role client factory
│   ├── jobs.ts                   # sync_jobs CRUD + single-job in-process queue guard
│   ├── storage.ts                # upsert claims/expense_heads/attachments + file/screenshot upload
│   ├── session.ts                # login + storageState persistence + expiry detection
│   ├── navigation.ts             # tasks icon → new tab → queue; PrimeFaces-AJAX wait helpers
│   ├── claims.ts                 # loop tasks, extract header + 14 expense fields
│   ├── attachments.ts            # capture filename + download bytes
│   ├── scrape.ts                 # orchestrator: retry, per-task try/catch, resume on expiry
│   └── server.ts                 # express app, 3 endpoints, X-Worker-Secret middleware
└── tests/
    ├── parse.test.ts
    ├── retry.test.ts
    ├── config.test.ts
    ├── jobs.test.ts
    ├── storage.test.ts
    └── server.test.ts
```

**Design notes that lock decisions:**
- `storage.ts` and `jobs.ts` receive a `SupabaseClient` as a constructor/argument (dependency injection) so tests inject a mock; production code calls `createSupabase()` once in `server.ts` and passes it down.
- Playwright modules (`session/navigation/claims/attachments`) take a `Page`/`BrowserContext` argument — never create their own browser — so `scrape.ts` owns lifecycle and the modules stay individually reasoned about.
- All Supabase writes go through `storage.ts`; all DOM reads go through the four Playwright modules. No module reaches across that line.

---

## Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.dockerignore`, `.env.example`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "everest-peoplestrong-worker",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "express": "^4.21.0",
    "js-yaml": "^4.1.0",
    "playwright": "^1.47.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^20.14.0",
    "@types/supertest": "^6.0.2",
    "supertest": "^7.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.5.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `.dockerignore`**

```
node_modules
dist
storage
.env
.env.local
*.log
.git
```

- [ ] **Step 5: Create `.env.example`**

```
WORKER_SECRET=change-me
PEOPLESTRONG_USER=
PEOPLESTRONG_PASS=
SUPABASE_URL=https://hbspmyossvwiueshvqjp.supabase.co
SUPABASE_SERVICE_KEY=
PORT=8080
STORAGE_DIR=./storage
CONFIG_PATH=./config/peoplestrong.yml
HEADLESS=true
```

- [ ] **Step 6: Install and verify**

Run: `cd /Users/vanshsood/Projects/everest/peoplestrong-tool && npm install`
Expected: completes, creates `node_modules` and `package-lock.json`.

Run: `npx playwright install chromium`
Expected: downloads Chromium browser.

- [ ] **Step 7: Commit**

```bash
cd /Users/vanshsood/Projects/everest/peoplestrong-tool
git add package.json package-lock.json tsconfig.json vitest.config.ts .dockerignore .env.example
git commit -m "chore: scaffold worker project (ts, express, playwright, vitest)"
```

---

## Task 2: Shared types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```ts
export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Progress {
  processed: number;
  total: number;
  currentEmployee: string | null;
}

export interface Attachment {
  filename: string;
  storagePath: string;
  sourceResponseUrl: string | null;
  ocrStatus: "pending";
}

export interface ExpenseHead {
  expenseHead: string;
  expenseCategory: string | null;
  billPeriod: string | null;
  billNumber: string | null;
  startDate: string | null;
  endDate: string | null;
  billDate: string | null;
  paymentMode: string | null;
  vendor: string | null;
  eligibleAmount: number | null;
  approvalAmount: number | null;
  claimAmount: number | null;
  employeeComment: string | null;
  approverComments: string | null;
  attachments: Attachment[];
}

export interface Claim {
  employeeCode: string;
  employeeName: string;
  totalClaimedAmount: number | null;
  status: string | null;
  expenseHeads: ExpenseHead[];
  error?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  progress: Progress;
  results: Claim[] | null;
  error: string | null;
  stageFilter: string | null;
  limit: number | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: shared domain types"
```

---

## Task 3: Parsing & key utilities (TDD)

**Files:**
- Create: `src/util/parse.ts`
- Test: `tests/parse.test.ts`

- [ ] **Step 1: Write the failing test `tests/parse.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import {
  parseAmount,
  claimKey,
  expenseHeadKey,
  attachmentKey,
  storagePath,
  slugSegment,
} from "../src/util/parse.js";

describe("parseAmount", () => {
  it("parses rupee-formatted strings", () => {
    expect(parseAmount("₹ 1,234.50")).toBe(1234.5);
    expect(parseAmount("Rs. 1,000")).toBe(1000);
    expect(parseAmount("2,50,000.00")).toBe(250000);
    expect(parseAmount("450")).toBe(450);
  });
  it("returns null for empty / non-numeric", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("  -  ")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("N/A")).toBeNull();
  });
});

describe("dedupe keys", () => {
  it("claimKey combines run + employee", () => {
    expect(claimKey("job1", "E123")).toBe("job1::E123");
  });
  it("expenseHeadKey combines claim + head + bill", () => {
    expect(expenseHeadKey("c1", "Miscellaneous", "B-9")).toBe("c1::Miscellaneous::B-9");
    expect(expenseHeadKey("c1", "Misc", null)).toBe("c1::Misc::");
  });
  it("attachmentKey combines expenseHead + filename", () => {
    expect(attachmentKey("eh1", "petrol (1).pdf")).toBe("eh1::petrol (1).pdf");
  });
});

describe("storagePath / slugSegment", () => {
  it("slugSegment makes a path-safe segment", () => {
    expect(slugSegment("Miscellaneous Travel/Local")).toBe("Miscellaneous-Travel-Local");
    expect(slugSegment("  spaces  ")).toBe("spaces");
  });
  it("storagePath builds run/emp/head/file", () => {
    expect(storagePath("job1", "E123", "Misc Travel", "bill (1).pdf")).toBe(
      "job1/E123/Misc-Travel/bill (1).pdf"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/vanshsood/Projects/everest/peoplestrong-tool && npx vitest run tests/parse.test.ts`
Expected: FAIL — cannot resolve `../src/util/parse.js`.

- [ ] **Step 3: Write `src/util/parse.ts`**

```ts
/** Parse an Indian-rupee-formatted amount string to a number, or null. */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/[^0-9.]/g, "");
  if (cleaned === "" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function claimKey(runId: string, employeeCode: string): string {
  return `${runId}::${employeeCode}`;
}

export function expenseHeadKey(
  claimId: string,
  expenseHead: string,
  billNumber: string | null
): string {
  return `${claimId}::${expenseHead}::${billNumber ?? ""}`;
}

export function attachmentKey(expenseHeadId: string, filename: string): string {
  return `${expenseHeadId}::${filename}`;
}

/** Make a single path segment safe (no slashes/spaces collapsing). Keeps the filename's dots. */
export function slugSegment(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Storage object path: {runId}/{employeeCode}/{expenseHeadSlug}/{filename} */
export function storagePath(
  runId: string,
  employeeCode: string,
  expenseHead: string,
  filename: string
): string {
  return `${slugSegment(runId)}/${slugSegment(employeeCode)}/${slugSegment(expenseHead)}/${filename}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/parse.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/util/parse.ts tests/parse.test.ts
git commit -m "feat: amount parsing, dedupe keys, storage path helpers"
```

---

## Task 4: Retry helper (TDD)

**Files:**
- Create: `src/util/retry.ts`
- Test: `tests/retry.test.ts`

- [ ] **Step 1: Write the failing test `tests/retry.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { withRetry } from "../src/util/retry.js";

describe("withRetry", () => {
  it("returns on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    expect(await withRetry(fn, { attempts: 3, baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");
    expect(await withRetry(fn, { attempts: 3, baseDelayMs: 1 })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("always"));
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1 })).rejects.toThrow("always");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls onRetry with attempt number", async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue("ok");
    await withRetry(fn, { attempts: 3, baseDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/retry.test.ts`
Expected: FAIL — cannot resolve `../src/util/retry.js`.

- [ ] **Step 3: Write `src/util/retry.ts`**

```ts
export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying up to `attempts` times with exponential backoff. Throws the last error. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < opts.attempts) {
        opts.onRetry?.(attempt, err);
        await sleep(opts.baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  throw lastErr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/retry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/util/retry.ts tests/retry.test.ts
git commit -m "feat: withRetry exponential-backoff helper"
```

---

## Task 5: Logger

**Files:**
- Create: `src/logger.ts`

- [ ] **Step 1: Write `src/logger.ts`**

```ts
type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const line = { level, msg, ...(meta ?? {}) };
  // eslint-disable-next-line no-console
  console[level === "info" ? "log" : level](JSON.stringify(line));
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
```

- [ ] **Step 2: Commit**

```bash
git add src/logger.ts
git commit -m "feat: structured json logger"
```

---

## Task 6: Config file + loader (TDD)

**Files:**
- Create: `config/peoplestrong.yml`, `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write `config/peoplestrong.yml`**

```yaml
# URLs — fill BASE_URL/LOGIN_URL from the live portal.
BASE_URL: "https://PLACEHOLDER.peoplestrong.com"
LOGIN_URL: "https://PLACEHOLDER.peoplestrong.com/login"

# Login selectors — UNKNOWN until inspected on the live login page. Fill these in.
USERNAME_SELECTOR: "PLACEHOLDER_username_input"
PASSWORD_SELECTOR: "PLACEHOLDER_password_input"
LOGIN_BUTTON_SELECTOR: "PLACEHOLDER_login_button"

# A DOM marker that is present ONLY when logged in (used for session-expiry detection).
# e.g. the tasks icon. Override if a more reliable marker exists.
LOGGED_IN_MARKER: ".mytasks_icon"

# Pre-filled, override-able selector map (concrete from inspection).
TASKS_ICON: ".mytasks_icon"
QUEUE_TITLE_TEXT: "Reimbursement Claim Requests"
TASK_LINK: "a[id*=ApproveRejectButton]"
EXPENSE_HEAD_LINK: "a[id*=tableId]"
ATTACHMENT_LINK: "a[id*=headAttachmentsList]"
TOTAL_CLAIMED_LABEL: "Total Claimed Amount:"

# Default stage filter (only rows whose text matches are processed).
STAGE_FILTER: "Finance Manager Approval"
```

- [ ] **Step 2: Write the failing test `tests/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const yamlPath = "./config/peoplestrong.yml";

const fullEnv = {
  WORKER_SECRET: "s",
  PEOPLESTRONG_USER: "u",
  PEOPLESTRONG_PASS: "p",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "k",
};

describe("loadConfig", () => {
  it("loads selectors from yaml and secrets from env", () => {
    const cfg = loadConfig(yamlPath, fullEnv);
    expect(cfg.selectors.TASK_LINK).toBe("a[id*=ApproveRejectButton]");
    expect(cfg.selectors.QUEUE_TITLE_TEXT).toBe("Reimbursement Claim Requests");
    expect(cfg.secrets.WORKER_SECRET).toBe("s");
    expect(cfg.stageFilter).toBe("Finance Manager Approval");
  });

  it("throws if a required secret is missing", () => {
    const { WORKER_SECRET, ...partial } = fullEnv;
    expect(() => loadConfig(yamlPath, partial)).toThrow(/WORKER_SECRET/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 4: Write `src/config.ts`**

```ts
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";

const SelectorSchema = z.object({
  BASE_URL: z.string(),
  LOGIN_URL: z.string(),
  USERNAME_SELECTOR: z.string(),
  PASSWORD_SELECTOR: z.string(),
  LOGIN_BUTTON_SELECTOR: z.string(),
  LOGGED_IN_MARKER: z.string(),
  TASKS_ICON: z.string(),
  QUEUE_TITLE_TEXT: z.string(),
  TASK_LINK: z.string(),
  EXPENSE_HEAD_LINK: z.string(),
  ATTACHMENT_LINK: z.string(),
  TOTAL_CLAIMED_LABEL: z.string(),
  STAGE_FILTER: z.string(),
});

const SecretsSchema = z.object({
  WORKER_SECRET: z.string().min(1, "WORKER_SECRET is required"),
  PEOPLESTRONG_USER: z.string().min(1, "PEOPLESTRONG_USER is required"),
  PEOPLESTRONG_PASS: z.string().min(1, "PEOPLESTRONG_PASS is required"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a URL"),
  SUPABASE_SERVICE_KEY: z.string().min(1, "SUPABASE_SERVICE_KEY is required"),
});

export type Selectors = z.infer<typeof SelectorSchema>;
export type Secrets = z.infer<typeof SecretsSchema>;

export interface AppConfig {
  selectors: Selectors;
  secrets: Secrets;
  stageFilter: string;
  storageDir: string;
  headless: boolean;
  bucket: string;
}

export function loadConfig(
  yamlPath: string,
  env: Record<string, string | undefined>
): AppConfig {
  const raw = yaml.load(readFileSync(yamlPath, "utf8"));
  const selectors = SelectorSchema.parse(raw);
  const secrets = SecretsSchema.parse(env);
  return {
    selectors,
    secrets,
    stageFilter: selectors.STAGE_FILTER,
    storageDir: env.STORAGE_DIR ?? "./storage",
    headless: (env.HEADLESS ?? "true") !== "false",
    bucket: "peoplestrong-claims",
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/peoplestrong.yml src/config.ts tests/config.test.ts
git commit -m "feat: yaml+env config loader with zod validation"
```

---

## Task 7: Supabase migration SQL

**Files:**
- Create: `migrations/0001_peoplestrong_worker.sql`

- [ ] **Step 1: Write `migrations/0001_peoplestrong_worker.sql`**

```sql
-- PeopleStrong Claims Sync Worker schema.
-- Apply to the shared Everest Supabase project (ref hbspmyossvwiueshvqjp).
-- RLS enabled with NO public policies: service-role (worker + platform) bypasses RLS.

create extension if not exists "pgcrypto";

create table if not exists public.sync_jobs (
  id            uuid primary key default gen_random_uuid(),
  status        text not null default 'queued'
                  check (status in ('queued','running','done','failed')),
  progress      jsonb not null default '{"processed":0,"total":0,"currentEmployee":null}'::jsonb,
  results       jsonb,
  error         text,
  stage_filter  text,
  "limit"       integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.claims (
  id                    uuid primary key default gen_random_uuid(),
  run_id                uuid not null references public.sync_jobs(id) on delete cascade,
  employee_code         text not null,
  employee_name         text,
  total_claimed_amount  numeric,
  status                text,
  scraped_at            timestamptz not null default now(),
  unique (run_id, employee_code)
);

create table if not exists public.expense_heads (
  id                uuid primary key default gen_random_uuid(),
  claim_id          uuid not null references public.claims(id) on delete cascade,
  expense_head      text not null,
  expense_category  text,
  bill_period       text,
  bill_number       text,
  start_date        text,
  end_date          text,
  bill_date         text,
  payment_mode      text,
  vendor            text,
  eligible_amount   numeric,
  approval_amount   numeric,
  claim_amount      numeric,
  employee_comment  text,
  approver_comments text,
  unique (claim_id, expense_head, bill_number)
);

create table if not exists public.attachments (
  id                  uuid primary key default gen_random_uuid(),
  expense_head_id     uuid not null references public.expense_heads(id) on delete cascade,
  filename            text not null,
  storage_path        text,
  source_response_url text,
  ocr_status          text not null default 'pending',
  unique (expense_head_id, filename)
);

alter table public.sync_jobs     enable row level security;
alter table public.claims        enable row level security;
alter table public.expense_heads enable row level security;
alter table public.attachments   enable row level security;

-- Storage bucket (private). If the SQL storage API is unavailable in your console,
-- create bucket "peoplestrong-claims" (private) via the Supabase dashboard instead.
insert into storage.buckets (id, name, public)
values ('peoplestrong-claims', 'peoplestrong-claims', false)
on conflict (id) do nothing;
```

- [ ] **Step 2: Commit**

```bash
git add migrations/0001_peoplestrong_worker.sql
git commit -m "feat: supabase migration for sync_jobs/claims/expense_heads/attachments"
```

> **Note (manual):** This migration is applied by the operator to the shared project, not by the worker at runtime. README documents running it (e.g. via the platform repo's `supabase/migrate.mjs` or the Supabase SQL editor).

---

## Task 8: Supabase client factory

**Files:**
- Create: `src/supabase.ts`

- [ ] **Step 1: Write `src/supabase.ts`**

```ts
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Secrets } from "./config.js";

export function createSupabase(secrets: Secrets): SupabaseClient {
  return createClient(secrets.SUPABASE_URL, secrets.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export type { SupabaseClient };
```

- [ ] **Step 2: Commit**

```bash
git add src/supabase.ts
git commit -m "feat: service-role supabase client factory"
```

---

## Task 9: Jobs module (TDD with mocked Supabase)

**Files:**
- Create: `src/jobs.ts`
- Test: `tests/jobs.test.ts`

The mock models the subset of the Supabase query builder we use: `from(table).insert(row).select().single()`, `from(table).update(patch).eq("id", id)`, and `from(table).select("*").eq("id", id).single()`.

- [ ] **Step 1: Write the failing test `tests/jobs.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { JobStore } from "../src/jobs.js";

function makeMockClient() {
  const store = new Map<string, any>();
  let idSeq = 0;
  const client: any = {
    from(table: string) {
      if (table !== "sync_jobs") throw new Error("unexpected table " + table);
      return {
        insert(row: any) {
          return {
            select() {
              return {
                async single() {
                  const id = "job-" + ++idSeq;
                  const rec = { id, ...row };
                  store.set(id, rec);
                  return { data: rec, error: null };
                },
              };
            },
          };
        },
        update(patch: any) {
          return {
            async eq(_col: string, id: string) {
              const rec = store.get(id);
              if (rec) store.set(id, { ...rec, ...patch });
              return { data: null, error: null };
            },
          };
        },
        select(_cols: string) {
          return {
            eq(_col: string, id: string) {
              return {
                async single() {
                  return { data: store.get(id) ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, store };
}

describe("JobStore", () => {
  it("creates a queued job", async () => {
    const { client } = makeMockClient();
    const store = new JobStore(client);
    const job = await store.create({ stageFilter: "Finance Manager Approval", limit: 5 });
    expect(job.status).toBe("queued");
    expect(job.id).toMatch(/^job-/);
    expect(job.stageFilter).toBe("Finance Manager Approval");
  });

  it("transitions status and progress", async () => {
    const { client } = makeMockClient();
    const store = new JobStore(client);
    const job = await store.create({ stageFilter: null, limit: null });
    await store.markRunning(job.id);
    await store.updateProgress(job.id, { processed: 2, total: 10, currentEmployee: "E1" });
    const fetched = await store.get(job.id);
    expect(fetched!.status).toBe("running");
    expect(fetched!.progress.processed).toBe(2);
  });

  it("blocks a second concurrent run while one is active", async () => {
    const { client } = makeMockClient();
    const store = new JobStore(client);
    expect(store.tryAcquire()).toBe(true);
    expect(store.tryAcquire()).toBe(false);
    store.release();
    expect(store.tryAcquire()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/jobs.test.ts`
Expected: FAIL — cannot resolve `../src/jobs.js`.

- [ ] **Step 3: Write `src/jobs.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Claim, JobRecord, Progress } from "./types.js";

interface DbRow {
  id: string;
  status: JobRecord["status"];
  progress: Progress;
  results: Claim[] | null;
  error: string | null;
  stage_filter: string | null;
  limit: number | null;
}

function toRecord(row: DbRow): JobRecord {
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    results: row.results,
    error: row.error,
    stageFilter: row.stage_filter,
    limit: row.limit,
  };
}

export class JobStore {
  private active = false;

  constructor(private client: SupabaseClient) {}

  /** In-process single-job guard. Returns false if a job is already running. */
  tryAcquire(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  release(): void {
    this.active = false;
  }

  async create(input: { stageFilter: string | null; limit: number | null }): Promise<JobRecord> {
    const { data, error } = await this.client
      .from("sync_jobs")
      .insert({
        status: "queued",
        progress: { processed: 0, total: 0, currentEmployee: null },
        stage_filter: input.stageFilter,
        limit: input.limit,
      })
      .select()
      .single();
    if (error) throw error;
    return toRecord(data as DbRow);
  }

  private async patch(id: string, patch: Partial<DbRow>): Promise<void> {
    const { error } = await this.client
      .from("sync_jobs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  }

  markRunning(id: string) {
    return this.patch(id, { status: "running" });
  }

  updateProgress(id: string, progress: Progress) {
    return this.patch(id, { progress });
  }

  markDone(id: string, results: Claim[]) {
    return this.patch(id, { status: "done", results });
  }

  markFailed(id: string, error: string) {
    return this.patch(id, { status: "failed", error });
  }

  async get(id: string): Promise<JobRecord | null> {
    const { data, error } = await this.client
      .from("sync_jobs")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) return null;
    return toRecord(data as DbRow);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/jobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jobs.ts tests/jobs.test.ts
git commit -m "feat: JobStore (sync_jobs CRUD + single-job guard)"
```

---

## Task 10: Storage module (TDD with mocked Supabase)

**Files:**
- Create: `src/storage.ts`
- Test: `tests/storage.test.ts`

`ClaimStore` persists one full `Claim` (header → expense heads → attachments) using upserts keyed by the dedupe constraints, and uploads file bytes to the bucket. Tests assert the upsert payloads and `onConflict` keys via a recording mock.

- [ ] **Step 1: Write the failing test `tests/storage.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { ClaimStore } from "../src/storage.js";
import type { Claim } from "../src/types.js";

function makeRecordingClient() {
  const calls: any[] = [];
  const uploads: any[] = [];
  let idSeq = 0;
  const client: any = {
    from(table: string) {
      return {
        upsert(rows: any, opts: any) {
          calls.push({ table, rows, opts });
          return {
            select() {
              return {
                async single() {
                  const row = Array.isArray(rows) ? rows[0] : rows;
                  return { data: { id: `${table}-${++idSeq}`, ...row }, error: null };
                },
              };
            },
          };
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, _bytes: Uint8Array, opts: any) {
            uploads.push({ bucket, path, opts });
            return { data: { path }, error: null };
          },
        };
      },
    },
  };
  return { client, calls, uploads };
}

const claim: Claim = {
  employeeCode: "E1",
  employeeName: "Asha",
  totalClaimedAmount: 1200,
  status: "Pending for Finance Manager Approval",
  expenseHeads: [
    {
      expenseHead: "Miscellaneous",
      expenseCategory: "Misc",
      billPeriod: "Jun 2026",
      billNumber: "B-9",
      startDate: null,
      endDate: null,
      billDate: "2026-06-01",
      paymentMode: "Cash",
      vendor: "ACME",
      eligibleAmount: 1200,
      approvalAmount: null,
      claimAmount: 1200,
      employeeComment: "ok",
      approverComments: null,
      attachments: [
        {
          filename: "petrol (1).pdf",
          storagePath: "",
          sourceResponseUrl: "https://x/y",
          ocrStatus: "pending",
        },
      ],
    },
  ],
};

describe("ClaimStore.persistClaim", () => {
  it("upserts claim, expense heads, attachments with conflict keys", async () => {
    const { client, calls } = makeRecordingClient();
    const store = new ClaimStore(client, "peoplestrong-claims");
    await store.persistClaim("job-1", claim, async () => new Uint8Array([1, 2, 3]));

    const claimCall = calls.find((c) => c.table === "claims");
    expect(claimCall.opts.onConflict).toBe("run_id,employee_code");
    expect(claimCall.rows.run_id).toBe("job-1");
    expect(claimCall.rows.total_claimed_amount).toBe(1200);

    const ehCall = calls.find((c) => c.table === "expense_heads");
    expect(ehCall.opts.onConflict).toBe("claim_id,expense_head,bill_number");
    expect(ehCall.rows.bill_number).toBe("B-9");

    const attCall = calls.find((c) => c.table === "attachments");
    expect(attCall.opts.onConflict).toBe("expense_head_id,filename");
  });

  it("uploads each attachment's bytes to the bucket and records the path", async () => {
    const { client, uploads, calls } = makeRecordingClient();
    const store = new ClaimStore(client, "peoplestrong-claims");
    await store.persistClaim("job-1", claim, async () => new Uint8Array([9]));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe("job-1/E1/Miscellaneous/petrol (1).pdf");
    const attCall = calls.find((c) => c.table === "attachments");
    expect(attCall.rows.storage_path).toBe("job-1/E1/Miscellaneous/petrol (1).pdf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL — cannot resolve `../src/storage.js`.

- [ ] **Step 3: Write `src/storage.ts`**

```ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Claim, ExpenseHead, Attachment } from "./types.js";
import { storagePath } from "./util/parse.js";

/** Returns raw bytes for an attachment (download already performed by the scraper). */
export type BytesFor = (att: Attachment) => Promise<Uint8Array>;

export class ClaimStore {
  constructor(private client: SupabaseClient, private bucket: string) {}

  async persistClaim(runId: string, claim: Claim, bytesFor: BytesFor): Promise<void> {
    const { data: claimRow, error: claimErr } = await this.client
      .from("claims")
      .upsert(
        {
          run_id: runId,
          employee_code: claim.employeeCode,
          employee_name: claim.employeeName,
          total_claimed_amount: claim.totalClaimedAmount,
          status: claim.status,
        },
        { onConflict: "run_id,employee_code" }
      )
      .select()
      .single();
    if (claimErr) throw claimErr;
    const claimId = (claimRow as { id: string }).id;

    for (const eh of claim.expenseHeads) {
      const ehId = await this.upsertExpenseHead(claimId, eh);
      for (const att of eh.attachments) {
        await this.upsertAttachment(runId, claim, eh, att, ehId, bytesFor);
      }
    }
  }

  private async upsertExpenseHead(claimId: string, eh: ExpenseHead): Promise<string> {
    const { data, error } = await this.client
      .from("expense_heads")
      .upsert(
        {
          claim_id: claimId,
          expense_head: eh.expenseHead,
          expense_category: eh.expenseCategory,
          bill_period: eh.billPeriod,
          bill_number: eh.billNumber,
          start_date: eh.startDate,
          end_date: eh.endDate,
          bill_date: eh.billDate,
          payment_mode: eh.paymentMode,
          vendor: eh.vendor,
          eligible_amount: eh.eligibleAmount,
          approval_amount: eh.approvalAmount,
          claim_amount: eh.claimAmount,
          employee_comment: eh.employeeComment,
          approver_comments: eh.approverComments,
        },
        { onConflict: "claim_id,expense_head,bill_number" }
      )
      .select()
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  private async upsertAttachment(
    runId: string,
    claim: Claim,
    eh: ExpenseHead,
    att: Attachment,
    ehId: string,
    bytesFor: BytesFor
  ): Promise<void> {
    const path = storagePath(runId, claim.employeeCode, eh.expenseHead, att.filename);
    const bytes = await bytesFor(att);
    const { error: upErr } = await this.client.storage
      .from(this.bucket)
      .upload(path, bytes, { upsert: true, contentType: "application/octet-stream" });
    if (upErr) throw upErr;

    const { error } = await this.client.from("attachments").upsert(
      {
        expense_head_id: ehId,
        filename: att.filename,
        storage_path: path,
        source_response_url: att.sourceResponseUrl,
        ocr_status: "pending",
      },
      { onConflict: "expense_head_id,filename" }
    );
    if (error) throw error;
  }

  /** Upload a failure screenshot under errors/{jobId}/. Returns the storage path. */
  async uploadErrorScreenshot(jobId: string, name: string, bytes: Uint8Array): Promise<string> {
    const path = `errors/${jobId}/${name}`;
    await this.client.storage
      .from(this.bucket)
      .upload(path, bytes, { upsert: true, contentType: "image/png" });
    return path;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/storage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/storage.ts tests/storage.test.ts
git commit -m "feat: ClaimStore upserts + attachment/screenshot upload"
```

---

## Task 11: Session module (Playwright; verified by live smoke)

**Files:**
- Create: `src/session.ts`

Playwright DOM interaction can't be meaningfully unit-tested without the live portal, so this module is verified by the documented smoke run in Task 16. Keep it small and dependency-injected (`BrowserContext` + config in).

- [ ] **Step 1: Write `src/session.ts`**

```ts
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";

function statePath(cfg: AppConfig): string {
  return join(cfg.storageDir, "state.json");
}

/** Create a context, reusing persisted storageState if present. */
export async function createContext(browser: Browser, cfg: AppConfig): Promise<BrowserContext> {
  const sp = statePath(cfg);
  if (existsSync(sp)) {
    log.info("reusing persisted session", { sp });
    return browser.newContext({ storageState: sp, acceptDownloads: true });
  }
  return browser.newContext({ acceptDownloads: true });
}

/** True if the logged-in marker is visible (i.e. session still valid). */
export async function isLoggedIn(page: Page, cfg: AppConfig): Promise<boolean> {
  try {
    await page.waitForSelector(cfg.selectors.LOGGED_IN_MARKER, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Perform username/password login and persist storageState. */
export async function login(context: BrowserContext, page: Page, cfg: AppConfig): Promise<void> {
  const { selectors, secrets } = cfg;
  log.info("logging in", { url: selectors.LOGIN_URL });
  await page.goto(selectors.LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.fill(selectors.USERNAME_SELECTOR, secrets.PEOPLESTRONG_USER);
  await page.fill(selectors.PASSWORD_SELECTOR, secrets.PEOPLESTRONG_PASS);
  await page.click(selectors.LOGIN_BUTTON_SELECTOR);
  await page.waitForSelector(selectors.LOGGED_IN_MARKER, { timeout: 30000 });

  const sp = statePath(cfg);
  await mkdir(dirname(sp), { recursive: true });
  await context.storageState({ path: sp });
  log.info("login complete, session persisted", { sp });
}

/** Ensure we are on the dashboard and logged in; re-login if the session expired. */
export async function ensureSession(
  context: BrowserContext,
  page: Page,
  cfg: AppConfig
): Promise<void> {
  await page.goto(cfg.selectors.BASE_URL, { waitUntil: "domcontentloaded" });
  if (await isLoggedIn(page, cfg)) return;
  await login(context, page, cfg);
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/session.ts
git commit -m "feat: session module (login, storageState reuse, expiry detection)"
```

---

## Task 12: Navigation module (Playwright; new-tab + PrimeFaces AJAX)

**Files:**
- Create: `src/navigation.ts`

- [ ] **Step 1: Write `src/navigation.ts`**

```ts
import type { BrowserContext, Page, Locator } from "playwright";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";

/**
 * Wait for a PrimeFaces AJAX partial update by waiting on a DOM marker (never a blind sleep).
 * `marker` may be a CSS selector or a text snippet; we wait for a matching element to be visible.
 */
export async function waitForMarker(page: Page, marker: string, timeout = 20000): Promise<void> {
  const looksLikeSelector = /[.#\[]/.test(marker);
  if (looksLikeSelector) {
    await page.waitForSelector(marker, { state: "visible", timeout });
  } else {
    await page.getByText(marker, { exact: false }).first().waitFor({ state: "visible", timeout });
  }
}

/**
 * Click the Tasks icon on the Angular dashboard and capture the NEW TAB it opens.
 * Returns the new PrimeFaces task tab.
 */
export async function openTaskTab(
  context: BrowserContext,
  dashboard: Page,
  cfg: AppConfig
): Promise<Page> {
  const icon = dashboard.locator(cfg.selectors.TASKS_ICON);
  await icon.first().waitFor({ state: "visible", timeout: 20000 });
  const clickable = icon
    .first()
    .locator("xpath=ancestor-or-self::*[self::a or self::button or self::div][1]");

  const [taskTab] = await Promise.all([
    context.waitForEvent("page"),
    clickable.click(),
  ]);
  await taskTab.waitForLoadState();
  log.info("task tab opened", { url: taskTab.url() });
  return taskTab;
}

/** Open the "Reimbursement Claim Requests" queue; return the pending count (or null). */
export async function openQueue(taskTab: Page, cfg: AppConfig): Promise<number | null> {
  const title = taskTab.getByText(cfg.selectors.QUEUE_TITLE_TEXT, { exact: false }).first();
  await title.waitFor({ state: "visible", timeout: 20000 });

  // pending-counts sits beside the title; read before clicking.
  let pending: number | null = null;
  try {
    const countText = await taskTab.locator("span.pending-counts").first().innerText();
    const n = Number(countText.replace(/[^0-9]/g, ""));
    pending = Number.isFinite(n) ? n : null;
  } catch {
    pending = null;
  }

  await title.click();
  // Wait for the task list to render (the first task link, or an empty-state).
  await taskTab
    .locator(cfg.selectors.TASK_LINK)
    .first()
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => log.warn("no task links after opening queue (empty queue?)"));

  log.info("queue opened", { pending });
  return pending;
}

/** All task-row links matching the stage filter text. */
export async function taskRows(taskTab: Page, cfg: AppConfig): Promise<Locator[]> {
  const links = taskTab.locator(cfg.selectors.TASK_LINK);
  const count = await links.count();
  const out: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const text = (await link.innerText().catch(() => "")) ?? "";
    if (text.includes(cfg.stageFilter)) out.push(link);
  }
  return out;
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/navigation.ts
git commit -m "feat: navigation (tasks icon, new-tab handoff, queue, AJAX markers)"
```

---

## Task 13: Claims module (extract header + expense heads)

**Files:**
- Create: `src/claims.ts`

`fieldValue` reads the value next to a PrimeFaces label by locating the label text and returning the nearest following cell/sibling text. The exact DOM relationship is confirmed during the smoke run; the helper centralises it so only one place changes if the layout differs.

- [ ] **Step 1: Write `src/claims.ts`**

```ts
import type { Page, Locator } from "playwright";
import type { AppConfig } from "./config.js";
import type { Claim, ExpenseHead } from "./types.js";
import { parseAmount } from "./util/parse.js";
import { waitForMarker } from "./navigation.js";
import { log } from "./logger.js";

/**
 * Read the value associated with a label inside the detail panel.
 * Strategy: find the element containing the label text, then read the text of the
 * following sibling / adjacent value cell. Falls back to null if not found.
 */
export async function fieldValue(scope: Page | Locator, label: string): Promise<string | null> {
  const labelEl = scope
    .locator(`xpath=.//*[contains(normalize-space(.), ${xpathLiteral(label)})]`)
    .first();
  if ((await labelEl.count()) === 0) return null;
  const value = labelEl
    .locator(
      "xpath=following-sibling::*[1] | ../following-sibling::*[1] | ../td[2] | ../../td[2]"
    )
    .first();
  const txt = await value.innerText().catch(() => null);
  return txt ? txt.trim() || null : null;
}

/** Escape a string for use as an XPath string literal. */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return "concat('" + s.split("'").join("',\"'\",'") + "')";
}

/** Capture employee code + name from a task row's text before clicking it. */
export function parseRowEmployee(rowText: string): { employeeName: string; employeeCode: string } {
  // Rows commonly read like "Asha Rao (E12345) - Finance Manager Approval".
  const codeMatch = rowText.match(/\(([A-Za-z0-9\-]+)\)/);
  const employeeCode = codeMatch ? codeMatch[1] : rowText.trim();
  const employeeName = codeMatch ? rowText.slice(0, codeMatch.index).trim() : rowText.trim();
  return { employeeName, employeeCode };
}

/** Open one task row and extract the claim header + all expense heads (without attachments). */
export async function extractClaim(
  taskTab: Page,
  row: Locator,
  cfg: AppConfig
): Promise<Claim> {
  const rowText = (await row.innerText().catch(() => "")) ?? "";
  const { employeeName, employeeCode } = parseRowEmployee(rowText);

  await row.click();
  // PrimeFaces partial update — wait for the Total Claimed Amount label to render.
  await waitForMarker(taskTab, cfg.selectors.TOTAL_CLAIMED_LABEL);

  const totalRaw = await fieldValue(taskTab, cfg.selectors.TOTAL_CLAIMED_LABEL);
  const status = await fieldValue(taskTab, "Status");

  const claim: Claim = {
    employeeCode,
    employeeName,
    totalClaimedAmount: parseAmount(totalRaw),
    status,
    expenseHeads: [],
  };

  claim.expenseHeads = await extractExpenseHeads(taskTab, cfg);
  log.info("claim extracted", { employeeCode, heads: claim.expenseHeads.length });
  return claim;
}

/** Loop expense-head links and extract the 14 fields for each. */
export async function extractExpenseHeads(taskTab: Page, cfg: AppConfig): Promise<ExpenseHead[]> {
  const links = taskTab.locator(cfg.selectors.EXPENSE_HEAD_LINK);
  const count = await links.count();
  const heads: ExpenseHead[] = [];

  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const headName = (await link.innerText().catch(() => `head-${i}`)).trim();
    await link.click();
    // Wait for the accounting/claim section to render.
    await waitForMarker(taskTab, "Accounting Information").catch(() =>
      waitForMarker(taskTab, "Reimbursement Claim")
    );

    heads.push({
      expenseHead: headName,
      expenseCategory: await fieldValue(taskTab, "Expense Category"),
      billPeriod: await fieldValue(taskTab, "Bill Period"),
      billNumber: await fieldValue(taskTab, "Bill Number"),
      startDate: await fieldValue(taskTab, "Start Date"),
      endDate: await fieldValue(taskTab, "End Date"),
      billDate: await fieldValue(taskTab, "Bill Date"),
      paymentMode: await fieldValue(taskTab, "Payment Mode"),
      vendor: await fieldValue(taskTab, "Vendor"),
      eligibleAmount: parseAmount(await fieldValue(taskTab, "Eligible Amount")),
      approvalAmount: parseAmount(await fieldValue(taskTab, "Approval Amount")),
      claimAmount: parseAmount(await fieldValue(taskTab, "Claim Amount")),
      employeeComment: await fieldValue(taskTab, "Employee Comment"),
      approverComments: await fieldValue(taskTab, "Approver Comments"),
      attachments: [],
    });
  }
  return heads;
}
```

- [ ] **Step 2: Add unit tests for the pure helpers `tests/claims-pure.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { parseRowEmployee, xpathLiteral } from "../src/claims.js";

describe("parseRowEmployee", () => {
  it("extracts name and code from a parenthesised row", () => {
    expect(parseRowEmployee("Asha Rao (E12345) - Finance Manager Approval")).toEqual({
      employeeName: "Asha Rao",
      employeeCode: "E12345",
    });
  });
  it("falls back to full text when no code present", () => {
    expect(parseRowEmployee("Finance Manager Approval")).toEqual({
      employeeName: "Finance Manager Approval",
      employeeCode: "Finance Manager Approval",
    });
  });
});

describe("xpathLiteral", () => {
  it("wraps plain strings in single quotes", () => {
    expect(xpathLiteral("Bill Date")).toBe("'Bill Date'");
  });
  it("uses double quotes when an apostrophe is present", () => {
    expect(xpathLiteral("Approver's")).toBe(`"Approver's"`);
  });
});
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npx vitest run tests/claims-pure.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS and no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/claims.ts tests/claims-pure.test.ts
git commit -m "feat: claims extraction (header + 14 expense fields) + pure helpers"
```

---

## Task 14: Attachments module (download capture)

**Files:**
- Create: `src/attachments.ts`

- [ ] **Step 1: Write `src/attachments.ts`**

```ts
import type { Page, Locator } from "playwright";
import type { AppConfig } from "./config.js";
import type { Attachment } from "./types.js";
import { log } from "./logger.js";

export interface DownloadedAttachment {
  meta: Attachment;
  bytes: Uint8Array;
}

/**
 * For each attachment link in the currently-rendered expense-head panel:
 * capture the filename (link text), click, and grab the downloaded bytes.
 * PrimeFaces attachment URLs are session-bound, so we download bytes now.
 */
export async function captureAttachments(
  taskTab: Page,
  cfg: AppConfig
): Promise<DownloadedAttachment[]> {
  const links = taskTab.locator(cfg.selectors.ATTACHMENT_LINK);
  const count = await links.count();
  const out: DownloadedAttachment[] = [];

  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const filename = (await link.innerText().catch(() => `attachment-${i}`)).trim();
    try {
      const result = await captureOne(taskTab, link, filename);
      out.push(result);
    } catch (err) {
      log.warn("attachment capture failed", { filename, err: String(err) });
    }
  }
  return out;
}

async function captureOne(
  taskTab: Page,
  link: Locator,
  filename: string
): Promise<DownloadedAttachment> {
  // Capture the response bytes AND the download event; whichever yields bytes wins.
  let responseUrl: string | null = null;
  let responseBytes: Uint8Array | null = null;

  const onResponse = async (resp: import("playwright").Response) => {
    const ct = resp.headers()["content-type"] ?? "";
    const cd = resp.headers()["content-disposition"] ?? "";
    if (cd.includes("attachment") || /application\/(pdf|octet-stream)|image\//.test(ct)) {
      try {
        responseBytes = new Uint8Array(await resp.body());
        responseUrl = resp.url();
      } catch {
        /* body not available (e.g. redirect) — ignore */
      }
    }
  };
  taskTab.on("response", onResponse);

  let bytes: Uint8Array;
  try {
    const [download] = await Promise.all([
      taskTab.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      link.click(),
    ]);

    if (download) {
      const stream = await download.createReadStream();
      bytes = await streamToBytes(stream);
      responseUrl = responseUrl ?? download.url();
    } else if (responseBytes) {
      bytes = responseBytes;
    } else {
      throw new Error("no download event and no response body captured");
    }
  } finally {
    taskTab.off("response", onResponse);
  }

  return {
    meta: { filename, storagePath: "", sourceResponseUrl: responseUrl, ocrStatus: "pending" },
    bytes,
  };
}

async function streamToBytes(
  stream: NodeJS.ReadableStream | null
): Promise<Uint8Array> {
  if (!stream) throw new Error("empty download stream");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/attachments.ts
git commit -m "feat: attachment download capture (download event + response listener)"
```

---

## Task 15: Scrape orchestrator

**Files:**
- Create: `src/scrape.ts`

Ties everything together: launch browser → ensure session → open task tab → open queue → loop rows with per-task try/catch and 3× retry on navigation → for each expense head capture attachments → persist via `ClaimStore` → update job progress. On session expiry mid-loop, re-login and continue.

- [ ] **Step 1: Write `src/scrape.ts`**

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import type { AppConfig } from "./config.js";
import type { Claim } from "./types.js";
import { JobStore } from "./jobs.js";
import { ClaimStore } from "./storage.js";
import { createContext, ensureSession, isLoggedIn, login } from "./session.js";
import { openTaskTab, openQueue, taskRows } from "./navigation.js";
import { extractClaim } from "./claims.js";
import { captureAttachments } from "./attachments.js";
import { withRetry } from "./util/retry.js";
import { log } from "./logger.js";

export interface ScrapeDeps {
  cfg: AppConfig;
  jobs: JobStore;
  claimStore: ClaimStore;
}

const RETRY = { attempts: 3, baseDelayMs: 1000 };

export async function runScrape(
  jobId: string,
  opts: { stageFilter: string | null; limit: number | null },
  deps: ScrapeDeps
): Promise<void> {
  const { cfg, jobs, claimStore } = deps;
  await jobs.markRunning(jobId);

  const browser = await chromium.launch({ headless: cfg.headless });
  const context = await createContext(browser, cfg);
  const dashboard = await context.newPage();
  const results: Claim[] = [];

  try {
    await withRetry(() => ensureSession(context, dashboard, cfg), {
      ...RETRY,
      onRetry: (a, e) => log.warn("ensureSession retry", { a, e: String(e) }),
    });

    const taskTab = await withRetry(() => openTaskTab(context, dashboard, cfg), RETRY);
    const pending = await openQueue(taskTab, cfg);

    let rows = await taskRows(taskTab, cfg);
    const total = opts.limit ? Math.min(rows.length, opts.limit) : rows.length;
    if (opts.limit) rows = rows.slice(0, opts.limit);
    await jobs.updateProgress(jobId, { processed: 0, total: total || pending || 0, currentEmployee: null });

    let processed = 0;
    for (const row of rows) {
      let claim: Claim | null = null;
      try {
        // Re-login mid-loop if the session expired.
        if (!(await isLoggedIn(dashboard, cfg))) {
          await login(context, dashboard, cfg);
        }

        claim = await withRetry(() => extractClaim(taskTab, row, cfg), RETRY);
        await jobs.updateProgress(jobId, {
          processed,
          total: total || pending || rows.length,
          currentEmployee: claim.employeeCode,
        });

        // Attachments per expense head (panel is the currently-rendered one).
        for (const eh of claim.expenseHeads) {
          const dls = await captureAttachments(taskTab, cfg);
          eh.attachments = dls.map((d) => d.meta);
          await claimStorePersist(claimStore, jobId, claim, dls);
        }
        if (claim.expenseHeads.length === 0) {
          await claimStore.persistClaim(jobId, claim, async () => new Uint8Array());
        }
      } catch (err) {
        const msg = String(err);
        log.error("task failed", { err: msg });
        await screenshotOnFailure(taskTab, cfg, claimStore, jobId, processed);
        results.push({
          employeeCode: claim?.employeeCode ?? `unknown-${processed}`,
          employeeName: claim?.employeeName ?? "",
          totalClaimedAmount: claim?.totalClaimedAmount ?? null,
          status: claim?.status ?? null,
          expenseHeads: claim?.expenseHeads ?? [],
          error: msg,
        });
        processed++;
        continue;
      }

      results.push(claim);
      processed++;
      await jobs.updateProgress(jobId, {
        processed,
        total: total || pending || rows.length,
        currentEmployee: claim.employeeCode,
      });
    }

    await jobs.markDone(jobId, results);
    log.info("scrape done", { jobId, claims: results.length });
  } catch (err) {
    log.error("scrape failed", { jobId, err: String(err) });
    await jobs.markFailed(jobId, String(err));
  } finally {
    await context.close();
    await browser.close();
  }
}

/** Persist a claim whose attachment bytes were captured this iteration. */
async function claimStorePersist(
  claimStore: ClaimStore,
  jobId: string,
  claim: Claim,
  dls: { meta: { filename: string }; bytes: Uint8Array }[]
): Promise<void> {
  const byName = new Map(dls.map((d) => [d.meta.filename, d.bytes]));
  await claimStore.persistClaim(jobId, claim, async (att) => byName.get(att.filename) ?? new Uint8Array());
}

async function screenshotOnFailure(
  taskTab: import("playwright").Page,
  cfg: AppConfig,
  claimStore: ClaimStore,
  jobId: string,
  index: number
): Promise<void> {
  try {
    const name = `task-${index}.png`;
    const dir = join(cfg.storageDir, "errors", jobId);
    await mkdir(dir, { recursive: true });
    const buf = await taskTab.screenshot({ fullPage: true });
    await writeFile(join(dir, name), buf);
    await claimStore.uploadErrorScreenshot(jobId, name, new Uint8Array(buf));
  } catch (e) {
    log.warn("screenshot-on-failure failed", { e: String(e) });
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/scrape.ts
git commit -m "feat: scrape orchestrator (retry, per-task isolation, resume, screenshots)"
```

---

## Task 16: Express server + auth middleware (TDD with supertest)

**Files:**
- Create: `src/server.ts`
- Test: `tests/server.test.ts`

The server is split so the runner (the function that actually launches Playwright) is injectable, letting the test drive endpoints without a browser.

- [ ] **Step 1: Write the failing test `tests/server.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/server.js";
import type { JobRecord } from "../src/types.js";

function fakeJobStore() {
  const jobs = new Map<string, JobRecord>();
  let seq = 0;
  return {
    store: {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
      async create(input: any) {
        const id = "job-" + ++seq;
        const rec: JobRecord = {
          id, status: "queued",
          progress: { processed: 0, total: 0, currentEmployee: null },
          results: null, error: null,
          stageFilter: input.stageFilter, limit: input.limit,
        };
        jobs.set(id, rec);
        return rec;
      },
      async get(id: string) { return jobs.get(id) ?? null; },
    } as any,
    jobs,
  };
}

describe("server", () => {
  const SECRET = "topsecret";
  let runner: ReturnType<typeof vi.fn>;
  let jobStore: ReturnType<typeof fakeJobStore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runner = vi.fn().mockResolvedValue(undefined);
    jobStore = fakeJobStore();
    app = buildApp({ workerSecret: SECRET, jobs: jobStore.store, runJob: runner, defaultStageFilter: "Finance Manager Approval" });
  });

  it("GET /health needs no auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("rejects missing/wrong secret", async () => {
    expect((await request(app).post("/sync-claims")).status).toBe(401);
    expect((await request(app).post("/sync-claims").set("X-Worker-Secret", "nope")).status).toBe(401);
  });

  it("POST /sync-claims returns jobId and invokes the runner", async () => {
    const res = await request(app)
      .post("/sync-claims")
      .set("X-Worker-Secret", SECRET)
      .send({ limit: 3 });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toMatch(/^job-/);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("409 when a job is already running", async () => {
    jobStore.store.tryAcquire = vi.fn(() => false);
    const res = await request(app).post("/sync-claims").set("X-Worker-Secret", SECRET).send({});
    expect(res.status).toBe(409);
  });

  it("GET /job/:id returns status or 404", async () => {
    const created = await request(app).post("/sync-claims").set("X-Worker-Secret", SECRET).send({});
    const id = created.body.jobId;
    const ok = await request(app).get(`/job/${id}`).set("X-Worker-Secret", SECRET);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBeDefined();
    const missing = await request(app).get("/job/nope").set("X-Worker-Secret", SECRET);
    expect(missing.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`.

- [ ] **Step 3: Write `src/server.ts`**

```ts
import express, { type Request, type Response, type NextFunction } from "express";
import { JobStore } from "./jobs.js";
import { ClaimStore } from "./storage.js";
import { createSupabase } from "./supabase.js";
import { loadConfig } from "./config.js";
import { runScrape } from "./scrape.js";
import { log } from "./logger.js";

export interface AppDeps {
  workerSecret: string;
  jobs: Pick<JobStore, "tryAcquire" | "release" | "create" | "get">;
  runJob: (jobId: string, opts: { stageFilter: string | null; limit: number | null }) => Promise<void>;
  defaultStageFilter: string;
}

export function buildApp(deps: AppDeps) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (req.header("X-Worker-Secret") !== deps.workerSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  };

  app.post("/sync-claims", auth, async (req, res) => {
    const stageFilter: string | null = req.body?.stageFilter ?? deps.defaultStageFilter;
    const limit: number | null =
      typeof req.body?.limit === "number" ? req.body.limit : null;

    if (!deps.jobs.tryAcquire()) {
      return res.status(409).json({ error: "a sync job is already running" });
    }

    let jobId: string;
    try {
      const job = await deps.jobs.create({ stageFilter, limit });
      jobId = job.id;
    } catch (err) {
      deps.jobs.release();
      return res.status(500).json({ error: String(err) });
    }

    // Fire-and-forget; always release the guard when done.
    deps
      .runJob(jobId, { stageFilter, limit })
      .catch((err) => log.error("runJob crashed", { jobId, err: String(err) }))
      .finally(() => deps.jobs.release());

    return res.status(202).json({ jobId });
  });

  app.get("/job/:id", auth, async (req, res) => {
    const job = await deps.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    return res.json({
      status: job.status,
      progress: job.progress,
      results: job.results ?? undefined,
      error: job.error ?? undefined,
    });
  });

  return app;
}

/** Production entrypoint. */
export function start() {
  const cfg = loadConfig(process.env.CONFIG_PATH ?? "./config/peoplestrong.yml", process.env);
  const supabase = createSupabase(cfg.secrets);
  const jobs = new JobStore(supabase);
  const claimStore = new ClaimStore(supabase, cfg.bucket);

  const app = buildApp({
    workerSecret: cfg.secrets.WORKER_SECRET,
    jobs,
    defaultStageFilter: cfg.stageFilter,
    runJob: (jobId, opts) => runScrape(jobId, opts, { cfg, jobs, claimStore }),
  });

  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, () => log.info("worker listening", { port }));
}

// Start only when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  start();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite + typecheck**

Run: `npx vitest run && npx tsc -p tsconfig.json --noEmit`
Expected: all tests PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts tests/server.test.ts
git commit -m "feat: express server, X-Worker-Secret auth, async job endpoints"
```

---

## Task 17: Docker, compose, render

**Files:**
- Create: `Dockerfile`, `docker-compose.yml`, `render.yaml`

- [ ] **Step 1: Write `Dockerfile`** (use the official Playwright image so Chromium + deps are present)

```dockerfile
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
RUN npm run build

# Persisted session + downloads + error screenshots.
RUN mkdir -p /app/storage
ENV STORAGE_DIR=/app/storage
ENV CONFIG_PATH=/app/config/peoplestrong.yml
ENV PORT=8080
EXPOSE 8080

CMD ["node", "dist/server.js"]
```

- [ ] **Step 2: Write `docker-compose.yml`**

```yaml
services:
  worker:
    build: .
    ports:
      - "8080:8080"
    environment:
      WORKER_SECRET: ${WORKER_SECRET}
      PEOPLESTRONG_USER: ${PEOPLESTRONG_USER}
      PEOPLESTRONG_PASS: ${PEOPLESTRONG_PASS}
      SUPABASE_URL: ${SUPABASE_URL}
      SUPABASE_SERVICE_KEY: ${SUPABASE_SERVICE_KEY}
      HEADLESS: "true"
    volumes:
      - ./storage:/app/storage
```

- [ ] **Step 3: Write `render.yaml`**

```yaml
services:
  - type: web
    name: everest-peoplestrong-worker
    runtime: docker
    plan: starter
    healthCheckPath: /health
    disk:
      name: storage
      mountPath: /app/storage
      sizeGB: 1
    envVars:
      - key: WORKER_SECRET
        sync: false
      - key: PEOPLESTRONG_USER
        sync: false
      - key: PEOPLESTRONG_PASS
        sync: false
      - key: SUPABASE_URL
        sync: false
      - key: SUPABASE_SERVICE_KEY
        sync: false
      - key: HEADLESS
        value: "true"
```

- [ ] **Step 4: Verify the image builds**

Run: `cd /Users/vanshsood/Projects/everest/peoplestrong-tool && docker build -t ps-worker .`
Expected: builds successfully through `npm run build`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml render.yaml
git commit -m "chore: docker, compose, render deploy config"
```

---

## Task 18: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`** covering: what it is; the data model; the 3 endpoints with `curl` examples; local run (`npm install`, `npx playwright install chromium`, fill `config/peoplestrong.yml` login selectors, `.env`, `npm run dev`); applying `migrations/0001_peoplestrong_worker.sql` to the shared project + creating the `peoplestrong-claims` bucket; Render deploy via `render.yaml` + env vars; **how the new-tab + PrimeFaces AJAX handling works** (new tab captured via `context.waitForEvent('page')`, waits are on DOM markers); and **how to update selectors** when PeopleStrong changes its UI (edit `config/peoplestrong.yml`; login selectors are the only true unknowns; use substring id selectors like `a[id*=ApproveRejectButton]`, never row indices).

Use this content:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README (run, deploy, new-tab/AJAX handling, selector maintenance)"
```

---

## Task 19: Live smoke run (manual verification)

**Files:** none (operational checklist).

This is the only verification for the Playwright DOM modules — they can't be unit-tested without the real portal.

- [ ] **Step 1:** Fill the real login selectors + URLs in `config/peoplestrong.yml` and secrets in `.env`.
- [ ] **Step 2:** Apply the migration and create the `peoplestrong-claims` bucket in the shared Supabase project.
- [ ] **Step 3:** `HEADLESS=false npm run dev`, then:

```bash
curl -s -X POST localhost:8080/sync-claims \
  -H "X-Worker-Secret: $WORKER_SECRET" -H 'content-type: application/json' -d '{"limit":1}'
```

- [ ] **Step 4:** Poll `GET /job/<jobId>` until `status` is `done`. Verify in Supabase: one `claims` row,
  its `expense_heads`, `attachments` rows, and the files present in the bucket. Confirm `storage/state.json`
  was written (session persisted).
- [ ] **Step 5:** Re-run with `{"limit":1}` and confirm **no duplicate rows** were created (dedupe works
  within the same run id; a new run id creates a fresh `claims` row by design).
- [ ] **Step 6:** If any selector was wrong, adjust `config/peoplestrong.yml` (and only if a label/DOM
  relationship differs, the corresponding wait marker or `fieldValue` xpath) and re-run.

---

## Self-Review (completed)

**Spec coverage:** stack ✓ (T1), endpoints ✓ (T16), login/session-persist/expiry ✓ (T11), new-tab ✓ (T12),
queue + pending count ✓ (T12), task loop + employee capture ✓ (T13), claim header ✓ (T13), 14 expense
fields ✓ (T13), attachments download ✓ (T14), Supabase storage + dedupe ✓ (T10), data model ✓ (T7),
results assembly + job state ✓ (T9/T15), resilience (3× retry, screenshot-on-failure, per-task isolation,
DOM-marker waits, re-login resume) ✓ (T4/T15), config (unknown login selectors + pre-filled map) ✓ (T6),
secrets via env ✓ (T1/T16), Dockerfile/compose/README ✓ (T17/T18), extensibility seam for approve/reject ✓
(claims row locator exposed via `taskRows`/`extractClaim`, noted in README/spec).

**Placeholder scan:** the only intentional placeholders are the unknown login selectors in
`config/peoplestrong.yml` (per spec). No TODO/TBD in code steps.

**Type consistency:** `Claim`/`ExpenseHead`/`Attachment`/`JobRecord`/`Progress` defined in T2 are used
consistently; `ClaimStore.persistClaim(runId, claim, bytesFor)`, `JobStore` method names, and `buildApp`
deps match across T9/T10/T15/T16.

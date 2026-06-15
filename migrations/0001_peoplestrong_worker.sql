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

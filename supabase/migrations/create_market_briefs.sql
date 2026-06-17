create extension if not exists pgcrypto;

create table if not exists public.market_briefs (
  id uuid primary key default gen_random_uuid(),
  us_date date not null,
  sydney_date date not null,
  generated_at timestamptz not null default now(),
  brief_json jsonb not null,
  markdown text,
  title text,
  created_at timestamptz not null default now()
);

create index if not exists market_briefs_generated_at_idx
  on public.market_briefs (generated_at desc);

create index if not exists market_briefs_us_date_idx
  on public.market_briefs (us_date desc);

alter table public.market_briefs enable row level security;

drop policy if exists "No direct anon access" on public.market_briefs;
create policy "No direct anon access"
  on public.market_briefs
  for all
  using (false)
  with check (false);

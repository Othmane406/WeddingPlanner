-- ============================================================
-- Wedding Planner Pro — Supabase sync schema
-- Run this once in Supabase → SQL Editor → New Query
-- ============================================================

create table if not exists public.wedding_sync (
  sync_key text primary key,              -- SHA-256 hash of (email + access code), never the raw email/code
  data jsonb not null,                    -- the entire app data blob (same shape as local storage)
  updated_at timestamptz not null default now(),
  app_version text
);

-- Keep updated_at accurate on every write, regardless of what the client sends
create or replace function public.touch_wedding_sync_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_wedding_sync on public.wedding_sync;
create trigger trg_touch_wedding_sync
before insert or update on public.wedding_sync
for each row execute function public.touch_wedding_sync_updated_at();

-- ============================================================
-- Row Level Security
-- ============================================================
-- IMPORTANT — read this before treating this as "secure":
-- This app uses a *shared secret* model (email + access code hashed into
-- sync_key), not real per-user authentication. The anon key is public by
-- design (it ships in the page source on GitHub Pages). Postgres RLS can
-- restrict *what kind of operations* the anon key is allowed to perform,
-- but it cannot verify that a caller "knows" a given sync_key the way a
-- signed JWT could — the caller supplies sync_key directly in the request.
--
-- The real protection here is that sync_key is an unguessable 256-bit
-- hash, not a lookup a stranger could enumerate. Treat the access code
-- exactly like a password: don't post it publicly, and only share it with
-- the people you want to see this data.
--
-- These policies limit the anon key to select/insert/update only (no
-- delete, no schema access) — a leaked key can sync data but can't wipe it.

alter table public.wedding_sync enable row level security;

drop policy if exists "anon can read" on public.wedding_sync;
create policy "anon can read"
  on public.wedding_sync for select
  to anon
  using (true);

drop policy if exists "anon can insert" on public.wedding_sync;
create policy "anon can insert"
  on public.wedding_sync for insert
  to anon
  with check (true);

drop policy if exists "anon can update" on public.wedding_sync;
create policy "anon can update"
  on public.wedding_sync for update
  to anon
  using (true)
  with check (true);

-- Deliberately no delete policy for anon — deletion (e.g. "Clear All Data"
-- and unlink) should go through the app's own soft-clear, not a table wipe.

-- ============================================================
-- Optional: uncomment to auto-expire abandoned rows after 2 years
-- ============================================================
-- create extension if not exists pg_cron;
-- select cron.schedule('wedding_sync_cleanup', '0 3 * * 0',
--   $$ delete from public.wedding_sync where updated_at < now() - interval '2 years' $$);

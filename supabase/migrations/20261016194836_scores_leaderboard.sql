-- Roadster Flight: global leaderboard + realtime score feed
--
-- Apply with the Supabase CLI (project is linked to imrbbuwundepbuegqnni):
--   npx supabase db push
-- Written to be idempotent, so it is safe on a database that already has these objects.
-- Then put the Project URL and the anon / publishable key in C:\Flyingcar\.env.local
-- (see .env.example) and restart `npm run dev`.
--
-- The live audience counter ("N online / N playing") uses Realtime Presence on the
-- channel 'roadster-audience' and needs no table. Without the env vars the game keeps
-- a local leaderboard in the browser instead.

create table if not exists public.scores (
  id         bigint generated always as identity primary key,
  name       text        not null check (char_length(name) between 1 and 16),
  level      text        not null check (char_length(level) <= 24),
  score      integer     not null check (score between 0 and 1000000),
  views      bigint      not null default 0 check (views >= 0),
  time_s     real,
  created_at timestamptz not null default now()
);

create index if not exists scores_level_score_idx on public.scores (level, score desc);

-- Row level security: anyone may read the board and add a score; nobody may edit or delete.
alter table public.scores enable row level security;

grant select, insert on public.scores to anon, authenticated;

drop policy if exists "anyone can read scores" on public.scores;
create policy "anyone can read scores"
  on public.scores for select
  to anon, authenticated
  using (true);

drop policy if exists "anyone can submit a score" on public.scores;
create policy "anyone can submit a score"
  on public.scores for insert
  to anon, authenticated
  with check (
    char_length(name) between 1 and 16
    and char_length(level) <= 24
    and score between 0 and 1000000
    and views >= 0
  );

-- Realtime: broadcast new rows to the in-game score ticker.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scores'
  ) then
    alter publication supabase_realtime add table public.scores;
  end if;
end
$$;

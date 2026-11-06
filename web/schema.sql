-- D1 database "board-moves" (binding DB). Apply with:
--   node node_modules/wrangler/bin/wrangler.js d1 execute board-moves --remote --file schema.sql
create table if not exists moves (
  id text primary key,
  league_key text not null,
  team_key text not null,
  add_player_key text not null,
  add_player_name text,
  drop_player_key text,
  drop_player_name text,
  trigger_type text not null check (trigger_type in ('when_available', 'at_time')),
  run_at text,
  expires_at text not null,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  code text,
  reason text,
  result text,
  attempts integer not null default 0,
  next_check_at text not null,
  last_checked_at text,
  created_at text not null,
  updated_at text not null
);
create index if not exists moves_due on moves (status, next_check_at);

-- Yahoo login (refresh token, cached access token, scope) and small caches
create table if not exists store (
  key text primary key,
  value text not null,
  expires_at integer
);

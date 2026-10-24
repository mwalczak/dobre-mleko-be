-- Sharing a place (DM-45): a link per member and place that shows a public preview of that place only — its name,
-- category, rating, cover and who shared it — and lets the person who opens it ask to join.
create table place_shares (
  token      text primary key check (token ~ '^[A-Za-z0-9_-]{8,32}$'),
  place_id   uuid not null references places (id) on delete cascade,
  shared_by  uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  -- How many times the preview page was opened by a person (not link-preview bots).
  opens      integer not null default 0,
  unique (place_id, shared_by)
);

-- Asking to join from a shared link; an admin puts the e-mail on the list (or dismisses it).
create table join_requests (
  id           uuid primary key default gen_random_uuid(),
  email        text not null check (email = lower(email) and position('@' in email) > 1 and length(email) <= 254),
  name         text not null check (length(name) between 1 and 60),
  -- Who shared the link it came from, and which place (kept when the share or the place goes away).
  share_token  text references place_shares (token) on delete set null,
  referred_by  uuid references users (id) on delete set null,
  place_id     uuid references places (id) on delete set null,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at   timestamptz not null default now(),
  handled_by   uuid references users (id) on delete set null,
  handled_at   timestamptz
);

create unique index join_requests_pending_email_idx on join_requests (email) where status = 'pending';
create index join_requests_created_idx on join_requests (created_at desc);

alter table push_log drop constraint push_log_kind_check;
alter table push_log add constraint push_log_kind_check
  check (kind in ('new_place', 'new_comment', 'gold_star', 'member_joined', 'join_request', 'admin'));

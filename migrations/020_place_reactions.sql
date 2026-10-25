-- Reactions to a place's recommendation („Dlaczego warto”, by the person who added it) — the same eight as on
-- comments; one per person and place (picking another replaces it).
create table place_reactions (
  place_id   uuid not null references places (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  reaction   text not null check (reaction in ('love', 'like', 'haha', 'wow', 'yum', 'fire', 'sad', 'cancel')),
  created_at timestamptz not null default now(),
  primary key (place_id, user_id)
);

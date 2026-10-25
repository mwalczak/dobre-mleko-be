-- Reactions to comments and @mentions (DM-40). One reaction per person and comment (picking another replaces it).
create table comment_reactions (
  comment_id uuid not null references comments (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  reaction   text not null check (reaction in ('love', 'like', 'haha', 'wow', 'yum', 'fire', 'sad')),
  created_at timestamptz not null default now(),
  primary key (comment_id, user_id)
);

-- Members mentioned in a comment (`@Imię` in its text); they get a push notification.
create table comment_mentions (
  comment_id uuid not null references comments (id) on delete cascade,
  user_id    uuid not null references users (id) on delete cascade,
  primary key (comment_id, user_id)
);

create index comment_mentions_user_idx on comment_mentions (user_id);

alter table users add column notify_mentions boolean not null default true;

alter table push_log drop constraint push_log_kind_check;
alter table push_log add constraint push_log_kind_check
  check (kind in ('new_place', 'new_comment', 'gold_star', 'member_joined', 'join_request', 'mention', 'admin'));

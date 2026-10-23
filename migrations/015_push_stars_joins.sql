-- More push notifications: a gold star for a place I added, and someone I put on the list joining (finishing
-- onboarding). Both can be turned off, like the others.
alter table users
  add column notify_gold_stars boolean not null default true,
  add column notify_joins boolean not null default true;

alter table push_log drop constraint push_log_kind_check;
alter table push_log add constraint push_log_kind_check
  check (kind in ('new_place', 'new_comment', 'gold_star', 'member_joined', 'admin'));

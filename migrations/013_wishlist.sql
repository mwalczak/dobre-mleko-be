-- Wishlists: places a member wants to visit, seen by everyone in the network (profiles and a map layer). Not
-- regular places: no category, ratings or photos — a name, a point, an optional description and link. Marking an
-- item visited keeps it on the list with the date; it may then be added as a regular place (place_id).
create table wishlist_items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 120),
  lat         double precision not null check (lat between -90 and 90),
  lng         double precision not null check (lng between -180 and 180),
  geom        geometry(Point, 4326) generated always as (ST_SetSRID(ST_MakePoint(lng, lat), 4326)) stored,
  address     text check (char_length(address) <= 200),
  description text check (char_length(description) <= 1000),
  url         text check (char_length(url) <= 500 and url ~ '^https?://'),
  visited_on  date,
  place_id    uuid references places (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz
);
create index wishlist_items_user_idx on wishlist_items (user_id, created_at desc);
create index wishlist_items_geom_idx on wishlist_items using gist (geom);

-- When I was at a place I rated (optional; null = not given).
alter table ratings add column visited_on date;

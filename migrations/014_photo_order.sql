-- Photo order of a place, set by its author or an admin; the first photo is the cover. Photos without a position
-- (never reordered, or attached later) follow in upload order.
alter table place_photos add column position integer check (position >= 0);

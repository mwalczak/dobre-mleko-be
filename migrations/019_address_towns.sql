-- Addresses the mobile apps saved without the town ("Węgłowa 4" rather than "Węgłowa 4, Warszawa") get the
-- town filled in from OpenStreetMap by the API (src/address-towns.ts); each row is looked at once.
alter table places add column address_checked_at timestamptz;
alter table wishlist_items add column address_checked_at timestamptz;

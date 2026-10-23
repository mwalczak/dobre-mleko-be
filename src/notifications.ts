import type { Ctx } from './app.js';
import type { PushCounts } from './push.js';

/** Who an admin message goes to. */
export type Audience =
  | { kind: 'all' }
  | { kind: 'users'; user_ids: string[] }
  | { kind: 'categories'; categories: string[] };

/** The notification settings on `users`. */
export interface NotifyColumns {
  notify_new_places: 'all' | 'favorites' | 'none';
  notify_comments: boolean;
  notify_gold_stars: boolean;
  notify_joins: boolean;
}

export const toNotificationPrefs = (u: NotifyColumns) => ({
  new_places: u.notify_new_places,
  comments: u.notify_comments,
  gold_stars: u.notify_gold_stars,
  joins: u.notify_joins,
});

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * A new place: to everyone who wants all new places, and to those with its category among their favourites
 * (the default) — not to its author.
 */
export function notifyNewPlace(ctx: Ctx, placeId: string, authorId: string): void {
  ctx.notifier.background(async () => {
    const [place] = await ctx.sql<{ name: string; category: string; label: string | null; author: string }[]>`
      select p.name, p.category, c.label, u.name as author
      from places p join users u on u.id = p.added_by left join categories c on c.id = p.category
      where p.id = ${placeId}
    `;
    if (!place) return;
    const rows = await ctx.sql<{ id: string }[]>`
      select id from users
      where status = 'active' and id <> ${authorId}
        and (notify_new_places = 'all'
             or (notify_new_places = 'favorites' and ${place.category} = any(favorite_categories)))
    `;
    await ctx.notifier.deliver(
      'new_place',
      rows.map((r) => r.id),
      {
        title: clip(`Nowe miejsce: ${place.name}`, 120),
        body: `${place.author} poleca · ${place.label ?? place.category}`,
        placeId,
      },
      { kind: 'new_place', category: place.category },
    );
  });
}

/**
 * A new comment: to the place's author, others who commented on it and those who saved it — not to the commenter,
 * and only to people who want comment notifications.
 */
export function notifyComment(ctx: Ctx, placeId: string, commenterId: string, body: string): void {
  ctx.notifier.background(async () => {
    const [place] = await ctx.sql<{ name: string; commenter: string }[]>`
      select p.name, (select name from users where id = ${commenterId}) as commenter from places p where p.id = ${placeId}
    `;
    if (!place) return;
    const rows = await ctx.sql<{ id: string }[]>`
      select u.id from users u
      where u.status = 'active' and u.notify_comments and u.id <> ${commenterId}
        and (u.id = (select added_by from places where id = ${placeId})
             or exists (select 1 from comments c where c.place_id = ${placeId} and c.user_id = u.id)
             or exists (select 1 from saved_places s where s.place_id = ${placeId} and s.user_id = u.id))
    `;
    await ctx.notifier.deliver(
      'new_comment',
      rows.map((r) => r.id),
      { title: clip(`${place.commenter} o: ${place.name}`, 120), body: clip(body, 160), placeId },
      { kind: 'new_comment' },
    );
  });
}

/** A gold star: to the place's author, unless it is their own star or they turned these off. */
export function notifyGoldStar(ctx: Ctx, placeId: string, giverId: string): void {
  ctx.notifier.background(async () => {
    const [row] = await ctx.sql<{ author: string; name: string; giver: string }[]>`
      select p.added_by as author, p.name, g.name as giver
      from places p join users a on a.id = p.added_by, users g
      where p.id = ${placeId} and g.id = ${giverId}
        and a.id <> g.id and a.status = 'active' and a.notify_gold_stars
    `;
    if (!row) return;
    await ctx.notifier.deliver(
      'gold_star',
      [row.author],
      { title: clip(`Złota Gwiazdka dla: ${row.name}`, 120), body: `${row.giver} wyróżnia Twoje miejsce`, placeId },
      { kind: 'gold_star' },
    );
  });
}

/**
 * Someone joined (finished onboarding): to whoever put their e-mail on the list — the closest thing to "my invite
 * was used" while invites are not in the MVP.
 */
export function notifyJoined(ctx: Ctx, userId: string): void {
  ctx.notifier.background(async () => {
    const [row] = await ctx.sql<{ inviter: string; name: string; email: string }[]>`
      select i.id as inviter, u.name, u.email
      from users u join allowed_emails a on a.email = u.email join users i on i.id = a.added_by
      where u.id = ${userId} and i.id <> u.id and i.status = 'active' and i.notify_joins
    `;
    if (!row) return;
    await ctx.notifier.deliver(
      'member_joined',
      [row.inviter],
      { title: clip(`${row.name} dołącza do Dobrego Mleka`, 120), body: clip(`${row.email} — z Twojej listy`, 160) },
      { kind: 'member_joined' },
    );
  });
}

/** An admin message: to everyone, to chosen people, or to people with chosen favourite categories. */
export async function sendAdminMessage(
  ctx: Ctx,
  audience: Audience,
  message: { title: string; body: string; placeId: string | null },
  adminId: string,
): Promise<PushCounts> {
  const rows =
    audience.kind === 'all'
      ? await ctx.sql<{ id: string }[]>`select id from users where status = 'active'`
      : audience.kind === 'users'
        ? await ctx.sql<{ id: string }[]>`
            select id from users where status = 'active' and id = any(${audience.user_ids}::uuid[])
          `
        : await ctx.sql<{ id: string }[]>`
            select id from users where status = 'active' and favorite_categories && ${audience.categories}::text[]
          `;
  return ctx.notifier.deliver(
    'admin',
    rows.map((r) => r.id),
    message,
    audience,
    adminId,
  );
}

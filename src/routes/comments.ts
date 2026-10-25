import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { notAuthorized, notFound } from '../errors.js';
import { decodeCursor, page, pagingQuery } from '../paging.js';
import { placeAuthor, requireOwnerOrAdmin } from '../place-access.js';
import { toProfile, type ProfileJson } from '../profiles.js';
import { Comment, CommentList, REACTIONS } from '../schemas.js';
import { notifyComment, notifyMention } from '../notifications.js';

type Reaction = (typeof REACTIONS)[number];

interface CommentRow {
  id: string;
  body: string;
  created_at: Date;
  updated_at: Date | null;
  author: ProfileJson;
  author_rating: number | null;
  reactions: { reaction: Reaction; count: number; names: string[] }[];
  my_reaction: Reaction | null;
  mentions: { id: string; display_name: string }[];
  total: number;
}

const body = z.string().trim().min(1).max(1000);
const mentionIds = z
  .array(z.uuid())
  .max(20)
  .meta({ description: 'Members mentioned with `@Imię` in the text: they get a push notification' });

/** Comments with their authors, reactions and mentions, oldest first; `my_reaction` is the viewer's. */
export async function selectComments(
  ctx: Ctx,
  where: { placeId?: string; commentId?: string },
  userId: string,
  limit = 1000,
  offset = 0,
): Promise<CommentRow[]> {
  const { sql } = ctx;
  return sql<CommentRow[]>`
    select c.id, c.body, c.created_at, c.updated_at, profile_json(u) as author, r.overall as author_rating,
           coalesce((
             select json_agg(json_build_object('reaction', x.reaction, 'count', x.count, 'names', x.names))
             from (
               select cr.reaction, count(*)::int as count, array_agg(ru.name order by cr.created_at) as names
               from comment_reactions cr join users ru on ru.id = cr.user_id
               where cr.comment_id = c.id
               group by cr.reaction
             ) x
           ), '[]') as reactions,
           (select cr.reaction from comment_reactions cr where cr.comment_id = c.id and cr.user_id = ${userId})
             as my_reaction,
           coalesce((
             select json_agg(json_build_object('id', mu.id, 'display_name', mu.name) order by mu.name)
             from comment_mentions m join users mu on mu.id = m.user_id
             where m.comment_id = c.id
           ), '[]') as mentions,
           (count(*) over ())::int as total
    from comments c
    join users u on u.id = c.user_id
    left join ratings r on r.user_id = c.user_id and r.place_id = c.place_id
    where ${where.commentId ? sql`c.id = ${where.commentId}` : sql`c.place_id = ${where.placeId!}`}
    order by c.created_at, c.id
    limit ${limit} offset ${offset}
  `;
}

const order = (reaction: Reaction) => REACTIONS.indexOf(reaction);

/** Reaction counts in display order. */
export const sortReactions = <T extends { reaction: Reaction }>(reactions: T[]) =>
  [...reactions].sort((a, b) => order(a.reaction) - order(b.reaction));

export const toComment = (ctx: Ctx, r: CommentRow, userId: string) => ({
  id: r.id,
  body: r.body,
  author: toProfile(r.author, ctx.urls),
  author_rating: r.author_rating,
  is_mine: r.author.id === userId,
  created_at: r.created_at.toISOString(),
  updated_at: r.updated_at?.toISOString() ?? null,
  reactions: sortReactions(r.reactions),
  my_reaction: r.my_reaction,
  mentions: r.mentions,
});

export function commentRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;
  const idParams = z.object({ id: z.uuid() });

  async function loadComment(id: string, userId: string) {
    const [row] = await selectComments(ctx, { commentId: id }, userId);
    if (!row) throw notFound('Comment');
    return toComment(ctx, row, userId);
  }

  /**
   * Stores who is mentioned (active members, not the author; the rest is ignored) and returns those newly mentioned —
   * they get a notification once, also when a comment is edited.
   */
  async function saveMentions(commentId: string, authorId: string, ids: string[] | undefined): Promise<string[]> {
    if (ids === undefined) return [];
    const valid = ids.length
      ? (
          await sql<{ id: string }[]>`
            select id from users where id = any(${[...new Set(ids)]}::uuid[]) and status = 'active' and id <> ${authorId}
          `
        ).map((u) => u.id)
      : [];
    const before = (
      await sql<{ user_id: string }[]>`select user_id from comment_mentions where comment_id = ${commentId}`
    ).map((m) => m.user_id);
    await sql`delete from comment_mentions where comment_id = ${commentId} and not (user_id = any(${valid}::uuid[]))`;
    if (valid.length) {
      await sql`
        insert into comment_mentions ${sql(valid.map((user_id) => ({ comment_id: commentId, user_id })))}
        on conflict do nothing
      `;
    }
    return valid.filter((id) => !before.includes(id));
  }

  async function commentAuthor(id: string): Promise<string> {
    const [c] = await sql<{ user_id: string }[]>`select user_id from comments where id = ${id}`;
    if (!c) throw notFound('Comment');
    return c.user_id;
  }

  app.get(
    '/places/:id/comments',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Comments on a place',
        description: 'Oldest first. `GET /places/{id}` already includes all of them; this pages through them.',
        params: idParams,
        querystring: z.object({ ...pagingQuery() }),
        response: { 200: CommentList },
      },
    },
    async (req) => {
      await placeAuthor(ctx, req.params.id);
      const offset = decodeCursor(req.query.cursor);
      const rows = await selectComments(ctx, { placeId: req.params.id }, req.user.id, req.query.limit, offset);
      return page(
        rows.map((r) => toComment(ctx, r, req.user.id)),
        offset,
        rows[0]?.total ?? 0,
      );
    },
  );

  app.post(
    '/places/:id/comments',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Add a comment',
        description:
          '1–1000 characters after trimming. `mention_ids`: members mentioned with `@Imię` — they get a push ' +
          'notification (`notifications.mentions`) instead of the usual one about a new comment.',
        params: idParams,
        body: z.object({ body, mention_ids: mentionIds.default([]) }),
        response: { 201: Comment },
      },
    },
    async (req, reply) => {
      await placeAuthor(ctx, req.params.id);
      const [created] = await sql<{ id: string }[]>`
        insert into comments (place_id, user_id, body) values (${req.params.id}, ${req.user.id}, ${req.body.body})
        returning id
      `;
      const mentioned = await saveMentions(created!.id, req.user.id, req.body.mention_ids);
      notifyMention(ctx, created!.id, mentioned);
      notifyComment(ctx, req.params.id, req.user.id, req.body.body, mentioned);
      return reply.status(201).send(await loadComment(created!.id, req.user.id));
    },
  );

  app.patch(
    '/comments/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Edit my comment',
        description: 'With `mention_ids` the mentions are replaced; members mentioned anew get a notification.',
        params: idParams,
        body: z.object({ body, mention_ids: mentionIds.optional() }),
        response: { 200: Comment },
      },
    },
    async (req) => {
      if ((await commentAuthor(req.params.id)) !== req.user.id) {
        throw notAuthorized('Only the author can edit a comment');
      }
      await sql`update comments set body = ${req.body.body}, updated_at = now() where id = ${req.params.id}`;
      notifyMention(ctx, req.params.id, await saveMentions(req.params.id, req.user.id, req.body.mention_ids));
      return loadComment(req.params.id, req.user.id);
    },
  );

  app.put(
    '/comments/:id/reaction',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'React to a comment',
        description: 'One reaction per member and comment: another one replaces it. Also on my own comments.',
        params: idParams,
        body: z.object({ reaction: z.enum(REACTIONS) }),
        response: { 200: Comment },
      },
    },
    async (req) => {
      await commentAuthor(req.params.id);
      await sql`
        insert into comment_reactions (comment_id, user_id, reaction)
        values (${req.params.id}, ${req.user.id}, ${req.body.reaction})
        on conflict (comment_id, user_id) do update set reaction = excluded.reaction, created_at = now()
      `;
      return loadComment(req.params.id, req.user.id);
    },
  );

  app.delete(
    '/comments/:id/reaction',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Take back my reaction',
        params: idParams,
        response: { 200: Comment },
      },
    },
    async (req) => {
      await commentAuthor(req.params.id);
      await sql`delete from comment_reactions where comment_id = ${req.params.id} and user_id = ${req.user.id}`;
      return loadComment(req.params.id, req.user.id);
    },
  );

  app.delete(
    '/comments/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Comments'],
        summary: 'Delete a comment',
        description: 'The author or an admin.',
        params: idParams,
      },
    },
    async (req, reply) => {
      requireOwnerOrAdmin(req.user, await commentAuthor(req.params.id), 'delete this comment');
      await sql`delete from comments where id = ${req.params.id}`;
      return reply.status(204).send();
    },
  );
}

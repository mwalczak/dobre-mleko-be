import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError, invalidInput, notAuthorized, notFound } from '../errors.js';
import type { FileVariant } from '../file-urls.js';
import { fileInUse, lockHash, releaseFiles, THUMB_TYPE } from '../photo-store.js';
import { placeAuthor, requireOwnerOrAdmin } from '../place-access.js';
import { toPhoto } from '../places-query.js';
import { PhotoFile } from '../schemas.js';
import { readImageUpload, storeImage } from '../uploads.js';

export function photoRoutes(app: App, ctx: Ctx) {
  const { sql } = ctx;

  app.post(
    '/photos',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Photos'],
        summary: 'Upload a photo',
        description:
          'multipart/form-data with one image file (JPEG, PNG or WebP, detected from the file itself, up to ' +
          '`max_photo_bytes` from /meta) and optionally a `blurhash` field computed on the phone. Resize to about ' +
          '2048 px first. The photo is not shown anywhere until it is attached to a rating via `photo_ids` ' +
          '(`POST /places` or `PUT /places/{id}/rating`); unattached uploads are removed after 24 hours.',
        consumes: ['multipart/form-data'],
        response: { 201: PhotoFile },
      },
    },
    async (req, reply) => {
      const upload = await readImageUpload(req, ctx);
      const photo = await sql.begin(async (tx) => {
        await lockHash(tx, upload.hash);
        await storeImage(ctx, upload);
        const [row] = await tx<{ id: string }[]>`
          insert into place_photos (uploaded_by, hash, content_type, size_bytes, blurhash, width, height)
          values (${req.user.id}, ${upload.hash}, ${upload.contentType}, ${upload.size}, ${upload.blurhash},
                  ${upload.width}, ${upload.height})
          returning id
        `;
        return row!;
      });
      return reply.status(201).send(toPhoto({ id: photo.id, ...upload }, ctx.urls));
    },
  );

  app.delete(
    '/photos/:id',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Photos'],
        summary: 'Delete a photo',
        description:
          'The uploader or an admin. 409 `rating_needs_photo` for the last photo of a rating: add another one or ' +
          'remove the rating instead.',
        params: z.object({ id: z.uuid() }),
      },
    },
    async (req, reply) => {
      await sql.begin(async (tx) => {
        const [photo] = await tx<{ uploaded_by: string; place_id: string | null; hash: string }[]>`
          select uploaded_by, place_id, hash from place_photos where id = ${req.params.id} for update
        `;
        if (!photo) throw notFound('Photo');
        if (photo.uploaded_by !== req.user.id && req.user.role !== 'admin') {
          throw notAuthorized('Only the uploader or an admin can delete this photo');
        }
        if (photo.place_id) {
          const [{ n }] = await tx<[{ n: number }]>`
            select count(*)::int as n from place_photos
            where place_id = ${photo.place_id} and uploaded_by = ${photo.uploaded_by}
          `;
          const [rated] = await tx`
            select 1 from ratings where place_id = ${photo.place_id} and user_id = ${photo.uploaded_by}
          `;
          if (rated && n <= 1) throw new HttpError(409, 'rating_needs_photo', 'A rating needs at least one photo');
        }
        await tx`delete from place_photos where id = ${req.params.id}`;
        await releaseFiles(tx, ctx.photos, [photo.hash]);
      });
      return reply.status(204).send();
    },
  );

  app.put(
    '/places/:id/photos/order',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Photos'],
        summary: 'Reorder the photos of a place',
        description:
          'The person who added the place, or an admin. `photo_ids` lists all photos of the place in the new order; ' +
          'the first one is the cover. Photos attached later are added at the end.',
        params: z.object({ id: z.uuid() }),
        body: z.object({ photo_ids: z.array(z.uuid()).min(1) }),
      },
    },
    async (req, reply) => {
      requireOwnerOrAdmin(req.user, await placeAuthor(ctx, req.params.id), 'reorder these photos');
      const ids = req.body.photo_ids;
      await sql.begin(async (tx) => {
        const photos = await tx<{ id: string }[]>`
          select id from place_photos where place_id = ${req.params.id} for update
        `;
        const current = new Set(photos.map((p) => p.id));
        if (new Set(ids).size !== ids.length || ids.length !== current.size || !ids.every((id) => current.has(id))) {
          throw invalidInput('photo_ids must list every photo of this place exactly once');
        }
        await tx`
          update place_photos set position = o.position
          from unnest(${ids}::uuid[]) with ordinality as o(id, position)
          where place_photos.id = o.id
        `;
      });
      return reply.status(204).send();
    },
  );

  // Photo and avatar files. Private: the URL must carry a valid signature (handed out in API responses).
  const signed = z.object({ exp: z.coerce.number().int(), sig: z.string().max(100) });
  const hashParams = z.object({ hash: z.string().regex(/^[0-9a-f]{64}$/) });

  async function serve(hash: string, variant: FileVariant, exp: number, sig: string, reply: FastifyReply) {
    const ttl = ctx.urls.verify(hash, variant, exp, sig);
    if (ttl == null) throw notAuthorized('Invalid or expired link');
    if (!(await fileInUse(sql, hash)) || !(await ctx.photos.exists(hash, variant))) throw notFound('File');
    const type = variant === 'thumb' ? THUMB_TYPE : ((await ctx.photos.sniff(hash)) ?? 'application/octet-stream');
    return reply
      .header('content-type', type)
      .header('cache-control', `private, max-age=${ttl}, immutable`)
      .header('etag', `"${hash}-${variant}"`)
      .send(ctx.photos.read(hash, variant));
  }

  const fileSchema = (summary: string) => ({
    tags: ['Photos'],
    summary,
    description: 'Use the signed URLs from API responses; they expire after 12–24 h.',
    params: hashParams,
    querystring: signed,
  });

  app.get('/files/:hash', { schema: fileSchema('Image file') }, async (req, reply) =>
    serve(req.params.hash, 'full', req.query.exp, req.query.sig, reply),
  );
  app.get('/files/:hash/thumb', { schema: fileSchema('400 px thumbnail (JPEG)') }, async (req, reply) =>
    serve(req.params.hash, 'thumb', req.query.exp, req.query.sig, reply),
  );
}

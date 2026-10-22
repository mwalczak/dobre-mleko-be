import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError, invalidInput, notFound } from '../errors.js';
import { PmoError } from '../pmo.js';
import { CreatedReport, ReportCommentList, ReportList, ReportOptions } from '../schemas.js';

/** Attachments per report, and the size of each (nginx in dobre-mleko-web allows the sum). */
export const MAX_REPORT_FILES = 3;
export const MAX_REPORT_FILE_BYTES = 50 * 1024 * 1024;

const ReportFields = z.object({
  type: z.string().trim().min(1).max(32),
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().max(5000).optional(),
  platform: z.string().trim().max(32).optional(),
});

/** Bug reports, ideas and abuse reports, kept in PMO. Members report as themselves (their e-mail and name). */
export function reportRoutes(app: App, ctx: Ctx) {
  const { sql, pmo } = ctx;

  const unavailable = () => new HttpError(503, 'reports_unavailable', 'Reporting is not available right now');
  /** Runs a PMO call, turning its failures into API errors. */
  async function viaPmo<T>(call: () => Promise<T>): Promise<T> {
    if (!pmo.configured) throw unavailable();
    try {
      return await call();
    } catch (error) {
      if (!(error instanceof PmoError)) throw error;
      if (error.status === 400) throw invalidInput(error.message);
      if (error.status === 404) throw notFound('Report');
      app.log.error({ err: error }, 'PMO request failed');
      throw unavailable();
    }
  }

  app.get(
    '/reports/options',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Reports'],
        summary: 'What can be reported',
        description:
          'The issue types and platforms the report form offers, with their labels, as configured in the issue ' +
          'tracker (PMO). Show them in this order; preselect the platform the app runs on. 503 `reports_unavailable` ' +
          'when the tracker cannot be reached.',
        response: { 200: ReportOptions },
      },
    },
    async () => viaPmo(() => pmo.reportOptions()),
  );

  app.get(
    '/reports',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Reports'],
        summary: 'Reported issues',
        description:
          'Bugs, ideas and abuse reports members have filed in the current milestone (searches with `q` cover all), newest first, so they can check before filing the same ' +
          'thing again. Abuse reports are private and never listed, nor are types members cannot report (such as the ' +
          'admins’ todos), so a page may hold fewer than `limit`. `q` searches titles and descriptions, tolerating ' +
          'typos, and sorts by relevance. 503 `reports_unavailable` when the issue tracker cannot be reached.',
        querystring: z.object({
          status: z
            .enum(['open', 'closed'])
            .optional()
            .meta({
              description:
                '`open`: reported, accepted, in progress, in review or waiting for release; `closed`: done, won’t fix ' +
                'or duplicate',
            }),
          q: z.string().trim().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: ReportList },
      },
    },
    async (req) => {
      const [options, page] = await viaPmo(() =>
        Promise.all([pmo.reportOptions(), pmo.listIssues({ ...req.query, q: req.query.q || undefined })]),
      );
      // Only what members can report: other types (e.g. the admins' todos) are internal.
      const offered = new Set(options.issue_types.map((t) => t.id));
      const items = page.items
        .filter((i) => offered.has(i.type))
        .map((i) => ({ ...i, comment_count: i.comment_count ?? 0 }));
      return { items, next_offset: page.next_offset };
    },
  );

  app.get(
    '/reports/:key/comments',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Reports'],
        summary: 'Comments on a report',
        description:
          'Comments from the admins (or others) on a report, oldest first, e.g. why it won’t be fixed. ' +
          '`comment_count` on a report says whether there are any.',
        params: z.object({ key: z.string().meta({ example: 'DM-12' }) }),
        response: { 200: ReportCommentList },
      },
    },
    async (req) => {
      const key = req.params.key.toUpperCase();
      if (!pmo.isIssueKey(key)) throw notFound('Report');
      const comments = await viaPmo(() => pmo.listComments(key));
      return {
        items: comments.map((c) => ({ id: c.id, body: c.body, author: c.author.name, created_at: c.created_at })),
      };
    },
  );

  app.post(
    '/reports',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Reports'],
        summary: 'Report a bug, an idea or abuse',
        description:
          'multipart/form-data with the fields `type` (an id from GET /reports/options), `title` (3–200 characters), ' +
          'optionally `description` (up to 5000) and `platform` (an id from the options), and up to ' +
          `${MAX_REPORT_FILES} screenshots or recordings in \`file\` fields (images or videos, up to ` +
          `${MAX_REPORT_FILE_BYTES / 1024 / 1024} MB each). Files the tracker rejects are listed in ` +
          '`failed_files`; the report is filed anyway. The report goes to the issue tracker with my e-mail and name; ' +
          'the first time, it e-mails me a personal key for following my reports, and it e-mails me when their ' +
          'status changes. Abuse reports are private: only the admins and I see them.',
        consumes: ['multipart/form-data'],
        response: { 201: CreatedReport },
      },
    },
    async (req, reply) => {
      if (!pmo.configured) throw unavailable();
      const dir = await mkdtemp(join(tmpdir(), 'report-'));
      try {
        const fields: Record<string, string> = {};
        const files: { path: string; filename: string; type: string }[] = [];
        const parts = req.parts({
          limits: { files: MAX_REPORT_FILES, fileSize: MAX_REPORT_FILE_BYTES, fields: 10, fieldSize: 10_000 },
        });
        for await (const part of parts) {
          if (part.type === 'field') {
            if (typeof part.value === 'string') fields[part.fieldname] = part.value;
            continue;
          }
          if (!/^(image|video)\//.test(part.mimetype)) {
            part.file.resume();
            throw new HttpError(415, 'unsupported_type', 'Attach images or videos only');
          }
          const path = join(dir, randomUUID());
          await pipeline(part.file, createWriteStream(path));
          if (part.file.truncated) {
            throw new HttpError(
              413,
              'file_too_large',
              `Files can be at most ${MAX_REPORT_FILE_BYTES / 1024 / 1024} MB`,
            );
          }
          files.push({ path, filename: part.filename || 'attachment', type: part.mimetype });
        }

        const parsed = ReportFields.safeParse(fields);
        if (!parsed.success) throw invalidInput(parsed.error.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
        const body = parsed.data;
        const options = await viaPmo(() => pmo.reportOptions());
        if (!options.issue_types.some((t) => t.id === body.type)) throw invalidInput(`Unknown type ${body.type}`);
        if (body.platform && !options.platforms.some((p) => p.id === body.platform)) {
          throw invalidInput(`Unknown platform ${body.platform}`);
        }

        const [user] = await sql<{ name: string | null }[]>`select name from users where id = ${req.user.id}`;
        const issue = await viaPmo(() =>
          pmo.reportIssue({
            type: body.type,
            title: body.title,
            description: body.description || null,
            platform: body.platform || null,
            reporter: { email: req.user.email, name: user?.name ?? null },
          }),
        );
        const failed: string[] = [];
        for (const file of files) {
          try {
            await pmo.attach(issue.key, file);
          } catch (error) {
            req.log.warn({ err: error, issue: issue.key }, 'attachment not accepted by PMO');
            failed.push(file.filename);
          }
        }
        return reply.status(201).send({
          ...issue,
          comment_count: issue.comment_count ?? 0,
          attachments: files.length - failed.length,
          failed_files: failed,
        });
      } catch (error) {
        const e = error as { code?: string };
        if (e.code === 'FST_FILES_LIMIT') throw invalidInput(`At most ${MAX_REPORT_FILES} files`);
        if (e.code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') throw invalidInput('Expected multipart/form-data');
        throw error;
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
}

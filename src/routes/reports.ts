import { z } from 'zod';
import type { App, Ctx } from '../app.js';
import { HttpError, invalidInput } from '../errors.js';
import { ISSUE_TYPES, PmoError } from '../pmo.js';
import { Report, ReportList } from '../schemas.js';

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
      app.log.error({ err: error }, 'PMO request failed');
      throw unavailable();
    }
  }

  app.get(
    '/reports',
    {
      preHandler: ctx.auth,
      schema: {
        tags: ['Reports'],
        summary: 'Reported issues',
        description:
          'Bugs, ideas and abuse reports members have filed, newest first, so they can check before filing the same ' +
          'thing again. Abuse reports are private and never listed. `q` searches titles and descriptions, tolerating ' +
          'typos, and sorts by relevance. 503 `reports_unavailable` when the issue tracker cannot be reached.',
        querystring: z.object({
          status: z.enum(['open', 'closed']).optional().meta({
            description: '`open`: reported, accepted or in progress; `closed`: done, won’t fix or duplicate',
          }),
          q: z.string().trim().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
          offset: z.coerce.number().int().min(0).default(0),
        }),
        response: { 200: ReportList },
      },
    },
    async (req) => {
      const page = await viaPmo(() => pmo.listIssues({ ...req.query, q: req.query.q || undefined }));
      return { items: page.items, next_offset: page.next_offset };
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
          'Files the report in the issue tracker with my e-mail and name. The first time, the tracker e-mails me a ' +
          'personal key for following my reports; it also e-mails me when their status changes. Abuse reports are ' +
          'private: only the admins and I see them.',
        body: z.object({
          type: z.enum(ISSUE_TYPES),
          title: z.string().trim().min(3).max(200),
          description: z.string().trim().max(5000).optional(),
        }),
        response: { 201: Report },
      },
    },
    async (req, reply) => {
      const [user] = await sql<{ name: string | null }[]>`select name from users where id = ${req.user.id}`;
      const issue = await viaPmo(() =>
        pmo.reportIssue({
          type: req.body.type,
          title: req.body.title,
          description: req.body.description || null,
          reporter: { email: req.user.email, name: user?.name ?? null },
        }),
      );
      return reply.status(201).send(issue);
    },
  );
}

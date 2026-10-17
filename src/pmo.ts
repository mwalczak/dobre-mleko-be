/**
 * Client for PMO (https://github.com/mwalczak/pmo), the issue tracker that bug reports, ideas and abuse reports go
 * to. This server calls it with the app's key; members never see that key.
 */

export const ISSUE_TYPES = ['bug', 'idea', 'abuse'] as const;
export const ISSUE_STATUSES = ['reported', 'accepted', 'in_progress', 'done', 'wont_fix', 'duplicate'] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export interface PmoIssue {
  key: string;
  type: IssueType;
  priority: string;
  status: (typeof ISSUE_STATUSES)[number];
  title: string;
  description: string | null;
  private: boolean;
  duplicate_of: string | null;
  created_at: string;
  updated_at: string;
}

/** PMO answered with an error, or could not be reached (`status` 0). */
export class PmoError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class Pmo {
  constructor(private readonly opts: { url: string; key: string; project: string; fetch: typeof fetch }) {}

  /** Reporting is off until PMO_API_URL and PMO_API_KEY are set. */
  get configured(): boolean {
    return Boolean(this.opts.url && this.opts.key);
  }

  listIssues(query: { status?: string; q?: string; limit: number; offset: number }) {
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
    if (query.status) params.set('status', query.status);
    if (query.q) params.set('q', query.q);
    return this.call<{ items: PmoIssue[]; next_offset: number | null }>('GET', `/issues?${params}`);
  }

  /** Reports an issue for a member; PMO e-mails them a personal key the first time. */
  reportIssue(issue: {
    type: IssueType;
    title: string;
    description: string | null;
    reporter: { email: string; name: string | null };
  }) {
    return this.call<PmoIssue>('POST', '/issues', issue);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const url = `${this.opts.url.replace(/\/+$/, '')}/v1/projects/${this.opts.project}${path}`;
    let res: Response;
    try {
      res = await this.opts.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new PmoError(0, `PMO unreachable: ${(error as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new PmoError(res.status, json.message ?? res.statusText);
    return json as T;
  }
}

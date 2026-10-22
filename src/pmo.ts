/**
 * Client for PMO (https://github.com/mwalczak/pmo), the issue tracker that bug reports, ideas and abuse reports go
 * to. This server calls it with the app's key; members never see that key.
 */
import { openAsBlob } from 'node:fs';

/** An issue type or platform the project offers, with the label to show (in the project's language). */
export interface PmoChoice {
  id: string;
  label: string;
}

export interface PmoIssue {
  key: string;
  type: string;
  priority: string;
  /** `reported`, `accepted`, `in_progress`, `in_review`, `waiting_for_release`, `done`, `wont_fix`, `duplicate`, … */
  status: string;
  title: string;
  description: string | null;
  platform: string | null;
  private: boolean;
  duplicate_of: string | null;
  /** Public comments; missing from PMO versions before comments. */
  comment_count?: number;
  created_at: string;
  updated_at: string;
}

export interface PmoComment {
  id: string;
  body: string;
  author: { kind: string; name: string | null };
  created_at: string;
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

/** How long the project's issue types and platforms are cached. */
const OPTIONS_TTL_MS = 5 * 60_000;

export class Pmo {
  private options: { value: { issue_types: PmoChoice[]; platforms: PmoChoice[] }; until: number } | null = null;

  constructor(
    private readonly opts: { url: string; key: string; project: string; fetch: typeof fetch; now?: () => number },
  ) {}

  /** Reporting is off until PMO_API_URL and PMO_API_KEY are set. */
  get configured(): boolean {
    return Boolean(this.opts.url && this.opts.key);
  }

  /** What the report form offers: the project's issue types and platforms, as configured in PMO. */
  async reportOptions(): Promise<{ issue_types: PmoChoice[]; platforms: PmoChoice[] }> {
    const now = (this.opts.now ?? Date.now)();
    if (this.options && this.options.until > now) return this.options.value;
    const project = await this.call<{ issue_types: PmoChoice[]; platforms: PmoChoice[] }>(
      'GET',
      `/v1/projects/${this.opts.project}`,
    );
    const value = { issue_types: project.issue_types, platforms: project.platforms };
    this.options = { value, until: now + OPTIONS_TTL_MS };
    return value;
  }

  listIssues(query: { status?: string; q?: string; limit: number; offset: number }) {
    const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset) });
    if (query.status) params.set('status', query.status);
    // PMO lists the open milestone's issues by default; a search looks through all, so older reports are found too.
    if (query.q) {
      params.set('q', query.q);
      params.set('milestone', 'all');
    }
    return this.call<{ items: PmoIssue[]; next_offset: number | null }>(
      'GET',
      `/v1/projects/${this.opts.project}/issues?${params}`,
    );
  }

  /** Public comments on an issue, oldest first (PMO never shows apps internal ones). */
  listComments(issueKey: string) {
    return this.call<PmoComment[]>('GET', `/v1/issues/${issueKey}/comments`);
  }

  /** The project's issue key format, e.g. DM-12. */
  isIssueKey(key: string): boolean {
    return new RegExp(`^${this.opts.project}-[1-9][0-9]{0,8}$`).test(key);
  }

  /** Reports an issue for a member; PMO e-mails them a personal key the first time. */
  reportIssue(issue: {
    type: string;
    title: string;
    description: string | null;
    platform: string | null;
    reporter: { email: string; name: string | null };
  }) {
    return this.call<PmoIssue>('POST', `/v1/projects/${this.opts.project}/issues`, JSON.stringify(issue));
  }

  /** Attaches a screenshot or recording, streamed from a file on disk. */
  async attach(issueKey: string, file: { path: string; filename: string; type: string }) {
    const form = new FormData();
    form.append('file', await openAsBlob(file.path, { type: file.type }), file.filename);
    return this.call<{ id: string; kind: string }>('POST', `/v1/issues/${issueKey}/attachments`, form, 120_000);
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: string | FormData, timeoutMs = 10_000) {
    let res: Response;
    try {
      res = await this.opts.fetch(this.opts.url.replace(/\/+$/, '') + path, {
        method,
        headers: {
          authorization: `Bearer ${this.opts.key}`,
          ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new PmoError(0, `PMO unreachable: ${(error as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { message?: string };
    if (!res.ok) throw new PmoError(res.status, json.message ?? res.statusText);
    return json as T;
  }
}

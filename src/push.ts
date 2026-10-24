import { connect, type ClientHttp2Session } from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import type { Sql } from './db.js';

/** A device to notify (a row of `devices`). */
export interface PushTarget {
  token: string;
  platform: 'ios' | 'android';
  environment: 'sandbox' | 'production';
  app_id: string;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Opens this place when the notification is tapped. */
  placeId?: string | null;
}

/** `gone`: the token is no longer valid (app removed, notifications reset) — the device is forgotten. */
export type PushResult = 'delivered' | 'gone' | 'failed';

export interface PushSender {
  /** False without credentials: nothing is sent, every device counts as failed. */
  readonly configured: boolean;
  send(target: PushTarget, message: PushMessage): Promise<PushResult>;
  close(): void;
}

export interface ApnsCredentials {
  /** Contents of the .p8 key (PEM); `\n` escapes are accepted. */
  key: string;
  keyId: string;
  teamId: string;
}

/** Firebase service account (its JSON key file): the project and the account that signs token requests. */
export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  /** PEM private key; `\n` escapes are accepted. */
  privateKey: string;
}

/** Without credentials for a platform (local development, tests). */
export class DisabledPushSender implements PushSender {
  readonly configured = false;
  async send(): Promise<PushResult> {
    return 'failed';
  }
  close(): void {}
}

const APNS_HOSTS = {
  production: 'https://api.push.apple.com',
  sandbox: 'https://api.sandbox.push.apple.com',
} as const;

/** Reasons APNs gives for tokens that will never work again. */
const GONE_REASONS = new Set(['BadDeviceToken', 'Unregistered', 'DeviceTokenNotForTopic']);

/**
 * Apple Push Notification service over HTTP/2 with a token (.p8 key): one connection per environment, a JWT
 * refreshed every 50 minutes (Apple accepts 20–60).
 */
export class ApnsSender implements PushSender {
  readonly configured = true;
  private sessions = new Map<string, ClientHttp2Session>();
  private jwt: { value: string; at: number } | null = null;

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly now: () => number = Date.now,
    /** APNs hosts per environment (tests point them at a local HTTP/2 server). */
    private readonly hosts: Record<PushTarget['environment'], string> = APNS_HOSTS,
  ) {}

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    if (target.platform !== 'ios') return 'failed'; // Android: FcmSender.
    const payload = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
      ...(message.placeId ? { place_id: message.placeId } : {}),
    });
    const { status, reason } = await this.request(target, payload, await this.token());
    if (status === 200) return 'delivered';
    if (status === 410 || (status === 400 && reason && GONE_REASONS.has(reason))) return 'gone';
    return 'failed';
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }

  private async token(): Promise<string> {
    const at = Math.floor(this.now() / 1000);
    if (this.jwt && at - this.jwt.at < 50 * 60) return this.jwt.value;
    const key = await importPKCS8(this.credentials.key.replace(/\\n/g, '\n'), 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.credentials.keyId })
      .setIssuer(this.credentials.teamId)
      .setIssuedAt(at)
      .sign(key);
    this.jwt = { value, at };
    return value;
  }

  private session(environment: PushTarget['environment']): ClientHttp2Session {
    const existing = this.sessions.get(environment);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(this.hosts[environment]);
    session.on('error', () => this.sessions.delete(environment));
    session.on('close', () => this.sessions.delete(environment));
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  private request(target: PushTarget, payload: string, jwt: string): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve) => {
      const req = this.session(target.environment).request({
        ':method': 'POST',
        ':path': `/3/device/${target.token}`,
        authorization: `bearer ${jwt}`,
        'apns-topic': target.app_id,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0;
      let body = '';
      req.setEncoding('utf8');
      req.setTimeout(10_000, () => req.close());
      req.on('response', (headers) => (status = Number(headers[':status'])));
      req.on('data', (chunk: string) => (body += chunk));
      req.on('end', () => {
        let reason: string | undefined;
        try {
          reason = body ? (JSON.parse(body) as { reason?: string }).reason : undefined;
        } catch {
          reason = undefined;
        }
        resolve({ status, reason });
      });
      req.on('error', () => resolve({ status: 0 }));
      req.end(payload);
    });
  }
}

/** Google endpoints (tests point them at a local server). */
export interface FcmEndpoints {
  token: string;
  send: string;
}

const FCM_ENDPOINTS: FcmEndpoints = {
  token: 'https://oauth2.googleapis.com/token',
  send: 'https://fcm.googleapis.com',
};

/** Error codes FCM gives for tokens that will never work again (app removed, token from another project). */
const FCM_GONE = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);

/**
 * Firebase Cloud Messaging (HTTP v1) for Android: an OAuth access token from the service account (a signed JWT
 * exchanged at Google, refreshed every 50 minutes; Google gives an hour), then one request per device. A
 * notification message — Android shows it itself in the background (the app's default channel) — with `place_id`
 * in the data, which the app opens when the notification is tapped.
 */
export class FcmSender implements PushSender {
  readonly configured = true;
  private access: { value: string; at: number } | null = null;

  constructor(
    private readonly credentials: FcmCredentials,
    private readonly now: () => number = Date.now,
    private readonly endpoints: FcmEndpoints = FCM_ENDPOINTS,
  ) {}

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    if (target.platform !== 'android') return 'failed';
    const body = JSON.stringify({
      message: {
        token: target.token,
        notification: { title: message.title, body: message.body },
        ...(message.placeId ? { data: { place_id: message.placeId } } : {}),
        android: { priority: 'HIGH', notification: { sound: 'default' } },
      },
    });
    const res = await fetch(`${this.endpoints.send}/v1/projects/${this.credentials.projectId}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'delivered';
    if (res.status === 404) return 'gone';
    const error = (await res.json().catch(() => null)) as {
      error?: { details?: { errorCode?: string }[] };
    } | null;
    const code = error?.error?.details?.find((d) => d.errorCode)?.errorCode;
    return code && FCM_GONE.has(code) ? 'gone' : 'failed';
  }

  close(): void {}

  private async token(): Promise<string> {
    const at = Math.floor(this.now() / 1000);
    if (this.access && at - this.access.at < 50 * 60) return this.access.value;
    const key = await importPKCS8(this.credentials.privateKey.replace(/\\n/g, '\n'), 'RS256');
    const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/firebase.messaging' })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.credentials.clientEmail)
      .setAudience(this.endpoints.token)
      .setIssuedAt(at)
      .setExpirationTime(at + 3600)
      .sign(key);
    const res = await fetch(this.endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`FCM access token: HTTP ${res.status}`);
    const { access_token } = (await res.json()) as { access_token: string };
    this.access = { value: access_token, at };
    return access_token;
  }
}

/** iOS devices through APNs, Android through FCM; a platform without credentials is not sent to. */
export class PlatformPushSender implements PushSender {
  constructor(private readonly senders: Record<PushTarget['platform'], PushSender>) {}

  get configured(): boolean {
    return this.senders.ios.configured || this.senders.android.configured;
  }

  send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    return this.senders[target.platform].send(target, message);
  }

  close(): void {
    this.senders.ios.close();
    this.senders.android.close();
  }
}

export type PushKind = 'new_place' | 'new_comment' | 'gold_star' | 'member_joined' | 'join_request' | 'admin';

export interface PushCounts {
  recipients: number;
  devices: number;
  delivered: number;
  failed: number;
}

/**
 * Sends a message to people's devices, forgets tokens APNs or FCM reject for good, and logs what was sent. Event
 * notifications (new place, comment) run in the background so the request does not wait for Apple or Google.
 */
export class Notifier {
  private pending = new Set<Promise<unknown>>();

  constructor(
    private readonly sql: Sql,
    readonly sender: PushSender,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  async deliver(
    kind: PushKind,
    userIds: string[],
    message: PushMessage,
    audience: Record<string, unknown>,
    sentBy: string | null = null,
  ): Promise<PushCounts> {
    const recipients = [...new Set(userIds)];
    const devices = recipients.length
      ? await this.sql<PushTarget[]>`
          select token, platform, environment, app_id from devices where user_id = any(${recipients}::uuid[])
        `
      : [];
    const results = await Promise.all(
      devices.map((d) => this.sender.send(d, message).catch((): PushResult => 'failed')),
    );
    const gone = devices.filter((_, i) => results[i] === 'gone').map((d) => d.token);
    if (gone.length) await this.sql`delete from devices where token = any(${gone})`;
    const counts = {
      recipients: recipients.length,
      devices: devices.length,
      delivered: results.filter((r) => r === 'delivered').length,
      failed: results.filter((r) => r !== 'delivered').length,
    };
    await this.sql`
      insert into push_log (kind, title, body, place_id, sent_by, audience, recipients, devices, delivered, failed)
      values (${kind}, ${message.title}, ${message.body}, ${message.placeId ?? null}, ${sentBy},
              ${this.sql.json(audience as never)}, ${counts.recipients}, ${counts.devices}, ${counts.delivered},
              ${counts.failed})
    `;
    return counts;
  }

  /** Runs after the response; errors are only logged. */
  background(work: () => Promise<unknown>): void {
    const run = work().catch(this.onError);
    this.pending.add(run);
    void run.finally(() => this.pending.delete(run));
  }

  /** Waits for background notifications (tests, shutdown). */
  async settle(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}

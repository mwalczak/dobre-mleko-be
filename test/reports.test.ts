import { describe, expect, it } from 'vitest';
import { login, multipart, pmo, setup, type TestApp, type Who } from './helpers.js';

const h = setup();

/** POST /reports as multipart: fields, then files. */
function report(
  app: TestApp,
  who: Who,
  fields: Record<string, string>,
  files: { name: string; type: string; value: Buffer }[] = [],
) {
  const { payload, contentType } = multipart([
    ...Object.entries(fields).map(([name, value]) => ({ name, value })),
    ...files.map((f) => ({ name: 'file', value: f.value, filename: f.name, type: f.type })),
  ]);
  return app.inject({
    method: 'POST',
    url: '/reports',
    headers: { ...who.headers, 'content-type': contentType },
    payload,
  });
}

const PNG = Buffer.from('\x89PNG\r\n\x1a\nfake');

describe('reports', () => {
  it('offers the issue types and platforms configured in PMO, cached', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const res = await h.app.inject({ method: 'GET', url: '/reports/options', headers: ola.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(pmo.options);
    await h.app.inject({ method: 'GET', url: '/reports/options', headers: ola.headers });
    expect(pmo.requests.filter((r) => r.url === '/v1/projects/DM')).toHaveLength(1);
  });

  it('files a report with screenshots in PMO as the signed-in member', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const res = await report(
      h.app,
      ola,
      { type: 'bug', title: '  Mapa się nie ładuje ', description: 'Biały ekran', platform: 'web' },
      [
        { name: 'ekran.png', type: 'image/png', value: PNG },
        { name: 'nagranie.mp4', type: 'video/mp4', value: Buffer.alloc(2048, 1) },
        { name: 'zepsuty.bad', type: 'image/png', value: PNG },
      ],
    );
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      key: 'DM-1',
      type: 'bug',
      status: 'reported',
      priority: 'P3',
      title: 'Mapa się nie ładuje',
      description: 'Biały ekran',
      platform: 'web',
      private: false,
      duplicate_of: null,
      comment_count: 0,
      created_at: expect.any(String),
      updated_at: expect.any(String),
      attachments: 2,
      failed_files: ['zepsuty.bad'],
    });
    expect(res.json()).not.toHaveProperty('reporter');

    const created = pmo.requests.find((r) => r.method === 'POST' && r.url === '/v1/projects/DM/issues');
    expect(created).toEqual({
      method: 'POST',
      url: '/v1/projects/DM/issues',
      authorization: 'Bearer pmo_a_test',
      body: {
        type: 'bug',
        title: 'Mapa się nie ładuje',
        description: 'Biały ekran',
        platform: 'web',
        reporter: { email: 'ola@gmail.com', name: 'Ola' },
      },
    });
    expect(pmo.attachments).toEqual([
      { issue: 'DM-1', filename: 'ekran.png', type: 'image/png', size: PNG.length },
      { issue: 'DM-1', filename: 'nagranie.mp4', type: 'video/mp4', size: 2048 },
    ]);
  });

  it('checks the type, platform and files before filing', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const cases: [Record<string, string>, { name: string; type: string; value: Buffer }[], number][] = [
      [{ type: 'complaint', title: 'Coś tam' }, [], 422],
      [{ type: 'bug', title: 'Coś tam', platform: 'windows' }, [], 422],
      [{ type: 'bug', title: 'x' }, [], 422],
      [{ type: 'bug', title: 'Coś tam' }, [{ name: 'a.pdf', type: 'application/pdf', value: PNG }], 415],
      [
        { type: 'bug', title: 'Coś tam' },
        Array.from({ length: 4 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', value: PNG })),
        422,
      ],
    ];
    for (const [fields, files, status] of cases) {
      const res = await report(h.app, ola, fields, files);
      expect(res.statusCode, JSON.stringify(fields)).toBe(status);
    }
    expect(pmo.issues).toEqual([]);
  });

  it('lists public reports, with search and status', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    for (const [type, title] of [
      ['bug', 'Mapa się nie ładuje'],
      ['abuse', 'Spam w komentarzach'],
      ['idea', 'Ciemny motyw'],
    ]) {
      await report(h.app, ola, { type: type!, title: title! });
    }
    // An admin's todo in PMO: not something members report, so not listed.
    pmo.issues.push({ ...pmo.issues[0], key: 'DM-4', type: 'todo', title: 'Odnowić certyfikat' });
    // Statuses pass through as PMO has them, including ones added later.
    pmo.issues[0]!.status = 'waiting_for_release';
    pmo.issues[2]!.status = 'some_future_status';
    pmo.requests = [];

    const all = await h.app.inject({ method: 'GET', url: '/reports?status=open', headers: ola.headers });
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((r: { key: string }) => r.key)).toEqual(['DM-1']);
    const everything = await h.app.inject({ method: 'GET', url: '/reports', headers: ola.headers });
    expect(everything.json().items.map((r: { key: string; status: string }) => [r.key, r.status])).toEqual([
      ['DM-3', 'some_future_status'],
      ['DM-1', 'waiting_for_release'],
    ]);
    expect(all.json().next_offset).toBeNull();

    const found = await h.app.inject({ method: 'GET', url: '/reports?q=mapa&limit=5', headers: ola.headers });
    expect(found.json().items.map((r: { key: string }) => r.key)).toEqual(['DM-1']);
    expect(pmo.requests.map((r) => r.url)).toEqual([
      '/v1/projects/DM/issues?limit=30&offset=0&status=open',
      '/v1/projects/DM/issues?limit=30&offset=0',
      '/v1/projects/DM/issues?limit=5&offset=0&q=mapa&milestone=all',
    ]);
  });

  it('shows the comments on a report', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    await report(h.app, ola, { type: 'bug', title: 'Ciemna mapa' });
    pmo.issues[0]!.comment_count = 1;
    pmo.comments['DM-1'] = [
      {
        id: 'c1',
        body: 'Mapa nie ma jeszcze ciemnego stylu.',
        author: { kind: 'user', name: 'Mateusz' },
        created_at: '2026-10-18T10:00:00Z',
      },
    ];

    const list = await h.app.inject({ method: 'GET', url: '/reports', headers: ola.headers });
    expect(list.json().items[0].comment_count).toBe(1);
    const res = await h.app.inject({ method: 'GET', url: '/reports/dm-1/comments', headers: ola.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      items: [
        {
          id: 'c1',
          body: 'Mapa nie ma jeszcze ciemnego stylu.',
          author: 'Mateusz',
          created_at: '2026-10-18T10:00:00Z',
        },
      ],
    });

    // Only this project's reports, and only existing ones.
    for (const url of ['/reports/XX-1/comments', '/reports/DM-99/comments', '/reports/..%2Fadmin/comments']) {
      const missing = await h.app.inject({ method: 'GET', url, headers: ola.headers });
      expect(missing.statusCode, url).toBe(404);
    }
    expect(pmo.requests.filter((r) => r.url.includes('/comments')).map((r) => r.url)).toEqual([
      '/v1/issues/DM-1/comments',
      '/v1/issues/DM-99/comments',
    ]);
  });

  it('needs a signed-in member', async () => {
    for (const url of ['/reports', '/reports/options']) {
      const anon = await h.app.inject({ method: 'GET', url });
      expect(anon.statusCode).toBe(401);
    }
    expect(pmo.requests).toEqual([]);
  });

  it('turns PMO failures into errors the app can show', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    await h.app.inject({ method: 'GET', url: '/reports/options', headers: ola.headers }); // cache the options

    pmo.status = 400;
    const rejected = await report(h.app, ola, { type: 'bug', title: 'Coś nie działa' });
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json().error).toBe('invalid_input');

    pmo.status = 500;
    const down = await h.app.inject({ method: 'GET', url: '/reports', headers: ola.headers });
    expect(down.statusCode).toBe(503);
    expect(down.json().error).toBe('reports_unavailable');
  });

  it('is off without PMO configuration', async () => {
    const app = await h.build({ PMO_API_URL: '', PMO_API_KEY: '' });
    try {
      const ola = await login(app, 'ola@gmail.com');
      for (const res of [
        await app.inject({ method: 'GET', url: '/reports', headers: ola.headers }),
        await app.inject({ method: 'GET', url: '/reports/options', headers: ola.headers }),
        await report(app, ola, { type: 'bug', title: 'Coś tam' }),
      ]) {
        expect(res.statusCode).toBe(503);
      }
      expect(pmo.requests).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

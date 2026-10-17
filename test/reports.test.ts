import { describe, expect, it } from 'vitest';
import { login, pmo, setup } from './helpers.js';

const h = setup();

describe('reports', () => {
  it('files a report in PMO as the signed-in member', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const res = await h.app.inject({
      method: 'POST',
      url: '/reports',
      headers: ola.headers,
      payload: { type: 'bug', title: '  Mapa się nie ładuje ', description: 'Biały ekran na iPhonie' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      key: 'DM-1',
      type: 'bug',
      status: 'reported',
      priority: 'P3',
      title: 'Mapa się nie ładuje',
      description: 'Biały ekran na iPhonie',
      private: false,
      duplicate_of: null,
      created_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(res.json()).not.toHaveProperty('reporter');

    expect(pmo.requests).toEqual([
      {
        method: 'POST',
        url: '/v1/projects/DM/issues',
        authorization: 'Bearer pmo_a_test',
        body: {
          type: 'bug',
          title: 'Mapa się nie ładuje',
          description: 'Biały ekran na iPhonie',
          reporter: { email: 'ola@gmail.com', name: 'Ola' },
        },
      },
    ]);
  });

  it('lists public reports, with search and status', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    for (const [type, title] of [
      ['bug', 'Mapa się nie ładuje'],
      ['abuse', 'Spam w komentarzach'],
      ['idea', 'Ciemny motyw'],
    ]) {
      await h.app.inject({ method: 'POST', url: '/reports', headers: ola.headers, payload: { type, title } });
    }
    pmo.requests = [];

    const all = await h.app.inject({ method: 'GET', url: '/reports?status=open', headers: ola.headers });
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((r: { key: string }) => r.key)).toEqual(['DM-3', 'DM-1']);
    expect(all.json().next_offset).toBeNull();

    const found = await h.app.inject({ method: 'GET', url: '/reports?q=mapa&limit=5', headers: ola.headers });
    expect(found.json().items.map((r: { key: string }) => r.key)).toEqual(['DM-1']);
    expect(pmo.requests.map((r) => r.url)).toEqual([
      '/v1/projects/DM/issues?limit=30&offset=0&status=open',
      '/v1/projects/DM/issues?limit=5&offset=0&q=mapa',
    ]);
  });

  it('needs a signed-in member and valid input', async () => {
    const anon = await h.app.inject({ method: 'GET', url: '/reports' });
    expect(anon.statusCode).toBe(401);
    const ola = await login(h.app, 'ola@gmail.com');
    const bad = await h.app.inject({
      method: 'POST',
      url: '/reports',
      headers: ola.headers,
      payload: { type: 'complaint', title: 'x' },
    });
    expect(bad.statusCode).toBe(422);
    expect(pmo.requests).toEqual([]);
  });

  it('turns PMO failures into errors the app can show', async () => {
    const ola = await login(h.app, 'ola@gmail.com');
    const report = { type: 'bug', title: 'Coś nie działa' };

    pmo.status = 400;
    const rejected = await h.app.inject({ method: 'POST', url: '/reports', headers: ola.headers, payload: report });
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
      const res = await app.inject({ method: 'GET', url: '/reports', headers: ola.headers });
      expect(res.statusCode).toBe(503);
      expect(pmo.requests).toEqual([]);
    } finally {
      await app.close();
    }
  });
});

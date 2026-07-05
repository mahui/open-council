import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import {
  isHostAllowed,
  isOriginAllowed,
  createSecurityMiddleware,
} from '../../src/server/security.js';

const PORT = 8787;

describe('isHostAllowed', () => {
  it('accepts loopback hosts with the expected port', () => {
    expect(isHostAllowed('127.0.0.1:8787', PORT)).toBe(true);
    expect(isHostAllowed('localhost:8787', PORT)).toBe(true);
    expect(isHostAllowed('[::1]:8787', PORT)).toBe(true);
  });

  it('accepts loopback hosts without a port', () => {
    expect(isHostAllowed('localhost', PORT)).toBe(true);
    expect(isHostAllowed('127.0.0.1', PORT)).toBe(true);
  });

  it('rejects non-loopback hosts', () => {
    expect(isHostAllowed('evil.com:8787', PORT)).toBe(false);
    expect(isHostAllowed('192.168.1.5:8787', PORT)).toBe(false);
    expect(isHostAllowed('10.0.0.1', PORT)).toBe(false);
  });

  it('rejects a mismatched port', () => {
    expect(isHostAllowed('127.0.0.1:9999', PORT)).toBe(false);
  });

  it('rejects a missing or empty header', () => {
    expect(isHostAllowed(undefined, PORT)).toBe(false);
    expect(isHostAllowed('', PORT)).toBe(false);
  });
});

describe('isOriginAllowed', () => {
  it('accepts same-origin loopback origins', () => {
    expect(isOriginAllowed('http://127.0.0.1:8787', PORT)).toBe(true);
    expect(isOriginAllowed('http://localhost:8787', PORT)).toBe(true);
  });

  it('rejects cross-origin and mismatched-port origins', () => {
    expect(isOriginAllowed('http://evil.com', PORT)).toBe(false);
    expect(isOriginAllowed('http://127.0.0.1:9999', PORT)).toBe(false);
    expect(isOriginAllowed(undefined, PORT)).toBe(false);
    expect(isOriginAllowed('not-a-url', PORT)).toBe(false);
  });
});

describe('createSecurityMiddleware', () => {
  function makeApp(): Hono {
    const app = new Hono();
    app.use('*', createSecurityMiddleware({ port: PORT }));
    app.get('/ping', (c) => c.text('pong'));
    app.post('/mutate', (c) => c.text('ok'));
    return app;
  }

  it('rejects requests with an invalid Host header', async () => {
    const res = await makeApp().request('http://x/ping', { headers: { host: 'evil.com:8787' } });
    expect(res.status).toBe(403);
  });

  it('allows GET requests with a valid Host header', async () => {
    const res = await makeApp().request('http://x/ping', { headers: { host: '127.0.0.1:8787' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
  });

  it('rejects state-changing requests without a valid Origin', async () => {
    const res = await makeApp().request('http://x/mutate', {
      method: 'POST',
      headers: { host: '127.0.0.1:8787' },
    });
    expect(res.status).toBe(403);
  });

  it('allows state-changing requests with a same-origin Origin', async () => {
    const res = await makeApp().request('http://x/mutate', {
      method: 'POST',
      headers: { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects state-changing requests with a cross-origin Origin', async () => {
    const res = await makeApp().request('http://x/mutate', {
      method: 'POST',
      headers: { host: '127.0.0.1:8787', origin: 'http://evil.com' },
    });
    expect(res.status).toBe(403);
  });
});

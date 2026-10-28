import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pageFetch, pageFetchScript } from './pageFetch.ts';

describe('pageFetch', () => {
    it('runs the request inside the page and hands back status and body', async () => {
        const scripts: string[] = [];
        const fetch = pageFetch({
            executeJavaScript: async (code) => {
                scripts.push(code);
                return { ok: true, status: 200, body: '{"nextcloudUrl":"http://localhost:8081"}' };
            },
        });
        const response = await fetch('http://localhost:5176/auth/app-password-status', { method: 'GET', headers: {}, credentials: 'include' });
        assert.equal(response.ok, true);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json?.(), { nextcloudUrl: 'http://localhost:8081' });
        assert.equal(scripts.length, 1);
        assert.match(scripts[0] ?? '', /^fetch\("http:\/\/localhost:5176\/auth\/app-password-status", /);
    });

    it('passes a refusal through as a refusal', async () => {
        const fetch = pageFetch({ executeJavaScript: async () => ({ ok: false, status: 401, body: '{"error":"Not authenticated"}' }) });
        const response = await fetch('http://localhost:5176/auth/save-app-password', { method: 'POST', headers: {}, body: '{}', credentials: 'include' });
        assert.equal(response.ok, false);
        assert.equal(response.status, 401);
    });

    it('treats anything that is not a page answer as a failure', async () => {
        const fetch = pageFetch({ executeJavaScript: async () => undefined });
        const response = await fetch('http://localhost:5176/x', { method: 'GET', headers: {}, credentials: 'include' });
        assert.equal(response.ok, false);
        assert.equal(response.status, 0);
    });

    it('puts the url and the body in as data, never as code', () => {
        const hostile = '"); alert(1); ("';
        const script = pageFetchScript(`http://localhost:5176/a${hostile}`, { method: 'POST', headers: {}, body: hostile, credentials: 'include' });
        const url = `http://localhost:5176/a${hostile}`;
        const init = { method: 'POST', headers: {}, body: hostile, credentials: 'include' as const };
        assert.equal(script, `fetch(${JSON.stringify(url)}, ${JSON.stringify(init)}).then(async (r) => ({ ok: r.ok, status: r.status, body: await r.text() }))`);
        assert.ok(!script.includes('"); alert(1); ("'), 'the quote is escaped, so the string never closes early');
    });
});

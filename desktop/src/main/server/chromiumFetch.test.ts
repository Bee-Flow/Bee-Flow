import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

import { chromiumFetch, type ClientRequestLike, type IncomingLike, type NetLike } from './chromiumFetch.ts';

/**
 * A stand-in for Electron's net.request: it plays back a script of redirects,
 * then either a response or an error, the way Chromium emits them.
 */
interface Script {
    redirects?: string[];
    status?: number;
    headers?: Record<string, string | string[]>;
    body?: string;
    error?: string;
    /** Never answer; for abort tests. */
    hang?: boolean;
}

function fakeNet(script: Script): NetLike & { requests: Array<{ options: unknown; headers: Record<string, string>; aborted: boolean }> } {
    const requests: Array<{ options: unknown; headers: Record<string, string>; aborted: boolean }> = [];
    return {
        requests,
        request(options) {
            const record = { options, headers: {} as Record<string, string>, aborted: false };
            requests.push(record);
            const emitter = new EventEmitter();
            const pending = [...(script.redirects ?? [])];
            let followed = 0;
            const request = Object.assign(emitter, {
                setHeader: (name: string, value: string) => {
                    record.headers[name] = value;
                },
                followRedirect: () => {
                    followed += 1;
                    setImmediate(step);
                },
                abort: () => {
                    record.aborted = true;
                },
                end: () => setImmediate(step),
            }) as unknown as ClientRequestLike;
            const step = () => {
                if (record.aborted || script.hang) return;
                const next = pending.shift();
                if (next !== undefined) {
                    emitter.emit('redirect', 301, 'GET', next);
                    return;
                }
                if (script.error) {
                    emitter.emit('error', new Error(script.error));
                    return;
                }
                const response = new EventEmitter() as unknown as IncomingLike & EventEmitter;
                Object.assign(response, { statusCode: script.status ?? 200, headers: script.headers ?? {} });
                emitter.emit('response', response);
                setImmediate(() => {
                    if (script.body) response.emit('data', Buffer.from(script.body));
                    response.emit('end');
                });
            };
            void followed;
            return request;
        },
    };
}

describe('chromiumFetch', () => {
    it('returns status, headers and body', async () => {
        const net = fakeNet({ status: 200, headers: { 'Content-Type': 'application/json' }, body: '{"status":"ok"}' });
        const response = await chromiumFetch(net)('https://bee.example.com/api/health');
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'application/json');
        assert.equal(await response.text(), '{"status":"ok"}');
        assert.equal(response.url, 'https://bee.example.com/api/health');
    });

    it('follows redirects itself and reports where it ended up', async () => {
        // The reason this is not net.fetch: its Response.url is documented as
        // wrong, and the final address is what the probe saves.
        const net = fakeNet({ redirects: ['http://bee.example.com:8080/', 'https://www.bee.example.com/'], status: 200, body: 'x' });
        const response = await chromiumFetch(net)('http://bee.example.com/');
        assert.equal(response.url, 'https://www.bee.example.com/');
    });

    it('stops a redirect loop', async () => {
        const net = fakeNet({ redirects: Array.from({ length: 20 }, (_, i) => `https://loop.example.com/${i}`) });
        await assert.rejects(chromiumFetch(net)('https://loop.example.com/'), /ERR_TOO_MANY_REDIRECTS/);
        assert.equal(net.requests[0]?.aborted, true);
    });

    it('asks for manual redirects and no cookies, and sends the headers it is given', async () => {
        const net = fakeNet({ status: 200 });
        await chromiumFetch(net)('https://bee.example.com/', { headers: { Origin: 'https://bee.example.com', 'X-Beeflow-Client': 'desktop' } });
        const [first] = net.requests;
        assert.deepEqual(first?.options, { url: 'https://bee.example.com/', method: 'GET', redirect: 'manual', useSessionCookies: false });
        assert.deepEqual(first?.headers, { Origin: 'https://bee.example.com', 'X-Beeflow-Client': 'desktop' });
    });

    it("passes Chromium's error through untouched, for the classifier", async () => {
        const net = fakeNet({ error: 'net::ERR_CERT_AUTHORITY_INVALID' });
        await assert.rejects(chromiumFetch(net)('https://bee.example.com/'), { message: 'net::ERR_CERT_AUTHORITY_INVALID' });
    });

    it('aborts on the signal and rejects with an AbortError', async () => {
        const net = fakeNet({ hang: true });
        const controller = new AbortController();
        const pending = chromiumFetch(net)('https://slow.example.com/', { signal: controller.signal });
        controller.abort();
        await assert.rejects(pending, { name: 'AbortError' });
        assert.equal(net.requests[0]?.aborted, true);
    });
});

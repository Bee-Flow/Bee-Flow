/**
 * The "Find repeating work" routes mounted on a real HTTP server, for the
 * tests next to routes/ai/automationBuilder/suggestions.js. The router comes
 * from createSuggestionsRouter(deps), so every collaborator is injected and
 * nothing is mocked through the module system.
 *
 *   const srv = mountSuggestions(test, createSuggestionsRouter(deps), { errorHandler: terminalErrorHandler });
 *   const { status, frames } = await srv.post('/suggest', { mode: 'ideas' });
 *   const last = await srv.get('/suggest/last', { user: 'u2' });
 *
 * The signed-in user is picked per request (`user`, default 'u1'); every user
 * is in organisation 'org-1', so a test can show that scope is per user.
 * Refusals pass through the error handler the test hands in: the real
 * terminal error handler, as in index.js. It is injected rather than required
 * here because testUtils/ is platform and core/http/ is core (layering.test.js).
 */

'use strict';

const http = require('node:http');
const express = require('express');
const { parseSse } = require('./builderStreamHarness');

const ORG = 'org-1';

/** Middleware that lets every request through: auth and rate limits in a test. */
const pass = (_req, _res, next) => next();

/**
 * @param {import('node:test')} test
 * @param {Function} router
 * @param {{ prefix?: string, errorHandler: Function }} opts
 */
function mountSuggestions(test, router, { prefix = '/builder', errorHandler }) {
    if (typeof errorHandler !== 'function') throw new TypeError('mountSuggestions needs opts.errorHandler (the terminal error handler)');
    let server = null;
    let base = null;
    test.before(async () => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            const id = req.get('x-test-user') || 'u1';
            req.session = { user: { id, organizationId: ORG } };
            next();
        });
        app.use(prefix, router);
        app.use(errorHandler);
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}${prefix}`;
    });
    test.after(async () => {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    });

    /** The response as JSON when it is JSON, as SSE frames when it is a stream. */
    async function read(res) {
        const text = await res.text();
        const type = res.headers.get('content-type') || '';
        if (type.includes('text/event-stream')) return { status: res.status, frames: parseSse(text), body: null };
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
        return { status: res.status, frames: [], body };
    }

    return {
        url: (path) => `${base}${path}`,
        async post(path, body, { user = 'u1' } = {}) {
            return read(await fetch(`${base}${path}`, {
                method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': user }, body: JSON.stringify(body),
            }));
        },
        async get(path, { user = 'u1' } = {}) {
            return read(await fetch(`${base}${path}`, { headers: { 'x-test-user': user } }));
        },
    };
}

/** The `data` of every frame named `event`. */
const framesOf = (frames, event) => frames.filter((f) => f.event === event).map((f) => f.data);

module.exports = { mountSuggestions, framesOf, pass, ORG };

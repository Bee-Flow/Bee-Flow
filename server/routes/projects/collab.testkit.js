/**
 * Test kit for the co-editing route tests: the co-editing routes and the
 * project stream served over real HTTP, on top of the world from
 * core/collab/collab.testkit.js. Lives under routes/ because it mounts
 * routers; core never requires routes.
 *
 * Not a test file: required by *.test.js next to it.
 */

'use strict';

const { fakeRoleGate, passThrough, quietLog } = require('../../core/collab/collab.testkit');

/** The notebooks gates letting everybody through (a test passes its own to refuse). */
async function passNotebooks(req, res, next) { next(); }

/**
 * The co-editing routes and the project stream over real HTTP, as the given
 * users (header `x-test-user`), with the role gate from `roles`.
 * @param {any} w  a world from core/collab/collab.testkit.js collabWorld()
 * @param {Record<string, Record<string, string>>} roles
 */
function serveCollab(w, roles, { maxBodyBytes = 64 * 1024, requireNotebooks = passNotebooks } = {}) {
    const http = require('node:http');
    const express = require('express');
    const { makeCollabRouter } = require('./collab');
    const { makeProjectStreamHandler } = require('./collabStream');
    const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');
    const gate = fakeRoleGate(roles);
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    app.use((req, _res, next) => {
        const who = req.headers['x-test-user'];
        req.session = who ? { isAuthenticated: true, user: JSON.parse(who) } : {};
        next();
    });
    app.use('/api/projects', makeCollabRouter({
        requireProjectRole: gate, collab: w.collab, maxBodyBytes,
        openLimiter: passThrough, syncLimiter: passThrough, updatesLimiter: passThrough, awarenessLimiter: passThrough,
        requireNotebooks,
    }));
    const stream = express.Router();
    stream.get('/:id/stream', gate('viewer'), makeProjectStreamHandler({
        projectStore: { getProjectEventSeq: async () => 0, listProjectEvents: async () => ({ events: [], truncated: false }) },
        bus: { subscribeProject: (id, fn) => { w.bus.on(id, fn); return () => w.bus.off(id, fn); }, isDistributed: () => true },
        getProjectRole: async (u, p) => roles[p]?.[u] || null,
        collab: w.collab,
        requireNotebooks,
        log: quietLog,
    }));
    app.use('/api/projects', stream);
    app.use(terminalErrorHandler);
    const server = http.createServer(app);
    const ready = new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = async () => { await ready; return `http://127.0.0.1:${server.address().port}`; };

    async function call(method, url, { body, user } = {}) {
        const headers = { 'content-type': 'application/json' };
        if (user) headers['x-test-user'] = JSON.stringify(user);
        const res = await fetch(`${await base()}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
        return { status: res.status, body: json, text };
    }

    /** Follow the project stream; frames land in `frames` as they arrive. */
    async function openStream(path, user, onFrame) {
        const ctrl = new AbortController();
        const frames = [];
        const res = await fetch(`${await base()}${path}`, { headers: { 'x-test-user': JSON.stringify(user) }, signal: ctrl.signal });
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        const done = (async () => {
            try {
                for (;;) {
                    const { done: end, value } = await reader.read();
                    if (end) break;
                    buf += dec.decode(value, { stream: true });
                    let i;
                    while ((i = buf.indexOf('\n\n')) >= 0) {
                        const raw = buf.slice(0, i);
                        buf = buf.slice(i + 2);
                        const f = { raw };
                        for (const line of raw.split('\n')) {
                            if (line.startsWith('event: ')) f.event = line.slice(7);
                            if (line.startsWith('data: ')) f.data = JSON.parse(line.slice(6));
                        }
                        if (f.event && f.event !== 'ping') { frames.push(f); if (onFrame) onFrame(f); }
                    }
                }
            } catch (_) { /* aborted */ }
        })();
        return { frames, done, close: () => ctrl.abort() };
    }

    return { call, openStream, base, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

module.exports = { serveCollab };

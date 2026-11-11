// @typecheck
/**
 * The real-HTTP harness of the studio route tests (attention.test.js,
 * counts.test.js, search.test.js). Every dependency is injected through the
 * router's factory, so no database or pool is opened; requests go over real
 * HTTP against app.listen(0).
 */

'use strict';

const http = require('node:http');
const express = require('express');

const USER = { id: 'u1', organizationId: 'orgA' };

/**
 * `router` at /api/studio. The real mount sits behind requireAuth; here the
 * x-test-user header stands in for the session (USER with that id), so an
 * unauthenticated request can be exercised too. `errors` adds the terminal
 * error handler: a schema refusal travels as an error, answered the way
 * index.js answers it.
 * @param {import('express').RequestHandler} router
 * @param {{ errors?: boolean }} [opts]
 */
function studioApp(router, { errors = false } = {}) {
    const app = express();
    app.use((req, _res, next) => {
        const who = req.headers['x-test-user'];
        Object.assign(req, { session: who ? { isAuthenticated: true, user: { ...USER, id: who } } : {} });
        next();
    });
    app.use('/api/studio', router);
    if (errors) app.use(require('../../core/http/terminalErrorHandler').terminalErrorHandler);
    return app;
}

/**
 * One listening server per test file: `listen(app)` closes the previous one
 * and serves `app` on a free port at `baseUrl`; the last one is closed after
 * the file.
 * @param {typeof import('node:test')} test
 */
function studioServer(test) {
    /** @type {http.Server | undefined} */
    let server;
    const close = async () => {
        const open = server;
        if (open) await new Promise((resolve) => open.close(resolve));
    };
    const srv = {
        baseUrl: '',
        /** @param {import('express').Express} app */
        async listen(app) {
            await close();
            const next = http.createServer(app);
            server = next;
            await new Promise((resolve) => next.listen(0, '127.0.0.1', () => resolve(undefined)));
            srv.baseUrl = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (next.address()).port}`;
        },
    };
    test.after(close);
    return srv;
}

module.exports = { USER, studioApp, studioServer };

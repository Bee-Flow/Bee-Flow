// @typecheck
'use strict';

/**
 * Calling a router's handlers directly (no HTTP), the way the route tests that
 * sit next to routes/automation/ do: find the route on `router.stack`, run its
 * whole stack (validation included) and let core/http/terminalErrorHandler
 * answer a thrown error as it would in the server.
 *
 *   const post = runRoute(router, 'post', '/:id/run');
 *   const res = await post({ params: { id: 'a1' }, session: { user: { id: 'u1' } }, body: {} }, makeRes());
 */

const path = require('path');

/** The handlers of one route, in order. */
function findRoute(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack.map((l) => l.handle);
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

/** `(req, res) => res`: the whole stack of a route, a thrown error answered by the terminal handler. */
function runRoute(router, method, routePath) {
    const handles = findRoute(router, method, routePath);
    return async (req, res) => {
        for (const handle of handles) {
            const step = await new Promise((resolve) => {
                let settled = false;
                const done = (v) => { if (!settled) { settled = true; resolve(v); } };
                Promise.resolve().then(() => handle(req, res, (err) => done({ passed: true, err })))
                    .then(() => done({ passed: false }), (e) => done({ passed: true, err: e }));
            });
            if (!step.passed) return res;
            if (step.err) {
                require(path.join(__dirname, '..', 'core/http/terminalErrorHandler')).terminalErrorHandler(step.err, req, res, () => {});
                return res;
            }
        }
        return res;
    };
}

/** A response double that keeps `statusCode` and `body`. */
function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (/** @type {number} */ c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    res.set = () => res;
    res.setHeader = () => res;
    return res;
}

module.exports = { findRoute, runRoute, makeRes };

/** @typedef {{ statusCode: number, body: unknown, status: (c: number) => MockRes, json: (b: unknown) => MockRes, set: () => MockRes, setHeader: () => MockRes }} MockRes */

// @typecheck
/**
 * The notebooks gates in front of a notebook made inside a project
 * (POST /api/projects/:id/notebooks, routes/projects/content.js), and in
 * front of a notebook co-edited through one (open, sync, updates, presence:
 * routes/projects/collab.js; the document stream: collabStream.js). Being a
 * project member does not make somebody a notebooks user: a body read or
 * rewritten through the project is read or rewritten all the same.
 *
 * Every /api/notebooks route sits behind four gates: the notebooks module,
 * the `notebooks` capability (plan and grants), the operator's feature
 * switch, and the `use_notebooks` permission (server/index.js,
 * routes/notebooks.js). A notebook created from a project is a notebook all
 * the same, and it can only ever be opened through /api/notebooks; without
 * these gates a project editor could create one that their plan or role
 * refuses, and then not open it.
 *
 * The gates here ARE those gates, run in the same order, so the two paths
 * cannot drift. What one of them refuses is said again as a project refusal
 * with a stable code the workspace words in the reader's language:
 *
 *   403 notebooks_unavailable   module off, not in the plan, switched off, or no permission
 *   503 notebooks_unknown       whether notebooks are available could not be told
 *
 * The module gate's own 404 conceals the module on /api/notebooks; here the
 * caller is already a member of an existing project, so a 403 with a reason
 * hides nothing and tells the screen what to say.
 *
 * `makeNotebookGate({ gates })` takes the gates, so a test runs it with fakes;
 * without them it binds the real ones on first use (loading this file loads
 * no store). The middleware is named `requireNotebooksMw`, which is what the
 * project route-table baseline records.
 */

'use strict';

const { HttpError } = require('../../core/http/errors');

/**
 * @typedef {(req: any, res: any, next: (err?: unknown) => void) => unknown} Middleware
 * @typedef {{ status: number, headers: Record<string, string> }} Refusal
 */

/**
 * Run one gate against a response that only records. Resolves null when the
 * gate calls next(), the refusal it wrote otherwise; rejects when it fails.
 *
 * @param {Middleware} gate
 * @param {any} req
 * @returns {Promise<Refusal|null>}
 */
function runGate(gate, req) {
    return new Promise((resolve, reject) => {
        let status = 200;
        /** @type {Record<string, string>} */
        const headers = {};
        const answered = () => resolve({ status, headers });
        const res = {
            status(/** @type {number} */ code) { status = code; return res; },
            set(/** @type {string} */ name, /** @type {string} */ value) { headers[name] = value; return res; },
            setHeader(/** @type {string} */ name, /** @type {string} */ value) { headers[name] = value; return res; },
            json() { answered(); return res; },
            send() { answered(); return res; },
            end() { answered(); return res; },
        };
        const next = (/** @type {unknown} */ err) => (err ? reject(err) : resolve(null));
        Promise.resolve().then(() => gate(req, res, next)).catch(reject);
    });
}

/** The real gates, in the order /api/notebooks applies them. */
function realGates() {
    const { requireModule } = require('../../modules');
    const { requireCapability } = require('../../core/entitlements/entitlements');
    const { featureGate } = require('../../boot/featureGate');
    const { requirePermission } = require('../../auth/permissions');
    return [
        requireModule('notebooks'),
        requireCapability('notebooks'),
        featureGate('notebooks', 'Notebooks'),
        requirePermission('use_notebooks'),
    ];
}

/**
 * @param {{ gates?: Middleware[] | (() => Middleware[]), refusal?: string }} [deps]
 *        `refusal` words the 403 for a route that does not create (co-editing)
 * @returns {Middleware}
 */
function makeNotebookGate(deps = {}) {
    /** @type {Middleware[] | null} */
    let gates = null;
    const bound = () => {
        if (!gates) gates = typeof deps.gates === 'function' ? deps.gates() : (deps.gates || realGates());
        return gates;
    };
    return async function requireNotebooksMw(req, res, next) {
        for (const gate of bound()) {
            const refusal = await runGate(gate, req);
            if (!refusal) continue;
            if (refusal.status === 401) throw new HttpError(401, 'unauthorized', 'Authentication required');
            if (refusal.status >= 500) {
                if (refusal.headers['Retry-After']) res.set('Retry-After', refusal.headers['Retry-After']);
                throw new HttpError(503, 'notebooks_unknown', 'Whether notebooks are available to you could not be checked. Try again in a moment.');
            }
            throw new HttpError(403, 'notebooks_unavailable', deps.refusal || 'Notebooks are not available to you, so no notebook was created.');
        }
        next();
    };
}

/**
 * The gates as a question for a caller that is not a middleware chain (a
 * kind gate, a stream that has already started): resolves when they pass,
 * rejects with the HttpError they refuse with. `res` only receives a
 * Retry-After; a stand-in by default, since a started stream takes no header.
 *
 * @param {Middleware} gate  a makeNotebookGate() middleware
 * @param {any} req
 * @param {any} [res]
 * @returns {Promise<void>}
 */
function passNotebookGate(gate, req, res = { set() { return this; } }) {
    return new Promise((resolve, reject) => {
        Promise.resolve()
            .then(() => gate(req, res, (/** @type {unknown} */ err) => (err ? reject(err) : resolve(undefined))))
            .catch(reject);
    });
}

/**
 * The notebooks gates for a route that reaches an item of ANY kind (the
 * co-editing routes, routes/projects/collab.js): they run only when
 * `kindOf(req)` says the item is a notebook. A page or a designed document
 * is not a notebook and passes untouched. A kind that cannot be told refuses
 * with the lookup's own error, never lets the request through.
 *
 * Named `requireNotebookKindMw` for the project route-table baseline.
 *
 * @param {Middleware} gate  a makeNotebookGate() middleware
 * @param {(req: any) => unknown} kindOf
 * @returns {Middleware}
 */
function makeNotebookKindGate(gate, kindOf) {
    return async function requireNotebookKindMw(req, res, next) {
        if ((await kindOf(req)) === 'notebook') await passNotebookGate(gate, req, res);
        next();
    };
}

module.exports = { makeNotebookGate, makeNotebookKindGate, passNotebookGate, runGate, realGates };

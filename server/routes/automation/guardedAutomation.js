// @typecheck strict
'use strict';

const { HttpError } = require('../../core/http/errors');

/**
 * `guarded(req, res, need)`: the automation of `req.params.id`, once the caller
 * holds `need` on it; null after the guard answered (403). A missing automation
 * is a 404.
 * @param {{ store: () => any, access: { guard: Function } }} deps
 */
function makeGuarded({ store, access }) {
    return async function guarded(/** @type {import('express').Request<{ id: string }>} */ req, /** @type {import('express').Response} */ res, /** @type {string} */ need) {
        const a = await store().getAutomation(req.params.id);
        if (!a) throw new HttpError(404, 'automation_not_found', 'Not found');
        if (!await access.guard(req, res, a, need)) return null;
        return a;
    };
}

module.exports = { makeGuarded };

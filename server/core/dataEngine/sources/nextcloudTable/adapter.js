// @typecheck strict
/**
 * The Nextcloud Tables ADAPTER the registry (../index.js) hands to routes, jobs
 * and runners: adapterCore.js (what the pipelines drive) plus the four modules
 * built on top of it. The modules are LAZY getters: requiring the registry, or
 * this file, loads nothing of a kind nobody asked for, and the engine unit tests
 * stub `./sync` and friends by request string.
 */

'use strict';

const core = require('./adapterCore');

/** @typedef {import('./adapterCore').NcSource} NcSource */

function linkModule() {
    const link = require('./link');
    return {
        ...link,
        /**
         * PUT /:id/source — the one setting a Nextcloud mirror has. There
         * is no schedule to set: a mirror is live (mirror/staleness.js).
         * @param {NcSource} source
         * @param {{ refreshOnView?: unknown, [k: string]: unknown } | null | undefined} body
         */
        applySettings(source, body) {
            const next = { ...source };
            const b = body || {};
            for (const k of Object.keys(b)) {
                if (k !== 'refreshOnView') {
                    const e = /** @type {Error & { status?: number, code?: string }} */ (new Error(`"${k}" is not a setting of a Nextcloud table`));
                    e.status = 400;
                    e.code = 'unknown_field';
                    throw e;
                }
            }
            if (b.refreshOnView !== undefined) next.refreshOnView = b.refreshOnView !== false;
            return { next, stale: false };
        },
    };
}

const adapter = Object.create(core, {
    sync: { enumerable: true, get() { return require('./sync'); } },
    writeThrough: { enumerable: true, get() { return require('./writeThrough'); } },
    link: { enumerable: true, get: linkModule },
    events: { enumerable: true, get() { return require('./events'); } },
});

module.exports = adapter;

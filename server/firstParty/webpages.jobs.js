// @typecheck strict
/**
 * The after-listen wiring and the shutdown flush of the first-party module "webpages" (part
 * "jobs" of firstParty/webpages.js; contract in modules/firstParty/contract.js). Moved verbatim
 * out of boot/lifecycle.js: afterListen runs where the webpage runtime started there (after the
 * startup checks, before the startup tasks), close inside loader.close.
 */

'use strict';

const defaultLog = require('../modules/firstParty/partLog');

/**
 * Webpage full-tier runtime (per-project Node/Vite dev container) — GATED + INERT by default.
 * startReaper() is always safe to call: it no-ops unless WEBPAGE_FULL_RUNTIME_ENABLED=1 (see
 * webpageRuntimeManager.js's own gate). The proxy mount (http-proxy-middleware + the WS
 * 'upgrade' listener) is additionally only required — not just gated internally — when the flag
 * is on, so installs that never touch this feature never load that dependency. No runner image
 * is built from this repository any more; enabling it in production needs its own image and a
 * security review first.
 * @param {import('express').Express} app
 * @param {import('node:http').Server} server
 * @param {import('../modules/firstParty/contract').AfterListenContext} ctx
 * @param {{ webpageRuntimeManager?: { startReaper(): void, isEnabled(): boolean },
 *   fullTierProxy?: { mountFullTierProxy(app: import('express').Express, server: import('node:http').Server): void } }} [deps] test seam
 */
function afterListen(app, server, ctx, deps = {}) {
    const log = ctx.log || defaultLog;
    const webpageRuntimeManager = deps.webpageRuntimeManager || require('../services/webpageRuntimeManager');
    webpageRuntimeManager.startReaper();
    if (webpageRuntimeManager.isEnabled()) {
        (deps.fullTierProxy || require('../routes/webpagesFullTierProxy')).mountFullTierProxy(app, server);
        log.info('[Server] Webpage full-tier runtime proxy mounted (WEBPAGE_FULL_RUNTIME_ENABLED=1).');
        // This proxy mounts once the server is already listening, i.e. BEHIND
        // the terminal error handler — and Express never routes an error
        // backwards. Re-register the handler so a proxy failure gets the same
        // generic body instead of falling through to the stack-printing default.
        // The earlier copy still wins for every layer that precedes it.
        if (ctx.terminalErrorHandler) app.use(ctx.terminalErrorHandler);
    }
}

/**
 * Flush the SQLite blob engine's dirty handles BEFORE the process exits (see firstParty/apps.jobs.js
 * close: the same race, for webpage writes). Bounded by loader.close.
 */
async function close() {
    try {
        await Promise.allSettled([require('../stores/webpageDbStore').closeAll()]);
    } catch (e) { defaultLog.warn('[Server] Blob-engine shutdown flush failed:', /** @type {Error} */ (e).message); }
}

module.exports = { afterListen, close };

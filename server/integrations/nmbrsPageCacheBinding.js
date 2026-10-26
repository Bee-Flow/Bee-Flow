// @typecheck strict
'use strict';

// Binds the NMBRS page cache (nmbrsPageCache.mts) to one caller for the paged list tools of
// nmbrsTools.js and nmbrsBulkTools.js. Kept apart so the tool modules stay small and so this
// file imports neither of them (no import cycle).

const log = require('../telemetry/log');
const { getPageCache, credentialFingerprint } = require('./nmbrsPageCache.mts');

/**
 * The full list of a paged tool, from the page cache or from `fetchRows`. `fresh` is true for
 * the first page (offset 0), which always fetches. `args` holds every argument that changes the
 * full list, never offset or limit.
 * @typedef {(request: { tool: string, companyId: string, args: Record<string, unknown>, fetchRows: () => Promise<unknown[]>, fresh: boolean }) => Promise<unknown[]>} CachedRows
 */

/** The process-wide cache; a request logs only its outcome and the tool name, never rows. */
function pageCache() {
    return getPageCache((tool, outcome) => log.debug(`[NMBRS] page cache ${outcome}: ${tool}`));
}

/**
 * Bind the page cache to one caller: organisation, user and a fingerprint of the connection
 * (never the secret itself) are part of every key.
 * @param {{ mode: string, env: string, subdomain: string, email: string, token: string }} creds
 * @param {string} userId
 * @param {string | null | undefined} orgId
 * @returns {CachedRows}
 */
function cachedRowsFor(creds, userId, orgId) {
    const credential = credentialFingerprint(creds);
    return async ({ tool, companyId, args, fetchRows, fresh }) => {
        const { rows } = await pageCache().load({ orgId, userId, credential, tool, companyId, args }, fetchRows, { fresh });
        return rows;
    };
}

/**
 * Forget the cached lists of one user. Called when that user's NMBRS settings change or are
 * removed. A changed token, tenant, mode or environment already gives another cache key, so
 * this only frees the memory sooner; anything missed ages out with the TTL.
 * @param {string} userId
 */
function clearNmbrsPageCacheForUser(userId) {
    pageCache().invalidateUser(String(userId));
}

module.exports = { cachedRowsFor, clearNmbrsPageCacheForUser };

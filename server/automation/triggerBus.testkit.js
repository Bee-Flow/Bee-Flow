// @typecheck
'use strict';

/**
 * Test kit for the triggerBus/dispatch.js suites: stub automationStore,
 * userStore and the runner in the require cache BEFORE dispatch.js is
 * required, so it loads without booting a DB pool and hands back synthetic
 * subscriptions spanning two different orgs' users.
 *
 *   const { SUBS, dispatchedRuns, storePath } = installDispatchStubs();
 *   const { dispatchEvent } = require('./triggerBus/dispatch');
 *
 * SUBS is the live array getSubscriptionsForProvider answers (tests may splice
 * it); dispatchedRuns collects the automation ids executeAutomation was called
 * with.
 * @param {string} resolved
 */

function cacheStub(resolved, exports) {
    require.cache[resolved] = /** @type {any} */ ({ id: resolved, filename: resolved, loaded: true, exports });
}

function installDispatchStubs() {
    const storePath = require.resolve('../stores/automationStore');
    const SUBS = [
        { id: 'sub-orgA', automationId: 'auto-orgA', userId: 'user-orgA', filter: null },
        { id: 'sub-orgB', automationId: 'auto-orgB', userId: 'user-orgB', filter: null },
    ];
    cacheStub(storePath, {
        getSubscriptionsForProvider: async () => SUBS,
        getAutomation: async (id) => ({ id, isActive: true, isDraft: false }),
    });

    /** @type {Record<string, { id: string; organizationId: string; }>} */
    const USERS = {
        'user-orgA': { id: 'user-orgA', organizationId: 'org-A' },
        'user-orgB': { id: 'user-orgB', organizationId: 'org-B' },
    };
    cacheStub(require.resolve('../stores/userStore'), { getUser: async (uid) => USERS[uid] || null });

    const dispatchedRuns = [];
    cacheStub(require.resolve('../core/automationRunner'), {
        executeAutomation: async (automation) => {
            dispatchedRuns.push(automation.id);
            return { id: `run-${automation.id}` };
        },
    });

    return { SUBS, USERS, dispatchedRuns, storePath };
}

/** dispatch.js runs executeAutomation fire-and-forget (setImmediate): give it a turn. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

module.exports = { installDispatchStubs, tick };

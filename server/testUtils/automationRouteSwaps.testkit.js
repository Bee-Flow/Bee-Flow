// @typecheck
'use strict';

/**
 * Automation routes on a real Express app (testUtils/routeHarness `serve`), with a few functions
 * of the automation store, the user store and the permission check swapped on their module
 * objects for the run and put back after it (testUtils/swaps.js). No module mocking.
 *
 *   const route = useAutomationRoutes(() => [require('./webhooksAndRunOps')], ({ swap, automationStore }) => {
 *       swap(automationStore, 'getAutomation', async () => row);
 *   });
 *   const res = await route.call('GET', '/a1/webhooks', { user: { id: 'owner' } });
 */

process.env.NODE_ENV = 'test';

const { before, after } = require('node:test');
const automationStore = require('../stores/automationStore');
const userStore = require('../stores/userStore');
const permissions = require('../auth/permissions');
const { serve } = require('./routeHarness');
const { makeSwaps } = require('./swaps');

/**
 * @param {() => unknown[]} routers  the routers to mount at '/', loaded once the swaps are in place
 * @param {(seams: { swap: ReturnType<typeof makeSwaps>['swap'], automationStore: typeof automationStore, userStore: typeof userStore, permissions: typeof permissions }) => void} setUp
 */
function useAutomationRoutes(routers, setUp) {
    const { swap, restore } = makeSwaps();
    /** @type {ReturnType<typeof serve> | null} */
    let api = null;
    before(() => {
        setUp({ swap, automationStore, userStore, permissions });
        api = serve('/', routers());
    });
    after(async () => {
        restore();
        await api?.close();
    });
    return {
        /** @param {Parameters<ReturnType<typeof serve>['call']>} args */
        call: (...args) => {
            if (!api) throw new Error('the routes are mounted in before()');
            return api.call(...args);
        },
    };
}

module.exports = { useAutomationRoutes };

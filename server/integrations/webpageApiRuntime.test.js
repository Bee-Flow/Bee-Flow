const test = require('node:test');
const assert = require('node:assert');
const { preloadStubs } = require('../testUtils/stubRequire');

test('the Privacy Shield policy is resolved with the page name (webpage rows have `name`, not `title`)', async () => {
    const seen = [];
    const mods = {
        '../automation/codeSandbox': { isAvailable: () => true },
        '../stores/webpageStore': { readExtraFile: async () => ({ content: 'export function main() {}', meta: { isText: true } }) },
        '../stores/webpageDbStore': {},
        '../core/webpages/webpageBridgeAuth': {
            loadAuthorContext: async () => ({ webpage: { id: 'wp1', name: 'Order desk' }, authorUserId: 'u1', authorOrgId: 'org1', bridgeGrants: {} }),
        },
        '../core/tools/toolDispatcher': { executeTool: async () => ({}) },
        '../core/webpages/webpageEgress': {
            resolveWebpagePolicy: async (args) => { seen.push(args); throw new Error('stop here'); },
        },
    };
    preloadStubs(require, mods);
    const rt = require('./webpageApiRuntime');
    await rt.executeApiHandler({ webpageId: 'wp1', route: 'orders', req: {} }).catch(() => null);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].pageTitle, 'Order desk');
});

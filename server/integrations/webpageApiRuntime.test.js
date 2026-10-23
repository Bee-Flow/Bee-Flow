const test = require('node:test');
const assert = require('node:assert');

function withModules(mods, fn) {
    const saved = new Map();
    for (const [spec, exports] of Object.entries(mods)) {
        const id = require.resolve(spec);
        saved.set(id, require.cache[id]);
        require.cache[id] = { id, filename: id, loaded: true, exports };
    }
    const selfId = require.resolve('./webpageApiRuntime');
    delete require.cache[selfId];
    return (async () => {
        try {
            return await fn(require('./webpageApiRuntime'));
        } finally {
            for (const [id, mod] of saved) { if (mod) require.cache[id] = mod; else delete require.cache[id]; }
            delete require.cache[selfId];
        }
    })();
}

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
    await withModules(mods, (rt) => rt.executeApiHandler({ webpageId: 'wp1', route: 'orders', req: {} }).catch(() => null));
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].pageTitle, 'Order desk');
});

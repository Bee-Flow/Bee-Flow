'use strict';

/**
 * The seam between the sandbox RULES and the stack that actually reaches the
 * model.
 *
 * `testSandbox.test.js` proves the rules; this proves they are applied — and
 * that nothing else is. A rule nobody calls is the exact failure mode
 * `toolPolicy`'s header spends a paragraph on ("a stored limit nothing applies
 * is worse than no feature"), and here it would be worse still: the limit is
 * "this run may not mail anybody".
 *
 * Three things are pinned:
 *   • with `messageMetadata.testSandbox`, the sending tool is gone from the
 *     stack and named in `sandboxWithheld`;
 *   • WITHOUT the flag it is still there — so the flag is what does it, and
 *     ordinary chat is untouched by any of this;
 *   • when the sandbox module itself fails, the stack comes back EMPTY. A test
 *     with no tools grades badly and someone fixes it; a test that mailed a
 *     customer is not recoverable.
 *
 * The real `toolPolicy` and the real `testSandbox` are used throughout; only
 * the store reads and the agent's own tools are faked.
 *
 * Run: cd server && node --test --test-force-exit core/agentRuntime/toolStackAssembly.sandbox.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('module');

const fx = { tools: [], sandboxThrows: false };

/**
 * Required by ABSOLUTE path, and that is load-bearing.
 *
 * Node keeps a relative-resolve cache keyed on `parentDir + request`, and this
 * test file sits in the SAME directory as the module under test. A plain
 * `require('./testSandbox')` here would fill that cache for
 * `<agentRuntime>/./testSandbox` with the real filename, and toolStackAssembly's
 * own `require('./testSandbox')` would then skip `_resolveFilename` entirely —
 * silently bypassing the hook below. The failure is invisible: the real module
 * does the right thing, so only the "what if it throws" case ever notices.
 */
const realSandbox = require(path.join(__dirname, 'testSandbox.js'));

const MOCKS = {
    './agentTools': {
        getAgentTools: async () => fx.tools.map(t => ({ ...t })),
    },
    '../../stores/agentStore': {
        getConversationMeta: async () => ({}),
        getAgentToolsWithParams: async () => [],
    },
    // Delegates to the real module unless the test asks it to fail, so the
    // rules under assertion are the shipped ones.
    './testSandbox': {
        ...realSandbox,
        sandboxToolStack: (...args) => {
            if (fx.sandboxThrows) throw new Error('sandbox unavailable');
            return realSandbox.sandboxToolStack(...args);
        },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:toolstack-sandbox:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agentRuntime[\\/]toolStackAssembly\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const { assembleToolStack } = require('./toolStackAssembly');
test.after(() => { Module._resolveFilename = originalResolve; });

const tool = (name, extra = {}) => ({ type: 'function', function: { name }, ...extra });

/**
 * `disableExternalTools` keeps the integration block (and its OAuth, skills
 * and entitlement machinery) out of this test entirely — the stack under
 * assertion is exactly what `getAgentTools` returned plus the two builtins.
 */
function agentWith(config = {}) {
    return { id: 'a1', owner_id: 'me', config: { disableExternalTools: true, ...config } };
}

async function assemble(messageMetadata, config = {}) {
    return assembleToolStack({
        agent: agentWith(config), agentId: 'a1', userId: 'me',
        userAuth: { session: {} }, messageMetadata,
    });
}

const names = (tools) => tools.map(t => t.function && t.function.name);

test.beforeEach(() => {
    fx.tools = [
        tool('gmail_search'),
        tool('gmail_compose'),
        tool('file_the_ticket', { __automation: { id: 'au-1' } }),
    ];
    fx.sandboxThrows = false;
});

test('a test run loses the sending tool and the automation, and says which', async () => {
    const out = await assemble({ testSandbox: true });
    assert.ok(names(out.tools).includes('gmail_search'));
    assert.ok(!names(out.tools).includes('gmail_compose'), 'a test run must never be handed a send');
    assert.ok(!names(out.tools).includes('file_the_ticket'));
    const byName = Object.fromEntries(out.sandboxWithheld.map(w => [w.name, w.reason]));
    assert.strictEqual(byName.gmail_compose, 'sends');
    assert.strictEqual(byName.file_the_ticket, 'automation');
});

test('without the flag nothing is withheld — ordinary chat is untouched', async () => {
    const out = await assemble({});
    assert.ok(names(out.tools).includes('gmail_compose'));
    assert.ok(names(out.tools).includes('file_the_ticket'));
    assert.deepStrictEqual(out.sandboxWithheld, []);
});

test('an agent with no grants map still loses its sends in a test run', async () => {
    // The headless drop in toolPolicy deliberately does nothing here (an
    // uncurated agent keeps its draft cards and its autoSend). The sandbox
    // must not inherit that opt-in.
    const out = await assemble({ testSandbox: true, unattended: true }, { tools: undefined });
    assert.ok(!names(out.tools).includes('gmail_compose'));
});

test('a sandbox that cannot run withholds everything', async () => {
    fx.sandboxThrows = true;
    const out = await assemble({ testSandbox: true });
    assert.deepStrictEqual(out.tools, [], 'a failed sandbox may not serve the whole stack');
    assert.ok(out.sandboxWithheld.length > 0);
});

test('chatStream forwards the withheld list to the run', () => {
    // The route reads `test_sandbox` off the event stream; nothing else in the
    // suite would notice that wire being cut. Static because chatStream cannot
    // be loaded in a unit test — it drags the whole provider stack in.
    // chatStream is a folder: read every module in it, or the wire could be cut
    // in a phase this scan never opened and the test would stay green.
    const dir = path.join(__dirname, 'chatStream');
    const src = fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
        .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    assert.match(src, /sandboxWithheld/, 'chatStream must destructure the withheld list');
    assert.match(src, /onEvent\?\.\('test_sandbox'/, 'chatStream must emit it as test_sandbox');
});

test('the integration catalog is asked for THIS agent, so only the automations bound to it can be offered', async () => {
    // The agent id is what scopes agent_call automations to their bindings
    // (automation/agentBinding.js); a call that dropped it would offer none, one
    // that took it from anywhere else could offer someone else's.
    const integrationTools = require('../integrations/integrationTools');
    const real = integrationTools.getIntegrationTools;
    const asked = [];
    integrationTools.getIntegrationTools = async (opts) => { asked.push(opts); return { tools: [], n8nOrgId: null }; };
    try {
        await assembleToolStack({
            agent: { id: 'a1', owner_id: 'me', config: {} }, agentId: 'a1', userId: 'me',
            userAuth: { session: {} }, messageMetadata: {},
        });
    } finally {
        integrationTools.getIntegrationTools = real;
    }
    assert.strictEqual(asked.length, 1);
    assert.strictEqual(asked[0].agentId, 'a1');
    assert.strictEqual(asked[0].userId, 'me');
});

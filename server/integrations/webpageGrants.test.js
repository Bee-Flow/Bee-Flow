/**
 * webpageGrants — shared grant/verify logic for the studio-AI bridge tools and
 * the owner REST endpoints. No DB and no real registry: every store/registry
 * touch is injected (the module resolves its deps lazily, so a fully-injected
 * test never pins a DB pool or loads a throwing integration module).
 * Run: node --test integrations/webpageGrants.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const grants = require('./webpageGrants');

const TOOL = 'gmail_search';

// Minimal fake registry — one available-looking app and one the author hasn't
// connected. Shape matches automation/toolRegistry entries + loaded tools.
const FAKE_REGISTRY = [
    {
        entry: { app: 'gmail', label: 'Gmail' },
        tools: [
            { function: { name: 'gmail_search', description: 'Search mail', parameters: {} } },
            { function: { name: 'gmail_read', description: 'Read a message', parameters: {} } },
        ],
    },
    {
        entry: { app: 'youtrack', label: 'YouTrack' },
        tools: [{ function: { name: 'youtrack_get_issue', description: 'Get an issue', parameters: {} } }],
    },
];

function okDeps(overrides = {}) {
    return {
        getIntegrationTools: async () => ({ tools: [{ function: { name: TOOL } }] }),
        findOwnerOfTool: (name) => {
            for (const { entry, tools } of FAKE_REGISTRY) {
                if (tools.some(t => t.function.name === name)) return entry;
            }
            return null;
        },
        loadRegistry: () => FAKE_REGISTRY,
        getBridgeGrants: async () => ({
            ai: { enabled: true, groundOnPage: true },
            integrations: [{ tool: TOOL, fixedArgs: { labelIds: ['INBOX'] } }],
            automations: [{ automationId: 'auto-1', label: 'Nightly sync' }],
        }),
        upsertEntry: async (webpageId, userId, list, entry) => ({
            integrations: list === 'integrations' ? [entry] : [],
            automations: list === 'automations' ? [entry] : [],
        }),
        removeEntry: async () => ({ integrations: [], automations: [] }),
        getAutomation: async (id) => (id === 'auto-1' ? { id, userId: 'u1', title: 'Nightly sync' } : null),
        getAutomationsForUser: async () => [{ id: 'auto-1', userId: 'u1', title: 'Nightly sync', isActive: true }],
        ...overrides,
    };
}

const CTX = { webpageId: 'wp1', userId: 'u1', session: {} };

// ── grantIntegration ────────────────────────────────────────────────

test('grantIntegration succeeds for a connected tool', async () => {
    const r = await grants.grantIntegration({ ...CTX, tool: TOOL, fixedArgs: { q: 'in:inbox' } }, okDeps());
    assert.strictEqual(r.success, true);
    assert.strictEqual(r.integrationId, 'gmail');
    assert.deepStrictEqual(r.grants.integrations[0].fixedArgs, { q: 'in:inbox' });
});

test('grantIntegration rejects an unconnected tool with connection_required + provider', async () => {
    await assert.rejects(
        grants.grantIntegration({ ...CTX, tool: 'youtrack_get_issue' }, okDeps()),
        (err) => {
            assert.strictEqual(err.status, 409);
            assert.strictEqual(err.code, 'connection_required');
            assert.strictEqual(err.provider, 'youtrack');
            return true;
        },
    );
});

test('grantIntegration fails closed (503) when availability discovery fails', async () => {
    const deps = okDeps({ getIntegrationTools: async () => { throw new Error('user not set up'); } });
    await assert.rejects(
        grants.grantIntegration({ ...CTX, tool: TOOL }, deps),
        (err) => err.status === 503 && err.code === 'availability_check_failed',
    );
});

test('grantIntegration rejects unknown tools and missing tool', async () => {
    await assert.rejects(
        grants.grantIntegration({ ...CTX, tool: 'not_a_real_tool' }, okDeps()),
        (err) => err.status === 404,
    );
    await assert.rejects(
        grants.grantIntegration({ ...CTX, tool: '' }, okDeps()),
        (err) => err.status === 400,
    );
});

test('grantIntegration surfaces read-only/foreign pages as 404', async () => {
    const deps = okDeps({ upsertEntry: async () => null });
    await assert.rejects(
        grants.grantIntegration({ ...CTX, tool: TOOL }, deps),
        (err) => err.status === 404,
    );
});

// ── revokeIntegration ───────────────────────────────────────────────

test('revokeIntegration removes the entry', async () => {
    let removed = null;
    const deps = okDeps({
        removeEntry: async (wp, u, list, id) => { removed = { list, id }; return { integrations: [], automations: [] }; },
    });
    const r = await grants.revokeIntegration({ ...CTX, tool: TOOL }, deps);
    assert.strictEqual(r.success, true);
    assert.deepStrictEqual(removed, { list: 'integrations', id: TOOL });
});

// ── grantAutomation ─────────────────────────────────────────────────

test('grantAutomation only grants the author\'s own automations', async () => {
    const deps = okDeps({ getAutomation: async (id) => ({ id, userId: 'someone-else', title: 'x' }) });
    await assert.rejects(
        grants.grantAutomation({ ...CTX, automationId: 'auto-9' }, deps),
        (err) => err.status === 403,
    );
    const ok = await grants.grantAutomation({ ...CTX, automationId: 'auto-1', label: 'Sync' }, okDeps());
    assert.strictEqual(ok.success, true);
    assert.strictEqual(ok.title, 'Nightly sync');
});

test('grantAutomation 404s an unknown automation', async () => {
    await assert.rejects(
        grants.grantAutomation({ ...CTX, automationId: 'nope' }, okDeps()),
        (err) => err.status === 404,
    );
});

// ── listAvailableIntegrations (fail-closed) ─────────────────────────

test('listAvailableIntegrations filters to connected tools', async () => {
    const r = await grants.listAvailableIntegrations(CTX, okDeps());
    assert.deepStrictEqual(r.integrations.map(i => i.tool), [TOOL]);
    assert.strictEqual(r.integrations[0].integrationId, 'gmail');
    assert.strictEqual(r.discoveryFailed, undefined);
});

test('listAvailableIntegrations fails closed when discovery fails', async () => {
    const deps = okDeps({ getIntegrationTools: async () => { throw new Error('boom'); } });
    const r = await grants.listAvailableIntegrations(CTX, deps);
    assert.deepStrictEqual(r.integrations, []);
    assert.strictEqual(r.discoveryFailed, true);
});

test('listAvailableIntegrations skips registry modules that fail to load', async () => {
    const deps = okDeps({
        loadRegistry: () => [
            { entry: { app: 'broken', label: 'Broken' }, tools: [] }, // loadRegistry already skipped the thrower
            ...FAKE_REGISTRY,
        ],
    });
    const r = await grants.listAvailableIntegrations(CTX, deps);
    assert.deepStrictEqual(r.integrations.map(i => i.tool), [TOOL]);
});

// ── describeGrants (IDE read-model) ─────────────────────────────────

test('describeGrants enriches entries with registry metadata + availability', async () => {
    const r = await grants.describeGrants(CTX, okDeps());
    const g = r.integrations[0];
    assert.strictEqual(g.tool, TOOL);
    assert.strictEqual(g.integrationId, 'gmail');
    assert.strictEqual(g.integrationLabel, 'Gmail');
    assert.strictEqual(g.available, true);
    assert.strictEqual(g.hasFixedArgs, true);
    assert.strictEqual(r.discoveryFailed, false);
    assert.deepStrictEqual(r.automations, [{ automationId: 'auto-1', label: 'Nightly sync' }]);
});

test('describeGrants flags a grant whose app was disconnected since', async () => {
    const deps = okDeps({ getIntegrationTools: async () => ({ tools: [] }) });
    const r = await grants.describeGrants(CTX, deps);
    assert.strictEqual(r.integrations[0].available, false);
});

test('describeGrants reports available:null (never OK) when discovery fails', async () => {
    const deps = okDeps({ getIntegrationTools: async () => { throw new Error('boom'); } });
    const r = await grants.describeGrants(CTX, deps);
    assert.strictEqual(r.integrations[0].available, null);
    assert.strictEqual(r.discoveryFailed, true);
});

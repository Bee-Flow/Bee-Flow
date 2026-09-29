/**
 * What the shared egress logger hands the activity store, beyond the row
 * fields the automation tests already pin (safety.egress.test.js):
 *
 *   - `is_local_hint` on EVERY row, probe or no probe: the store decides the
 *     location from the peers and falls back to this only when none were seen;
 *   - an MCP tool that reached no socket of ours ran in a stdio child process,
 *     and its row says so with one `child_process` peer;
 *   - a custom integration (cint_) gets its host from the stored definition;
 *   - a caller that only knows the user still lands in its org's ledger.
 *
 * Stores are swapped through __setDepsForTests; no module-cache mocking.
 *
 * Run: cd server && node --test core/integrations/integrationLogging.test.js
 */
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const logging = require('./integrationLogging');
const { withPeers } = require('../http/egressCapture');

const inserted = [];
const customBySlug = new Map();
const usersById = new Map();

beforeEach(() => {
    inserted.length = 0;
    customBySlug.clear();
    usersById.clear();
    logging.__setDepsForTests({
        activityStore: () => ({ async logIntegrationActivity(event) { inserted.push(event); } }),
        configStore: () => ({ async getConfig() { return null; }, async getSecret() { return null; } }),
        customIntegrationStore: () => ({ async getBySlug(slug) { return customBySlug.get(slug) || null; } }),
        userStore: () => ({ async getUser(id) { return usersById.get(id) || null; } }),
    });
});
after(() => logging.__setDepsForTests());

async function logOne(o) {
    logging.logToolEgress({ source: 'direct_chat', shield: { monitorIntegrations: false }, ...o });
    await logging.flushEgressLogs();
    assert.strictEqual(inserted.length, 1, 'exactly one row');
    return inserted[0];
}

test('is_local_hint is passed without a probe, from the integration\'s own flag', async () => {
    const row = await logOne({ toolName: 'kb_search', toolArgs: { q: 'x' }, ids: { organization_id: 'org1', user_id: 'u1' } });
    assert.strictEqual(row.is_local_hint, true);
    assert.strictEqual(row.probe, null);
});

test('is_local_hint is false for a third-party integration, and the probe reaches the store as captured', async () => {
    const probe = withPeers(null, [{ host: 'api.fireflies.ai', ip: '104.18.24.82', port: 443, basis: 'socket', sentBody: true, method: 'POST' }]);
    const row = await logOne({ toolName: 'fireflies_list_transcripts', probe, ids: { organization_id: 'org1', user_id: 'u1' } });
    assert.strictEqual(row.is_local_hint, false);
    assert.strictEqual(row.probe, probe);
    assert.strictEqual(row.probe.peers[0].ip, '104.18.24.82');
});

test('a local integration with a frozen probe: the legacy is_local is set on a copy', async () => {
    const probe = withPeers(null, []);
    const row = await logOne({ toolName: 'kb_search', probe, ids: { organization_id: 'org1' } });
    assert.strictEqual(row.probe.is_local, true);
    assert.strictEqual(probe.is_local, false, 'the caller\'s snapshot is never mutated');
});

test('an MCP tool with no socket of its own gets a child_process peer', async () => {
    const row = await logOne({ toolName: 'mcp_soverin_list_messages', probe: withPeers(null, []), ids: { organization_id: 'org1' } });
    assert.deepStrictEqual(row.probe.peers.map((p) => [p.host, p.ip, p.basis]), [['soverin', null, 'child_process']]);
    assert.strictEqual(row.probe.peers[0].sentBody, true);
});

test('an MCP tool over HTTP keeps the peers it was seen on', async () => {
    const probe = withPeers(null, [{ host: 'mcp.example.com', ip: '203.0.113.7', basis: 'socket', sentBody: true }]);
    const row = await logOne({ toolName: 'mcp__remote__search', probe, ids: { organization_id: 'org1' } });
    assert.deepStrictEqual(row.probe.peers.map((p) => p.basis), ['socket']);
});

test('a blocked MCP call gets no peer: nothing was sent', async () => {
    const row = await logOne({ toolName: 'mcp_tuya_list_devices', blocked: true, probe: null, ids: { organization_id: 'org1' } });
    assert.strictEqual(row.probe, null);
    assert.strictEqual(row.status, 'blocked');
});

test('a shield refusal arrives with the error it threw and is still recorded as blocked', async () => {
    const err = Object.assign(new Error('Blocked: personal data'), { guardrailBlocked: true });
    const row = await logOne({ toolName: 'mcp_tuya_list_devices', blocked: true, error: err, probe: null, ids: { organization_id: 'org1' } });
    assert.strictEqual(row.status, 'blocked');
});

test('a call that failed on its own is an error', async () => {
    const row = await logOne({ toolName: 'kb_search', error: new Error('timeout'), probe: null, ids: { organization_id: 'org1' } });
    assert.strictEqual(row.status, 'error');
});

test('a custom integration row names the host from its stored definition', async () => {
    customBySlug.set('ab12cd34', {
        slug: 'ab12cd34', kind: 'rest', name: 'Invoice API',
        activatedDefinition: { api: { baseUrl: 'https://api.invoices.example/v2' } },
    });
    const row = await logOne({ toolName: 'cint_ab12cd34_list_invoices', ids: { organization_id: 'org1', user_id: 'u1' } });
    assert.strictEqual(row.integration_type, 'custom_integration');
    assert.strictEqual(row.server_endpoint, 'https://api.invoices.example');
    assert.strictEqual(row.data_direction, 'received');
    assert.strictEqual(row.is_local_hint, false);
});

test('a remote-MCP custom integration uses its MCP URL; an unknown slug still writes a row', async () => {
    customBySlug.set('mcp9x8y7', { slug: 'mcp9x8y7', kind: 'mcp_remote', name: 'Vendor MCP', definition: { mcp: { url: 'https://mcp.vendor.example/mcp' } } });
    const known = await logOne({ toolName: 'cint_mcp9x8y7_search', ids: { organization_id: 'org1' } });
    assert.strictEqual(known.server_endpoint, 'https://mcp.vendor.example');
    inserted.length = 0;
    const unknown = await logOne({ toolName: 'cint_gone0000_search', ids: { organization_id: 'org1' } });
    assert.strictEqual(unknown.integration_type, 'custom_integration');
    assert.strictEqual(unknown.server_endpoint, null);
});

test('a row with only a user id is filed under that user\'s org', async () => {
    usersById.set('u7', { id: 'u7', organizationId: 'org7' });
    const row = await logOne({ toolName: 'gmail_list_messages', ids: { user_id: 'u7' } });
    assert.strictEqual(row.organization_id, 'org7');
});

test('an internal tool writes nothing', async () => {
    logging.logToolEgress({ toolName: 'set_reminder', ids: { organization_id: 'org1' } });
    await logging.flushEgressLogs();
    assert.strictEqual(inserted.length, 0);
});

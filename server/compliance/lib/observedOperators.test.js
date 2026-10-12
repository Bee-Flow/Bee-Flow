/**
 * observedOperators — the three sources (activity ledger, connections, AI
 * providers) and the union register `collect()` builds from them.
 *
 * Run: cd server && node --test --test-force-exit compliance/lib/observedOperators.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../testUtils/stubRequire');

const state = { activity: [], connections: [], activityError: null, connectionsError: null, ai: null, aiError: null, sql: [] };
const flat = (s) => String(s).replace(/\s+/g, ' ').trim();

const fakeDb = {
    async getAll(sql, params) {
        const s = flat(sql);
        state.sql.push({ sql: s, params });
        if (/integration_activity_log/.test(s)) {
            if (state.activityError) throw state.activityError;
            return state.activity;
        }
        if (/integration_connections/.test(s)) {
            if (state.connectionsError) throw state.connectionsError;
            return state.connections;
        }
        throw new Error(`unexpected query: ${s}`);
    },
    async getOne() { return null; },
    async run() { return { rowCount: 0 }; },
    async exec() {},
};
const fakeConfigStore = {
    async getConfig(key) {
        assert.equal(key, 'ai');
        if (state.aiError) throw state.aiError;
        return state.ai;
    },
};
const restore = installResolveStub({ '../../db': fakeDb, '../../stores/configStore': fakeConfigStore });
const ops = require('./observedOperators');
test.after(() => restore());

test.beforeEach(() => {
    state.activity = []; state.connections = []; state.activityError = null; state.connectionsError = null;
    state.ai = null; state.aiError = null; state.sql = [];
});

test('canonical: lower-case, corporate suffix stripped, aliases folded, empty stays empty', () => {
    assert.equal(ops.canonical('OpenAI, Inc.'), 'openai');
    assert.equal(ops.canonical('Scaleway SAS'), 'scaleway sas'); // SAS is not in the suffix list — kept
    assert.equal(ops.canonical('Mistral AI B.V.'), 'mistral ai');
    assert.equal(ops.canonical('Acme GmbH'), 'acme');
    assert.equal(ops.canonical('Claude'), 'anthropic');
    assert.equal(ops.canonical('azure-openai'), 'microsoft');
    assert.equal(ops.canonical('google-vertex'), 'google');
    assert.equal(ops.canonical('AWS'), 'amazon');
    assert.equal(ops.canonical(''), '');
    assert.equal(ops.canonical(null), '');
    assert.equal(ops.WINDOW_DAYS, 30);
});

test('fromActivityLog: null when the ledger is missing, rows otherwise; country column only on request', async () => {
    state.activityError = Object.assign(new Error('missing'), { code: '42P01' });
    assert.equal(await ops.fromActivityLog('org-1'), null);
    state.activityError = null;
    state.activity = [{ operator: 'OpenAI', is_eu: false, calls: 4 }];
    assert.deepEqual(await ops.fromActivityLog('org-1'), state.activity);
    assert.doesNotMatch(state.sql.at(-1).sql, /country_code/);
    assert.deepEqual(state.sql.at(-1).params, ['org-1']);
    await ops.fromActivityLog('org-1', { withCountry: true });
    assert.match(state.sql.at(-1).sql, /MAX\(country_code\) AS country_code/);
});

test('fromActivityLog: a failed read throws — only a missing table or column is "no ledger"', async () => {
    state.activityError = Object.assign(new Error('missing column'), { code: '42703' });
    assert.equal(await ops.fromActivityLog('org-1'), null);
    state.activityError = Object.assign(new Error('canceling statement'), { code: '57014' });
    await assert.rejects(() => ops.fromActivityLog('org-1'), (e) => e.code === '57014');
    // The register keeps listing connections and AI providers through it.
    state.connections = [{ provider: 'github', connections: 1, any_active: true }];
    const reg = await ops.collect('org-1');
    assert.equal(reg.ledger_available, false);
    assert.deepEqual(reg.operators.map(o => o.key), ['github']);
});

test('fromActivityLog: local (private address too) and nameless unknown rows are no supplier; networks stay', async () => {
    await ops.fromActivityLog('org-1');
    const sql = state.sql.at(-1).sql;
    assert.match(sql, /COALESCE\(is_local, false\) = false/);
    assert.match(sql, /NOT COALESCE\(COALESCE\(peer_ip, server_ip\) ~\* '\^\(\(10/, 'a private peer address is local');
    assert.match(sql, /NOT \(operator IS NULL AND COALESCE\(location_state,/, 'no operator and no location names nobody');
    assert.doesNotMatch(sql, /via_network/, 'a global network is not filtered out');
});

test('fromConnections: revoked connections excluded, org-scoped, [] when the table is missing', async () => {
    state.connections = [{ provider: 'nextcloud', connections: 2, any_active: true }];
    assert.deepEqual(await ops.fromConnections('org-1'), state.connections);
    assert.match(state.sql.at(-1).sql, /FROM integration_connections WHERE org_id = \$1 AND status <> 'revoked'/);
    state.connectionsError = Object.assign(new Error('missing'), { code: '42P01' });
    assert.deepEqual(await ops.fromConnections('org-1'), []);
});

test('fromAiProviders: self-hosted runtimes are not third parties; types deduplicated; errors → []', async () => {
    state.ai = { providers: [
        { type: 'claude', name: 'Anthropic' }, { type: 'ollama', name: 'Local box' }, { type: 'vllm' },
        { type: 'openai' }, { type: 'OpenAI', name: 'dup' }, { type: '' }, null,
    ] };
    const list = await ops.fromAiProviders();
    assert.deepEqual(list.map(p => p.type), ['claude', 'openai']);
    assert.equal(list[0].name, 'Anthropic');
    state.aiError = new Error('config down');
    assert.deepEqual(await ops.fromAiProviders(), []);
    state.aiError = null; state.ai = null;
    assert.deepEqual(await ops.fromAiProviders(), []);
});

test('collect: one register over all three sources, keyed canonically, sources recorded, sorted by calls', async () => {
    state.activity = [
        { operator: 'OpenAI', is_eu: false, calls: 40, country_code: 'us' },
        { operator: 'Scaleway', is_eu: true, calls: 5, country_code: 'FR' },
        { operator: 'unknown', is_eu: false, calls: 1, country_code: null },
    ];
    state.connections = [{ provider: 'nextcloud', connections: 2, any_active: true }, { provider: 'openai', connections: 1, any_active: false }];
    state.ai = { providers: [{ type: 'claude' }, { type: 'openai' }, { type: 'ollama' }] };
    const reg = await ops.collect('org-1');
    assert.equal(reg.window_days, 30);
    assert.equal(reg.ledger_available, true);
    assert.deepEqual(reg.operators.map(o => o.key), ['openai', 'scaleway', 'unknown', 'anthropic', 'nextcloud']);
    const openai = reg.operators[0];
    assert.equal(openai.operator, 'OpenAI', 'display name is the first spelling seen');
    assert.deepEqual(openai.sources, ['activity_log', 'connection', 'ai_provider']);
    assert.equal(openai.calls_30d, 40);
    assert.equal(openai.connections, 1);
    assert.equal(openai.is_eu, false);
    assert.equal(openai.country_code, 'US');
    const anthropic = reg.operators.find(o => o.key === 'anthropic');
    assert.deepEqual(anthropic.sources, ['ai_provider']);
    assert.equal(anthropic.is_eu, null, 'nothing observed → EU status unknown, not false');
    assert.equal(anthropic.calls_30d, 0);
    assert.ok(!reg.operators.some(o => o.key === 'ollama'), 'self-hosted runtime dropped');
});

test('collect: without a ledger the register still lists connections and AI providers', async () => {
    state.activityError = Object.assign(new Error('missing'), { code: '42P01' });
    state.connections = [{ provider: 'github', connections: 1, any_active: true }];
    state.ai = { providers: [{ type: 'mistral' }] };
    const reg = await ops.collect('org-1');
    assert.equal(reg.ledger_available, false);
    assert.deepEqual(reg.activity, []);
    assert.deepEqual(reg.operators.map(o => o.key).sort(), ['github', 'mistral']);
});

test('collect: ledger_error tells a failed ledger read apart from a ledger that is not provisioned', async () => {
    state.activityError = Object.assign(new Error('missing'), { code: '42P01' });
    assert.equal((await ops.collect('org-1')).ledger_error, false, 'not provisioned is no read failure');
    state.activityError = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const reg = await ops.collect('org-1');
    assert.equal(reg.ledger_available, false);
    assert.equal(reg.ledger_error, true);
    state.activityError = null;
    assert.equal((await ops.collect('org-1')).ledger_error, false);
});

test('collect: an EU flag seen once sticks even when a later row says false', async () => {
    state.activity = [
        { operator: 'Scaleway', is_eu: false, calls: 1, country_code: null },
        { operator: 'scaleway', is_eu: true, calls: 2, country_code: 'FR' },
    ];
    const reg = await ops.collect('org-1');
    assert.equal(reg.operators.length, 1);
    assert.equal(reg.operators[0].is_eu, true);
    assert.equal(reg.operators[0].calls_30d, 3);
    assert.equal(reg.operators[0].country_code, 'FR');
});

// @typecheck
/**
 * observedOperators — the three sources (activity ledger, connections, AI
 * providers) and the union register `collect()` builds from them. The ledger
 * and the connections are real tables (the boot ladder's schema on PGlite
 * behind db.js's pool); the AI provider config is replaced on the configStore
 * object, since the provider lists under test include ones it would not save.
 *
 * Run: cd server && node --test compliance/lib/observedOperators.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { usePglitePool } = require('../../testUtils/pglitePool');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');
const { insertRow } = require('../../testUtils/pgliteSeed');
const { failReads, hideTable } = require('../../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
/** @type {{ ai: any, aiError: Error | null }} */
const state = { ai: null, aiError: null };
const configStore = require('../../stores/configStore');
const savedGetConfig = configStore.getConfig;
configStore.getConfig = /** @type {any} */ (async (/** @type {string} */ key) => {
    assert.equal(key, 'ai');
    if (state.aiError) throw state.aiError;
    return state.ai;
});
const ops = require('./observedOperators');
test.after(async () => { configStore.getConfig = savedGetConfig; await close(); });

test.beforeEach(async () => {
    state.ai = null; state.aiError = null;
    await pg.exec('DELETE FROM integration_activity_log; DELETE FROM integration_connections');
});

/** `n` ledger rows for `operator`, org-1 unless said otherwise. @param {string | null} operator @param {number} [n] @param {Record<string, unknown>} [over] */
async function calls(operator, n = 1, over = {}) {
    for (let i = 0; i < n; i++) await insertRow(pg, 'integration_activity_log', { tool_name: 'llm', organization_id: 'org-1', operator, is_eu: false, ...over });
}
/** @param {string} provider @param {Record<string, unknown>} [over] */
const connection = (provider, over = {}) => insertRow(pg, 'integration_connections', { owner_user_id: 'u1', org_id: 'org-1', provider, status: 'active', ...over });
/**
 * Run `fn` while the ledger fails with `code`.
 * @template T
 * @param {string} code
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function ledgerFails(code, fn) {
    const undo = code === '42P01' ? await hideTable(pg, 'integration_activity_log') : await failReads(pg, 'integration_activity_log', code, 'canceling statement due to statement timeout');
    try { return await fn(); } finally { await undo(); }
}

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
    assert.equal(await ledgerFails('42P01', () => ops.fromActivityLog('org-1')), null);
    await calls('OpenAI', 4, { country_code: 'us' });
    await calls('Other', 1, { organization_id: 'org-2' });
    assert.deepEqual(await ops.fromActivityLog('org-1'), [{ operator: 'OpenAI', is_eu: false, calls: 4 }]);
    const [withCountry] = await ops.fromActivityLog('org-1', { withCountry: true });
    assert.equal(withCountry.country_code, 'us');
});

test('fromActivityLog: a failed read throws — only a missing table or column is "no ledger"', async () => {
    await pg.exec('ALTER TABLE integration_activity_log RENAME COLUMN operator TO operator_hidden');
    try { assert.equal(await ops.fromActivityLog('org-1'), null); } finally {
        await pg.exec('ALTER TABLE integration_activity_log RENAME COLUMN operator_hidden TO operator');
    }
    await assert.rejects(() => ledgerFails('57014', () => ops.fromActivityLog('org-1')), (/** @type {any} */ e) => e.code === '57014');
    // The register keeps listing connections and AI providers through it.
    await connection('github');
    const reg = await ledgerFails('57014', () => ops.collect('org-1'));
    assert.equal(reg.ledger_available, false);
    assert.deepEqual(reg.operators.map((/** @type {any} */ o) => o.key), ['github']);
});

test('fromActivityLog: local (private address too) and nameless unknown rows are no supplier; networks stay; 30-day window', async () => {
    await calls('Local Box', 1, { is_local: true });
    await calls('LAN Host', 1, { peer_ip: '10.1.2.3' });
    await calls('LAN Host 2', 1, { server_ip: '192.168.1.9' });
    await calls(null, 2);                                        // neither operator nor location: names nobody
    await calls(null, 1, { location_state: 'outside' });         // located, operator unknown
    await calls('Old', 1, { timestamp: new Date(Date.now() - 40 * 86400e3).toISOString() });
    await calls('Dry', 1, { is_dry_run: true });
    await calls('Cloudflare', 3, { peer_ip: '104.16.1.1' });
    const rows = await ops.fromActivityLog('org-1');
    assert.deepEqual(Object.fromEntries(rows.map((/** @type {any} */ r) => [r.operator, r.calls])), { Cloudflare: 3, unknown: 1 },
        'a global network is not filtered out');
});

test('fromConnections: revoked connections excluded, org-scoped, [] when the table is missing', async () => {
    await connection('nextcloud');
    await connection('nextcloud', { status: 'needs_reauth' });
    await connection('gitlab', { status: 'revoked' });
    await connection('jira', { org_id: 'org-2' });
    assert.deepEqual(await ops.fromConnections('org-1'), [{ provider: 'nextcloud', connections: 2, any_active: true }]);
    const show = await hideTable(pg, 'integration_connections');
    try { assert.deepEqual(await ops.fromConnections('org-1'), []); } finally { await show(); }
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
    await calls('OpenAI', 40, { country_code: 'us' });
    await calls('Scaleway', 5, { is_eu: true, country_code: 'FR' });
    await calls(null, 1, { location_state: 'outside' });
    await connection('nextcloud');
    await connection('nextcloud');
    await connection('openai', { status: 'needs_reauth' });
    state.ai = { providers: [{ type: 'claude' }, { type: 'openai' }, { type: 'ollama' }] };
    const reg = await ops.collect('org-1');
    assert.equal(reg.window_days, 30);
    assert.equal(reg.ledger_available, true);
    assert.deepEqual(reg.operators.map((/** @type {any} */ o) => o.key), ['openai', 'scaleway', 'unknown', 'anthropic', 'nextcloud']);
    const openai = reg.operators[0];
    assert.equal(openai.operator, 'OpenAI', 'display name is the first spelling seen');
    assert.deepEqual(openai.sources, ['activity_log', 'connection', 'ai_provider']);
    assert.equal(openai.calls_30d, 40);
    assert.equal(openai.connections, 1);
    assert.equal(openai.is_eu, false);
    assert.equal(openai.country_code, 'US');
    const anthropic = reg.operators.find((/** @type {any} */ o) => o.key === 'anthropic');
    assert.deepEqual(anthropic.sources, ['ai_provider']);
    assert.equal(anthropic.is_eu, null, 'nothing observed → EU status unknown, not false');
    assert.equal(anthropic.calls_30d, 0);
    assert.ok(!reg.operators.some((/** @type {any} */ o) => o.key === 'ollama'), 'self-hosted runtime dropped');
});

test('collect: without a ledger the register still lists connections and AI providers', async () => {
    await connection('github');
    state.ai = { providers: [{ type: 'mistral' }] };
    const reg = await ledgerFails('42P01', () => ops.collect('org-1'));
    assert.equal(reg.ledger_available, false);
    assert.deepEqual(reg.activity, []);
    assert.deepEqual(reg.operators.map((/** @type {any} */ o) => o.key).sort(), ['github', 'mistral']);
});

test('collect: ledger_error tells a failed ledger read apart from a ledger that is not provisioned', async () => {
    assert.equal((await ledgerFails('42P01', () => ops.collect('org-1'))).ledger_error, false, 'not provisioned is no read failure');
    const reg = await ledgerFails('57014', () => ops.collect('org-1'));
    assert.equal(reg.ledger_available, false);
    assert.equal(reg.ledger_error, true);
    assert.equal((await ops.collect('org-1')).ledger_error, false);
});

test('collect: an EU flag seen once sticks even when a later row says false', async () => {
    await calls('Scaleway', 1);
    await calls('scaleway', 2, { is_eu: true, country_code: 'FR' });
    const reg = await ops.collect('org-1');
    assert.equal(reg.operators.length, 1);
    assert.equal(reg.operators[0].is_eu, true);
    assert.equal(reg.operators[0].calls_30d, 3);
    assert.equal(reg.operators[0].country_code, 'FR');
});

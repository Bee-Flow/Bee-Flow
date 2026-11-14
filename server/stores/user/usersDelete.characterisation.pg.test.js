/**
 * deleteUser, pinned through its public entry against the WHOLE schema (the
 * data directory the real boot ladder leaves behind, testUtils/pgliteTemplate.js):
 * for each case the golden holds what the call answered or threw, every
 * statement that reached the pool with its parameters, every port call and
 * every log line, all in the order they happened, and how many rows still name
 * the account afterwards.
 *
 * Cases: an unknown account, an account with rows in every table the steps
 * name (a private table, a shared table with an heir, a personal schema, an
 * owned agent with a conversation, certificates with a public lookup), an
 * account that runs a Solution stage, and one fault per erasure step: the
 * step fails, the call rejects naming exactly that step, the account stays,
 * and the same call with the fault gone finishes the erasure.
 *
 * Refresh (only for a deliberate change):
 *   cd server && UPDATE_GOLDEN=1 node --require ./testUtils/registerFeatures.js --test stores/user/usersDelete.characterisation.pg.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'integration-test-session-secret-0123456789abcdef';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { usePglitePool } = require('../../testUtils/pglitePool');
const { ladderPglite } = require('../../testUtils/pgliteTemplate');

const { query: rawQuery, close } = usePglitePool(ladderPglite());
const db = require('../../db');
const users = require('./users');
const configStore = require('../configStore');
const { resetErasurePortsForTests, registerErasurePorts } = require('./erasurePorts');

const GOLDEN_PATH = path.join(__dirname, 'usersDelete.characterisation.golden.json');
const ORG = 'org-char';
const HEIR = 'heir-char';

// ── Recording ───────────────────────────────────────────────────────────

/** @type {Array<Record<string, unknown>> | null} */
let events = null;
/** Generated ids (tables, rows) by order of first appearance, so the golden is the same on every run. */
/** @type {Map<string, string>} */
let aliases = new Map();
const GENERATED = /\b(?:tbl_[0-9a-f]{12}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g;
const steady = (/** @type {string} */ text) => text
    .replace(GENERATED, (id) => {
        if (!aliases.has(id)) aliases.set(id, `<id${aliases.size + 1}>`);
        return /** @type {string} */ (aliases.get(id));
    })
    .replace(TIMESTAMP, '<time>');
const steadyValue = (/** @type {unknown} */ v) => {
    if (v instanceof Date) return '<time>';
    if (typeof v === 'string') return steady(v);
    if (v !== null && typeof v === 'object') return JSON.parse(steady(JSON.stringify(v)));
    return v;
};

const recordQuery = (/** @type {Function} */ query) => async (/** @type {any} */ sql, /** @type {any} */ params) => {
    if (events) {
        const text = typeof sql === 'string' ? sql : String(sql?.text || '');
        const values = Array.isArray(params) ? params : (sql?.values || []);
        events.push({ sql: steady(text.replace(/\s+/g, ' ').trim()), params: values.map(steadyValue) });
    }
    return query(sql, params);
};
const pooled = { query: db.pool.query, connect: db.pool.connect };
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

// Said once per process by a listener that fires some time after a table
// changed: when it lands is a matter of timing, not of the call recorded.
const LATE_NOTICE = /^\[(?:Datatables|seatSync)\] /;
/** @param {'log'|'info'|'warn'|'error'} level */
const recordLog = (level) => (/** @type {unknown[]} */ ...args) => {
    const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    if (events && !LATE_NOTICE.test(line)) events.push({ log: level, line: steady(line) });
};

// ── Ports (what the server registers at boot), recorded and breakable ──

/** @type {{ notebooks: boolean, teardown: boolean }} */
const down = { notebooks: false, teardown: false };
/** @param {string} name @param {unknown[]} args */
const port = (name, args) => { if (events) events.push({ port: name, args: args.map(steadyValue) }); };

function registerPorts() {
    resetErasurePortsForTests();
    registerErasurePorts({
        notebooks: {
            deleteAllForUser: async (/** @type {string} */ id) => {
                port('notebooks.deleteAllForUser', [id]);
                if (down.notebooks) throw Object.assign(new Error('object storage unreachable'), { code: 'ECONNREFUSED' });
                return { notebooks: id.startsWith('full') ? 2 : 0 };
            },
        },
        projects: {
            makeTeardown: () => ({
                deleteProject: async (/** @type {unknown[]} */ ...args) => {
                    port('projects.deleteProject', args.slice(0, 1));
                    if (down.teardown) throw new Error('teardown refused');
                    await rawQuery('DELETE FROM projects WHERE id = $1', [args[0]]);
                    return true;
                },
            }),
        },
        // The real content port: the stores, as the server registers them.
        content: require('../../projects/accountContentErasure'),
    });
}

// ── Fixtures ────────────────────────────────────────────────────────────

/** @param {string} sql @param {unknown[]} [params] */
const q = async (sql, params) => (await rawQuery(sql, params)).rows;

/** A row with every NOT NULL column without a default filled in, plus `values`. */
async function seed(/** @type {string} */ table, /** @type {Record<string, unknown>} */ values) {
    const columns = await q(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL`, [table]);
    /** @type {Record<string, unknown>} */
    const row = {};
    for (const { column_name: name, data_type: type } of columns) {
        if (type === 'integer' || type === 'bigint' || type === 'numeric' || type === 'double precision' || type === 'smallint') row[name] = 1;
        else if (type === 'boolean') row[name] = false;
        else if (type === 'jsonb' || type === 'json') row[name] = '{}';
        else if (type.startsWith('timestamp') || type === 'date') row[name] = '2026-01-01T00:00:00Z';
        else if (type === 'bytea') row[name] = Buffer.from('x');
        else if (type === 'uuid') row[name] = crypto.randomUUID();
        else row[name] = `${table}-${values.id || Object.values(values)[0]}-${name}`.slice(0, 60);
    }
    Object.assign(row, values);
    const names = Object.keys(row);
    await rawQuery(
        `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`,
        names.map((n) => row[n]));
}

/** The tables a step deletes from by one user column, with that column. */
const USER_ROWS = [
    ['mcp_tokens', 'user_id'], ['notebook_conversations', 'user_id'], ['user_memories', 'user_id'],
    ['pii_vault_entries', 'user_id'], ['pii_vault_counters', 'user_id'], ['execution_history', 'user_id'],
    ['message_feedback', 'user_id'], ['ai_usage_log', 'user_id'], ['chat_signal_objections', 'user_id'],
    ['automation_credentials', 'user_id'], ['voiceprints', 'user_id'], ['integration_connections', 'owner_user_id'],
];

/** An account with a session, per-user settings and a row in each USER_ROWS table. */
async function account(/** @type {string} */ id) {
    assert.equal(await users.createUser({ id, username: id, passwordHash: '', organizationId: ORG }), true);
    // The rows stand alone: no parent rows for foreign keys the steps never read.
    await rawQuery(`SET session_replication_role = replica`);
    try { await accountRows(id); } finally { await rawQuery(`SET session_replication_role = DEFAULT`); }
}

async function accountRows(/** @type {string} */ id) {
    await rawQuery(`INSERT INTO user_sessions (sid, sess, expire) VALUES ($1, $2, NOW() + interval '1 day')`,
        [`s-${id}`, JSON.stringify({ user: { id } })]);
    await configStore.setConfig(`learning_progress_user_${id}`, { done: 1 });
    await configStore.setConfig(`learning_certificate_user_${id}`, { c1: { verifyTokenHash: `hash-${id}` }, c2: {} });
    await configStore.setConfig(`learning_cert_lookup_hash-${id}`, { userId: id });
    await configStore.setConfig(`mcp_cred_frappe_FRAPPE_API_SECRET_user_${id}`, 'sealed');
    await configStore.setConfig(`cms_mcp_upload_ticket-${id}`, { userId: id });
    for (const [table, column] of USER_ROWS) await seed(table, { [column]: id, ...(table === 'message_feedback' ? { rating: 'up' } : {}) });
    await seed('connection_grants', { grantor_user_id: id, grantee_type: 'org', grantee_id: ORG, connection_id: (await q('SELECT id FROM integration_connections WHERE owner_user_id = $1', [id]))[0].id });
    await seed('project_shares', { id: `ps-${id}`, project_id: 'p-heir', shared_with_type: 'user', shared_with_id: id });
    await seed('notifications', { user_id: id });
    await seed('agents', { id: `ag-${id}`, owner_id: id });
    await seed('agent_conversations', { id: `c-${id}`, agent_id: `ag-${id}`, user_id: HEIR });
    await seed('conversation_messages', { id: `m-${id}`, conversation_id: `c-${id}`, role: 'user', content: 'x', seq: 1 });
    await seed('reminders', { id: `r-${id}`, user_id: id });
    await seed('projects', { id: `p-${id}`, owner_id: id, organization_id: ORG });
}

/** How many rows still name `id`, per table a step is responsible for. */
async function left(/** @type {string} */ id) {
    /** @type {Record<string, number>} */
    const counts = {};
    const count = async (/** @type {string} */ name, /** @type {string} */ sql) => { counts[name] = (await q(sql, [id]))[0].n; };
    await count('users', 'SELECT COUNT(*)::int AS n FROM users WHERE id = $1');
    for (const [table, column] of USER_ROWS) await count(table, `SELECT COUNT(*)::int AS n FROM "${table}" WHERE "${column}" = $1`);
    await count('user_sessions', `SELECT COUNT(*)::int AS n FROM user_sessions WHERE sess::jsonb -> 'user' ->> 'id' = $1`);
    await count('config', `SELECT COUNT(*)::int AS n FROM config WHERE key LIKE '%' || $1 || '%'`);
    await count('connection_grants', 'SELECT COUNT(*)::int AS n FROM connection_grants WHERE grantor_user_id = $1');
    await count('project_shares', 'SELECT COUNT(*)::int AS n FROM project_shares WHERE shared_with_id = $1');
    await count('notifications', 'SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1');
    await count('agents', 'SELECT COUNT(*)::int AS n FROM agents WHERE owner_id = $1');
    await count('agent_conversations', `SELECT COUNT(*)::int AS n FROM agent_conversations WHERE agent_id = 'ag-' || $1`);
    await count('conversation_messages', `SELECT COUNT(*)::int AS n FROM conversation_messages WHERE conversation_id = 'c-' || $1`);
    await count('reminders', 'SELECT COUNT(*)::int AS n FROM reminders WHERE user_id = $1');
    await count('projects', 'SELECT COUNT(*)::int AS n FROM projects WHERE owner_id = $1');
    await count('datatables', 'SELECT COUNT(*)::int AS n FROM datatables WHERE owner_user_id = $1');
    await count('datatable_grants', `SELECT COUNT(*)::int AS n FROM datatable_grants WHERE grantee_type = 'user' AND grantee_id = $1`);
    await count('datatable_models', `SELECT COUNT(*)::int AS n FROM datatable_models WHERE scope_kind = 'user' AND scope_id = $1`);
    return counts;
}

// ── One recorded call ───────────────────────────────────────────────────

/** deleteUser(id), with everything it did, in order. */
async function recorded(/** @type {string} */ id) {
    aliases = new Map();
    events = [];
    /** @type {Record<string, unknown>} */
    let outcome;
    try {
        outcome = { returned: await users.deleteUser(id) };
    } catch (err) {
        const e = /** @type {any} */ (err);
        outcome = { threw: { status: e.status, code: e.code, message: e.message, expose: e.expose, details: steadyValue(e.details) } };
    }
    // The seat sync is started after the answer; let it land inside the recording.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    const trace = events;
    events = null;
    return { outcome, trace, left: await left(id) };
}

const digest = (/** @type {unknown} */ v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** @type {Record<string, unknown>} */
const actual = {};
/** @type {Record<string, any>} */
let golden = {};

before(async () => {
    db.pool.query = /** @type {any} */ (recordQuery(pooled.query));
    db.pool.connect = /** @type {any} */ (async () => {
        const client = await /** @type {any} */ (pooled.connect)();
        return { ...client, query: recordQuery(client.query) };
    });
    console.log = recordLog('log'); console.info = recordLog('info');
    console.warn = recordLog('warn'); console.error = recordLog('error');
    registerPorts();
    if (fs.existsSync(GOLDEN_PATH)) golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));

    await rawQuery(`INSERT INTO organizations (id, name) VALUES ($1, 'Characterisation Org')`, [ORG]);
    assert.equal(await users.createUser({ id: HEIR, username: HEIR, passwordHash: '', organizationId: ORG, orgRole: 'org_admin' }), true);
    await rawQuery(`UPDATE users SET "createdAt" = NOW() - INTERVAL '1 day' WHERE id = $1`, [HEIR]);
    await seed('projects', { id: 'p-heir', owner_id: HEIR, organization_id: ORG });
    await rawQuery(`
        CREATE FUNCTION refuse_statement() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'canceling statement due to statement timeout' USING ERRCODE = '57014'; END $$`);
    // Every store a deleteUser reaches creates its schema on first use: one
    // unrecorded call, so no case records another store's init.
    await account('warm-up');
    assert.equal(await users.deleteUser('warm-up'), true);
});

after(async () => {
    db.pool.query = pooled.query;
    db.pool.connect = pooled.connect;
    Object.assign(console, realConsole);
    resetErasurePortsForTests();
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 1)}\n`);
    await close();
});

/** @param {string} name @param {unknown} value */
function pin(name, value) {
    const plain = JSON.parse(JSON.stringify(value));
    actual[name] = plain;
    if (process.env.UPDATE_GOLDEN === '1') return;
    assert.deepEqual(plain, golden[name]);
}

test('an unknown account', async () => {
    pin('unknown account', await recorded('nobody'));
});

test('an account with rows in every table the steps name', async () => {
    const id = 'full-leaver';
    await account(id);
    const datatableStore = require('../datatableStore');
    const scope = { kind: 'org', id: ORG };
    const fields = [{ key: 'name', type: 'text', label: 'Name' }];
    await datatableStore.createDatatable({ scope, ownerUserId: id, key: 'private_notes', name: 'Private notes', fields });
    const shared = await datatableStore.createDatatable({ scope, ownerUserId: id, key: 'team_list', name: 'Team list', fields });
    await rawQuery('UPDATE datatables SET is_published = TRUE WHERE id = $1', [shared.id]);
    await datatableStore.createDatatable({ scope: { kind: 'user', id }, ownerUserId: id, key: 'own_list', name: 'Own list', fields });
    await seed('datatable_grants', { datatable_id: shared.id, grantee_type: 'user', grantee_id: id, grade: 'viewer' });
    const before = await left(id);
    pin('full account', { before, ...(await recorded(id)) });
    const heirTables = await q('SELECT key FROM datatables WHERE owner_user_id = $1 ORDER BY key', [HEIR]);
    pin('full account: tables handed to the heir', heirTables.map((r) => r.key));
});

test('an account that runs a Solution stage', async () => {
    const id = 'stage-runner';
    await account(id);
    const projectStore = require('../projectStore');
    const dev = await projectStore.createProject({ name: 'Invoices', ownerId: id, organizationId: ORG, kind: 'solution' });
    await require('../solutionStageStore').createStages({ devProject: dev, stages: ['uat'], actorId: id });
    const { outcome, trace, left: remaining } = await recorded(id);
    const threw = /** @type {any} */ (outcome).threw;
    pin('stage run-as', {
        threw: { status: threw.status, code: threw.code, message: threw.message, expose: threw.expose, stages: threw.details.stages.length },
        statements: trace.length, left: remaining,
    });
});

// ── One fault per step ──────────────────────────────────────────────────

/** A statement-level trigger: every DELETE (or UPDATE) on `table` fails with 57014. */
const refuseDeletes = (/** @type {string} */ table, /** @type {'DELETE'|'UPDATE'} */ write = 'DELETE') => async () => {
    await rawQuery(`CREATE TRIGGER refuse_write BEFORE ${write} ON "${table}" FOR EACH STATEMENT EXECUTE FUNCTION refuse_statement()`);
    return () => rawQuery(`DROP TRIGGER refuse_write ON "${table}"`);
};
/** A row-level trigger: deleting the config row `key(id)` fails with 57014. */
const refuseConfigKey = (/** @type {(id: string) => string} */ key) => async (/** @type {string} */ id) => {
    await rawQuery(`CREATE TRIGGER refuse_key BEFORE DELETE ON config FOR EACH ROW WHEN (OLD.key = '${key(id)}') EXECUTE FUNCTION refuse_statement()`);
    return () => rawQuery('DROP TRIGGER refuse_key ON config');
};
const portDown = (/** @type {'notebooks'|'teardown'} */ name) => async () => {
    down[name] = true;
    return async () => { down[name] = false; };
};

/** @type {Array<[string, (id: string) => Promise<() => Promise<unknown>>]>} */
const FAULTS = [
    ['certificate lookups', refuseConfigKey((id) => `learning_cert_lookup_hash-${id}`)],
    ['config keys', refuseConfigKey((id) => `learning_progress_user_${id}`)],
    ['sessions', refuseDeletes('user_sessions')],
    ['mcp_tokens', refuseDeletes('mcp_tokens')],
    ['mcp credentials', refuseConfigKey((id) => `mcp_cred_frappe_FRAPPE_API_SECRET_user_${id}`)],
    ['cms upload tickets', refuseConfigKey((id) => `cms_mcp_upload_ticket-${id}`)],
    ['notebooks', portDown('notebooks')],
    ['notebook_conversations', refuseDeletes('notebook_conversations')],
    ['user_memories', refuseDeletes('user_memories')],
    ['pii_vault_entries', refuseDeletes('pii_vault_entries')],
    ['pii_vault_counters', refuseDeletes('pii_vault_counters')],
    ['conversations (content port)', refuseDeletes('agent_conversations')],
    ['execution_history', refuseDeletes('execution_history')],
    ['message_feedback', refuseDeletes('message_feedback')],
    ['ai_usage_log', refuseDeletes('ai_usage_log')],
    ['chat_signal_objections', refuseDeletes('chat_signal_objections')],
    ['kb_query_log', refuseDeletes('kb_query_log')],
    ['suggestion traces', refuseDeletes('suggestion_scan_cache')],
    ['automation_credentials', refuseDeletes('automation_credentials')],
    ['integration cache', refuseDeletes('integration_response_cache')],
    ['connection_grants', refuseDeletes('connection_grants')],
    ['integration_connections', refuseDeletes('integration_connections')],
    ['voiceprints', refuseDeletes('voiceprints')],
    ['owned projects', portDown('teardown')],
    ['project_shares', refuseDeletes('project_shares')],
    ['project traces', refuseDeletes('project_comments', 'UPDATE')],
    ['agents', refuseDeletes('agents')],
    ['content (coverage map)', refuseDeletes('reminders')],
    ['datatables', refuseDeletes('datatable_grants')],
    ['notifications', refuseDeletes('notifications')],
];

for (const [index, [name, install]] of FAULTS.entries()) {
    test(`a fault in the step: ${name}`, async () => {
        const id = `fault-${index + 1}`;
        await account(id);
        const repair = await install(id);
        let broken;
        try { broken = await recorded(id); } finally { await repair(); }
        const retried = await recorded(id);
        pin(`fault: ${name}`, {
            outcome: broken.outcome,
            errorLines: broken.trace.filter((e) => e.log === 'error' || e.log === 'warn').map((e) => e.line),
            statements: broken.trace.filter((e) => e.sql).length,
            trace: digest(broken.trace),
            accountKept: broken.left.users,
            retry: { outcome: retried.outcome, trace: digest(retried.trace), left: Object.values(retried.left).reduce((a, b) => a + b, 0) },
        });
    });
}

test('cached integration answers that cannot be deleted leave the erasure incomplete', async () => {
    const id = 'cache-fault';
    await account(id);
    await rawQuery('SET session_replication_role = replica');
    try { await seed('integration_response_cache', { user_id: id }); } finally { await rawQuery('SET session_replication_role = DEFAULT'); }
    const cached = async () => (await q('SELECT COUNT(*)::int AS n FROM integration_response_cache WHERE user_id = $1', [id]))[0].n;
    const repair = await refuseDeletes('integration_response_cache')();
    let broken;
    try { broken = await recorded(id); } finally { await repair(); }
    assert.deepEqual(/** @type {any} */ (broken.outcome).threw?.details, { failed: ['integration cache'] });
    assert.equal(broken.left.users, 1, 'the account stays for a retry');
    assert.equal(await cached(), 1);
    assert.equal(await users.deleteUser(id), true);
    assert.equal(await cached(), 0);
});

test('sessions that cannot be deleted leave the erasure incomplete', async () => {
    const id = 'session-fault';
    await account(id);
    const sessions = async () => (await q(`SELECT COUNT(*)::int AS n FROM user_sessions WHERE sess::jsonb -> 'user' ->> 'id' = $1`, [id]))[0].n;
    assert.ok(await sessions() > 0, 'the fixture account is signed in');
    const repair = await refuseDeletes('user_sessions')();
    let broken;
    try { broken = await recorded(id); } finally { await repair(); }
    assert.deepEqual(/** @type {any} */ (broken.outcome).threw?.details, { failed: ['sessions'] });
    assert.equal(broken.left.users, 1, 'the account stays for a retry');
    assert.equal(await users.deleteUser(id), true);
    assert.equal(await sessions(), 0);
});

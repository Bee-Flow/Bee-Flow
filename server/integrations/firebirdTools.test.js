/**
 * Unit tests for the Firebird tool module: registry, credentials, every tool against a fake driver.
 * Run: node --test integrations/firebirdTools.test.js
 */
const { useConfigRows } = require('../testUtils/configRows');
const config = useConfigRows();

const test = require('node:test');
const assert = require('node:assert/strict');

const tools = require('./firebirdTools');
const { _setDriverForTests } = require('./firebirdClient');

const {
    FIREBIRD_TOOLS, FIREBIRD_TOOL_NAMES, executeFirebirdTool, isFirebirdTool, testFirebirdConnection,
    getFirebirdCredentials, HOST_RE, PORT_RE, DATABASE_RE, USER_RE, PASSWORD_RE, CHARSET_RE,
} = tools;

const PASSWORD = 'pw-Zx9!secret-4471';
const ISOLATION = ['read_committed', 'no_rec_version'];

function setCreds(userId, overrides = {}) {
    const values = { host: 'db.internal', port: '3050', database: '/data/main.fdb', user: 'READER', password: PASSWORD, charset: 'WIN1252', ...overrides };
    for (const [k, v] of Object.entries(values)) {
        if (v === undefined) delete config.rows[`firebird_${k}_user_${userId}`];
        else config.rows[`firebird_${k}_user_${userId}`] = v;
    }
}

/** Fake node-firebird; `script(sql, params)` returns rows or an Error. */
function makeDriver(script, { attachError } = {}) {
    const rec = { attach: [], tx: [], statements: [], events: [] };
    const driver = {
        ISOLATION_READ_COMMITTED_READ_ONLY: ISOLATION,
        attachAsync: async (options) => {
            rec.attach.push(options);
            if (attachError) throw attachError;
            return {
                transactionAsync: async (txOptions) => {
                    rec.tx.push(txOptions);
                    return {
                        sequentiallyAsync: async (sql, params, on) => {
                            rec.statements.push({ sql, params });
                            const out = script(sql, params);
                            if (out instanceof Error) throw out;
                            let i = 0;
                            for (const row of out) await on(row, i++);
                        },
                        commitAsync: async () => { rec.events.push('commit'); },
                        rollbackAsync: async () => { rec.events.push('rollback'); },
                    };
                },
                detachAsync: async () => { rec.events.push('detach'); },
            };
        },
    };
    return { driver, rec };
}

function install(script, options) {
    const made = makeDriver(script, options);
    _setDriverForTests(made.driver);
    return made.rec;
}

test.beforeEach(() => { config.reset(); setCreds('u1'); });
test.afterEach(() => {
    _setDriverForTests(null);
    delete process.env.FIREBIRD_MAX_ROWS;
    delete process.env.FIREBIRD_ALLOWED_HOSTS;
});
test.after(config.restore);

function assertNoPassword(value) {
    assert.ok(!JSON.stringify(value).includes(PASSWORD), 'password leaked');
}

function assertReadOnlyAndDetached(rec) {
    assert.ok(rec.tx.length > 0);
    for (const t of rec.tx) assert.deepEqual(t, { isolation: ISOLATION, readOnly: true });
    assert.equal(rec.events.filter(e => e === 'detach').length, rec.attach.length);
    assert.equal(rec.events.at(-1), 'detach');
}

// ── registry ──────────────────────────────────────────────────────────

test('registry: five unique firebird_ tools without write verbs, described and consistent', () => {
    assert.equal(FIREBIRD_TOOLS.length, 5);
    const names = FIREBIRD_TOOLS.map(t => t.function.name);
    assert.equal(new Set(names).size, 5);
    assert.deepEqual([...names].sort(), ['firebird_describe_table', 'firebird_list_tables', 'firebird_query', 'firebird_sample_rows', 'firebird_whoami']);
    assert.deepEqual([...FIREBIRD_TOOL_NAMES].sort(), [...names].sort());
    for (const t of FIREBIRD_TOOLS) {
        const f = t.function;
        assert.equal(t.type, 'function');
        assert.ok(f.name.startsWith('firebird_'));
        assert.doesNotMatch(f.name, /(?:insert|update|delete|create|drop|alter|write|execute|merge|grant)/i);
        assert.ok(f.description.length > 40, f.name);
        assert.equal(f.parameters.type, 'object');
        for (const req of f.parameters.required) assert.ok(req in f.parameters.properties, `${f.name}.${req}`);
        for (const prop of Object.values(f.parameters.properties)) assert.ok(prop.type);
    }
    assert.deepEqual(FIREBIRD_TOOLS.find(t => t.function.name === 'firebird_query').function.parameters.required, ['sql']);
    assert.ok(isFirebirdTool('firebird_query'));
    assert.ok(!isFirebirdTool('vplan_whoami'));
});

// ── credentials ───────────────────────────────────────────────────────

test('credential regexes', () => {
    assert.ok(HOST_RE.test('db.internal') && HOST_RE.test('10.0.0.5') && HOST_RE.test('[::1]'));
    for (const bad of ['http://x', 'a b', 'a/b', '', 'a:3050']) assert.ok(!HOST_RE.test(bad), bad);
    assert.ok(PORT_RE.test('3050') && !PORT_RE.test('0') && !PORT_RE.test('abc') && !PORT_RE.test('-1'));
    assert.ok(DATABASE_RE.test('C:\\data\\atrium.fdb') && DATABASE_RE.test('alias') && !DATABASE_RE.test('a\nb'));
    assert.ok(USER_RE.test('SYSDBA') && !USER_RE.test('a b') && !USER_RE.test('a@b') && !USER_RE.test('a:b'));
    assert.ok(PASSWORD_RE.test('p@ss w0rd') && !PASSWORD_RE.test('a\rb') && !PASSWORD_RE.test(''));
    assert.ok(CHARSET_RE.test('WIN1252') && CHARSET_RE.test('ISO8859_1') && !CHARSET_RE.test('a b'));
});

test('getFirebirdCredentials returns null unless host, database, user and password are present', async () => {
    assert.equal((await getFirebirdCredentials('u1')).host, 'db.internal');
    setCreds('u2', { password: undefined });
    assert.equal(await getFirebirdCredentials('u2'), null);
    assert.equal(await getFirebirdCredentials('nobody'), null);
});

test('missing credentials: "not configured" and no driver call', async () => {
    const rec = install(() => []);
    const out = await executeFirebirdTool('firebird_whoami', {}, 'nobody');
    assert.match(out.error, /not configured/);
    assert.equal(rec.attach.length, 0);
    assert.match((await executeFirebirdTool('firebird_whoami', {}, '')).error, /User context/);
    assert.match((await executeFirebirdTool('nope', {}, 'u1')).error, /Unknown Firebird tool/);
    assert.equal(rec.attach.length, 0);
});

test('invalid stored credentials make no driver call and never echo the password', async () => {
    const rec = install(() => []);
    for (const bad of [{ host: 'http://evil/x' }, { port: '99999' }, { port: 'abc' }, { user: 'a b' }, { charset: 'UTF-8;x' }, { database: 'a\nb' }]) {
        setCreds('u3', bad);
        const out = await executeFirebirdTool('firebird_whoami', {}, 'u3');
        assert.match(out.error, /invalid format|port must be/, JSON.stringify(bad));
        assertNoPassword(out);
    }
    assert.equal(rec.attach.length, 0);
});

test('FIREBIRD_ALLOWED_HOSTS restricts the host when set', async () => {
    const rec = install(() => [{ SERVER_VERSION: '3.0.11', TABLE_COUNT: 1 }]);
    process.env.FIREBIRD_ALLOWED_HOSTS = 'other.host, 10.0.0.9';
    assert.match((await executeFirebirdTool('firebird_whoami', {}, 'u1')).error, /allowed hosts/);
    assert.equal(rec.attach.length, 0);
    process.env.FIREBIRD_ALLOWED_HOSTS = 'DB.internal';
    assert.equal((await executeFirebirdTool('firebird_whoami', {}, 'u1')).server_version, '3.0.11');
});

test('empty port and charset fall back to 3050 and UTF8', async () => {
    const rec = install(() => [{ SERVER_VERSION: '4.0.2', TABLE_COUNT: 0 }]);
    setCreds('u4', { port: undefined, charset: undefined });
    await executeFirebirdTool('firebird_whoami', {}, 'u4');
    assert.equal(rec.attach[0].port, 3050);
    assert.equal(rec.attach[0].encoding, 'UTF8');
});

// ── tools ─────────────────────────────────────────────────────────────

test('firebird_whoami', async () => {
    const rec = install(() => [{ SERVER_VERSION: '3.0.11', TABLE_COUNT: 412 }]);
    const out = await executeFirebirdTool('firebird_whoami', {}, 'u1');
    assert.deepEqual(out, { server_version: '3.0.11', database: '/data/main.fdb', user: 'READER', charset: 'WIN1252', table_count: 412 });
    assertReadOnlyAndDetached(rec);
    assertNoPassword(out);
});

test('firebird_list_tables: shape, search parameter, limit and truncation', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ NAME: `T${i}`, KIND: i % 2 ? 'view' : 'table', DESCRIPTION: i === 0 ? 'Customers' : null }));
    const rec = install(() => rows);
    const out = await executeFirebirdTool('firebird_list_tables', { search: 'klant', limit: 3 }, 'u1');
    assert.equal(out.count, 3);
    assert.equal(out.truncated, true);
    assert.deepEqual(out.data[0], { name: 'T0', kind: 'table', description: 'Customers' });
    assert.deepEqual(out.data[1], { name: 'T1', kind: 'view' });
    assert.match(rec.statements[0].sql, /CONTAINING \?/);
    assert.deepEqual(rec.statements[0].params, ['KLANT']);
    assertReadOnlyAndDetached(rec);

    const rec2 = install(() => rows);
    const all = await executeFirebirdTool('firebird_list_tables', {}, 'u1');
    assert.equal(all.truncated, false);
    assert.equal(all.count, 5);
    assert.deepEqual(rec2.statements[0].params, []);
});

function metadata(sql) {
    if (sql.includes('RDB$RELATION_FIELDS')) {
        return [
            { NAME: 'ID', FIELD_TYPE: 8, SUB_TYPE: 0, SCALE: 0, PRECISION: 0, NULL_FLAG: 1, DESCRIPTION: null, DEFAULT_SOURCE: null },
            { NAME: 'NAAM', FIELD_TYPE: 37, CHAR_LENGTH: 50, FIELD_LENGTH: 200, NULL_FLAG: null, DESCRIPTION: 'Name  ', DEFAULT_SOURCE: "DEFAULT 'x'" },
            { NAME: 'BEDRAG', FIELD_TYPE: 16, SUB_TYPE: 1, SCALE: -2, PRECISION: 15, NULL_FLAG: null, DESCRIPTION: null, DEFAULT_SOURCE: null },
            { NAME: 'NOTITIE', FIELD_TYPE: 261, SUB_TYPE: 1, NULL_FLAG: null, DESCRIPTION: null, DEFAULT_SOURCE: null },
            { NAME: 'GEBOREN', FIELD_TYPE: 12, NULL_FLAG: null, DESCRIPTION: null, DEFAULT_SOURCE: null },
        ];
    }
    if (sql.includes("'PRIMARY KEY'")) return [{ COLUMN_NAME: 'ID' }];
    if (sql.includes("'FOREIGN KEY'")) {
        return [
            { CONSTRAINT_NAME: 'FK_A', COLUMN_NAME: 'X', REF_TABLE: 'ANDER', REF_COLUMN: 'ID' },
            { CONSTRAINT_NAME: 'FK_A', COLUMN_NAME: 'Y', REF_TABLE: 'ANDER', REF_COLUMN: 'KEY2' },
            { CONSTRAINT_NAME: 'FK_B', COLUMN_NAME: 'Z', REF_TABLE: 'DERDE', REF_COLUMN: 'ID' },
        ];
    }
    return [];
}

test('firebird_describe_table output shape', async () => {
    const rec = install(metadata);
    const out = await executeFirebirdTool('firebird_describe_table', { table: 'klanten' }, 'u1');
    assert.equal(out.table, 'KLANTEN');
    assert.deepEqual(out.columns, [
        { name: 'ID', type: 'INTEGER', nullable: false, primary_key: true },
        { name: 'NAAM', type: 'VARCHAR(50)', nullable: true, primary_key: false, default: "'x'", description: 'Name' },
        { name: 'BEDRAG', type: 'NUMERIC(15,2)', nullable: true, primary_key: false },
        { name: 'NOTITIE', type: 'BLOB TEXT', nullable: true, primary_key: false },
        { name: 'GEBOREN', type: 'DATE', nullable: true, primary_key: false },
    ]);
    assert.deepEqual(out.primary_key, ['ID']);
    assert.deepEqual(out.foreign_keys, [
        { columns: ['X', 'Y'], references_table: 'ANDER', references_columns: ['ID', 'KEY2'] },
        { columns: ['Z'], references_table: 'DERDE', references_columns: ['ID'] },
    ]);
    assert.deepEqual(rec.statements.map(s => s.params), [['KLANTEN'], ['KLANTEN'], ['KLANTEN']]);
    assertReadOnlyAndDetached(rec);
    assert.equal(rec.tx.length, 3);
});

test('firebird_describe_table: quoted name keeps case; unknown or invalid table is an error', async () => {
    const rec = install(metadata);
    await executeFirebirdTool('firebird_describe_table', { table: '"Klanten"' }, 'u1');
    assert.deepEqual(rec.statements[0].params, ['Klanten']);

    install(() => []);
    assert.match((await executeFirebirdTool('firebird_describe_table', { table: 'weg' }, 'u1')).error, /not found/);
    const rec2 = install(metadata);
    assert.match((await executeFirebirdTool('firebird_describe_table', { table: 'a;drop' }, 'u1')).error, /Invalid table name/);
    assert.equal(rec2.attach.length, 0);
});

test('firebird_sample_rows quotes the identifier and bounds the statement', async () => {
    const rec = install(() => [{ ID: 1, NAAM: 'a  ' }, { ID: 2, NAAM: 'b' }]);
    const out = await executeFirebirdTool('firebird_sample_rows', { table: 'klanten', limit: 2 }, 'u1');
    assert.deepEqual(out.data, [{ ID: 1, NAAM: 'a' }, { ID: 2, NAAM: 'b' }]);
    assert.equal(out.truncated, false);
    assert.equal(rec.statements[0].sql, 'SELECT FIRST 3 * FROM "KLANTEN"');
    assertReadOnlyAndDetached(rec);

    install(() => []);
    assert.match((await executeFirebirdTool('firebird_sample_rows', {}, 'u1')).error, /Invalid table name/);
});

test('firebird_sample_rows with unlimited rows omits FIRST', async () => {
    process.env.FIREBIRD_MAX_ROWS = '0';
    const rec = install(() => []);
    await executeFirebirdTool('firebird_sample_rows', { table: 't', limit: 5000 }, 'u1');
    assert.equal(rec.statements[0].sql, 'SELECT FIRST 5001 * FROM "T"');
    await executeFirebirdTool('firebird_sample_rows', { table: 't' }, 'u1');
    assert.equal(rec.statements[1].sql, 'SELECT FIRST 101 * FROM "T"');
});

test('firebird_query: rows, columns, params, truncation by limit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ID: i, D: new Date('2026-02-03T00:00:00Z') }));
    const rec = install(() => rows);
    const out = await executeFirebirdTool('firebird_query', { sql: 'select id, d from t where x = ?;', params: ['a', 1, true, null], limit: 4 }, 'u1');
    assert.equal(out.count, 4);
    assert.equal(out.truncated, true);
    assert.deepEqual(out.columns, ['ID', 'D']);
    assert.equal(out.data[0].D, '2026-02-03T00:00:00.000Z');
    assert.ok(out.message);
    assert.equal(rec.statements[0].sql, 'select id, d from t where x = ?');
    assert.deepEqual(rec.statements[0].params, ['a', 1, true, null]);
    assertReadOnlyAndDetached(rec);
});

test('firebird_query: default limit 100 and env maximum', async () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({ ID: i }));
    install(() => rows);
    const def = await executeFirebirdTool('firebird_query', { sql: 'select id from t' }, 'u1');
    assert.equal(def.count, 100);
    assert.equal(def.truncated, true);
    process.env.FIREBIRD_MAX_ROWS = '10';
    assert.equal((await executeFirebirdTool('firebird_query', { sql: 'select id from t', limit: 200 }, 'u1')).count, 10);
    process.env.FIREBIRD_MAX_ROWS = '0';
    assert.equal((await executeFirebirdTool('firebird_query', { sql: 'select id from t', limit: 250 }, 'u1')).count, 250);
});

test('firebird_query: output budget drops trailing rows and flags truncation', async () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ ID: i, TXT: 'q'.repeat(1900) }));
    install(() => rows);
    const out = await executeFirebirdTool('firebird_query', { sql: 'select * from t' }, 'u1');
    assert.equal(out.truncated, true);
    assert.ok(out.count < 100);
    assert.ok(JSON.stringify(out.data).length <= 30000);
    assert.match(out.message, /too large/);
});

test('firebird_query: rejected statements and bad params never reach the driver', async () => {
    const rec = install(() => []);
    for (const sql of ['delete from t', 'select 1 from t; select 2 from t', 'execute block as begin end', 'set transaction read write', '/* */ delete from t', 'with c as (select 1 from t) insert into t select * from c']) {
        const out = await executeFirebirdTool('firebird_query', { sql }, 'u1');
        assert.ok(out.error && out.error.startsWith('Firebird:'), sql);
    }
    for (const params of ['x', [{ a: 1 }], [[1]], Array(101).fill(1)]) {
        assert.ok((await executeFirebirdTool('firebird_query', { sql: 'select 1 from t', params }, 'u1')).error);
    }
    assert.ok((await executeFirebirdTool('firebird_query', {}, 'u1')).error);
    assert.equal(rec.attach.length, 0);
});

test('every failure is an { error } that detaches and hides the password', async () => {
    const failing = new Error(`Dynamic SQL Error ${PASSWORD}`);
    failing.gdscode = 335544569;
    for (const [tool, args] of [
        ['firebird_whoami', {}],
        ['firebird_list_tables', {}],
        ['firebird_describe_table', { table: 't' }],
        ['firebird_sample_rows', { table: 't' }],
        ['firebird_query', { sql: 'select 1 from t' }],
    ]) {
        const rec = install(() => failing);
        const out = await executeFirebirdTool(tool, args, 'u1');
        assert.match(out.error, /^Firebird: /, tool);
        assertNoPassword(out);
        assertReadOnlyAndDetached(rec);
    }
});

test('connection errors are { error } with host:port and no password', async () => {
    const cases = [
        [Object.assign(new Error('Your user name and password are not defined'), { gdscode: 335544472 }), /failed: wrong user name or password/],
        [Object.assign(new Error('unavailable'), { gdscode: 335544375 }), /unavailable at db\.internal:3050/],
        [Object.assign(new Error(`connect ECONNREFUSED ${PASSWORD}`), { code: 'ECONNREFUSED' }), /Could not connect to db\.internal:3050/],
    ];
    for (const [attachError, pattern] of cases) {
        install(() => [], { attachError });
        const out = await executeFirebirdTool('firebird_whoami', {}, 'u1');
        assert.match(out.error, pattern);
        assert.match(out.error, /db\.internal:3050/);
        assertNoPassword(out);
    }
});

// ── testFirebirdConnection ────────────────────────────────────────────

const RAW = { host: 'db.internal', port: 3050, database: '/data/main.fdb', user: 'READER', password: PASSWORD, charset: 'UTF8' };

test('testFirebirdConnection: ok', async () => {
    const rec = install(() => [{ SERVER_VERSION: '5.0.1', TABLE_COUNT: 77 }]);
    assert.deepEqual(await testFirebirdConnection(RAW), { ok: true, server_version: '5.0.1', table_count: 77 });
    assertReadOnlyAndDetached(rec);
});

test('testFirebirdConnection: failures carry a message without the password', async () => {
    install(() => [], { attachError: Object.assign(new Error(`bad ${PASSWORD}`), { gdscode: 335544472 }) });
    const login = await testFirebirdConnection(RAW);
    assert.equal(login.ok, false);
    assert.match(login.error, /wrong user name or password/);
    assertNoPassword(login);

    const rec = install(() => []);
    const invalid = await testFirebirdConnection({ ...RAW, host: 'http://x' });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /server name/);
    assert.equal((await testFirebirdConnection({})).ok, false);
    assert.equal((await testFirebirdConnection(undefined)).ok, false);
    assert.equal(rec.attach.length, 0);
});

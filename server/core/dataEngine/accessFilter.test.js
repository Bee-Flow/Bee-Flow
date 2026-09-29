/**
 * The access-filter compiler, exercised directly at its new home in core/.
 *
 * appStudio/rlsGateway.matrix.test.js and rlsGateway.publicRole.test.js already
 * pin the behaviour through the App Studio shim, and they must keep passing
 * unmodified — that is the acceptance gate for the move. What THIS file adds is
 * the two properties the move itself created:
 *
 *   1. the module is importable with no App Studio, no store and no database —
 *      it is a pure function of (tableMeta, role, viewer, action);
 *   2. the dialect comes from the caller, so a Postgres-backed datatable is not
 *      handed SQLite predicates by the process-global App Studio engine flag.
 *
 * Property 1 is not cosmetic: server/layering.test.js forbids core/ requiring a
 * feature, so a stray `require('../../appStudio/…')` here would fail the build.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const accessFilter = require('./accessFilter');
const engineFlag = require('./engineFlag');

const TABLE = {
    id: 'tbl_aaaaaa',
    key: 'people',
    fields: [
        { id: 'f1', key: 'name', type: 'text' },
        { id: 'f2', key: 'region', type: 'text' },
        { id: 'f3', key: 'active', type: 'bool' },
    ],
    access: {
        default: 'none',
        roles: {
            viewer: { read: 'own', create: false, update: 'none', delete: 'none' },
            editor: { read: 'all', create: true, update: 'all', delete: 'all' },
        },
    },
};

function withEnv(dialect, fn) {
    engineFlag._setForTests(dialect);
    try { return fn(); } finally { engineFlag._setForTests(null); }
}

// ── it stands alone ─────────────────────────────────────────────────────────

test('the module exports the whole compiler and nothing app-shaped', () => {
    for (const fn of ['resolveScope', 'canRead', 'compileAccessFilter', 'assertCanWrite',
        'rowFilterToSql', 'validateRowFilter']) {
        assert.strictEqual(typeof accessFilter[fn], 'function', `${fn} must be exported`);
    }
    assert.strictEqual(accessFilter.resolveViewerRole, undefined,
        'resolveViewerRole reads studio_app_members and belongs to the App Studio shim');
    assert.strictEqual(typeof accessFilter.AccessError, 'function');
});

test('nothing under core/dataEngine reaches for a feature, a store or the database', () => {
    const path = require('node:path');
    const seen = new Set();
    const here = path.dirname(require.resolve('./accessFilter'));
    // Walk the live require cache: everything accessFilter pulled in, transitively.
    const walk = (id) => {
        if (seen.has(id)) return;
        seen.add(id);
        const mod = require.cache[id];
        if (!mod) return;
        for (const child of mod.children || []) walk(child.id);
    };
    walk(require.resolve('./accessFilter'));
    const offenders = [...seen].filter(id =>
        !id.includes('node_modules')
        && (id.includes(`${path.sep}appStudio${path.sep}`)
            || id.includes(`${path.sep}stores${path.sep}`)
            || id.endsWith(`${path.sep}db.js`)));
    assert.deepStrictEqual(offenders, [],
        'core/dataEngine must stay pure — no feature, no store, no db:\n  ' + offenders.join('\n  '));
    assert.ok(here.endsWith(path.join('core', 'dataEngine')));
});

// ── scopes ──────────────────────────────────────────────────────────────────

test('an owner gets full access and skips row filters', () => {
    assert.strictEqual(accessFilter.resolveScope(TABLE, 'owner', 'read'), 'all');
    assert.strictEqual(accessFilter.resolveScope(TABLE, 'owner', 'create'), true);
});

test('an unknown role is denied, not defaulted', () => {
    assert.strictEqual(accessFilter.resolveScope(TABLE, 'stranger', 'read'), 'none');
    assert.strictEqual(accessFilter.resolveScope(TABLE, null, 'read'), 'none');
    assert.strictEqual(accessFilter.canRead(TABLE, 'stranger'), false);
});

test('an "own" read scopes rows to the viewer', () => {
    const { where, params } = accessFilter.compileAccessFilter(TABLE, 'viewer', { id: 'u1' }, 'read');
    assert.match(where, /created_by/);
    assert.ok(params.includes('u1'));
});

test('a denied role compiles to a predicate that matches nothing', () => {
    const { where } = accessFilter.compileAccessFilter(TABLE, 'stranger', { id: 'u1' }, 'read');
    assert.match(where, /1\s*=\s*0/, 'deny must be expressed in SQL, never by omitting the filter');
});

test('compileAccessFilter always returns a non-empty where — the compiler refuses an absent one', () => {
    for (const role of ['owner', 'editor', 'viewer', 'stranger', null]) {
        const af = accessFilter.compileAccessFilter(TABLE, role, { id: 'u1' }, 'read');
        assert.ok(af && typeof af.where === 'string' && af.where.length > 0,
            `role ${role} produced an empty access filter`);
        assert.ok(Array.isArray(af.params));
    }
});

test('assertCanWrite throws 403 for a role without the action and returns the scope otherwise', () => {
    assert.strictEqual(accessFilter.assertCanWrite(TABLE, 'editor', 'update'), 'all');
    assert.throws(() => accessFilter.assertCanWrite(TABLE, 'viewer', 'update'), (e) => e.status === 403);
    assert.throws(() => accessFilter.assertCanWrite(TABLE, 'editor', 'read'), (e) => e.status === 400);
});

// ── 'create' is not a row predicate ─────────────────────────────────────────

test('compiling a filter for a CREATE throws — for every role, owner included', () => {
    // It used to answer 1=0 for owner, editor and viewer alike: resolveScope
    // returns the BOOLEAN true for a create while the where-builder only knows
    // the strings 'all'/'own'. execDatatable handed that to the upsert probe,
    // so "add or update a row" had always been "always add a row".
    for (const role of ['owner', 'editor', 'viewer', 'stranger', null]) {
        assert.throws(
            () => accessFilter.compileAccessFilter(TABLE, role, { id: 'u1' }, 'create'),
            (e) => e.name === 'AccessError' && /create/.test(e.message),
            `role ${role} must not receive a row predicate for a create`,
        );
    }
    // The permission half still answers, and answers differently per role.
    assert.strictEqual(accessFilter.assertCanWrite(TABLE, 'editor', 'create'), true);
    assert.throws(() => accessFilter.assertCanWrite(TABLE, 'viewer', 'create'), (e) => e.status === 403);
});

test('the read/update/delete matrix is unchanged by the create refusal', () => {
    const rows = {
        owner: { read: '1=1', update: '1=1', delete: '1=1' },
        // 'own' READ scopes to the viewer; viewer update/delete are 'none'.
        viewer: { read: 'created_by', update: '1=0', delete: '1=0' },
        editor: { read: '1=1', update: '1=1', delete: '1=1' },
        stranger: { read: '1=0', update: '1=0', delete: '1=0' },
    };
    for (const [role, expected] of Object.entries(rows)) {
        for (const [action, fragment] of Object.entries(expected)) {
            const { where } = accessFilter.compileAccessFilter(TABLE, role, { id: 'u1' }, action);
            assert.ok(where.includes(fragment),
                `${role} × ${action} should compile to ${fragment}, got ${where}`);
        }
    }
});

test('a WRITE predicate does not distinguish grades — the coarse check is the only guard', () => {
    // Documented, not endorsed: a table whose default is 'app' compiles
    // viewer+update to 1=1, so nothing stops a viewer writing except the
    // caller's own gradeAtLeast/assertCanWrite. Its own ticket, its own test
    // matrix — do not "fix" it here and quietly change what every caller means.
    const T = { ...TABLE, access: { default: 'app' } };
    assert.strictEqual(accessFilter.compileAccessFilter(T, 'viewer', { id: 'u1' }, 'update').where, '1=1');
    assert.strictEqual(accessFilter.assertCanWrite(T, 'viewer', 'update'), 'all',
        'the ANDed predicate is NOT a second line of defence for writes');
});

// ── row filters ─────────────────────────────────────────────────────────────

test('a row filter compiles to parameterised SQL over record.* and viewer.*', () => {
    const { sql, params } = accessFilter.rowFilterToSql(
        'record.region == viewer.region', { region: 'eu' }, TABLE);
    assert.match(sql, /"region"/);
    assert.match(sql, /\?/);
    assert.deepStrictEqual(params, ['eu']);
});

test('a row filter rejects anything outside the safe subset', () => {
    for (const expr of ['record.name.length > 2', 'foo(record.name)', 'record.a + 1 > 2', 'other.x == 1']) {
        assert.strictEqual(accessFilter.validateRowFilter(expr, TABLE).ok, false, `${expr} must be refused`);
    }
});

test('a row filter cannot address a column the table does not declare', () => {
    assert.strictEqual(accessFilter.validateRowFilter('record.salary > 1', TABLE).ok, false);
});

// ── the dialect comes from the caller ───────────────────────────────────────

test('a row-filter boolean binds per the CALLER dialect, not the process global', () => {
    const asPg = withEnv('sqlite', () => accessFilter.rowFilterToSql(
        'record.active == true', {}, TABLE, { dialect: 'pg' }));
    const asLite = withEnv('pg', () => accessFilter.rowFilterToSql(
        'record.active == true', {}, TABLE, { dialect: 'sqlite' }));
    assert.ok(asPg.params.includes(true), 'pg binds a real boolean');
    assert.ok(asLite.params.includes(1), 'better-sqlite3 refuses a raw boolean');
});

test('a viewer boolean attribute binds per the caller dialect too', () => {
    const T = { ...TABLE, access: { default: 'none', roles: { viewer: { read: 'all' } },
        rowFilters: { viewer: 'record.active == viewer.flag' } } };
    const asPg = withEnv('sqlite', () => accessFilter.compileAccessFilter(
        T, 'viewer', { id: 'u1', flag: true }, 'read', { dialect: 'pg' }));
    assert.ok(asPg.params.includes(true), 'the row filter must inherit the compiled dialect');
});

test('passing no dialect follows the process global, preserving App Studio behaviour', () => {
    const asPg = withEnv('pg', () => accessFilter.rowFilterToSql('record.active == true', {}, TABLE));
    const asLite = withEnv('sqlite', () => accessFilter.rowFilterToSql('record.active == true', {}, TABLE));
    assert.ok(asPg.params.includes(true));
    assert.ok(asLite.params.includes(1));
});

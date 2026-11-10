/**
 * Row rules: lists of the viewer (`record.x in viewer.groups`) and a rule per
 * operation (`rowFilters[role] = { read, update, delete }`).
 *
 * Three things are pinned here:
 *   1. one rule (a string) compiles to the same SQL and params it always did,
 *      for read, update and delete;
 *   2. membership is bound, and an attribute nobody supplied is UNKNOWN: no
 *      row, not under a `!` either (run against a real SQLite);
 *   3. a per-operation entry gives each operation its own rule, and a
 *      malformed one is refused instead of read as "no rule".
 *
 * Run: cd server && node --test core/dataEngine/accessFilter.viewerRules.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const accessFilter = require('./accessFilter');
const { VIEWER_ATTRIBUTES, ROW_FILTER_FEATURES } = require('./dataModel/vocabulary');

const SQLITE = { dialect: 'sqlite' };
const PG = { dialect: 'pg' };

/** A table whose `member` role may read, change and delete every row, narrowed by `rule`. */
function tableWith(rule) {
    return {
        id: 'tbl_aaaaaa',
        key: 'tasks',
        fields: [
            { id: 'f1', key: 'title', type: 'text' },
            { id: 'f2', key: 'team', type: 'text' },
            { id: 'f3', key: 'status', type: 'select', options: ['open', 'done'] },
            { id: 'f4', key: 'amount', type: 'number' },
            { id: 'f5', key: 'contact', type: 'text' },
        ],
        access: {
            default: 'none',
            roles: { member: { read: 'all', create: true, update: 'all', delete: 'all' } },
            rowFilters: rule === undefined ? {} : { member: rule },
        },
    };
}

const compile = (rule, viewer, action = 'read', opts = SQLITE) => accessFilter.compileAccessFilter(tableWith(rule), 'member', viewer, action, opts);

// ── 1. one rule stays one rule ──────────────────────────────────────

test('a string rule compiles to the same SQL for read, update and delete', () => {
    const rule = 'record.team == viewer.region && record.amount >= 10';
    const viewer = { id: 'u1', role: 'member', region: 'north' };
    for (const action of ['read', 'update', 'delete']) {
        assert.deepEqual(compile(rule, viewer, action), {
            where: '(1=1) AND ((("team" = ?) AND ("amount" >= ?)))',
            params: ['north', 10],
        }, action);
    }
});

test('the same rule under all three operations equals the single rule', () => {
    const rule = 'record.status != "done"';
    const viewer = { id: 'u1', role: 'member' };
    for (const action of ['read', 'update', 'delete']) {
        assert.deepEqual(
            compile({ read: rule, update: rule, delete: rule }, viewer, action),
            compile(rule, viewer, action), action);
    }
});

test('extra attributes on the viewer change nothing for a rule that does not read them', () => {
    const rule = 'record.team == viewer.region';
    const bare = compile(rule, { id: 'u1', role: 'member', region: 'north' });
    const rich = compile(rule, { id: 'u1', role: 'member', region: 'north', email: 'a@example.org', groups: ['g1'], orgId: 'org_1' });
    assert.deepEqual(rich, bare);
});

// ── 2. membership ───────────────────────────────────────────────────

test('record.x in viewer.groups binds every item', () => {
    const out = compile('record.team in viewer.groups', { id: 'u1', groups: ['g1', 'g2', 'g3'] });
    assert.deepEqual(out, { where: '(1=1) AND (("team" IN (?, ?, ?)))', params: ['g1', 'g2', 'g3'] });
    assert.deepEqual(compile('record.team in viewer.groups', { id: 'u1', groups: ['g1'] }, 'read', PG), {
        where: '(1=1) AND (("team" IN (?)))', params: ['g1'],
    });
});

test('an empty list is false; a list that was not supplied is unknown', () => {
    assert.deepEqual(compile('record.team in viewer.groups', { id: 'u1', groups: [] }), { where: '(1=1) AND ((1=0))', params: [] });
    assert.deepEqual(compile('record.team in viewer.groups', { id: 'u1' }), { where: '(1=1) AND (("team" IN (NULL)))', params: [] });
    // Not a list at all counts as not supplied, never as "everything".
    assert.deepEqual(compile('record.team in viewer.groups', { id: 'u1', groups: 'g1' }), { where: '(1=1) AND (("team" IN (NULL)))', params: [] });
    // Items that are not text never reach the statement.
    assert.deepEqual(compile('record.team in viewer.groups', { id: 'u1', groups: ['g1', null, 7, '', { a: 1 }] }).params, ['g1']);
});

test('membership combines with the rest of the grammar', () => {
    const out = compile('record.team in viewer.groups || record.contact == viewer.email', { id: 'u1', groups: ['g1'], email: 'a@example.org' });
    assert.deepEqual(out, { where: '(1=1) AND ((("team" IN (?)) OR ("contact" = ?)))', params: ['g1', 'a@example.org'] });
    assert.deepEqual(compile('record.org_id == viewer.orgId', { id: 'u1', orgId: 'org_1' }), { where: '(1=1) AND (("org_id" = ?))', params: ['org_1'] });
});

test('unknown is never true, not under a negation either (real SQLite)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE tasks (id TEXT PRIMARY KEY, team TEXT, contact TEXT)');
    const ins = db.prepare('INSERT INTO tasks (id, team, contact) VALUES (?, ?, ?)');
    ins.run('r1', 'g1', 'a@example.org');
    ins.run('r2', 'g2', 'b@example.org');
    ins.run('r3', null, null);
    const ids = (rule, viewer) => {
        const f = compile(rule, viewer);
        return db.prepare(`SELECT id FROM tasks WHERE ${f.where} ORDER BY id`).all(...f.params).map((r) => r.id);
    };
    const member = { id: 'u1', groups: ['g1'], email: 'a@example.org' };
    assert.deepEqual(ids('record.team in viewer.groups', member), ['r1']);
    assert.deepEqual(ids('!(record.team in viewer.groups)', member), ['r2']);
    // In no group: in none of them, and "not in mine" holds for every row that has a team.
    assert.deepEqual(ids('record.team in viewer.groups', { id: 'u2', groups: [] }), []);
    assert.deepEqual(ids('!(record.team in viewer.groups)', { id: 'u2', groups: [] }), ['r1', 'r2', 'r3']);
    // Not supplied: no row, whichever way the rule is turned.
    const unresolved = { id: 'u3' };
    assert.deepEqual(ids('record.team in viewer.groups', unresolved), []);
    assert.deepEqual(ids('!(record.team in viewer.groups)', unresolved), []);
    assert.deepEqual(ids('record.contact == viewer.email', unresolved), []);
    assert.deepEqual(ids('record.contact != viewer.email', unresolved), []);
    assert.deepEqual(ids('!(record.contact == viewer.email)', unresolved), []);
    db.close();
});

test('membership is refused outside its one shape', () => {
    const bad = (rule) => accessFilter.validateRowFilter(rule, tableWith()).errors.join(' | ');
    assert.match(bad('record.amount in viewer.groups'), /only a text or select field/);
    assert.match(bad('record.created_at in viewer.groups'), /does not hold text/);
    assert.match(bad('record.team in viewer.email'), /must be a list of the viewer: viewer\.groups/);
    assert.match(bad('record.team in viewer.teams'), /must be a list of the viewer/);
    assert.match(bad('record.team in record.status'), /must be a list of the viewer/);
    assert.match(bad('"g1" in viewer.groups'), /left side of "in" must be record\.<field>/);
    assert.match(bad('viewer.id in viewer.groups'), /left side of "in" must be record\.<field>/);
    assert.match(bad('record.nope in viewer.groups'), /unknown field "nope"/);
    assert.equal(accessFilter.validateRowFilter('record.created_by in viewer.groups', tableWith()).ok, true);
    assert.equal(accessFilter.validateRowFilter('record.status in viewer.groups', tableWith()).ok, true);
});

test('a list used as one value is an error at save time and matches nothing at read time', () => {
    const check = accessFilter.validateRowFilter('record.team == viewer.groups', tableWith());
    assert.equal(check.ok, false);
    assert.match(check.errors[0], /viewer\.groups is a list: write record\.<field> in viewer\.groups/);
    // A stored rule of that shape keeps reading (no row), it does not start failing.
    assert.deepEqual(compile('record.team == viewer.groups', { id: 'u1', groups: ['g1'] }), { where: '(1=1) AND (("team" = ?))', params: [null] });
});

// ── advice ──────────────────────────────────────────────────────────

test('viewer.organizationId is accepted with a recommendation for viewer.orgId', () => {
    const check = accessFilter.validateRowFilter('record.org_id == viewer.organizationId', tableWith());
    assert.equal(check.ok, true);
    assert.deepEqual(check.errors, []);
    assert.equal(check.warnings.length, 1);
    assert.match(check.warnings[0], /use viewer\.orgId in a new rule/);
    assert.deepEqual(accessFilter.validateRowFilter('record.org_id == viewer.orgId', tableWith()).warnings, []);
});

test('an attribute the viewer does not have is a warning, as it only ever matched nothing', () => {
    const check = accessFilter.validateRowFilter('record.team == viewer.region', tableWith());
    assert.equal(check.ok, true);
    assert.match(check.warnings[0], /viewer\.region is not something a row rule knows/);
    for (const known of ['id', 'role', 'email']) {
        assert.deepEqual(accessFilter.validateRowFilter(`record.team == viewer.${known}`, tableWith()).warnings, [], known);
    }
});

// ── 3. a rule per operation ─────────────────────────────────────────

test('each operation gets its own rule; one that is left out has none', () => {
    const rule = { read: 'record.status == "open"', update: 'record.team in viewer.groups' };
    const viewer = { id: 'u1', groups: ['g1'] };
    assert.deepEqual(compile(rule, viewer, 'read'), { where: '(1=1) AND (("status" = ?))', params: ['open'] });
    assert.deepEqual(compile(rule, viewer, 'update'), { where: '(1=1) AND (("team" IN (?)))', params: ['g1'] });
    assert.deepEqual(compile(rule, viewer, 'delete'), { where: '1=1', params: [] });
    assert.deepEqual(compile(rule, viewer, 'delete'), compile(undefined, viewer, 'delete'));
});

test('a per-operation rule narrows the scope it sits on, it never replaces it', () => {
    const table = tableWith({ update: 'record.status == "open"' });
    table.access.roles.member = { read: 'all', create: true, update: 'own', delete: 'none' };
    const viewer = { id: 'u1' };
    assert.deepEqual(accessFilter.compileAccessFilter(table, 'member', viewer, 'update', SQLITE), {
        where: '("created_by" = ?) AND (("status" = ?))', params: ['u1', 'open'],
    });
    assert.deepEqual(accessFilter.compileAccessFilter(table, 'member', viewer, 'delete', SQLITE), { where: '1=0', params: [] });
    assert.deepEqual(accessFilter.compileAccessFilter(table, 'owner', viewer, 'update', SQLITE), { where: '1=1', params: [] });
});

test('an AST is one rule, and a per-operation entry may hold ASTs', () => {
    const { parseExpr } = require('../../shared/expr/index.mjs');
    const ast = parseExpr('record.status == "open"');
    const viewer = { id: 'u1' };
    assert.deepEqual(compile(ast, viewer, 'delete'), compile('record.status == "open"', viewer, 'delete'));
    assert.deepEqual(compile({ delete: ast }, viewer, 'delete'), compile('record.status == "open"', viewer, 'delete'));
    assert.deepEqual(compile({ delete: ast }, viewer, 'read'), { where: '1=1', params: [] });
});

test('a malformed per-operation entry is refused, at save time and at read time', () => {
    const typo = { reed: 'record.status == "open"' };
    const check = accessFilter.validateRowFilter(typo, tableWith());
    assert.equal(check.ok, false);
    assert.match(check.errors[0], /"reed" is not a row rule operation \(read, update, delete\)/);
    assert.throws(() => compile(typo, { id: 'u1' }, 'read'), (e) => e.status === 400 && /"reed" is not a row rule operation/.test(e.message));
    // A key that IS an operation does not save the entry.
    assert.throws(() => compile({ read: 'record.status == "open"', create: 'true' }, { id: 'u1' }, 'read'), /"create" is not a row rule operation/);
    assert.match(accessFilter.validateRowFilter({}, tableWith()).errors[0], /needs at least one of read, update, delete/);
    assert.throws(() => compile(['record.status == "open"'], { id: 'u1' }, 'read'), /expression string or AST/);
});

test('errors and warnings of a per-operation entry name their operation', () => {
    const check = accessFilter.validateRowFilter({
        read: 'record.org_id == viewer.organizationId',
        update: 'record.amount in viewer.groups',
        delete: 'record.team in viewer.groups',
    }, tableWith());
    assert.equal(check.ok, false);
    assert.equal(check.errors.length, 1);
    assert.match(check.errors[0], /^update: field "amount" cannot be tested with "in"/);
    assert.match(check.warnings[0], /^read: viewer\.organizationId/);
});

// ── vocabulary ──────────────────────────────────────────────────────

test('the new attributes and grammar parts are marked with the version they arrived in', () => {
    const byKey = Object.fromEntries(VIEWER_ATTRIBUTES.map((spec) => [spec.key, spec]));
    assert.deepEqual(Object.keys(byKey), ['id', 'role', 'organizationId', 'orgId', 'email', 'groups']);
    for (const old of ['id', 'role', 'organizationId']) assert.equal('since' in byKey[old], false, old);
    for (const added of ['orgId', 'email', 'groups']) assert.equal(byKey[added].since, 3, added);
    assert.equal(byKey.groups.list, true);
    assert.deepEqual(ROW_FILTER_FEATURES, { membership: { since: 3 }, perOperation: { since: 3 } });
});

/**
 * RLS gateway — the ACCESS MATRIX across RELATIONS, against a real in-memory
 * SQLite. The sibling of rlsGateway.matrix.test.js for reads that go through a
 * relation field: one row of the matrix per (role, linked table).
 *
 * `tasks` points at two tables with different rules:
 *   projects   member reads OWN projects only; manager all; auditor none
 *   teams      member reads the teams of the viewer's region (a row rule);
 *              manager all; auditor all
 * and at itself (`blocked_by`), under the tasks rules.
 *
 * For every role and every linked table:
 *   • an expansion holds the related row exactly when that role could read the
 *     row directly from its own table, and null otherwise (an invisible parent
 *     reads null, the same as no parent);
 *   • a `<relation>.<column>` filter matches exactly the tasks whose related
 *     row the role can read AND that row passes the clause;
 *   • no column of an unreadable related row is in the answer.
 *
 * Run: cd server && node --test appStudio/rlsGateway.matrix.relations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Database = require('better-sqlite3');

// The access half of the gateway, required from where it lives (rlsGateway re-exports it unchanged),
// so this file needs no stand-in for the membership store the gateway module loads.
const gateway = require('../core/dataEngine/accessFilter');
const qc = require('./queryCompiler');
const { relationRead, finishRecords } = require('../core/dataEngine/relationRead.mts');

const all = { read: 'all', create: true, update: 'all', delete: 'all' };
const MODEL = {
    modelVersion: 1,
    roles: [{ key: 'manager' }, { key: 'member' }, { key: 'auditor' }],
    tables: [
        {
            id: 'tbl_projects', key: 'projects',
            fields: [{ id: 'f_pn', key: 'name', type: 'text' }, { id: 'f_pb', key: 'budget', type: 'number', subtype: 'integer' }],
            access: { default: 'none', roles: { manager: all, member: { read: 'own' } } },
        },
        {
            id: 'tbl_teams', key: 'teams',
            fields: [{ id: 'f_tn', key: 'name', type: 'text' }, { id: 'f_tr', key: 'region', type: 'text' }],
            access: { default: 'none', roles: { manager: all, member: { read: 'all' }, auditor: { read: 'all' } }, rowFilters: { member: 'record.region == viewer.region' } },
        },
        {
            id: 'tbl_tasks', key: 'tasks',
            fields: [
                { id: 'f_title', key: 'title', type: 'text' },
                { id: 'f_proj', key: 'project', type: 'relation', relation: { table: 'tbl_projects', displayField: 'name' } },
                { id: 'f_team', key: 'team', type: 'relation', relation: { table: 'tbl_teams', displayField: 'name' } },
                { id: 'f_blk', key: 'blocked_by', type: 'relation', relation: { table: 'tbl_tasks', displayField: 'title' } },
            ],
            access: { default: 'none', roles: { manager: all, member: { read: 'own' }, auditor: { read: 'all' } } },
        },
    ],
};
const tableOf = (key) => MODEL.tables.find((t) => t.key === key);

const PROJECTS = [
    { id: 'p_alice', created_by: 'alice', name: 'Alpha', budget: 100 },
    { id: 'p_bob', created_by: 'bob', name: 'Bravo', budget: 900 },
];
const TEAMS = [
    { id: 't_eu', created_by: 'carol', name: 'Europe', region: 'EU' },
    { id: 't_us', created_by: 'carol', name: 'States', region: 'US' },
];
const TASKS = [
    { id: 'k1', created_by: 'alice', title: 'One', project: 'p_alice', team: 't_eu', blocked_by: null },
    { id: 'k2', created_by: 'alice', title: 'Two', project: 'p_bob', team: 't_us', blocked_by: 'k1' },
    { id: 'k3', created_by: 'alice', title: 'Three', project: null, team: null, blocked_by: 'k4' },
    { id: 'k4', created_by: 'bob', title: 'Four', project: 'p_bob', team: 't_eu', blocked_by: 'k2' },
    { id: 'k5', created_by: 'alice', title: 'Five', project: 'p_gone', team: 't_eu', blocked_by: null },
];
const ROWS = { projects: PROJECTS, teams: TEAMS, tasks: TASKS };

function seedDb() {
    const db = new Database(':memory:');
    for (const t of MODEL.tables) {
        const cols = t.fields.map((f) => `"${f.key}" ${f.type === 'number' ? 'INTEGER' : 'TEXT'}`).join(', ');
        db.exec(`CREATE TABLE "${t.key}" (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, created_by TEXT, org_id TEXT, ${cols})`);
        for (const row of ROWS[t.key]) {
            const names = ['id', 'created_at', 'updated_at', 'created_by', 'org_id', ...t.fields.map((f) => f.key)];
            const full = { created_at: `2026-01-0${ROWS[t.key].indexOf(row) + 1}T00:00:00.000Z`, updated_at: '2026-01-09T00:00:00.000Z', org_id: 'org1', ...row };
            db.prepare(`INSERT INTO "${t.key}" (${names.map((n) => `"${n}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...names.map((n) => full[n] ?? null));
        }
    }
    return db;
}

const VIEWERS = {
    manager: { id: 'carol', region: 'EU' },
    member: { id: 'alice', region: 'EU' },
    auditor: { id: 'dave', region: 'US' },
};

/** The ids of a table this role reads when it lists that table directly: the ground truth of the matrix. */
function readableIds(db, key, role) {
    const t = tableOf(key);
    if (!gateway.canRead(t, role)) return new Set();
    const c = qc.compileRecordList(t, { limit: 1000 }, gateway.compileAccessFilter(t, role, VIEWERS[role], 'read'));
    return new Set(db.prepare(c.sql).all(...c.params).map((r) => r.id));
}

/** A tasks read for a role, through the compiler and the expansion step. */
async function listTasks(db, role, descriptor) {
    const tasks = tableOf('tasks');
    const who = { role, viewer: VIEWERS[role] };
    const compiled = qc.compileRecordList(tasks, { filters: descriptor.filters, limit: 1000 },
        gateway.compileAccessFilter(tasks, role, VIEWERS[role], 'read'), relationRead(MODEL, tasks, descriptor, who));
    const rows = db.prepare(compiled.sql).all(...compiled.params);
    return finishRecords(compiled, rows, async (sql, params) => ({ rows: db.prepare(sql).all(...params) }));
}

/** [relation field, linked table, a column of it, a value some rows of it have]. */
const LINKS = [
    ['project', 'projects', 'name', 'Bravo'],
    ['team', 'teams', 'region', 'EU'],
    ['blocked_by', 'tasks', 'title', 'Two'],
];

for (const role of Object.keys(VIEWERS)) {
    for (const [field, linked, column, value] of LINKS) {
        test(`${role} × ${linked}: an expansion holds exactly the related rows the role reads itself; an invisible parent reads null`, async () => {
            const db = seedDb();
            const readable = readableIds(db, linked, role);
            const visibleTasks = readableIds(db, 'tasks', role);
            const records = await listTasks(db, role, { expand: [{ field, pick: [column], as: 'rel' }] });
            assert.deepStrictEqual(new Set(records.map((r) => r.id)), visibleTasks, 'expanding never changes which tasks are listed');
            for (const r of records) {
                const target = ROWS[linked].find((x) => x.id === r[field]);
                if (target && readable.has(target.id)) {
                    const label = tableOf('tasks').fields.find((f) => f.key === field).relation.displayField;
                    assert.deepStrictEqual(r.rel, { id: target.id, [column]: target[column], _label: target[label] }, `${r.id}: the readable related row`);
                } else {
                    assert.strictEqual(r.rel, null, `${r.id}: ${r[field] ?? 'no relation'} is not readable for ${role}`);
                }
            }
            const leaked = ROWS[linked].filter((x) => !readable.has(x.id)).flatMap((x) => [x.name, x.title].filter(Boolean));
            const text = JSON.stringify(records.map((r) => r.rel));
            for (const name of leaked) assert.ok(!text.includes(`"${name}"`), `${name} never leaves`);
        });

        test(`${role} × ${linked}: a ${field}.${column} filter matches only through related rows the role reads`, async () => {
            const db = seedDb();
            const readable = readableIds(db, linked, role);
            const visibleTasks = readableIds(db, 'tasks', role);
            const expected = TASKS.filter((k) => visibleTasks.has(k.id)).filter((k) => {
                const target = ROWS[linked].find((x) => x.id === k[field]);
                return !!target && readable.has(target.id) && target[column] === value;
            }).map((k) => k.id).sort();
            const records = await listTasks(db, role, { filters: [{ field: `${field}.${column}`, op: 'eq', value }] });
            assert.deepStrictEqual(records.map((r) => r.id).sort(), expected);
            // The negation holds every other visible task, readable parent or not.
            const rest = await listTasks(db, role, { filters: [{ not: { field: `${field}.${column}`, op: 'eq', value } }] });
            assert.deepStrictEqual(rest.map((r) => r.id).sort(), [...visibleTasks].filter((id) => !expected.includes(id)).sort());
        });
    }
}

test('the matrix is not vacuous: each linked table hides a parent from some role and shows it to another', async () => {
    const db = seedDb();
    assert.deepStrictEqual([...readableIds(db, 'projects', 'member')], ['p_alice']);
    assert.strictEqual(readableIds(db, 'projects', 'auditor').size, 0);
    assert.strictEqual(readableIds(db, 'projects', 'manager').size, 2);
    assert.deepStrictEqual([...readableIds(db, 'teams', 'member')], ['t_eu']);
    assert.strictEqual(readableIds(db, 'teams', 'auditor').size, 2);
    const member = await listTasks(db, 'member', { expand: [{ field: 'project' }, { field: 'team' }, { field: 'blocked_by' }] });
    const k2 = member.find((r) => r.id === 'k2');
    assert.deepStrictEqual([k2.project_record, k2.team_record, k2.blocked_by_record], [null, null, { id: 'k1', title: 'One', _label: 'One' }]);
    // k3 is blocked by bob's task: the member cannot read it, so it reads null.
    assert.strictEqual(member.find((r) => r.id === 'k3').blocked_by_record, null);
});

test('no role: no read, and nothing to expand into', () => {
    const tasks = tableOf('tasks');
    const read = relationRead(MODEL, tasks, { expand: [{ field: 'project' }] }, { role: null, viewer: { id: 'x' } });
    assert.deepStrictEqual(read.related.project.accessFilter, { where: '1=0', params: [] });
    assert.strictEqual(gateway.canRead(tasks, null), false);
});

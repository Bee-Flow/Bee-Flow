/**
 * COLUMN RIGHTS, the oracle test, on SQLite (better-sqlite3) and Postgres (PGlite).
 *
 * Two worlds hold the same app and the same rows; only the fields hidden from the
 * restricted roles differ (testUtils/columnRightsWorlds.testkit.js). Each probe below is
 * one way a viewer could try to learn a hidden value: an equality, range or text filter, a
 * comparison with another column, a sort, a search, a group, an aggregate, a groupFilter, a
 * computed field, a relation path from another table, an expansion, a projection, the total
 * of a filtered read, the match count of a bulk write, a key lookup, a cursor.
 *
 * For a role that may not read the fields, the answer to every probe (the rows, the count,
 * or the refusal and its text) is the same in both worlds, and holds no hidden value. For a
 * role that may read them the same probes do tell the worlds apart, so the probes are not
 * vacuous.
 *
 * Run: cd server && node --test core/dataEngine/columnRights.oracle.engines.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const qc = require('./queryCompiler');
const bulk = require('./queryCompilerBulk.mts');
const access = require('./accessFilter');
const { relationRead, finishRecords } = require('./relationRead.mts');
const { relatedForAggregate } = require('./aggregateRelated.mts');
const { queryWithComputed } = require('./computedRead.mts');
const { recordListDescriptor, aggregateDescriptor } = require('./readDescriptor.mts');
const { APP_ENGINES } = require('../../testUtils/appEngines');
const { MODEL, tableOf, secretsOf, seedWorld } = require('../../testUtils/columnRightsWorlds.testkit');

const viewerOf = (role) => ({ id: `u_${role}`, role });

/** A record read the way dataReadRunner.runRecordList runs it: list, computed fields, total, expansions. */
async function records(engine, role, key, d) {
    const table = tableOf(key);
    const who = { role, viewer: viewerOf(role), dialect: engine.dialect };
    const filter = access.compileAccessFilter(table, role, who.viewer, 'read', { dialect: engine.dialect });
    const read = relationRead(MODEL, table, d, who);
    const descriptor = recordListDescriptor(d, { cursor: d.cursor, limit: d.limit, dialect: engine.dialect, readTimeComputed: true });
    const compiled = qc.compileRecordList(table, descriptor, filter, read);
    const { result, notes } = await queryWithComputed(engine.query, compiled);
    const rows = result.rows.slice(0, compiled.limit);
    const out = { records: await finishRecords(compiled, rows, engine.query), notes };
    if (result.rows.length > compiled.limit) out.nextCursor = qc.nextCursor(compiled, rows[rows.length - 1]);
    if (d.total === true) {
        const count = qc.compileRecordCount(table, descriptor, filter, read);
        out.total = Number((await engine.query(count.sql, count.params)).rows[0].total);
    }
    return out;
}

/** An aggregate read the way dataReadRunner.runInlineAggregate runs it. */
async function aggregate(engine, role, key, d) {
    const table = tableOf(key);
    const who = { role, viewer: viewerOf(role), dialect: engine.dialect };
    const filter = access.compileAccessFilter(table, role, who.viewer, 'read', { dialect: engine.dialect });
    const related = relatedForAggregate(MODEL, table, d.groupBy, who, d.filters);
    const { sql, params } = qc.compileAggregate(table, aggregateDescriptor(d, { limit: d.limit, dialect: engine.dialect }), filter, related);
    return (await engine.query(sql, params)).rows;
}

async function one(engine, role, key, id) {
    const table = tableOf(key);
    const filter = access.compileAccessFilter(table, role, viewerOf(role), 'read', { dialect: engine.dialect });
    const compiled = qc.compileGetById(table, id, filter, { dialect: engine.dialect, readTimeComputed: true });
    return (await queryWithComputed(engine.query, compiled)).result.rows;
}

/** How many rows a filtered bulk update would match (the count a bulk step reports). */
async function bulkMatch(engine, role, key, filters) {
    const table = tableOf(key);
    const filter = access.compileAccessFilter(table, role, viewerOf(role), 'update', { dialect: engine.dialect });
    const count = bulk.compileCountMatching(table, filters, filter, { dialect: engine.dialect });
    const ids = bulk.compileMatchIds(table, filters, filter, { dialect: engine.dialect });
    return { n: Number((await engine.query(count.sql, count.params)).rows[0].n), ids: (await engine.query(ids.sql, ids.params)).rows };
}

async function keyIndex(engine, role, key, field, keys) {
    const table = tableOf(key);
    const filter = access.compileAccessFilter(table, role, viewerOf(role), 'read', { dialect: engine.dialect });
    const { sql, params } = qc.compileKeyIndex(table, field, keys, filter, { dialect: engine.dialect });
    return (await engine.query(sql, params)).rows;
}

const staff = (d) => (engine, role) => records(engine, role, 'staff', d);
const staffAgg = (d) => (engine, role) => aggregate(engine, role, 'staff', d);
const count = { fn: 'count', as: 'n' };

/** [what the viewer tries, the read]. Values are chosen so each probe splits the worlds for a role that reads the field. */
const PROBES = [
    // The record itself.
    ['a plain list', staff({})],
    ['one record by id', (e, r) => one(e, r, 'staff', 's2')],
    ['departments, a plain list', (e, r) => records(e, r, 'departments', {})],
    // Filters on a hidden field.
    ['filter: equality', staff({ filters: [{ field: 'salary', op: 'eq', value: 41010 }] })],
    ['filter: greater than', staff({ filters: [{ field: 'salary', op: 'gt', value: 60000 }] })],
    ['filter: less than or equal', staff({ filters: [{ field: 'salary', op: 'lte', value: 52020 }] })],
    ['filter: between', staff({ filters: [{ field: 'salary', op: 'between', value: [50000, 90000] }] })],
    ['filter: in', staff({ filters: [{ field: 'salary', op: 'in', value: [41010, 88080] }] })],
    ['filter: contains on a text field', staff({ filters: [{ field: 'rating', op: 'contains', value: 'yew' }] })],
    ['filter: startsWith on a text field', staff({ filters: [{ field: 'rating', op: 'startsWith', value: 'rating-a' }] })],
    ['filter: is empty on a relation', staff({ filters: [{ field: 'mentor', op: 'isNull' }] })],
    ['filter: equality on a relation', staff({ filters: [{ field: 'mentor', op: 'eq', value: 's1' }] })],
    ['filter: a visible column compared with the hidden one', staff({ filters: [{ field: 'level', op: 'lt', otherField: 'salary' }] })],
    ['filter: the hidden column compared with a visible one', staff({ filters: [{ field: 'salary', op: 'gt', otherField: 'level' }] })],
    ['filter: inside an any group', staff({ filters: [{ any: [{ field: 'name', op: 'eq', value: 'Ada' }, { field: 'salary', op: 'gt', value: 60000 }] }] })],
    ['filter: inside a not', staff({ filters: [{ not: { field: 'salary', op: 'gt', value: 60000 } }] })],
    ['filter: match any', staff({ match: 'any', filters: [{ field: 'name', op: 'eq', value: 'Ada' }, { field: 'salary', op: 'gt', value: 60000 }] })],
    ['filter: on the stored computed field', staff({ filters: [{ field: 'bonus', op: 'gt', value: 6000 }] })],
    ['filter with a total', staff({ filters: [{ field: 'salary', op: 'gt', value: 60000 }], total: true, limit: 1 })],
    ['a total without a filter', staff({ total: true, limit: 2 })],
    // Order.
    ['sort ascending', staff({ sort: [{ field: 'salary', dir: 'asc' }] })],
    ['sort descending', staff({ sort: { field: 'salary', dir: 'desc' } })],
    ['sort on the stored computed field', staff({ sort: [{ field: 'bonus', dir: 'asc' }] })],
    ['orderBy, hidden column first', staff({ orderBy: [{ field: 'salary', dir: 'desc' }, { field: 'name', dir: 'asc' }] })],
    ['orderBy, hidden column last', staff({ orderBy: [{ field: 'level', dir: 'asc' }, { field: 'rating', dir: 'asc' }] })],
    ['sort on a text field, paged', staff({ sort: [{ field: 'rating', dir: 'asc' }], limit: 2 })],
    // Search.
    ['search in a named hidden field', staff({ search: { value: 'yew', fields: ['rating'] } })],
    ['search in a hidden field beside a visible one', staff({ search: { value: 'rating', fields: ['name', 'rating'] } })],
    ['search for a hidden value', staff({ search: { value: 'rating-birch', fields: ['name', 'city', 'rating'] } })],
    // Projection and expansion.
    ['fields: a hidden one beside a visible one', staff({ fields: ['name', 'salary'] })],
    ['fields: only hidden ones', staff({ fields: ['salary', 'rating', 'bonus', 'pay_note'] })],
    ['expand a hidden relation', staff({ expand: [{ field: 'mentor' }] })],
    ['expand a hidden relation, picking a name', staff({ expand: [{ field: 'mentor', pick: ['name'], as: 'coach' }] })],
    ['expand, picking a hidden field of the related table', staff({ expand: [{ field: 'department', pick: ['name', 'budget'] }] })],
    ['expand from another table, picking hidden fields', (e, r) => records(e, r, 'reviews', { expand: [{ field: 'subject', pick: ['name', 'salary', 'rating', 'mentor', 'bonus'] }] })],
    // Through a relation.
    ['relation filter on a hidden field of the related table', staff({ filters: [{ field: 'department.budget', op: 'gt', value: 800000 }] })],
    ['relation filter from another table', (e, r) => records(e, r, 'reviews', { filters: [{ field: 'subject.salary', op: 'gt', value: 60000 }] })],
    ['relation filter from another table, with a total', (e, r) => records(e, r, 'reviews', { filters: [{ field: 'subject.rating', op: 'contains', value: 'yew' }], total: true })],
    ['relation filter through a hidden relation', staff({ filters: [{ field: 'mentor.name', op: 'eq', value: 'Ada' }] })],
    // Groups and aggregates.
    ['group by the hidden field', staffAgg({ groupBy: [{ field: 'salary' }], aggregates: [count] })],
    ['group by a hidden text field', staffAgg({ groupBy: [{ field: 'rating' }], aggregates: [count] })],
    ['group by a hidden relation', staffAgg({ groupBy: [{ field: 'mentor' }], aggregates: [count] })],
    ['group by number steps of the hidden field', staffAgg({ groupBy: [{ field: 'salary', binWidth: 20000 }], aggregates: [count] })],
    ['group by a hidden field of the related table', staffAgg({ groupBy: [{ field: 'department', relatedField: 'budget' }], aggregates: [count] })],
    ['group through a hidden relation', staffAgg({ groupBy: [{ field: 'mentor', relatedField: 'name' }], aggregates: [count] })],
    ['group from another table by a hidden field', (e, r) => aggregate(e, r, 'reviews', { groupBy: [{ field: 'subject', relatedField: 'salary' }], aggregates: [count] })],
    ...['min', 'max', 'sum', 'avg', 'countDistinct', 'p50', 'p90'].map((fn) => [`aggregate: ${fn}`, staffAgg({ aggregates: [{ fn, field: 'salary', as: 'v' }] })]),
    ['aggregate: count of the hidden field', staffAgg({ aggregates: [{ fn: 'count', field: 'mentor', as: 'v' }] })],
    ['aggregate: max per visible group', staffAgg({ groupBy: [{ field: 'city' }], aggregates: [{ fn: 'max', field: 'salary', as: 'v' }] })],
    ['aggregate: count under a filter on the hidden field', staffAgg({ filters: [{ field: 'salary', op: 'gt', value: 60000 }], aggregates: [count] })],
    ['aggregate: min of a hidden text field', staffAgg({ aggregates: [{ fn: 'min', field: 'rating', as: 'v' }] })],
    ['aggregate: sum of the stored computed field', staffAgg({ aggregates: [{ fn: 'sum', field: 'bonus', as: 'v' }] })],
    ['groupFilter on an aggregate of the hidden field', staffAgg({ groupBy: [{ field: 'city' }], aggregates: [count, { fn: 'sum', field: 'salary', as: 'paid' }], groupFilter: [{ field: 'paid', op: 'gt', value: 100000 }] })],
    ['aggregate sorted by an aggregate of the hidden field', staffAgg({ groupBy: [{ field: 'name' }], aggregates: [{ fn: 'max', field: 'salary', as: 'v' }], sort: [{ field: 'v', dir: 'desc' }] })],
    // Writes that match rows, and the upsert lookup.
    ['bulk write: how many rows a filter on the hidden field matches', (e, r) => bulkMatch(e, r, 'staff', [{ field: 'salary', op: 'gt', value: 60000 }])],
    ['bulk write: a filter on a visible field', (e, r) => bulkMatch(e, r, 'staff', [{ field: 'level', op: 'gt', value: 1 }])],
    ['key lookup on the hidden field', (e, r) => keyIndex(e, r, 'staff', 'salary', [41010, 88080])],
];

async function answer(probe, engine, role) {
    try {
        return { ok: await probe(engine, role) };
    } catch (e) {
        if (e.name !== 'CompileError' && e.name !== 'AccessError') throw e;
        return { refused: e.message, status: e.status };
    }
}

for (const [name, make] of APP_ENGINES) {
    test(`${name}: no probe tells a role that cannot read the fields which world it is in`, async () => {
        const worlds = { A: make(), B: make() };
        try {
            await seedWorld(worlds.A, 'A');
            await seedWorld(worlds.B, 'B');
            const secrets = [...secretsOf('A'), ...secretsOf('B')];
            let told = 0;
            for (const [what, probe] of PROBES) {
                for (const role of ['staffer', 'public']) {
                    const a = await answer(probe, worlds.A, role);
                    const b = await answer(probe, worlds.B, role);
                    assert.deepStrictEqual(a, b, `${role}: "${what}" answers differently in the two worlds`);
                    const text = JSON.stringify(a);
                    for (const secret of secrets) assert.ok(!text.includes(secret), `${role}: "${what}" holds the hidden value ${secret}`);
                }
                const hrA = await answer(probe, worlds.A, 'hr');
                const hrB = await answer(probe, worlds.B, 'hr');
                assert.ok(hrA.ok && hrB.ok, `hr: "${what}" is a read hr can make (${hrA.refused || hrB.refused})`);
                if (JSON.stringify(hrA) !== JSON.stringify(hrB)) told += 1;
            }
            // The probes are real: for a role that reads the fields nearly all of them split the worlds.
            assert.ok(told >= PROBES.length - 4, `only ${told} of ${PROBES.length} probes split the worlds for hr`);
        } finally {
            await worlds.A.close();
            await worlds.B.close();
        }
    });

    test(`${name}: what a restricted role does get, and how a hidden field is refused`, async () => {
        const engine = make();
        try {
            await seedWorld(engine, 'A');
            const plain = (await records(engine, 'staffer', 'staff', {})).records;
            assert.deepStrictEqual(Object.keys(plain[0]).sort(),
                ['city', 'created_at', 'created_by', 'department', 'id', 'level', 'logged_by', 'name', 'note', 'org_id', 'photo', 'title', 'updated_at']);
            assert.strictEqual(plain.length, 4, 'column rights hide no row');
            // The anonymous role is named by no list, so it has no field with one.
            const anon = (await records(engine, 'public', 'staff', {})).records;
            assert.ok(!('city' in anon[0]) && anon[0].name, 'public reads name and not city');
            // hr and the owner read every field, the computed ones evaluated.
            for (const role of ['hr', 'owner']) {
                const full = (await records(engine, role, 'staff', { sort: [{ field: 'name', dir: 'asc' }] })).records[0];
                assert.strictEqual(Number(full.salary), 41010);
                assert.strictEqual(Number(full.bonus), 4101);
                assert.strictEqual(Number(full.pay_note), 41013);
            }
            // A hidden field is refused in the words of a field that does not exist.
            const hiddenName = await answer(staff({ filters: [{ field: 'salary', op: 'gt', value: 1 }] }), engine, 'staffer');
            const noSuchName = await answer(staff({ filters: [{ field: 'nosuch', op: 'gt', value: 1 }] }), engine, 'staffer');
            assert.deepStrictEqual(hiddenName, { refused: 'unknown field: salary', status: 422 });
            assert.strictEqual(noSuchName.refused, 'unknown field: nosuch');
            // What only says what to return is left out, and the read goes on.
            const projected = (await records(engine, 'staffer', 'staff', { fields: ['name', 'salary'], expand: [{ field: 'mentor' }, { field: 'department', pick: ['name', 'budget'] }] })).records;
            assert.deepStrictEqual(projected.find((r) => r.id === 's1'), { id: 's1', name: 'Ada', department_record: { id: 'd1', name: 'Finance', _label: 'Finance' } });
            // A read-time computed field over visible columns still evaluates; none is reported as failed.
            const { records: rows, notes } = await records(engine, 'staffer', 'staff', {});
            assert.strictEqual(rows.find((r) => r.id === 's1').title, 'ADA');
            assert.deepStrictEqual(notes, []);
        } finally {
            await engine.close();
        }
    });

    test(`${name}: a table with column rights is not read under an access filter that never resolved them`, async () => {
        const table = tableOf('staff');
        const bare = { where: '1=1', params: [] };
        const forged = { where: '1=1', params: [], columns: { table: 'staff', hidden: [], readOnly: [] } };
        const other = access.compileAccessFilter(tableOf('departments'), 'staffer', viewerOf('staffer'), 'read');
        for (const filter of [bare, forged, other]) {
            for (const compile of [
                () => qc.compileRecordList(table, {}, filter),
                () => qc.compileRecordCount(table, {}, filter),
                () => qc.compileGetById(table, 's1', filter),
                () => qc.compileAggregate(table, { aggregates: [count] }, filter),
                () => qc.compileKeyIndex(table, 'name', ['Ada'], filter),
                () => bulk.compileCountMatching(table, [], filter),
            ]) assert.throws(compile, /did not resolve them/);
        }
        // The owner's access (a sync, a recount) reads every column of any table.
        assert.match(qc.compileRecordList(table, {}, access.OWNER_ACCESS).sql, /^SELECT \* FROM "staff"/);
    });
}

// ── Lookup, rollup and many-relation fields (columnRightsLinked.mts) ────────────

const { bootLinkedEngines, useEngineAsAppStore } = require('../../testUtils/linkedEngines.testkit');
const { LINKED_MODEL, linkedTableOf, linkedSecretsOf, seedLinkedWorld } = require('../../testUtils/columnRightsLinkedWorlds.testkit');
const { fillLinkedRecords } = require('./relationRead.mts');
const { eraseRecord, writeRecord } = require('../../appStudio/actionExecutor/records');

const asQuery = (engine) => (sql, params) => engine.all(sql, params).then((rows) => ({ rows }));

/** A record list of the linked worlds, read the way `records` above reads one. */
async function linkedRecords(engine, role, key, d) {
    const table = linkedTableOf(key);
    const query = asQuery(engine);
    const who = { role, viewer: viewerOf(role), dialect: engine.dialect };
    const filter = access.compileAccessFilter(table, role, who.viewer, 'read', { dialect: engine.dialect });
    const compiled = qc.compileRecordList(table, recordListDescriptor(d, { dialect: engine.dialect, readTimeComputed: true }), filter, relationRead(LINKED_MODEL, table, d, who));
    const { result } = await queryWithComputed(query, compiled);
    return finishRecords(compiled, result.rows.slice(0, compiled.limit), query);
}

/** One record by id with its lookups, rollups and many relations (appDataContext.readOne). */
async function linkedOne(engine, role, key, id) {
    const table = linkedTableOf(key);
    const who = { role, viewer: viewerOf(role), dialect: engine.dialect };
    const filter = access.compileAccessFilter(table, role, who.viewer, 'read', { dialect: engine.dialect });
    const compiled = qc.compileGetById(table, id, filter, { dialect: engine.dialect, readTimeComputed: true });
    const { rows } = (await queryWithComputed(asQuery(engine), compiled)).result;
    return fillLinkedRecords(LINKED_MODEL, table, who, rows, asQuery(engine));
}

const teams = (d) => (engine, role) => linkedRecords(engine, role, 'teams', d);
const LINKED_PROBES = [
    ['teams, a plain list', teams({})],
    ['one team by id', (e, r) => linkedOne(e, r, 'teams', 't1')],
    ['people, a plain list', (e, r) => linkedRecords(e, r, 'people', {})],
    // Lookups.
    ['fields: a lookup of a hidden field of the related table', teams({ fields: ['name', 'lead_grade'] })],
    ['fields: a lookup through a hidden relation', teams({ fields: ['name', 'shadow_name'] })],
    ['fields: a lookup with its own read list', teams({ fields: ['lead_name', 'lead_name_hr'] })],
    // Rollups, one probe per function and per filter.
    ...['sum', 'min', 'max', 'avg'].map((fn) => [`rollup: ${fn} of a hidden field`, teams({ fields: ['name', `hours_${fn}`] })]),
    ['rollup: count under a filter on a hidden field', teams({ fields: ['graded_count'] })],
    ['rollup: count through a hidden relation', teams({ fields: ['shadow_count'] })],
    ['rollup: count and sum of visible fields', teams({ fields: ['member_count', 'open_count', 'minutes_sum'] })],
    // Many relations.
    ['fields: a hidden many relation', teams({ fields: ['name', 'members', 'crew'] })],
    ['expand a hidden many relation', teams({ expand: [{ field: 'crew' }] })],
    ['expand a many relation, picking hidden fields', teams({ expand: [{ field: 'members', pick: ['name', 'grade'] }] })],
    ['filter: contains on a hidden many relation', teams({ filters: [{ field: 'crew', op: 'contains', value: 'q1' }] })],
    ['filter: notContains on a hidden many relation', teams({ filters: [{ field: 'crew', op: 'notContains', value: 'q3' }] })],
    ['filter: contains on a visible many relation', teams({ filters: [{ field: 'members', op: 'contains', value: 'q2' }] })],
];

async function linkedAnswer(probe, engine, role) {
    try {
        return { ok: await probe(engine, role) };
    } catch (e) {
        if (typeof e.status !== 'number' && e.name !== 'CompileError') throw e;
        return { refused: e.message, status: e.status, code: e.code };
    }
}

/** Two worlds on both engines: { A: { sqlite, pg }, B: { sqlite, pg } }. */
async function linkedWorlds(closers) {
    const worlds = { A: await bootLinkedEngines(LINKED_MODEL, closers), B: await bootLinkedEngines(LINKED_MODEL, closers) };
    for (const [world, engines] of Object.entries(worlds)) for (const engine of Object.values(engines)) await seedLinkedWorld(engine, world);
    return worlds;
}

test('lookup, rollup and many fields: no probe tells a role that cannot read the fields which world it is in', async () => {
    const closers = [];
    try {
        const worlds = await linkedWorlds(closers);
        const secrets = [...linkedSecretsOf('A'), ...linkedSecretsOf('B')];
        for (const dialect of ['sqlite', 'pg']) {
            let told = 0;
            for (const [what, probe] of LINKED_PROBES) {
                for (const role of ['staffer', 'public']) {
                    const a = await linkedAnswer(probe, worlds.A[dialect], role);
                    const b = await linkedAnswer(probe, worlds.B[dialect], role);
                    assert.deepStrictEqual(a, b, `${dialect} ${role}: "${what}" answers differently in the two worlds`);
                    const text = JSON.stringify(a);
                    for (const secret of secrets) assert.ok(!text.includes(secret), `${dialect} ${role}: "${what}" holds the hidden value ${secret}`);
                }
                const hrA = await linkedAnswer(probe, worlds.A[dialect], 'hr');
                const hrB = await linkedAnswer(probe, worlds.B[dialect], 'hr');
                assert.ok(hrA.ok && hrB.ok, `${dialect} hr: "${what}" is a read hr can make (${hrA.refused || hrB.refused})`);
                if (JSON.stringify(hrA) !== JSON.stringify(hrB)) told += 1;
            }
            // Only the probes over visible values alone agree for hr (a lookup's own read list, the visible rollups and many relation).
            assert.ok(told >= LINKED_PROBES.length - 3, `${dialect}: only ${told} of ${LINKED_PROBES.length} probes split the worlds for hr`);

            // A delete that would empty a relation the role may not write is refused alike in both worlds, before anything changes.
            const refusals = [];
            for (const world of ['A', 'B']) {
                const restore = useEngineAsAppStore(worlds[world][dialect]);
                try {
                    refusals.push(await linkedAnswer(() => eraseRecord({ id: 'app1', userId: 'owner1' }, LINKED_MODEL, linkedTableOf('teams'), 't1', { viewer: viewerOf('staffer') }), null, 'staffer'));
                } finally { restore(); }
            }
            assert.deepStrictEqual(refusals[0], refusals[1], `${dialect}: the refusal is the same in both worlds`);
            assert.deepStrictEqual(refusals[0], { refused: 'This record has linked records in "People" whose link to it you may not change.', status: 403, code: 'cascade_forbidden' });
        }
    } finally {
        for (const close of closers) await close();
    }
});

test('lookup, rollup and many fields: what a restricted role does get', async () => {
    const closers = [];
    try {
        const { A } = await linkedWorlds(closers);
        for (const engine of Object.values(A)) {
            const [t1] = (await linkedRecords(engine, 'staffer', 'teams', {})).filter((r) => r.id === 't1');
            for (const gone of ['shadow_lead', 'shadow_name', 'lead_name_hr', 'crew', 'crew_record']) assert.ok(!(gone in t1), `${engine.dialect}: ${gone} is left out`);
            assert.deepStrictEqual(
                [t1.lead_name, t1.lead_grade, t1.member_count, t1.open_count, t1.minutes_sum, t1.graded_count, t1.shadow_count, t1.hours_sum, t1.hours_avg, t1.members],
                ['Ada', null, 2, 1, 30, null, null, null, null, ['q1', 'q2']],
                `${engine.dialect}: visible rollups count, hidden ones read null`,
            );
            const [full] = (await linkedRecords(engine, 'hr', 'teams', {})).filter((r) => r.id === 't1');
            assert.deepStrictEqual([full.lead_grade, full.shadow_name, full.graded_count, full.shadow_count, full.hours_sum, full.crew], ['grade-amber', 'Bram', 1, 2, 14603, ['q1', 'q2']], `${engine.dialect}: hr reads them all`);
            const refused = await linkedAnswer(teams({ filters: [{ field: 'crew', op: 'contains', value: 'q1' }] }), engine, 'staffer');
            assert.deepStrictEqual(refused, { refused: 'unknown field: crew', status: 422, code: undefined }, `${engine.dialect}: refused like any hidden field`);
            // Writing a many relation the role may not write is refused by the gate every field passes.
            const restore = useEngineAsAppStore(engine);
            try {
                const write = (values) => writeRecord({ id: 'app1', userId: 'owner1' }, LINKED_MODEL, linkedTableOf('teams'), values, { viewer: viewerOf('staffer'), recordId: 't1' });
                await assert.rejects(write({ crew: ['q3'] }), { status: 403, code: 'field_not_writable' }, engine.dialect);
                assert.equal((await write({ members: ['q3'] })).changes, 1, `${engine.dialect}: a many relation the role may write`);
                const [after] = (await linkedRecords(engine, 'hr', 'teams', {})).filter((r) => r.id === 't1');
                assert.deepStrictEqual([after.members, after.crew], [['q3'], ['q1', 'q2']], `${engine.dialect}: the hidden list is untouched`);
            } finally { restore(); }
        }
    } finally {
        for (const close of closers) await close();
    }
});

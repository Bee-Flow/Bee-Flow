'use strict';

/**
 * Two worlds for the column-rights tests: the same app, the same rows, and the same value in
 * every field the restricted roles may read. Only the HIDDEN fields differ between world A and
 * world B. A role that cannot read those fields must get the same answer to every request in
 * both worlds; if one answer differs, that request tells the role something about a hidden value.
 *
 *   departments   name, budget (hr only)
 *   staff         name, city (not public), level, salary (hr only), rating (hr only),
 *                 department → departments, mentor → staff (hr only),
 *                 bonus (stored, computed from salary), pay_note (read-time, computed from salary),
 *                 title (read-time, computed from name)
 *                 note and logged_by (everyone reads, hr writes), feedback (hr reads, staffer writes),
 *                 photo (a file), contract (a file, hr only)
 *   reviews       note, subject → staff
 *
 *   hr       reads and writes everything
 *   staffer  reads every row; not salary, rating, mentor, budget (and so not bonus, pay_note)
 *   public   as staffer, and not city
 */

const all = { read: 'all', create: true, update: 'all', delete: 'all' };
const HR = ['hr'];

const MODEL = Object.freeze({
    modelVersion: 1,
    roles: [{ key: 'hr' }, { key: 'staffer' }],
    tables: [
        {
            id: 'tbl_departments', key: 'departments',
            fields: [
                { id: 'fld_dn00', key: 'name', type: 'text' },
                { id: 'fld_db00', key: 'budget', type: 'number', subtype: 'integer', access: { read: HR } },
            ],
            access: { default: 'none', roles: { hr: all, staffer: all, public: { read: 'all' } } },
        },
        {
            id: 'tbl_staff', key: 'staff',
            fields: [
                { id: 'fld_sn00', key: 'name', type: 'text' },
                { id: 'fld_sc00', key: 'city', type: 'text', access: { read: ['hr', 'staffer'] } },
                { id: 'fld_sl00', key: 'level', type: 'number', subtype: 'integer' },
                { id: 'fld_ss00', key: 'salary', type: 'number', subtype: 'integer', access: { read: HR } },
                { id: 'fld_sr00', key: 'rating', type: 'text', access: { read: HR } },
                { id: 'fld_sd00', key: 'department', type: 'relation', relation: { table: 'tbl_departments', displayField: 'name' } },
                { id: 'fld_sm00', key: 'mentor', type: 'relation', relation: { table: 'tbl_staff', displayField: 'name' }, access: { read: HR } },
                { id: 'fld_sb00', key: 'bonus', type: 'computed', computed: { expr: 'salary / 10', type: 'number', stored: true } },
                { id: 'fld_sp00', key: 'pay_note', type: 'computed', computed: { expr: 'salary + level' } },
                { id: 'fld_st00', key: 'title', type: 'computed', computed: { expr: 'upper(name)' } },
                // Read by everyone, written by hr only; the second one is filled by the server on create.
                { id: 'fld_so00', key: 'note', name: 'Note', type: 'text', access: { write: HR } },
                { id: 'fld_sg00', key: 'logged_by', type: 'text', dynamicDefault: 'currentUser.id', access: { write: HR } },
                // Written by a staffer who may not read it back.
                { id: 'fld_sf00', key: 'feedback', type: 'text', access: { read: HR, write: ['hr', 'staffer'] } },
                { id: 'fld_sh00', key: 'photo', type: 'file' },
                { id: 'fld_sk00', key: 'contract', type: 'file', access: { read: HR } },
            ],
            access: { default: 'none', roles: { hr: all, staffer: all, public: { read: 'all' } } },
        },
        {
            id: 'tbl_reviews', key: 'reviews',
            fields: [
                { id: 'fld_rn00', key: 'note', type: 'text' },
                { id: 'fld_rs00', key: 'subject', type: 'relation', relation: { table: 'tbl_staff', displayField: 'name' } },
            ],
            access: { default: 'none', roles: { hr: all, staffer: all, public: { read: 'all' } } },
        },
    ],
});

const tableOf = (key) => MODEL.tables.find((t) => t.key === key);

/** Per world, the hidden values: [salary, rating, mentor] per staff id, and the budget per department id. */
const HIDDEN = Object.freeze({
    A: {
        staff: { s1: [41010, 'rating-amber', null], s2: [52020, 'rating-birch', 's1'], s3: [63030, 'rating-cedar', 's1'], s4: [74040, 'rating-dune', 's2'] },
        departments: { d1: 910001, d2: 820002 },
    },
    B: {
        staff: { s1: [99090, 'rating-zinc', null], s2: [88080, 'rating-yew', null], s3: [88080, 'rating-yew', 's2'], s4: [15050, 'rating-xenon', 's3'] },
        departments: { d1: 130003, d2: 770007 },
    },
});

/** Every hidden value of a world, as text: none of them may appear in an answer to a restricted role. */
function secretsOf(world) {
    const h = HIDDEN[world];
    return [...Object.values(h.staff).flatMap(([salary, rating]) => [String(salary), rating, String(salary / 10)]), ...Object.values(h.departments).map(String)];
}

const VISIBLE = Object.freeze({
    departments: [{ id: 'd1', name: 'Finance' }, { id: 'd2', name: 'Support' }],
    staff: [
        { id: 's1', name: 'Ada', city: 'Utrecht', level: 3, department: 'd1' },
        { id: 's2', name: 'Bram', city: 'Zwolle', level: 1, department: 'd1' },
        { id: 's3', name: 'Cato', city: 'Utrecht', level: 2, department: 'd2' },
        { id: 's4', name: 'Dirk', city: 'Breda', level: 2, department: null },
    ],
    reviews: [
        { id: 'r1', note: 'first', subject: 's1' },
        { id: 'r2', note: 'second', subject: 's3' },
        { id: 'r3', note: 'third', subject: 's4' },
    ],
});

/** The rows of one table in one world: the visible values plus that world's hidden ones. */
function rowsOf(world, key) {
    const h = HIDDEN[world];
    return VISIBLE[key].map((row) => {
        if (key === 'departments') return { ...row, budget: h.departments[row.id] };
        if (key !== 'staff') return row;
        const [salary, rating, mentor] = h.staff[row.id];
        return { ...row, salary, rating, mentor };
    });
}

/**
 * Create the three tables on `engine` (testUtils/appEngines) and insert world `world`. Ids and
 * stamps are fixed, so the two worlds differ in nothing but the hidden values.
 */
async function seedWorld(engine, world) {
    const qc = require('../core/dataEngine/queryCompiler');
    const { ddlForTable } = require('../core/dataEngine/dataModel/ddl');
    for (const table of MODEL.tables) await engine.exec(ddlForTable(table, { dialect: engine.dialect }));
    for (const table of MODEL.tables) {
        const rows = rowsOf(world, table.key);
        for (const [n, { id, ...values }] of rows.entries()) {
            const ins = qc.compileInsert(table, values, { createdBy: 'u_seed', orgId: 'org1', id, dialect: engine.dialect });
            await engine.query(ins.sql, ins.params);
            const stamp = `2026-03-0${n + 1}T08:00:00.000Z`;
            await engine.query(`UPDATE "${table.key}" SET "created_at" = ?, "updated_at" = ? WHERE "id" = ?`, [stamp, stamp, id]);
        }
    }
}

/** A better-sqlite3 database as an engine seedWorld takes (the door tests seed the app stores' database). */
function sqliteEngineOn(db) {
    return {
        dialect: 'sqlite',
        exec: async (sql) => db.exec(sql),
        query: async (sql, params) => {
            const stmt = db.prepare(sql);
            return { rows: stmt.reader ? stmt.all(...params) : (stmt.run(...params), []) };
        },
    };
}

module.exports = { MODEL, HIDDEN, VISIBLE, tableOf, rowsOf, secretsOf, seedWorld, sqliteEngineOn };

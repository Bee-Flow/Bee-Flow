'use strict';

/**
 * Two worlds for column rights on the fields that have no column (lookup, rollup, many
 * relation; core/dataEngine/columnRightsLinked.mts), in the manner of
 * columnRightsWorlds.testkit.js: the same app, the same rows, and only the values hidden from
 * the restricted roles differ between world A and world B.
 *
 *   profiles  name, grade (hr only)
 *   teams     name, lead → profiles, shadow_lead → profiles (hr only),
 *             lookups:  lead_name (lead.name), lead_grade (lead.grade: hidden on profiles),
 *                       shadow_name (through the hidden shadow_lead), lead_name_hr (its own read list)
 *             rollups over people.team: member_count (count), open_count (count, filter on status),
 *                       graded_count (count, filter on the hidden grade), minutes_sum (sum of minutes),
 *                       hours_<fn> (sum, min, max, avg of the hidden hours),
 *                       shadow_count (count through the hidden shadow_team)
 *             many → profiles: members (everyone), crew (hr only)
 *   people    name, status, minutes, hours (hr only), grade (hr only),
 *             team → teams (everyone reads; hr writes; onDelete setNull), shadow_team → teams (hr only)
 *
 *   hr       reads and writes everything;  staffer and public: every row, none of the hr-only fields
 */

const qc = require('../core/dataEngine/queryCompiler');
const { junctionName } = require('../core/dataEngine/dataModel/linkedFields');

const all = { read: 'all', create: true, update: 'all', delete: 'all' };
const HR = { read: ['hr'] };
const ACCESS = { default: 'none', roles: { hr: all, staffer: all, public: { read: 'all' } } };
const rollup = (id, key, spec) => ({ id, key, type: 'rollup', rollup: { table: 'tbl_people', relation: 'team', ...spec } });
const lookup = (id, key, relation, field, extra = {}) => ({ id, key, type: 'lookup', lookup: { relation, field }, ...extra });
const toProfiles = (extra = {}) => ({ table: 'tbl_profiles', displayField: 'name', ...extra });

const PROFILES = {
    id: 'tbl_profiles', key: 'profiles', name: 'Profiles', access: ACCESS,
    fields: [
        { id: 'fld_qn00', key: 'name', type: 'text' },
        { id: 'fld_qg00', key: 'grade', type: 'text', access: HR },
    ],
};

const TEAMS = {
    id: 'tbl_teams', key: 'teams', name: 'Teams', access: ACCESS,
    fields: [
        { id: 'fld_tn00', key: 'name', type: 'text' },
        { id: 'fld_tl00', key: 'lead', type: 'relation', relation: toProfiles() },
        { id: 'fld_tx00', key: 'shadow_lead', type: 'relation', relation: toProfiles(), access: HR },
        lookup('fld_ta00', 'lead_name', 'lead', 'name'),
        lookup('fld_tb00', 'lead_grade', 'lead', 'grade'),
        lookup('fld_tc00', 'shadow_name', 'shadow_lead', 'name'),
        lookup('fld_td00', 'lead_name_hr', 'lead', 'name', { access: HR }),
        rollup('fld_tr01', 'member_count', { fn: 'count' }),
        rollup('fld_tr02', 'open_count', { fn: 'count', filter: [{ field: 'status', op: 'eq', value: 'open' }] }),
        rollup('fld_tr03', 'graded_count', { fn: 'count', filter: [{ field: 'grade', op: 'eq', value: 'grade-a' }] }),
        rollup('fld_tr04', 'minutes_sum', { fn: 'sum', field: 'minutes' }),
        ...['sum', 'min', 'max', 'avg'].map((fn, i) => rollup(`fld_th0${i}`, `hours_${fn}`, { fn, field: 'hours' })),
        { id: 'fld_ts00', key: 'shadow_count', type: 'rollup', rollup: { table: 'tbl_people', relation: 'shadow_team', fn: 'count' } },
        { id: 'fld_tm00', key: 'members', type: 'relation', relation: toProfiles({ many: true }) },
        { id: 'fld_tk00', key: 'crew', type: 'relation', relation: toProfiles({ many: true }), access: HR },
    ],
};

const PEOPLE = {
    id: 'tbl_people', key: 'people', name: 'People', access: ACCESS,
    fields: [
        { id: 'fld_pn00', key: 'name', type: 'text' },
        { id: 'fld_ps00', key: 'status', type: 'text' },
        { id: 'fld_pm00', key: 'minutes', type: 'number', subtype: 'integer' },
        { id: 'fld_ph00', key: 'hours', type: 'number', subtype: 'integer', access: HR },
        { id: 'fld_pg00', key: 'grade', type: 'text', access: HR },
        { id: 'fld_pt00', key: 'team', type: 'relation', relation: { table: 'tbl_teams', onDelete: 'setNull' }, access: { write: ['hr'] } },
        { id: 'fld_px00', key: 'shadow_team', type: 'relation', relation: { table: 'tbl_teams' }, access: HR },
    ],
};

const LINKED_MODEL = Object.freeze({ modelVersion: 1, roles: [{ key: 'hr' }, { key: 'staffer' }], tables: [PROFILES, TEAMS, PEOPLE] });
const linkedTableOf = (key) => LINKED_MODEL.tables.find((t) => t.key === key);

/** Per world: the grade per profile, [shadow_lead, crew] per team, [hours, grade, shadow_team] per person. */
const HIDDEN = Object.freeze({
    A: {
        profiles: { q1: 'grade-amber', q2: 'grade-birch', q3: 'grade-cedar' },
        teams: { t1: ['q2', ['q1', 'q2']], t2: [null, []], t3: ['q3', ['q3']] },
        people: { p1: [7301, 'grade-a', 't1'], p2: [7302, 'grade-b', 't1'], p3: [7303, 'grade-a', null], p4: [7304, 'grade-c', 't2'] },
    },
    B: {
        profiles: { q1: 'grade-zinc', q2: 'grade-yew', q3: 'grade-xenon' },
        teams: { t1: [null, ['q3']], t2: ['q3', ['q1', 'q2', 'q3']], t3: [null, []] },
        people: { p1: [9901, 'grade-z', null], p2: [9902, 'grade-a', 't2'], p3: [9903, 'grade-y', 't3'], p4: [9904, 'grade-a', 't3'] },
    },
});

const VISIBLE = Object.freeze({
    profiles: [{ id: 'q1', name: 'Ada' }, { id: 'q2', name: 'Bram' }, { id: 'q3', name: 'Cato' }],
    teams: [
        { id: 't1', name: 'North', lead: 'q1', members: ['q1', 'q2'] },
        { id: 't2', name: 'South', lead: 'q3', members: ['q3'] },
        { id: 't3', name: 'East', lead: null, members: [] },
    ],
    people: [
        { id: 'p1', name: 'Dirk', status: 'open', minutes: 10, team: 't1' },
        { id: 'p2', name: 'Eva', status: 'done', minutes: 20, team: 't1' },
        { id: 'p3', name: 'Fem', status: 'open', minutes: 30, team: 't2' },
        { id: 'p4', name: 'Gijs', status: 'open', minutes: 40, team: null },
    ],
});

/** Every hidden value of a world that could leak as text (grades and hours). */
function linkedSecretsOf(world) {
    const h = HIDDEN[world];
    return [...Object.values(h.profiles), ...Object.values(h.people).flatMap(([hours, grade]) => [String(hours), grade])];
}

/** The row of one table in one world: the visible values plus that world's hidden ones. */
function hiddenOf(world, key, id) {
    const h = HIDDEN[world];
    if (key === 'profiles') return { grade: h.profiles[id] };
    if (key === 'teams') return { shadow_lead: h.teams[id][0] };
    const [hours, grade, shadow] = h.people[id];
    return { hours, grade, shadow_team: shadow };
}

/** Insert world `world` on an engine of linkedEngines.testkit (tables already laid down by bootLinkedEngines). */
async function seedLinkedWorld(engine, world) {
    for (const table of LINKED_MODEL.tables) {
        for (const { id, members, ...values } of VISIBLE[table.key]) {
            const c = qc.compileInsert(table, { ...values, ...hiddenOf(world, table.key, id) }, { id, createdBy: 'u_seed', orgId: 'org1', dialect: engine.dialect });
            await engine.run(c.sql, c.params);
            if (!members) continue;
            for (const [field, ids] of [['fld_tm00', members], ['fld_tk00', HIDDEN[world].teams[id][1]]]) {
                for (const target of ids) await engine.run(`INSERT INTO "${junctionName(TEAMS.id, field)}" (source_id, target_id) VALUES (?, ?)`, [id, target]);
            }
        }
        await engine.run(`UPDATE "${table.key}" SET "created_at" = ?, "updated_at" = ?`, ['2026-03-01T08:00:00.000Z', '2026-03-01T08:00:00.000Z']);
    }
}

module.exports = { LINKED_MODEL, HIDDEN, linkedTableOf, linkedSecretsOf, seedLinkedWorld };

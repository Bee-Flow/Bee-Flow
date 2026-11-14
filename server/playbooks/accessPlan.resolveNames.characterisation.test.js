// @typecheck
'use strict';

/**
 * Characterisation (golden) test for resolveNames: the whole plan (note,
 * audience, new roles and their table rules, default role, group roles,
 * members, the unresolved list in order, empty) for model answers that reach
 * every branch: junk answers, role keys that clean up, collide with an
 * existing, built-in or earlier key or stay invalid, the role cap, scopes on
 * an unknown column, an unknown value, a bad column name, a rule the
 * validator refuses or lets through, with and without a table; group roles
 * and people (exact, forgiving and prefix matches, unknown names and roles,
 * repeated people, the entry cap); every audience kind; the default role.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test playbooks/accessPlan.resolveNames.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveNames } = require('./accessPlan');

const GOLDEN = path.join(__dirname, 'accessPlan.resolveNames.characterisation.golden.json');

const DIGEST = {
    tableName: 'Invoices',
    columns: [
        { key: 'supplier', values: [{ value: 'Acme' }, { value: 'Globex' }, { value: 42 }] },
        { key: 'status', values: [{ value: 'open' }, { value: ' padded ' }] },
        { key: 'bad-col', values: [{ value: 'x' }] },
        { key: 'empty' },
    ],
};
const CTX = {
    roles: [{ key: 'viewer', label: 'Viewer' }, { key: '', label: 'nameless' }, /** @type {any} */ (null)],
    groups: [{ id: 'g_fin', name: 'Finance' }, { id: 'g_fin2', name: 'Finance Team' }, { id: 'g_ops', name: 'Operations' }],
    people: [
        { id: 'u_jan', name: 'Jan de Vries', email: 'jan@example.com' },
        { id: 'u_jan2', name: 'Jan', email: 'jan2@example.com' },
        { id: 'u_ann', name: 'Ann Blok', email: 'ann@example.com' },
        { id: 'u_mail', email: 'only@example.com' },
    ],
    digest: DIGEST,
    tableId: 'tbl_1',
};
const refuse = (/** @type {string} */ rule) => (rule.includes('Globex') ? { ok: false } : { ok: true });
const many = (/** @type {number} */ n, /** @type {(i: number) => unknown} */ f) => Array.from({ length: n }, (_, i) => f(i));

/** @type {Record<string, [unknown, Record<string, unknown>?]>} */
const CASES = {
    nullAnswer: [null],
    stringAnswer: ['grant everything'],
    emptyObject: [{}],
    noContext: [{ roles: [{ key: 'a', label: 'A' }], defaultRole: 'a' }, undefined],
    roleKeys: [{ roles: [
        { key: ' Approver ', label: ' Fiatteur ' }, { key: 'approver', label: 'Again' }, { key: 'viewer', label: 'Existing' },
        { key: 'member', label: 'Built-in' }, { key: '9lives', label: 'Digit' }, { key: 'Fin-Ops Lead', label: '' },
        { key: 'x'.repeat(40), label: 'Long' }, { label: 'no key' }, null, 'junk', { key: 7 }, { key: 'café', label: 'é' },
    ] }],
    roleCap: [{ roles: many(45, (i) => ({ key: `r${i}`, label: `R ${i}` })) }],
    scopes: [{ roles: [
        { key: 'acme', label: 'Acme', scope: { column: 'supplier', value: 'Acme' } },
        { key: 'globex', label: 'Globex', scope: { column: 'supplier', value: 'Globex' } },
        { key: 'numeric', label: 'Numeric', scope: { column: 'supplier', value: '42' } },
        { key: 'ghost_col', label: 'Ghost', scope: { column: 'country', value: 'NL' } },
        { key: 'ghost_val', label: 'Ghost', scope: { column: 'supplier', value: 'Initech' } },
        { key: 'bad_col', label: 'Bad', scope: { column: 'bad-col', value: 'x' } },
        { key: 'padded', label: 'Padded', scope: { column: ' status ', value: ' padded ' } },
        { key: 'trim_val', label: 'Trim', scope: { column: 'status', value: 'padded' } },
        { key: 'empty_col', label: 'Empty', scope: { column: 'empty', value: '' } },
        { key: 'scope_junk', label: 'Junk', scope: 'supplier' },
        { key: 'scope_null', label: 'Null', scope: null },
    ] }, { validateRule: refuse }],
    scopesNoValidator: [{ roles: [{ key: 'globex', label: 'Globex', scope: { column: 'supplier', value: 'Globex' } }] }, { validateRule: null }],
    scopesValidatorSaysNothing: [{ roles: [{ key: 'globex', label: 'Globex', scope: { column: 'supplier', value: 'Globex' } }] }, { validateRule: () => null }],
    scopesNoTable: [{ roles: [{ key: 'acme', label: 'Acme', scope: { column: 'supplier', value: 'Acme' } }] }, { tableId: null }],
    scopesNoDigest: [{ roles: [{ key: 'acme', label: 'Acme', scope: { column: 'supplier', value: 'Acme' } }] }, { digest: null }],
    groupRoles: [{ roles: [{ key: 'approver', label: 'A' }], groupRoles: [
        { group: 'finance', role: 'viewer' }, { group: 'FINANCE  team', role: 'approver' }, { group: 'ops', role: 'app' },
        { group: 'Operations dept', role: 'viewer' }, { group: 'Legal', role: 'viewer' }, { group: 'Legal', role: 'nope' },
        { group: 'Operations', role: 'Nope Either' }, { group: '', role: 'viewer' }, null, { role: 'viewer' },
        { group: 'Finance', role: 'APPROVER' },
    ] }],
    groupRolesCap: [{ groupRoles: many(30, (i) => ({ group: i % 2 ? 'Finance' : `G${i}`, role: 'viewer' })) }],
    people: [{ people: [
        { person: 'jan@example.com', role: 'viewer' }, { person: 'Jan', role: 'viewer' }, { person: 'jan', role: 'member' },
        { person: 'Ann', role: 'viewer' }, { person: 'ann blok', role: 'public' }, { person: 'Somebody', role: 'viewer' },
        { person: 'Ann Blok', role: 'nope' }, { person: 'only@example.com', role: 'viewer' }, { person: '', role: 'viewer' },
        null, { role: 'viewer' }, { person: 'Jan de Vries', role: 'viewer' },
    ] }],
    peopleCap: [{ people: many(30, (i) => ({ person: i % 3 ? 'Ann Blok' : `P${i}`, role: 'viewer' })) }],
    audiencePrivate: [{ audience: { kind: 'private', groups: ['Finance'] } }],
    audienceOrg: [{ audience: { kind: 'organisation' } }],
    audienceUnchanged: [{ audience: { kind: 'unchanged' } }],
    audienceUnknownKind: [{ audience: { kind: 'everyone' } }],
    audienceNotObject: [{ audience: 'groups' }],
    audienceGroups: [{ audience: { kind: 'groups', groups: ['Finance', 'finance', 'Finance Team', 'Legal', '', 7, 'operations'] } }],
    audienceGroupsNone: [{ audience: { kind: 'groups', groups: ['Legal'] } }],
    audienceGroupsNotList: [{ audience: { kind: 'groups', groups: 'Finance' } }],
    audienceGroupsCap: [{ audience: { kind: 'groups', groups: many(30, (i) => (i === 26 ? 'Finance' : `G${i}`)) } }],
    defaultRoleKnown: [{ defaultRole: 'Viewer' }],
    defaultRoleNew: [{ roles: [{ key: 'reader', label: 'R' }], defaultRole: 'reader' }],
    defaultRoleUnknown: [{ defaultRole: 'boss' }],
    defaultRoleEmpty: [{ defaultRole: '' }],
    defaultRoleNumber: [{ defaultRole: 5 }],
    note: [{ note: `  ${'n'.repeat(300)}  ` }],
    noteNotString: [{ note: { text: 'x' } }],
    unresolvedOrder: [{
        audience: { kind: 'groups', groups: ['Legal'] }, roles: [{ key: 'ghost', label: 'G', scope: { column: 'nope', value: 'x' } }],
        groupRoles: [{ group: 'Sales', role: 'viewer' }], people: [{ person: 'Nobody', role: 'boss' }], defaultRole: 'chief',
    }],
    everything: [{
        audience: { kind: 'groups', groups: ['Operations'] },
        roles: [{ key: 'acme', label: 'Acme', scope: { column: 'supplier', value: 'Acme' } }, { key: 'lead', label: 'Lead' }],
        defaultRole: 'viewer', groupRoles: [{ group: 'Operations', role: 'lead' }], people: [{ person: 'Ann Blok', role: 'acme' }], note: 'All of it.',
    }],
};

test('resolveNames: every case matches the golden result', () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const [name, [raw, over]] of Object.entries(CASES)) {
        actual[name] = resolveNames(/** @type {any} */ (raw), over === undefined && name === 'noContext' ? undefined : { ...CTX, ...over });
    }
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.deepEqual(Object.keys(actual), Object.keys(golden));
    for (const name of Object.keys(actual)) assert.deepEqual(actual[name], golden[name], name);
});

/**
 * The access assistant PROPOSES. Nothing here writes, and every name the model
 * used is resolved against the real directory — or reported as unresolved,
 * which the person sees, rather than quietly dropped.
 *
 * Run: node --test --test-force-exit playbooks/accessPlan.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('./accessPlan');

const DIR = {
    roles: [{ key: 'viewer', label: 'Viewer' }],
    groups: [{ id: 'g_fin', name: 'Finance' }, { id: 'g_ops', name: 'Operations' }],
    people: [{ id: 'u_jan', name: 'Jan de Vries', email: 'jan@beeflow.nl' }, { id: 'u_ann', name: 'Ann Blok', email: 'ann@beeflow.nl' }],
};

test('names become ids: groups, people, roles — and a new role is usable in the same breath', () => {
    const plan = A.resolveNames({
        audience: { kind: 'groups', groups: ['finance'] },
        roles: [{ key: 'approver', label: 'Fiatteur' }],
        defaultRole: 'viewer',
        groupRoles: [{ group: 'Operations', role: 'approver' }],
        people: [{ person: 'jan@beeflow.nl', role: 'approver' }],
        note: 'Finance kijkt mee, Operations keurt goed.',
    }, DIR);
    assert.deepEqual(plan.audience, { kind: 'groups', groupIds: ['g_fin'], groupNames: ['Finance'] });
    assert.deepEqual(plan.roles, [{ key: 'approver', label: 'Fiatteur' }]);
    assert.equal(plan.defaultRole, 'viewer');
    assert.deepEqual(plan.byGroup, { g_ops: 'approver' });
    assert.deepEqual(plan.members, [{ userId: 'u_jan', roleKey: 'approver', name: 'Jan de Vries' }]);
    assert.deepEqual(plan.unresolved, []);
    assert.equal(plan.empty, false);
});

test('what it could not find is SAID, not silently dropped', () => {
    const plan = A.resolveNames({
        audience: { kind: 'groups', groups: ['Legal'] },
        groupRoles: [{ group: 'Legal', role: 'viewer' }],
        people: [{ person: 'Somebody Else', role: 'viewer' }, { person: 'Ann Blok', role: 'nope' }],
    }, DIR);
    assert.equal(plan.audience, null, 'an audience of groups that do not exist is no audience at all');
    assert.deepEqual(plan.byGroup, {});
    assert.deepEqual(plan.members, []);
    // Order is an implementation detail; the SET is the promise to the person.
    assert.deepEqual(
        [...new Set(plan.unresolved.map((u) => `${u.kind}:${u.name}`))].sort(),
        ['group:Legal', 'person:Somebody Else', 'role:nope'],
    );
});

test('a role key is snake_case ASCII, never a duplicate, never a built-in', () => {
    const plan = A.resolveNames({
        roles: [
            { key: 'Team Lead', label: 'Team lead' },      // normalised
            { key: 'team_lead', label: 'Again' },          // duplicate of it
            { key: 'viewer', label: 'Exists already' },    // already on the app
            { key: 'member', label: 'Built in' },
            { key: '9lives', label: 'Bad start' },
        ],
    }, DIR);
    assert.deepEqual(plan.roles, [{ key: 'team_lead', label: 'Team lead' }]);
});

test('an empty proposal is an empty proposal — and the prompt never shows the model an id', () => {
    const plan = A.resolveNames({ audience: { kind: 'unchanged' }, note: 'Niets te doen.' }, DIR);
    assert.equal(plan.empty, true);
    assert.equal(plan.audience, null);
    const sys = A.systemPrompt({ locale: 'en', roles: DIR.roles, groups: DIR.groups, people: DIR.people, appName: 'Invoices' });
    assert.match(sys, /LANGUAGE: English/);
    assert.match(sys, /Groups in this workspace: Finance, Operations/);
    assert.doesNotMatch(sys, /g_fin|u_jan/, 'the model speaks in names; ids are ours to resolve');
    assert.match(A.systemPrompt({ locale: 'nl', roles: [], groups: [], people: [], appName: 'X' }), /LANGUAGE: Dutch/);
});

test('planAccess: one forced call, no writes, and a refusal is coded', async () => {
    const calls = [];
    const deps = {
        resolveModel: async () => 'fast',
        chatForcedTool: async (m, messages, tool, opts) => { calls.push({ messages, tool, opts }); return { structured: { people: [{ person: 'Ann Blok', role: 'viewer' }] } }; },
    };
    const out = await A.planAccess({ message: 'Ann may look at it', ...DIR, locale: 'en' }, deps);
    assert.equal(out.ok, true);
    assert.deepEqual(out.plan.members, [{ userId: 'u_ann', roleKey: 'viewer', name: 'Ann Blok' }]);
    assert.equal(calls[0].tool, A.ACCESS_TOOL);
    assert.match(calls[0].messages.at(-1).content, /Ann may look at it/);
    assert.equal((await A.planAccess({ message: '   ' }, deps)).code, 'message_required');
    assert.equal((await A.planAccess({ message: 'x' }, { resolveModel: async () => 'm', chatForcedTool: async () => ({ structured: null }) })).code, 'plan_empty');
    assert.equal((await A.planAccess({ message: 'x' }, { resolveModel: async () => 'm', chatForcedTool: async () => { throw new Error('down'); } })).code, 'plan_failed');
});

// ── A role per value of a column ─────────────────────────────────────

const DIGEST = {
    tableName: 'Invoices',
    columns: [{ key: 'supplier', name: 'Leverancier', values: [{ value: 'ACME', count: 4 }, { value: 'Globex', count: 2 }] }],
};

test('a scope pair becomes a row rule the gateway accepts — and the model never writes the expression', () => {
    const plan = A.resolveNames({
        roles: [
            { key: 'supplier_acme', label: 'ACME', scope: { column: 'supplier', value: 'ACME' } },
            { key: 'controller', label: 'Controller' },
        ],
    }, { ...DIR, roles: [], digest: DIGEST, tableId: 'tbl_model01' });
    assert.deepEqual(plan.tableRules, [{ tableId: 'tbl_model01', roleKey: 'supplier_acme', expr: 'record.supplier == "ACME"' }]);
    assert.deepEqual(plan.roles.map((r) => r.key), ['supplier_acme', 'controller']);
    assert.deepEqual(plan.roles[0].scope, { column: 'supplier', value: 'ACME' });
    assert.equal('scope' in plan.roles[1], false, 'a role without a scope sees everything, and says nothing else');
    // The value is a JSON literal, so a quote in a supplier name cannot end it.
    assert.equal(A.renderRule('supplier', 'O\'Neill "and" Co'), 'record.supplier == "O\'Neill \\"and\\" Co"');
    assert.equal(A.renderRule('drop table', 'x'), null, 'a column name that is not a column name is refused');
    assert.equal(A.renderRule('supplier', '   '), null);
});

test('a column or a value the data does not have is refused — with the role, not silently', () => {
    const plan = A.resolveNames({
        roles: [
            { key: 'ghost_col', label: 'Ghost', scope: { column: 'nope', value: 'ACME' } },
            { key: 'ghost_val', label: 'Ghost value', scope: { column: 'supplier', value: 'Invented BV' } },
        ],
    }, { ...DIR, roles: [], digest: DIGEST, tableId: 'tbl_model01' });
    assert.deepEqual(plan.roles, [], 'a role whose whole point was the scope is not created without it');
    assert.deepEqual(plan.tableRules, []);
    assert.deepEqual(plan.unresolved.map((u) => `${u.kind}:${u.name}`), ['column:nope', 'value:Invented BV']);
});

test('a rule the gateway refuses never reaches the person as a working role', () => {
    const refusing = () => ({ ok: false, errors: ['nope'] });
    const plan = A.resolveNames({
        roles: [{ key: 'supplier_acme', label: 'ACME', scope: { column: 'supplier', value: 'ACME' } }],
    }, { ...DIR, roles: [], digest: DIGEST, tableId: 'tbl_model01', validateRule: refusing });
    assert.deepEqual(plan.roles, []);
    assert.deepEqual(plan.tableRules, []);
    assert.deepEqual(plan.unresolved.map((u) => u.kind), ['rule']);
});

test('the digest is in the prompt, and the model is told what "a role per X" means', () => {
    const sys = A.systemPrompt({ locale: 'en', roles: [], groups: [], people: [], appName: 'Invoices', digest: DIGEST });
    assert.match(sys, /The table "Invoices" holds these columns/);
    assert.match(sys, /- supplier \("Leverancier"\): "ACME" \(4\), "Globex" \(2\)/);
    assert.match(sys, /ONE ROLE PER VALUE/);
    assert.match(sys, /never write a filter expression yourself/);
    // Without a digest the model is not invited to scope anything.
    const bare = A.systemPrompt({ locale: 'en', roles: [], groups: [], people: [], appName: 'X' });
    assert.doesNotMatch(bare, /ONE ROLE PER VALUE/);
    assert.doesNotMatch(bare, /holds these columns/);
});

test('one role per supplier scales past the old cap of eight', () => {
    const values = Array.from({ length: 30 }, (_, i) => ({ value: `Supplier ${i}`, count: 1 }));
    const digest = { tableName: 'Invoices', columns: [{ key: 'supplier', name: 'Supplier', values }] };
    const plan = A.resolveNames({
        roles: values.map((v, i) => ({ key: `supplier_${i}`, label: v.value, scope: { column: 'supplier', value: v.value } })),
    }, { ...DIR, roles: [], digest, tableId: 'tbl_model01' });
    assert.equal(plan.roles.length, 30);
    assert.equal(plan.tableRules.length, 30);
    assert.equal(A.MAX_ROLES, 40);
});

// The provider's own words reached the person: `The model could not be
// reached: ${e.message}` was the 422 the access phase answered with, an
// internal host and port included, and so was a config store's error when the
// model could not be looked up. Compose was fixed first (composeRecipe.test.js).
test('an unreachable model is a fixed sentence and a correlation id; the error itself goes to the log under that id', async () => {
    const { runWithRequestId } = require('../telemetry/log');
    const leak = 'connect ECONNREFUSED 10.20.30.40:8080 (upstream llama-box-3)';
    const lines = [];
    const orig = console.error;
    console.error = (...a) => lines.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
    let out;
    let lookup;
    try {
        out = await runWithRequestId('req-4711', () => A.planAccess({ message: 'the finance team' }, { resolveModel: async () => 'local-model', chatForcedTool: async () => { throw new Error(leak); } }));
        lookup = await runWithRequestId('req-4712', () => A.planAccess({ message: 'the finance team' }, { resolveModel: async () => { throw new Error('connect ECONNREFUSED 10.9.9.9:5432'); }, chatForcedTool: async () => ({ structured: {} }) }));
    } finally { console.error = orig; }
    assert.equal(out.ok, false);
    assert.equal(out.code, 'plan_failed');
    assert.equal(out.error, 'The model could not be reached. Try again in a moment.');
    assert.equal(out.correlationId, 'req-4711');
    assert.doesNotMatch(JSON.stringify(out), /10\.20\.30\.40|ECONNREFUSED|llama-box/);
    const logged = lines.find((l) => l.includes('correlationId=req-4711'));
    assert.ok(logged, `logged under the id: ${JSON.stringify(lines)}`);
    assert.match(logged, /ECONNREFUSED 10\.20\.30\.40:8080/, 'the operator still reads what happened');
    assert.match(logged, /local-model/);

    assert.equal(lookup.code, 'model_unavailable');
    assert.equal(lookup.correlationId, 'req-4712');
    assert.doesNotMatch(JSON.stringify(lookup), /10\.9\.9\.9|ECONNREFUSED/);
    assert.ok(lines.some((l) => l.includes('correlationId=req-4712') && /10\.9\.9\.9:5432/.test(l)), 'the lookup failure is logged under its id');
});

'use strict';

/**
 * Apply of a proposal that creates tables, driven with injected stores: the
 * order of the steps, the claim, the reserved key, and what each failure leaves
 * behind for a retry.
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const { applyPendingDatatables, keptDatatables, CLAIM_LEASE_MS } = require('./applyPendingDatatables');

const LIVE = { schemaVersion: 2, trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'set', label: 'Original' }], edges: [{ from: 'trg', to: 's1' }] };
const PROPOSED = {
    ...LIVE,
    steps: [
        ...LIVE.steps,
        { id: 'd1', type: 'datatable', op: 'add_row', datatableId: 'pending:1', datatableKey: 'facturen', values: {} },
        { id: 'd2', type: 'datatable', op: 'find_rows', datatableId: 'pending:2', datatableKey: 'klanten' },
    ],
    edges: [...LIVE.edges, { from: 's1', to: 'd1' }, { from: 'd1', to: 'd2' }],
};
const pendingEntries = () => [
    { ref: 'pending:1', name: 'Facturen', key: 'facturen', description: '', scope: 'org', fields: [{ key: 'datum', name: 'Datum', type: 'date' }] },
    { ref: 'pending:2', name: 'Klanten', key: 'klanten', description: '', scope: 'org', fields: [{ key: 'naam', name: 'Naam', type: 'text' }] },
];

function setup({ proposal = {}, session = {}, tables = [], access = null, quota = null, createFailures = {}, now = Date.parse('2026-10-09T10:00:00Z'), beforeWrite = null } = {}) {
    const state = {
        session: {
            sessionId: 's', version: 4, approvedDatatableIds: ['tbl_old'],
            proposal: { id: 'prop1', baseDefinition: LIVE, definition: PROPOSED, title: 'T', description: '', pendingDatatables: pendingEntries(), ...proposal },
            ...session,
        },
        tables: [...tables], created: [], writes: [], warnings: [], released: 0, now,
    };
    const automationStore = {
        async getAutomation() { return { id: 'a1', userId: 'u1', organizationId: 'orgA', definition: structuredClone(LIVE) }; },
        async getBuilderSession() { return structuredClone(state.session); },
        async setBuilderSession(_aid, _uid, next, { expectedVersion }) {
            if (beforeWrite) beforeWrite(next, state);
            if (expectedVersion !== state.session.version) return { ok: false, conflict: true };
            state.session = { ...structuredClone(next), version: state.session.version + 1 };
            state.writes.push(structuredClone(state.session));
            return { ok: true, snapshot: structuredClone(state.session) };
        },
    };
    const deps = {
        automationStore,
        now: () => state.now,
        uuid: () => 'token-1',
        log: { warn: (m) => state.warnings.push(m), info() {}, error() {} },
        checkDatatableCreate: async () => access || { ok: true, principal: { userId: 'u1' }, scope: { kind: 'org', id: 'orgA' }, hasManage: true },
        assertDatatableQuota: async (_scope, opts) => { if (quota) throw Object.assign(new Error(quota), { code: 'quota_exceeded' }); state.quotaAsked = opts; },
        listDatatablesForScope: async () => state.tables.map((t) => ({ ...t })),
        createPendingDatatable: async (userId, entry, { key }) => {
            const fail = createFailures[entry.ref];
            if (fail) return { ok: false, ...fail };
            if (state.tables.some((t) => t.key === key)) return { ok: false, code: 'key_taken', error: 'taken' };
            const table = { id: `tbl_${entry.ref.split(':')[1]}`, key, name: entry.name, ownerUserId: userId };
            state.tables.push(table);
            state.created.push({ ref: entry.ref, key, exactKey: true });
            return { ok: true, table: { ...table, scope: { kind: 'org', id: 'orgA' }, fields: entry.fields } };
        },
    };
    return { state, deps };
}
const apply = (ctx) => applyPendingDatatables({ req: {}, automationId: 'a1', userId: 'u1', snapshot: structuredClone(ctx.state.session) }, ctx.deps);
const failsWith = (status, code) => (e) => e.status === status && e.code === code;

test('happy path: tables are created in order, the staged ids are swapped, the proposal is cleared and the outcome records the tables', async () => {
    const ctx = setup();
    const res = await apply(ctx);
    assert.deepStrictEqual(ctx.state.created.map((c) => c.ref), ['pending:1', 'pending:2']);
    assert.deepStrictEqual(res.createdDatatables, [
        { ref: 'pending:1', id: 'tbl_1', key: 'facturen', name: 'Facturen' },
        { ref: 'pending:2', id: 'tbl_2', key: 'klanten', name: 'Klanten' },
    ]);
    assert.deepStrictEqual([res.ok, res.outcome], [true, 'applied']);
    assert.deepStrictEqual(res.definition.steps.filter((s) => s.type === 'datatable').map((s) => [s.datatableId, s.datatableKey]), [['tbl_1', 'facturen'], ['tbl_2', 'klanten']]);
    const final = ctx.state.session;
    assert.strictEqual(final.proposal, null);
    assert.deepStrictEqual(final.reviewOutcome.datatables, res.createdDatatables);
    assert.deepStrictEqual([final.reviewOutcome.kind, final.reviewOutcome.status, final.reviewOutcome.id], ['proposal', 'applied', 'prop1']);
    assert.deepStrictEqual(final.approvedDatatableIds, ['tbl_old', 'tbl_1', 'tbl_2']);
    assert.deepStrictEqual(ctx.state.quotaAsked, { addTables: 2 });
    assert.ok(ctx.state.created.every((c) => c.exactKey), 'created with the reserved key');
});

test('a stale proposal (the flow changed since) is refused with 409 before anything is created or claimed', async () => {
    const ctx = setup({ proposal: { baseDefinition: { ...LIVE, steps: [] } } });
    await assert.rejects(() => apply(ctx), failsWith(409, 'stale_proposal'));
    assert.deepStrictEqual(ctx.state.created, []);
    assert.deepStrictEqual(ctx.state.writes, [], 'no claim was written either');
});

test('a fresh claim is refused with apply_in_progress; a claim older than the lease is taken over', async () => {
    const at = (ms) => new Date(Date.parse('2026-10-09T10:00:00Z') - ms).toISOString();
    const busy = setup({ proposal: { applying: { token: 'other', at: at(30_000) } } });
    await assert.rejects(() => apply(busy), failsWith(409, 'apply_in_progress'));
    assert.deepStrictEqual(busy.state.created, []);
    const stale = setup({ proposal: { applying: { token: 'other', at: at(CLAIM_LEASE_MS + 1000) } } });
    const res = await apply(stale);
    assert.strictEqual(res.createdDatatables.length, 2);
});

test('the claim is a compare-and-set: a second tab that loses the race gets apply_in_progress', async () => {
    const ctx = setup({ beforeWrite: (_next, state) => { state.session.version += 1; } });
    await assert.rejects(() => apply(ctx), failsWith(409, 'apply_in_progress'));
    assert.deepStrictEqual(ctx.state.created, []);
});

test('a failure on table 2 keeps table 1 recorded and the proposal; a retry creates only table 2', async () => {
    const ctx = setup({ createFailures: { 'pending:2': { code: 'create_failed', error: 'connection to 10.0.0.5 refused for table klanten' } } });
    await assert.rejects(() => apply(ctx), (e) => {
        assert.strictEqual(e.status, 409);
        assert.strictEqual(e.code, 'datatable_create_failed');
        assert.match(e.message, /The table "Klanten" could not be created\. Nothing was applied; press Apply again or ask the assistant\./);
        assert.doesNotMatch(e.message, /10\.0\.0\.5|connection/, 'the raw driver error never reaches the response');
        return true;
    });
    const kept = ctx.state.session.proposal;
    assert.ok(kept, 'the proposal stays');
    assert.strictEqual(kept.applying, null, 'the claim is released');
    assert.deepStrictEqual(kept.pendingDatatables.map((e) => e.createdId || null), ['tbl_1', null]);
    assert.ok(ctx.state.warnings.some((w) => /creating a table failed/.test(w)), 'logged');
    // Retry: only the rest is created.
    const retry = setup({ tables: ctx.state.tables });
    retry.state.session = structuredClone(ctx.state.session);
    const res = await apply(retry);
    assert.deepStrictEqual(retry.state.created.map((c) => c.ref), ['pending:2'], 'table 1 is not created again');
    assert.deepStrictEqual(res.createdDatatables.map((c) => c.id), ['tbl_1', 'tbl_2']);
    assert.strictEqual(retry.state.session.proposal, null);
});

test('a reserved key whose table exists (owner and name match) is adopted instead of creating a second table', async () => {
    const entries = pendingEntries();
    entries[0].applyKey = 'facturen';
    const ctx = setup({ proposal: { pendingDatatables: entries }, tables: [{ id: 'tbl_crash', key: 'facturen', name: 'Facturen', ownerUserId: 'u1' }] });
    const res = await apply(ctx);
    assert.deepStrictEqual(ctx.state.created.map((c) => c.ref), ['pending:2'], 'table 1 was adopted, not created');
    assert.deepStrictEqual(res.createdDatatables[0], { ref: 'pending:1', id: 'tbl_crash', key: 'facturen', name: 'Facturen' });
});

test('a reserved key that now belongs to somebody else is re-reserved', async () => {
    const entries = pendingEntries();
    entries[0].applyKey = 'facturen';
    const ctx = setup({ proposal: { pendingDatatables: entries }, tables: [{ id: 'tbl_theirs', key: 'facturen', name: 'Facturen', ownerUserId: 'u2' }] });
    const res = await apply(ctx);
    assert.strictEqual(res.createdDatatables[0].key, 'facturen_2');
    assert.deepStrictEqual(ctx.state.created[0], { ref: 'pending:1', key: 'facturen_2', exactKey: true });
});

test('the key is reserved in the proposal BEFORE the create', async () => {
    const ctx = setup();
    const seen = [];
    const orig = ctx.deps.createPendingDatatable;
    ctx.deps.createPendingDatatable = async (userId, entry, opts) => {
        seen.push(ctx.state.session.proposal.pendingDatatables.find((e) => e.ref === entry.ref).applyKey);
        return orig(userId, entry, opts);
    };
    await apply(ctx);
    assert.deepStrictEqual(seen, ['facturen', 'klanten'], 'persisted before each create');
});

test('a key_taken answer from the create re-looks-up: a stranger\'s table fails the Apply and clears the reservation', async () => {
    const ctx = setup({ createFailures: { 'pending:1': { code: 'key_taken', error: 'taken' } } });
    await assert.rejects(() => apply(ctx), failsWith(409, 'datatable_create_failed'));
    assert.strictEqual(ctx.state.session.proposal.pendingDatatables[0].applyKey, null);
    assert.strictEqual(ctx.state.session.proposal.applying, null);
});

test('access refusals (no manage_datatables, training, organisation mismatch) are 403/409, release the claim and create nothing', async () => {
    for (const [status, code] of [[403, 'manage_datatables_required'], [403, 'training_required'], [409, 'datatable_org_mismatch'], [503, 'identity_unavailable']]) {
        const ctx = setup({ access: { ok: false, status, code, message: `refused ${code}` } });
        await assert.rejects(() => apply(ctx), failsWith(status, code));
        assert.deepStrictEqual(ctx.state.created, []);
        assert.strictEqual(ctx.state.session.proposal.applying, null, `${code}: claim released`);
    }
});

test('the quota pre-check gives 409 datatable_quota before anything is created', async () => {
    const ctx = setup({ quota: 'This workspace already has 50 datatables (the limit is 50).' });
    await assert.rejects(() => apply(ctx), (e) => e.status === 409 && e.code === 'datatable_quota' && /50 datatables/.test(e.message));
    assert.deepStrictEqual(ctx.state.created, []);
    assert.strictEqual(ctx.state.session.proposal.applying, null);
});

test('a create failure with a quota or schema code maps to its own status', async () => {
    const quota = setup({ createFailures: { 'pending:1': { code: 'quota', error: 'full' } } });
    await assert.rejects(() => apply(quota), failsWith(409, 'datatable_quota'));
    const schema = setup({ createFailures: { 'pending:1': { code: 'schema_invalid', error: 'bad' } } });
    await assert.rejects(() => apply(schema), failsWith(422, 'schema_invalid'));
    const manage = setup({ createFailures: { 'pending:1': { code: 'manage_datatables_required', error: 'no' } } });
    await assert.rejects(() => apply(manage), failsWith(403, 'manage_datatables_required'));
});

test('a staged id that is not part of the proposal (unknown ref) gives 409 proposal_inconsistent', async () => {
    const stray = { ...PROPOSED, steps: [...PROPOSED.steps, { id: 'd3', type: 'datatable', op: 'find_rows', datatableId: 'pending:9' }] };
    const ctx = setup({ proposal: { definition: stray } });
    await assert.rejects(() => apply(ctx), failsWith(409, 'proposal_inconsistent'));
    assert.strictEqual(ctx.state.session.proposal.applying, null);
});

test('a version conflict on the final write is logged, not failed: the tables exist and the client saves the flow', async () => {
    let conflicts = 0;
    const ctx = setup({
        beforeWrite: (next, state) => {
            // Only the final write (proposal cleared) races a chat turn once.
            if (next.proposal === null && conflicts === 0) { conflicts += 1; state.session = { ...state.session, version: state.session.version + 1, proposal: { id: 'someone-else' } }; }
        },
    });
    const res = await apply(ctx);
    assert.strictEqual(res.createdDatatables.length, 2, 'the Apply still succeeds');
    assert.ok(ctx.state.warnings.some((w) => /session changed while applying/.test(w)));
});

test('a version conflict on the final write with the same proposal is retried once', async () => {
    let conflicts = 0;
    const ctx = setup({
        beforeWrite: (next, state) => {
            if (next.proposal === null && conflicts === 0) { conflicts += 1; state.session = { ...state.session, version: state.session.version + 1 }; }
        },
    });
    await apply(ctx);
    assert.strictEqual(ctx.state.session.proposal, null, 'the retry wrote the outcome');
    assert.strictEqual(ctx.state.session.reviewOutcome.datatables.length, 2);
});

test('keptDatatables lists only the tables an earlier failed Apply had created', () => {
    assert.deepStrictEqual(keptDatatables({ pendingDatatables: [{ createdId: 'tbl_1', name: 'A' }, { name: 'B' }] }), [{ id: 'tbl_1', name: 'A' }]);
    assert.deepStrictEqual(keptDatatables(null), []);
});

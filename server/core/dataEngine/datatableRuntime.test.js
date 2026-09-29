/**
 * core/dataEngine/datatableRuntime — de gedeelde datatable-runner.
 *
 * Geen databank: `stores/datatableStore` en `stores/datatableDbStore` worden
 * gemonkeypatcht, zodat de ECHTE `queryCompiler` en de ECHTE
 * `auth/datatableAccess` meelopen. Wat hier getoetst wordt is precies wat een
 * stub niet mag wegnemen: de graadbeslissing, de kolombegrenzing en de vraag
 * welke SQL er daadwerkelijk uitkomt.
 *
 * Draaien: cd server && node --test --test-force-exit core/dataEngine/datatableRuntime.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const datatableStore = require('../../stores/datatableStore');
const datatableDbStore = require('../../stores/datatableDbStore');
const runtime = require('./datatableRuntime');

const OWNER = 'u-owner';
const ORG = 'org-1';

/**
 * Een `datatables`-rij zoals rowToDatatable hem oplevert: camelCase voor de
 * consumenten, plus de snake_case-velden die auth/datatableAccess leest.
 */
function table(over = {}) {
    const base = {
        id: 'tbl_1',
        key: 'rates',
        name: 'Rates',
        scope: { kind: 'org', id: ORG },
        scope_kind: 'org',
        scope_id: ORG,
        organizationId: ORG,
        organization_id: ORG,
        ownerUserId: OWNER,
        owner_user_id: OWNER,
        is_published: true,
        shared_groups: [],
        write_mode: 'grants',
        row_scope: 'all',
        rowCount: 3,
    };
    const out = { ...base, ...over };
    // Houd de twee spellingen synchroon, zodat een test die er één zet niet per
    // ongeluk de andere laat staan.
    if ('ownerUserId' in over) out.owner_user_id = over.ownerUserId;
    if ('owner_user_id' in over) out.ownerUserId = over.owner_user_id;
    if ('organizationId' in over) out.organization_id = over.organizationId;
    return out;
}

function meta(over = {}) {
    return {
        key: 'rates',
        fields: [
            { id: 'f1', key: 'name', type: 'text' },
            { id: 'f2', key: 'price', type: 'number' },
            { id: 'f3', key: 'secret_note', type: 'text' },
        ],
        ...over,
    };
}

/** Een principal zoals resolveDatatablePrincipalForUser hem oplevert. */
function principal(over = {}) {
    return { userId: OWNER, orgId: ORG, organizationId: ORG, orgRole: null, groupIds: [], ...over };
}

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    const done = () => { for (const [obj, key, orig] of originals) obj[key] = orig; };
    try {
        const out = fn();
        return (out && typeof out.then === 'function') ? out.finally(done) : (done(), out);
    } catch (e) { done(); throw e; }
}

/** Standaardstubs: de tabel bestaat, geen extra grants, geen rijen. */
function baseStubs({ rows = [], t = table(), m = meta(), grants = [], exec = null, bumped = [] } = {}) {
    return [
        [datatableStore, 'getDatatable', async (id, scope) => (
            id === t.id && scope.kind === t.scope.kind && scope.id === t.scope.id ? t : null)],
        [datatableStore, 'listGrants', async () => grants],
        [datatableStore, 'getTableMeta', async () => m],
        [datatableStore, 'bumpAfterWrite', async (...a) => { bumped.push(a); }],
        [datatableDbStore, 'scopeKey', (s) => `${s.kind}:${s.id}`],
        [datatableDbStore, 'query', async (_a, _b, sql, params) => {
            baseStubs.lastQuery = { sql, params };
            return { rows };
        }],
        [datatableDbStore, 'exec', async (_a, _b, sql, params) => {
            baseStubs.lastExec = { sql, params };
            return exec || { changes: 1 };
        }],
    ];
}

// ── resolveForPrincipal ──────────────────────────────────────────────

test('resolveForPrincipal grades the caller fresh and returns the descriptor + access block', async () => {
    await withPatches(baseStubs(), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        assert.strictEqual(r.grade, 'owner');
        assert.strictEqual(r.scopeKey, `org:${ORG}`);
        // De compiler krijgt de descriptor MET toegangsblok; zonder dat blok
        // valt compileAccessFilter op de default terug.
        assert.ok(r.meta.access, 'meta.access must ride along');
        assert.strictEqual(r.meta.key, 'rates');
    });
});

test('no grade at all is a 404, never a 403 — the table must not be probeable', async () => {
    // Een buitenstaander: andere org, geen grant.
    await withPatches(baseStubs(), async () => {
        await assert.rejects(
            () => runtime.resolveForPrincipal('tbl_1', principal({ userId: 'u-other', orgId: 'org-2', organizationId: 'org-2' })),
            (e) => e.status === 404 && e.code === 'datatable_not_found');
    });
});

test('a grade that is too low is a 403', async () => {
    // Gepubliceerd zonder groepsbeperking → viewer voor de org; editor gevraagd.
    await withPatches(baseStubs({ t: table({ ownerUserId: 'u-else' }) }), async () => {
        const p = principal({ userId: 'u-reader' });
        const asViewer = await runtime.resolveForPrincipal('tbl_1', p, { needed: 'viewer' });
        assert.strictEqual(asViewer.grade, 'viewer');
        await assert.rejects(
            () => runtime.resolveForPrincipal('tbl_1', p, { needed: 'editor' }),
            (e) => e.status === 403 && e.code === 'datatable_forbidden');
    });
});

// ── allowColumns: de versmalling ─────────────────────────────────────

test('BITE — a missing allowColumns throws loudly instead of meaning "all columns"', async () => {
    await withPatches(baseStubs({ rows: [] }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        await assert.rejects(() => runtime.readRows(r, {}), /allowColumns is required/);
        await assert.rejects(() => runtime.readRows(r, { allowColumns: null }), /allowColumns is required/);
    });
});

test('BITE — an EMPTY allowColumns is a refusal, not "everything"', async () => {
    await withPatches(baseStubs({ rows: [{ id: 'r1', name: 'a' }] }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        await assert.rejects(
            () => runtime.readRows(r, { allowColumns: [] }),
            (e) => e.status === 403 && e.code === 'no_columns_bound');
    });
});

test('BITE — rows are projected onto the bound columns plus id/updated_at, and nothing else', async () => {
    const rows = [{
        id: 'r1', name: 'Basic', price: 10, secret_note: 'internal only',
        created_by: 'u-someone', org_id: ORG, created_at: 't0', updated_at: 't1',
    }];
    await withPatches(baseStubs({ rows }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        const out = await runtime.readRows(r, { allowColumns: ['name'] });
        assert.deepStrictEqual(Object.keys(out.rows[0]).sort(), ['id', 'name', 'updated_at']);
        assert.strictEqual(out.rows[0].name, 'Basic');
        // created_by is een gebruikers-id: persoonsgegeven, nooit gratis mee.
        assert.strictEqual('created_by' in out.rows[0], false);
        assert.strictEqual('price' in out.rows[0], false);
        assert.strictEqual('secret_note' in out.rows[0], false);
    });
});

test('a bound column the table no longer has simply drops out; all-gone is a refusal', async () => {
    await withPatches(baseStubs({ rows: [{ id: 'r1', name: 'a', updated_at: 't' }] }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        const out = await runtime.readRows(r, { allowColumns: ['name', 'gone_last_year'] });
        assert.deepStrictEqual(out.columns, ['name']);
        await assert.rejects(
            () => runtime.readRows(r, { allowColumns: ['gone_last_year'] }),
            (e) => e.status === 403 && e.code === 'no_columns_bound');
    });
});

test('BITE — filtering and sorting on an unbound column is refused (no value oracle)', async () => {
    await withPatches(baseStubs({ rows: [] }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        await assert.rejects(
            () => runtime.readRows(r, { allowColumns: ['name'], filters: [{ field: 'secret_note', op: 'eq', value: 'x' }] }),
            (e) => e.status === 400 && e.code === 'column_not_bound');
        await assert.rejects(
            () => runtime.readRows(r, { allowColumns: ['name'], sort: { field: 'secret_note', dir: 'asc' } }),
            (e) => e.status === 400 && e.code === 'column_not_bound');
        // Dezelfde toets moet gelden voor de LIJST-vorm van sort: die accepteert
        // de compiler ook, en alleen `sort.field` lezen liet hem er langs.
        await assert.rejects(
            () => runtime.readRows(r, { allowColumns: ['name'], sort: [{ field: 'secret_note', dir: 'asc' }] }),
            (e) => e.status === 400 && e.code === 'column_not_bound');
        // Op een gebonden kolom mag het wel.
        const ok = await runtime.readRows(r, { allowColumns: ['name'], filters: [{ field: 'name', op: 'eq', value: 'x' }] });
        assert.strictEqual(ok.count, 0);
        const okSorted = await runtime.readRows(r, { allowColumns: ['name'], sort: [{ field: 'name', dir: 'asc' }] });
        assert.strictEqual(okSorted.count, 0);
    });
});

test('the cursor probe row never leaks out of the page', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `r${i}`, name: `n${i}`, updated_at: 't', created_at: `t${i}` }));
    await withPatches(baseStubs({ rows }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        const out = await runtime.readRows(r, { allowColumns: ['name'], limit: 2 });
        assert.strictEqual(out.rows.length, 2);
        assert.strictEqual(out.hasMore, true);
        assert.ok(out.nextCursor, 'a next page must be reachable');
    });
});

test('the compiled read carries the access predicate — a viewer on a row_scope:own table only sees its own', async () => {
    const t = table({ row_scope: 'own', ownerUserId: 'u-else' });
    await withPatches(baseStubs({ t, rows: [] }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal({ userId: 'u-reader' }));
        assert.strictEqual(r.grade, 'viewer');
        await runtime.readRows(r, { allowColumns: ['name'] });
        assert.match(baseStubs.lastQuery.sql, /created_by/,
            'the access filter must be ANDed into the SQL');
        assert.ok(baseStubs.lastQuery.params.includes('u-reader'),
            'the predicate must be bound to the VIEWER, not the author');
    });
});

// ── schrijven ────────────────────────────────────────────────────────

test('insert refuses a value for an unbound column instead of silently dropping it', async () => {
    await withPatches(baseStubs(), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        await assert.rejects(
            () => runtime.insertRow(r, { allowColumns: ['name'], values: { name: 'a', price: 3 } }),
            (e) => e.status === 400 && e.code === 'column_not_bound');
    });
});

test('insert stamps created_by on the VIEWER and org_id from the table', async () => {
    const bumped = [];
    await withPatches(baseStubs({ bumped }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal({ userId: 'u-reader', orgRole: 'admin' }));
        const out = await runtime.insertRow(r, { allowColumns: ['name'], values: { name: 'a' } });
        assert.ok(out.id, 'the new row id comes back');
        assert.ok(baseStubs.lastExec.params.includes('u-reader'), 'created_by = the viewer');
        assert.deepStrictEqual(bumped[0].slice(0, 3), ['tbl_1', { kind: 'org', id: ORG }, 1]);
    });
});

test('a viewer may not insert — assertCanWrite refuses before any SQL runs', async () => {
    let execCalled = false;
    const stubs = baseStubs({ t: table({ ownerUserId: 'u-else' }) });
    stubs.push([datatableDbStore, 'exec', async () => { execCalled = true; return { changes: 1 }; }]);
    await withPatches(stubs, async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal({ userId: 'u-reader' }));
        await assert.rejects(() => runtime.insertRow(r, { allowColumns: ['name'], values: { name: 'a' } }));
        assert.strictEqual(execCalled, false, 'nothing may be written');
    });
});

test('update demands expectedUpdatedAt and answers 409 with the projected row on a conflict', async () => {
    const stored = { id: 'r1', name: 'a', price: 9, secret_note: 's', updated_at: 't2', created_by: 'u-x' };
    await withPatches(baseStubs({ rows: [stored], exec: { changes: 0 } }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        await assert.rejects(
            () => runtime.updateRow(r, { allowColumns: ['name'], rowId: 'r1', values: { name: 'b' } }),
            (e) => e.status === 400 && e.code === 'expected_updated_at_required');
        await assert.rejects(
            () => runtime.updateRow(r, { allowColumns: ['name'], rowId: 'r1', values: { name: 'b' }, expectedUpdatedAt: 't1' }),
            (e) => e.status === 409 && e.code === 'row_conflict'
                && e.row && !('secret_note' in e.row) && !('created_by' in e.row));
    });
});

test('a successful update answers the projected row and bumps data_version without adding rows', async () => {
    const stored = { id: 'r1', name: 'b', secret_note: 's', updated_at: 't3' };
    const bumped = [];
    await withPatches(baseStubs({ rows: [stored], exec: { changes: 1 }, bumped }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        const out = await runtime.updateRow(r, {
            allowColumns: ['name'], rowId: 'r1', values: { name: 'b' }, expectedUpdatedAt: 't2',
        });
        assert.deepStrictEqual(Object.keys(out.row).sort(), ['id', 'name', 'updated_at']);
        assert.strictEqual(bumped[0][2], 0, 'an edit adds no rows');
    });
});

// ── aggregateRows: groeperen binnen dezelfde begrenzing ──────────────

test('BITE — aggregateRows binds groupBy, aggregates, filters and sort to allowColumns', async () => {
    await withPatches(baseStubs({ rows: [] }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal());
        const bound = (over) => runtime.aggregateRows(r, { allowColumns: ['name'], ...over });
        // Groeperen op een kolom die deze consument niet mag lezen is hetzelfde
        // orakel als erop filteren: de waarden komen er letterlijk uit.
        await assert.rejects(
            () => bound({ groupBy: [{ field: 'secret_note' }] }),
            (e) => e.status === 400 && e.code === 'column_not_bound');
        await assert.rejects(
            () => bound({ groupBy: [{ field: 'name' }], aggregates: [{ fn: 'sum', field: 'price', as: 'n' }] }),
            (e) => e.status === 400 && e.code === 'column_not_bound');
        await assert.rejects(
            () => bound({ groupBy: [{ field: 'name' }], filters: [{ field: 'price', op: 'gt', value: 1 }] }),
            (e) => e.status === 400 && e.code === 'column_not_bound');
        await assert.rejects(
            () => bound({ groupBy: [{ field: 'name' }], sort: [{ field: 'secret_note', dir: 'asc' }] }),
            (e) => e.status === 400 && e.code === 'column_not_bound');
        // En dezelfde twee weigeringen als readRows op de kolomlijst zelf.
        await assert.rejects(() => runtime.aggregateRows(r, { groupBy: [] }), /allowColumns is required/);
        await assert.rejects(
            () => runtime.aggregateRows(r, { allowColumns: [], groupBy: [{ field: 'name' }] }),
            (e) => e.status === 403 && e.code === 'no_columns_bound');
    });
});

test('aggregateRows gives the distinct values of a bound column, with the access filter in the WHERE', async () => {
    const rows = [{ name: 'ACME', n: 4 }, { name: 'Globex', n: 2 }];
    // row_scope 'own' dwingt een created_by-predicaat af: dat moet VÓÓR de
    // GROUP BY staan, anders telt een rij mee die deze persoon niet mag zien.
    await withPatches(baseStubs({ rows, t: table({ row_scope: 'own', ownerUserId: 'u-else', is_published: true, shared_groups: ['g1'] }) }), async () => {
        const r = await runtime.resolveForPrincipal('tbl_1', principal({ groupIds: ['g1'] }));
        const out = await runtime.aggregateRows(r, {
            allowColumns: ['name'],
            groupBy: [{ field: 'name' }],
            aggregates: [{ fn: 'count', field: '*', as: 'n' }],
            limit: 50,
        });
        assert.deepStrictEqual(out.rows, rows);
        const { sql, params } = baseStubs.lastQuery;
        assert.match(sql, /GROUP BY/i);
        const where = sql.slice(0, sql.search(/GROUP BY/i));
        assert.match(where, /created_by/, 'the access predicate lands before the GROUP BY');
        assert.ok(params.includes(OWNER));
    });
});

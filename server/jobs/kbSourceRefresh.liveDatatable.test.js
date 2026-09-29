/**
 * "Live" — the two halves that make it mean what it says.
 *
 * ── THE HOOK, AND WHY IT IS DEBOUNCED ───────────────────────────────
 * `datatableStore.bumpAfterWrite` runs once per write STEP, and a routine
 * looping over 400 rows produces 400 of them in a few seconds. Arming on each
 * would queue 400 refresh passes over a table that settled once.
 *
 * ── THE BACKSTOP, AND WHY IT IS NOT OPTIONAL ────────────────────────
 * That hook is an in-process timer. It does not survive a restart, it does not
 * cross a replica, and a write from a job on another pod fires nobody's timer
 * here. A source that missed its notification would sit on stale rows until
 * somebody pressed refresh — and "live" would be a label with nothing behind
 * it. So the tick compares versions too.
 *
 * Run: cd server && node --test --test-force-exit jobs/kbSourceRefresh.liveDatatable.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { onDatatableChanged, armStaleLiveSources } = require('./kbSourceRefresh');
const { syncSource } = require('../core/kb/sources/index');

// ../stores/datatableStore is sinds de opsplitsing een FACADE met zijn
// onderdelen in stores/datatableStore/. De beweringen hieronder gaan over de
// AANROEPER, dus lees de hele module als één tekst — alleen de facade lezen
// zou elke slice leeg maken en deze bestandsbeweringen stil groen laten worden.
function datatableStoreSource() {
    const fs = require('node:fs');
    const nodePath = require('node:path');
    const facade = require.resolve('../stores/datatableStore');
    const dir = facade.replace(/\.js$/, '');
    const parts = fs.readdirSync(dir)
        .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
        .map(f => fs.readFileSync(nodePath.join(dir, f), 'utf8'));
    return [...parts, fs.readFileSync(facade, 'utf8')].join('\n');
}

function store(over = {}) {
    const calls = { armed: [], refreshed: [] };
    return {
        calls,
        armDatatableSources: async (id) => {
            calls.armed.push(id);
            if (over.armThrows) throw new Error(over.armThrows);
            return over.armedCount ?? 1;
        },
        listLiveDatatableSources: async () => {
            if (over.listThrows) throw new Error(over.listThrows);
            return over.sources || [];
        },
        requestRefresh: async (id) => { calls.refreshed.push(id); return {}; },
    };
}

const datatables = (versions, over = {}) => ({
    getDataVersion: async (id) => {
        if (over.throws) throw new Error(over.throws);
        return Object.prototype.hasOwnProperty.call(versions, id) ? versions[id] : null;
    },
});

// ── The hook ────────────────────────────────────────────────────────

test('a changed table arms the live sources watching it', async () => {
    const s = store();
    assert.strictEqual(await onDatatableChanged('dt1', { store: s }), 1);
    assert.deepStrictEqual(s.calls.armed, ['dt1']);
});

test('no table is no work', async () => {
    const s = store();
    assert.strictEqual(await onDatatableChanged(null, { store: s }), 0);
    assert.deepStrictEqual(s.calls.armed, []);
});

test('a store that fails costs the promptness, never the write', async () => {
    // The row is already committed by the time this runs, and the backstop
    // catches the source on the next tick.
    const s = store({ armThrows: 'kb_sources is locked' });
    await assert.doesNotReject(() => onDatatableChanged('dt1', { store: s }));
});

test('the write path debounces, so 400 row writes are one pass', async () => {
    // Not a claim about this function — about the caller. datatableStore holds
    // one timer per table and drops every bump inside it.
    const src = datatableStoreSource();
    // Tot het EINDE van de functie, niet n tekens ver: het lichaam groeit (er
    // hangt sinds W3 stap 4 een tweede luisteraar aan dezelfde melding) en een
    // vast venster zou dan iets missen dat er wel degelijk staat.
    const start = src.indexOf('function notifyDatatableChanged');
    const end = src.indexOf('\n}', start);
    const fn = src.slice(start, end);
    assert.match(fn, /_liveTimers\.has\(datatableId\)\) return/, 'a bump inside a pending window is dropped');
    assert.match(fn, /unref/, 'and a pending refresh never holds the process open');
});

test('both write paths notify, including the retention sweep', () => {
    // The sweep matters MORE than an ordinary write: rows it removed are rows
    // a knowledge base must stop answering from, and a purge that leaves its
    // copies searchable has not purged anything.
    const src = datatableStoreSource();
    const bump = src.slice(src.indexOf('async function bumpAfterWrite'), src.indexOf('async function bumpAfterWrite') + 800);
    const setCount = src.slice(src.indexOf('async function setRowCount'), src.indexOf('async function setRowCount') + 800);
    assert.match(bump, /notifyDatatableChanged\(id\)/);
    assert.match(setCount, /notifyDatatableChanged\(id\)/);
});

// ── The backstop ────────────────────────────────────────────────────

test('a source that fell behind the table version is armed', async () => {
    const s = store({ sources: [{ id: 's1', datatableId: 'dt1', seenDataVersion: 4, nextRefreshAt: null }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt1: 7 }) }), 1);
    assert.deepStrictEqual(s.calls.refreshed, ['s1']);
});

test('a source that is level with the table is left alone', async () => {
    const s = store({ sources: [{ id: 's1', datatableId: 'dt1', seenDataVersion: 7, nextRefreshAt: null }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt1: 7 }) }), 0);
    assert.deepStrictEqual(s.calls.refreshed, []);
});

test('a source already armed is not armed again', async () => {
    // It is in the queue; arming it once more only moves a timestamp.
    const s = store({ sources: [{ id: 's1', datatableId: 'dt1', seenDataVersion: 1, nextRefreshAt: '2026-09-04T12:00:00.000Z' }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt1: 9 }) }), 0);
});

test('a table that cannot be read is NOT armed', async () => {
    // It was deleted, or this replica cannot see it. Arming would make the
    // pass fail the same way, every minute, for ever.
    const s = store({ sources: [{ id: 's1', datatableId: 'gone', seenDataVersion: 1, nextRefreshAt: null }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({}) }), 0);
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({}, { throws: 'db down' }) }), 0);
});

test('one version lookup per table, however many sources watch it', async () => {
    let asked = 0;
    const dt = { getDataVersion: async () => { asked += 1; return 9; } };
    const s = store({
        sources: [
            { id: 's1', datatableId: 'dt1', seenDataVersion: 1, nextRefreshAt: null },
            { id: 's2', datatableId: 'dt1', seenDataVersion: 2, nextRefreshAt: null },
            { id: 's3', datatableId: 'dt1', seenDataVersion: 3, nextRefreshAt: null },
        ],
    });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: dt }), 3);
    assert.strictEqual(asked, 1);
});

test('one source failing does not abandon the rest', async () => {
    const s = store({
        sources: [
            { id: 's1', datatableId: 'dt1', seenDataVersion: 1, nextRefreshAt: null },
            { id: 's2', datatableId: 'dt2', seenDataVersion: 1, nextRefreshAt: null },
        ],
    });
    s.requestRefresh = async (id) => {
        if (id === 's1') throw new Error('locked');
        s.calls.refreshed.push(id);
        return {};
    };
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt1: 9, dt2: 9 }) }), 1);
    assert.deepStrictEqual(s.calls.refreshed, ['s2']);
});

test('a backstop that cannot list anything fails the backstop, not the tick', async () => {
    const s = store({ listThrows: 'kb_sources is gone' });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({}) }), 0);
});

test('no live sources is no work at all', async () => {
    let asked = 0;
    const s = store({ sources: [] });
    await armStaleLiveSources({ store: s, datatables: { getDataVersion: async () => { asked += 1; return 1; } } });
    assert.strictEqual(asked, 0);
});

test('the backstop runs BEFORE the claim, so its work lands in the same tick', () => {
    // After it, everything it arms waits a full minute for the next tick —
    // which is most of what "live" was supposed to remove.
    const src = require('node:fs').readFileSync(require.resolve('./kbSourceRefresh'), 'utf8');
    const tick = src.slice(src.indexOf('async function processDueSources'));
    // The CALL sites, not the prose: the docblock above the tick discusses
    // claimDue at length, and matching that would pass whatever the code did.
    const armAt = tick.indexOf('await armStaleLiveSources(');
    const claimAt = tick.indexOf('kbSourcesStore.claimDue(');
    assert.ok(armAt > 0 && claimAt > 0, 'both are called');
    assert.ok(armAt < claimAt, 'the backstop arms before the claim collects');
});

// syncSource takes its deps by injection (opts.deps), so the tail block that
// records a table version is driven for real here, with a fake adapter
// standing in for the datatable one — instead of reading index.js as text.
function datatableHarness({ enumerate = async () => [], cancelled = false, related = null } = {}) {
    const KB = { id: 'kb1', tenant_id: 'tenant1' };
    const calls = { setSeenDataVersion: [] };
    const deps = {
        kbStore: { getKB: async () => KB, listDocuments: async () => [], bumpKBVersion: async () => {} },
        kbSourcesStore: {
            isCancelRequested: async () => cancelled,
            setSeenDataVersion: async (...args) => { calls.setSeenDataVersion.push(args); },
        },
        datatableStore: { getDataVersion: async () => 5 },
        // Every item is "skipped": nothing lands in `summarise`, so
        // labelDocuments short-circuits and needs no summariser stub.
        helpers: { ingestDocument: async () => ({ document: { id: 'newdoc' }, status: 'skipped' }) },
    };
    const adapter = {
        enumerate: async (source, ctx) => {
            if (related) ctx.relatedTables = related;
            return enumerate();
        },
        isUnchanged: () => false,
        fetch: async () => ({ content: 'x', title: 'x' }),
    };
    const source = { id: 'src1', knowledgeBaseId: 'kb1', kind: 'datatable', config: { datatableId: 'dt1' }, createdBy: 'u1' };
    return { deps, calls, adapter, source };
}

test('a completed datatable pass records the table version it read', async () => {
    const { deps, calls, adapter, source } = datatableHarness();
    await syncSource(source, { deps, adapter });
    assert.deepStrictEqual(calls.setSeenDataVersion, [['src1', 5, null]]);
});

test('a cancelled pass does not record the version — it saw only part of the table', async () => {
    // Recording it would tell the backstop "up to date" about rows nobody
    // read — the exact silence `live` exists to prevent.
    const { deps, calls, adapter, source } = datatableHarness({
        enumerate: async () => [{ externalId: 'a' }],
        cancelled: true,
    });
    await syncSource(source, { deps, adapter });
    assert.deepStrictEqual(calls.setSeenDataVersion, []);
});

test('a truncated pass does not record the version either', async () => {
    const { deps, calls, adapter, source } = datatableHarness({
        enumerate: async () => [{ externalId: 'a' }, { externalId: 'b' }],
    });
    await syncSource(source, { deps, adapter, maxItems: 1 });
    assert.deepStrictEqual(calls.setSeenDataVersion, []);
});

test('the recorded version carries the TARGET tables the adapter read labels from', async () => {
    // ctx.relatedTables (the write-path's `related`, K8): a supplier renamed
    // in its own table changes every order document that names it, with no
    // row of the orders table having moved at all.
    const related = { dt_sup: 9 };
    const { deps, calls, adapter, source } = datatableHarness({ related });
    await syncSource(source, { deps, adapter });
    assert.deepStrictEqual(calls.setSeenDataVersion, [['src1', 5, related]]);
});

// ── The tables a source points AT ───────────────────────────────────
//
// An orders source renders its `supplier` cells as the supplier's name, read
// from the Suppliers table. A rename or an erasure THERE changes every order
// document, and not one row of the orders table has moved. So a `live`
// source watches its targets too — both halves, hook and backstop.

test('a source whose TARGET table moved is armed, though its own table is level', async () => {
    const s = store({ sources: [{
        id: 's1', datatableId: 'dt_ord', seenDataVersion: 7, nextRefreshAt: null,
        relatedTableIds: ['dt_sup'], seenRelatedVersions: { dt_sup: 3 },
    }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt_ord: 7, dt_sup: 5 }) }), 1);
    assert.deepStrictEqual(s.calls.refreshed, ['s1']);
});

test('a target table that is level leaves the source alone', async () => {
    const s = store({ sources: [{
        id: 's1', datatableId: 'dt_ord', seenDataVersion: 7, nextRefreshAt: null,
        relatedTableIds: ['dt_sup'], seenRelatedVersions: { dt_sup: 5 },
    }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt_ord: 7, dt_sup: 5 }) }), 0);
});

test('a target table never seen before counts as behind', async () => {
    // The source recorded the target but no version for it: it has not read
    // the labels since the target existed here. Read them.
    const s = store({ sources: [{
        id: 's1', datatableId: 'dt_ord', seenDataVersion: 7, nextRefreshAt: null,
        relatedTableIds: ['dt_sup'], seenRelatedVersions: {},
    }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt_ord: 7, dt_sup: 1 }) }), 1);
});

test('a target table that cannot be read does not arm, for the same reason its own would not', async () => {
    const s = store({ sources: [{
        id: 's1', datatableId: 'dt_ord', seenDataVersion: 7, nextRefreshAt: null,
        relatedTableIds: ['gone'], seenRelatedVersions: { gone: 1 },
    }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt_ord: 7 }) }), 0);
});

test('a source from before targets were recorded is judged on its own table only', async () => {
    const s = store({ sources: [{ id: 's1', datatableId: 'dt_ord', seenDataVersion: 7, nextRefreshAt: null }] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: datatables({ dt_ord: 7 }) }), 0);
});

test('one version lookup per table, shared between own and target', async () => {
    let asked = 0;
    const dt = { getDataVersion: async () => { asked += 1; return 9; } };
    const s = store({ sources: [
        { id: 's1', datatableId: 'dt_sup', seenDataVersion: 9, nextRefreshAt: null },
        { id: 's2', datatableId: 'dt_ord', seenDataVersion: 9, nextRefreshAt: null, relatedTableIds: ['dt_sup'], seenRelatedVersions: { dt_sup: 8 } },
    ] });
    assert.strictEqual(await armStaleLiveSources({ store: s, datatables: dt }), 1);
    assert.strictEqual(asked, 2, 'dt_sup and dt_ord, once each');
});

test('the write-path hook arms the sources POINTING AT the table too', () => {
    // The store's query, since that is where the match lives: a write to
    // Suppliers must reach the Orders source, whose own table did not change.
    const src = require('node:fs').readFileSync(require.resolve('../stores/kbSources'), 'utf8');
    const start = src.indexOf('armDatatableSources:');
    const fn = src.slice(start, src.indexOf('},', start));
    assert.match(fn, /config->>'datatableId' = \$1/);
    assert.match(fn, /config->'relatedTableIds' \? \$1/, 'or the table is one this source reads labels from');
});

// 'the engine hands the targets to the store, only when the pass FINISHED'
// used to live here as a second source-text scan of the same block. Replaced
// above by 'the recorded version carries the TARGET tables the adapter read
// labels from' and 'a truncated pass does not record the version either',
// which call syncSource for real instead of re-reading the same lines.

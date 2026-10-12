/**
 * The `automation` sources of a knowledge base, kept in step with the automations
 * that write to it.
 *
 * The properties that carry the design:
 *   - a source appears when the automation is SAVED, not when it first runs;
 *   - it never appears for a base the owner may not write to;
 *   - a base the automation stopped writing to is MARKED, never deleted — the
 *     documents hanging off that source are somebody's knowledge, and removing
 *     a step is not a request to throw them away.
 *
 * Run: cd server && node --test --test-force-exit core/kb/kbSourceSync.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { syncKbSources } = require('./kbSourceSync');

/** An in-memory kb_sources table, remembering every call. */
function fakeStore(seed = []) {
    let n = 0;
    const rows = seed.map(r => ({ ...r }));
    return {
        rows,
        findOne: async (kbId, kind, { configMatch } = {}) => rows.find(r => r.knowledgeBaseId === kbId
            && r.kind === kind
            && Object.entries(configMatch || {}).every(([k, v]) => r.config?.[k] === v)) || null,
        listByAutomation: async (id) => rows.filter(r => r.kind === 'automation' && r.config?.automationId === id),
        create: async (row) => {
            const made = { id: `src${++n}`, ...row };
            rows.push(made);
            return made;
        },
        update: async (id, patch) => {
            const row = rows.find(r => r.id === id);
            if (row) Object.assign(row, patch);
            return row || null;
        },
        remove: async (id) => { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1); return i >= 0; },
    };
}

const writeAccess = (okIds) => ({
    canOwnerWriteToKb: async (kbId) => (okIds.includes(kbId) ? { ok: true } : { ok: false, reason: 'no_manage' }),
});

const def = (kbIds) => ({
    steps: kbIds.map((kbId, i) => ({ id: `w${i}`, type: 'knowledge_write', knowledgeBaseId: kbId, content: 'x' })),
});

test('a saved automation attaches a source to each base it writes to', async () => {
    const store = fakeStore();
    const out = await syncKbSources('a1', def(['kb1', 'kb2']), {
        userId: 'u1', title: 'Tickets → KB',
        deps: { kbSourcesStore: store, writeAccess: writeAccess(['kb1', 'kb2']) },
    });
    assert.deepStrictEqual(out.added.sort(), ['kb1', 'kb2']);
    assert.strictEqual(store.rows.length, 2);
    assert.strictEqual(store.rows[0].kind, 'automation');
    assert.strictEqual(store.rows[0].name, 'Tickets → KB', 'the automation names its own source');
    assert.strictEqual(store.rows[0].config.automationId, 'a1');
});

test('no source is attached to a base the owner may not write to', async () => {
    // The step is refused at activation and again at run time, so a source row
    // for it would advertise a feed that is never going to arrive.
    const store = fakeStore();
    const out = await syncKbSources('a1', def(['kb1', 'kb_forbidden']), {
        userId: 'u1', deps: { kbSourcesStore: store, writeAccess: writeAccess(['kb1']) },
    });
    assert.deepStrictEqual(out.added, ['kb1']);
    assert.deepStrictEqual(store.rows.map(r => r.knowledgeBaseId), ['kb1']);
});

test('saving twice does not attach a second source', async () => {
    const store = fakeStore();
    const deps = { kbSourcesStore: store, writeAccess: writeAccess(['kb1']) };
    await syncKbSources('a1', def(['kb1']), { userId: 'u1', title: 'T', deps });
    const out = await syncKbSources('a1', def(['kb1']), { userId: 'u1', title: 'T', deps });
    assert.deepStrictEqual(out, { added: [], kept: ['kb1'], removed: [] });
    assert.strictEqual(store.rows.length, 1);
});

test('renaming the automation renames its source', async () => {
    // It is the only thing a person has to recognise it by in the Sources list.
    const store = fakeStore();
    const deps = { kbSourcesStore: store, writeAccess: writeAccess(['kb1']) };
    await syncKbSources('a1', def(['kb1']), { userId: 'u1', title: 'Old name', deps });
    await syncKbSources('a1', def(['kb1']), { userId: 'u1', title: 'New name', deps });
    assert.strictEqual(store.rows[0].name, 'New name');
});

test('a base the automation stopped writing to is MARKED, never deleted', async () => {
    // The source owns the documents hanging off it, and kb_sources cascades.
    // Removing a step is not a request to delete last year's articles.
    const store = fakeStore();
    const deps = { kbSourcesStore: store, writeAccess: writeAccess(['kb1', 'kb2']) };
    await syncKbSources('a1', def(['kb1', 'kb2']), { userId: 'u1', title: 'T', deps });
    const out = await syncKbSources('a1', def(['kb1']), { userId: 'u1', title: 'T', deps });

    assert.deepStrictEqual(out.removed, ['kb2']);
    assert.strictEqual(store.rows.length, 2, 'nothing is deleted');
    const dropped = store.rows.find(r => r.knowledgeBaseId === 'kb2');
    assert.match(dropped.name, /no longer writes here/, 'and it SAYS it is stale');
});

test('an ai_step reading a base is not a source', async () => {
    // Nothing arrives because of a read link, so nothing feeds the base.
    const store = fakeStore();
    const out = await syncKbSources('a1', {
        steps: [{ id: 'a', type: 'ai_step', knowledgeBaseIds: ['kb1'] }],
    }, { userId: 'u1', deps: { kbSourcesStore: store, writeAccess: writeAccess(['kb1']) } });
    assert.deepStrictEqual(out, { added: [], kept: [], removed: [] });
    assert.strictEqual(store.rows.length, 0);
});

test('a write inside a loop or a flowlet counts too', async () => {
    const store = fakeStore();
    const out = await syncKbSources('a1', {
        steps: [{ id: 'l', type: 'loop', body: [{ id: 'w', type: 'knowledge_write', knowledgeBaseId: 'kb1', content: 'x' }] }],
        layers: { enrich: { steps: [{ id: 'w2', type: 'knowledge_write', knowledgeBaseId: 'kb2', content: 'x' }] } },
    }, { userId: 'u1', deps: { kbSourcesStore: store, writeAccess: writeAccess(['kb1', 'kb2']) } });
    assert.deepStrictEqual(out.added.sort(), ['kb1', 'kb2']);
});

test('two steps writing to one base attach ONE source', async () => {
    const store = fakeStore();
    const out = await syncKbSources('a1', def(['kb1', 'kb1']), {
        userId: 'u1', deps: { kbSourcesStore: store, writeAccess: writeAccess(['kb1']) },
    });
    assert.deepStrictEqual(out.added, ['kb1']);
    assert.strictEqual(store.rows.length, 1);
});

test('a store that is down never fails the save', async () => {
    // The source is bookkeeping; the automation is the product.
    const broken = {
        findOne: async () => { throw new Error('db down'); },
        create: async () => { throw new Error('db down'); },
        update: async () => { throw new Error('db down'); },
        listByAutomation: async () => { throw new Error('db down'); },
    };
    const out = await syncKbSources('a1', def(['kb1']), {
        userId: 'u1', deps: { kbSourcesStore: broken, writeAccess: writeAccess(['kb1']) },
    });
    assert.deepStrictEqual(out, { added: [], kept: [], removed: [] });
});

test('a write check that throws refuses rather than attaching', async () => {
    const store = fakeStore();
    const out = await syncKbSources('a1', def(['kb1']), {
        userId: 'u1',
        deps: {
            kbSourcesStore: store,
            writeAccess: { canOwnerWriteToKb: async () => { throw new Error('boom'); } },
        },
    });
    assert.deepStrictEqual(out.added, []);
    assert.strictEqual(store.rows.length, 0);
});

test('no automation id is a no-op, not a throw', async () => {
    assert.deepStrictEqual(await syncKbSources('', def(['kb1']), { userId: 'u1' }),
        { added: [], kept: [], removed: [] });
});

test('an untitled automation still gets a recognisable source name', async () => {
    const store = fakeStore();
    await syncKbSources('a1', def(['kb1']), {
        userId: 'u1', title: '   ',
        deps: { kbSourcesStore: store, writeAccess: writeAccess(['kb1']) },
    });
    assert.strictEqual(store.rows[0].name, 'Automation a1');
});

// ── an outage is not a refusal, and a refusal is not a dead feed ────────
//
// The stale pass marks everything outside `allowed`. Folding either of those
// into "no longer writes here" relabels a live source dead on an automation that
// changed nothing — and the label is what a person reads to decide whether the
// base is current.

test('a transient check outage does not relabel a live source as dead', async () => {
    const store = fakeStore();
    const good = { kbSourcesStore: store, writeAccess: writeAccess(['kb1']) };
    await syncKbSources('a1', def(['kb1']), { userId: 'u1', title: 'T', deps: good });

    let calls = 0;
    const flaky = {
        kbSourcesStore: store,
        writeAccess: { canOwnerWriteToKb: async () => { calls += 1; throw new Error('db down'); } },
    };
    const out = await syncKbSources('a1', def(['kb1']), { userId: 'u1', title: 'T', deps: flaky });

    assert.ok(calls > 0, 'the check really was attempted');
    assert.deepStrictEqual(out.removed, [], 'nothing is declared stale on an outage');
    assert.strictEqual(store.rows[0].name, 'T', 'and the live source keeps its name');
});

test('a base the owner may no longer write to is NOT relabelled "no longer writes here"', async () => {
    // That is a permission problem for the author to fix, not a feed that
    // stopped. Only a base the DEFINITION dropped earns the stale label.
    const store = fakeStore();
    await syncKbSources('a1', def(['kb1']), {
        userId: 'u1', title: 'T', deps: { kbSourcesStore: store, writeAccess: writeAccess(['kb1']) },
    });
    const out = await syncKbSources('a1', def(['kb1']), {
        userId: 'u1', title: 'T', deps: { kbSourcesStore: store, writeAccess: writeAccess([]) },
    });
    assert.deepStrictEqual(out.removed, []);
    assert.strictEqual(store.rows[0].name, 'T');
});

test('a base the definition DROPPED is still marked stale', async () => {
    // The behaviour the two guards above must not have broken.
    const store = fakeStore();
    const deps = { kbSourcesStore: store, writeAccess: writeAccess(['kb1', 'kb2']) };
    await syncKbSources('a1', def(['kb1', 'kb2']), { userId: 'u1', title: 'T', deps });
    const out = await syncKbSources('a1', def(['kb1']), { userId: 'u1', title: 'T', deps });
    assert.deepStrictEqual(out.removed, ['kb2']);
    assert.match(store.rows.find(r => r.knowledgeBaseId === 'kb2').name, /no longer writes here/);
});

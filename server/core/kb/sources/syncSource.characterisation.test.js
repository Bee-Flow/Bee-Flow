// @typecheck
'use strict';

/**
 * Characterisation (golden) test for syncSource: for each scenario the
 * returned counters (or the thrown error) and every call the pass makes, in
 * order, with what it was given: the knowledge-base lookup, the adapter's
 * precheck, enumerate, isUnchanged and fetch, the stored-document pages, the
 * cancel checks, ingest and reingest with their full options, the kept
 * originals, the removals, the version bump, the labels, the table version,
 * the change cursor and the log lines. The clock stands still.
 *
 * Scenarios reach each branch: a knowledge base that is gone, a kind without
 * an adapter, a precheck that says unchanged / changed / fails, new, changed,
 * unchanged (both ways) and gone documents, a row wrongly marked duplicate,
 * the optional fields of a fetched document, an ingest that was skipped or
 * redacted, a failing document, a cancelled pass, the item cap and the time
 * budget, a partial list, documents without an external id, the datatable
 * version (with related tables, failing, cancelled) and the cursor.
 *
 * Regenerate the golden file ONLY for an intended behaviour change:
 *   UPDATE_GOLDEN=1 node --test core/kb/sources/syncSource.characterisation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const NOW = Date.parse('2026-03-01T10:00:00.000Z');
test.mock.timers.enable({ apis: ['Date'], now: NOW });

const { syncSource } = require('./index');

const GOLDEN = path.join(__dirname, 'syncSource.characterisation.golden.json');

const KB = { id: 'kb1', tenant_id: 'tenant1', organization_id: 'org1', keep_originals: true };
/** @param {Record<string, unknown>} [over] */
const source = (over = {}) => ({ id: 'src1', knowledgeBaseId: 'kb1', kind: 'fake', createdBy: 'user1', refreshMode: 'scheduled', refreshCron: null, refreshTz: null, config: {}, ...over });
/** @param {string} id @param {string | null} externalId @param {Record<string, unknown>} [over] */
const doc = (id, externalId, over = {}) => ({ id, external_id: externalId, title: `stored ${externalId}`, status: 'processed', ...over });
/** @param {string[]} ids */
const items = (...ids) => ids.map((externalId) => ({ externalId }));
const FULL = {
    content: 'fresh text', title: 'Fresh title', sourceType: 'web', sourceUri: 'https://example.com/a', metadata: { rows: [1, 2] },
    sourceModifiedAt: '2026-02-20T00:00:00Z', sizeBytes: 0, mime: 'text/html', pageCount: 0, sheetCount: 3,
    original: { buffer: Buffer.from('file'), mime: '', filename: '' },
};

/**
 * name → { source?, opts?, env }. env: kb, adapter switches (precheck,
 * enumerate, unchanged, fetched per external id, dedupe, maxItems, partial,
 * relatedTables), stored documents, ingest/reingest answers and what fails.
 * @type {Record<string, { source?: any, opts?: Record<string, unknown>, env?: Record<string, any> }>}
 */
const CASES = {
    // before the pass
    kbGone: { env: { kb: null } },
    kindWithoutAdapter: { source: source({ kind: 'not_a_kind' }), env: { noAdapter: true } },
    precheckUnchanged: { env: { precheck: { changed: false, cursor: 'c1' }, enumerate: items('a') } },
    precheckUnchangedOnChangeSource: { source: source({ refreshMode: 'on_change' }), env: { precheck: { changed: false } } },
    precheckUnchangedManualSource: { source: source({ refreshMode: 'manual' }), env: { precheck: { changed: false } } },
    precheckChanged: { env: { precheck: { changed: true, cursor: 42 }, enumerate: items('a') } },
    precheckSaysNothing: { env: { precheck: null, enumerate: items('a') } },
    precheckFails: { env: { precheckThrows: true, enumerate: items('a') } },
    precheckEmptyCursor: { env: { precheck: { changed: true, cursor: '' }, enumerate: items('a') } },
    // the diff
    nothingListed: { env: { enumerate: [] } },
    listIsNotAList: { env: { enumerate: null } },
    listIsAString: { env: { enumerate: 'ab' } },
    newDocument: { env: { enumerate: items('a') } },
    newDocumentAllFields: { env: { enumerate: items('a'), fetched: { a: FULL } } },
    newDocumentNoCreator: { source: source({ createdBy: undefined }), env: { kb: { id: 'kb1', tenant_id: 'tenant1' }, enumerate: items('a') } },
    newDocumentNoDedupe: { env: { dedupe: false, enumerate: items('a') } },
    newDocumentSkipped: { env: { enumerate: items('a'), fetched: { a: FULL }, ingest: { document: { id: 'new_a' }, status: 'skipped' } } },
    newDocumentRedacted: { env: { enumerate: items('a'), fetched: { a: FULL }, ingest: { document: { id: 'new_a' }, status: 'redacted' } } },
    newDocumentNoRow: { env: { enumerate: items('a'), fetched: { a: FULL }, ingest: null } },
    newDocumentNoTitle: { env: { enumerate: items('a'), fetched: { a: { content: 'untitled text' } } } },
    changedDocument: { env: { stored: [doc('d1', 'a')], enumerate: items('a') } },
    changedDocumentAllFields: { env: { stored: [doc('d1', 'a')], enumerate: items('a'), fetched: { a: FULL } } },
    changedDocumentKeepsStoredTitle: { env: { stored: [doc('d1', 'a')], enumerate: items('a'), fetched: { a: { content: 'x' } } } },
    changedDocumentRedacted: { env: { stored: [doc('d1', 'a')], enumerate: items('a'), fetched: { a: FULL }, reingest: { status: 'redacted' } } },
    changedDocumentNoAnswer: { env: { stored: [doc('d1', 'a')], enumerate: items('a'), fetched: { a: FULL }, reingest: null } },
    unchangedByAdapter: { env: { stored: [doc('d1', 'a')], enumerate: items('a'), unchanged: true } },
    unchangedAtFetch: { env: { stored: [doc('d1', 'a')], enumerate: items('a'), fetched: { a: null } } },
    unchangedAtFetchNewItem: { env: { enumerate: items('a'), fetched: { a: null } } },
    fetchAnswersNothing: { env: { enumerate: items('a'), fetched: { a: undefined } } },
    goneDocument: { env: { stored: [doc('d1', 'a'), doc('d2', 'b')], enumerate: items('a'), unchanged: true } },
    goneDocumentDeleteFails: { env: { stored: [doc('d1', 'a'), doc('d2', 'b'), doc('d3', 'c')], enumerate: items('a'), unchanged: true, deleteThrows: 'd2' } },
    everythingGone: { env: { stored: [doc('d1', 'a')], enumerate: [] } },
    wronglyDuplicateIsRebuilt: { env: { dedupe: false, stored: [doc('d1', 'a', { status: 'duplicate' })], enumerate: items('a'), unchanged: true } },
    duplicateStaysWhenAdapterDedupes: { env: { stored: [doc('d1', 'a', { status: 'duplicate' })], enumerate: items('a'), unchanged: true } },
    mixedPass: { env: { stored: [doc('d1', 'a'), doc('d2', 'b'), doc('d3', 'gone'), doc('d4', null)], enumerate: items('a', 'b', 'c', 'd'), unchangedIds: ['a'], fetched: { d: null } } },
    numericExternalId: { env: { stored: [doc('d1', '7')], enumerate: [{ externalId: 7 }] } },
    documentsWithoutExternalId: { env: { stored: [doc('d1', null), doc('d2', '')], enumerate: items('a') } },
    storedPages: { env: { stored: Array.from({ length: 201 }, (_, i) => doc(`d${i}`, `e${i}`)), enumerate: items('e0', 'e200'), unchanged: true, partial: true } },
    // failures, stopping and caps
    documentFails: { env: { enumerate: items('a', 'b', 'c'), fetchThrows: 'b' } },
    ingestFails: { env: { enumerate: items('a', 'b'), ingestThrows: 'a' } },
    reingestFails: { env: { stored: [doc('d1', 'a')], enumerate: items('a'), reingestThrows: true, precheck: { changed: true, cursor: 'c2' } } },
    isUnchangedThrows: { env: { stored: [doc('d1', 'a')], enumerate: items('a'), unchangedThrows: true } },
    enumerateThrows: { env: { enumerateThrows: true } },
    cancelledAtOnce: { env: { stored: [doc('d1', 'a'), doc('d2', 'b')], enumerate: items('a', 'c'), cancelAfter: 0 } },
    cancelledBetweenDocuments: { env: { stored: [doc('d9', 'z')], enumerate: items('a', 'b', 'c'), cancelAfter: 1 } },
    cancelledWhileLabelling: { env: { enumerate: items('a', 'b', 'c', 'd', 'e'), cancelAfter: 6 } },
    itemCap: { opts: { maxItems: 2 }, env: { stored: [doc('d9', 'z')], enumerate: items('a', 'b', 'c'), precheck: { changed: true, cursor: 'c3' } } },
    itemCapFromAdapter: { env: { maxItems: 1, enumerate: items('a', 'b') } },
    itemCapCallerWins: { opts: { maxItems: 2 }, env: { maxItems: 1, enumerate: items('a', 'b', 'c') } },
    itemCapExactlyMet: { opts: { maxItems: 2 }, env: { stored: [doc('d9', 'z')], enumerate: items('a', 'b') } },
    outOfTime: { opts: { now: NOW - 60_000 }, env: { stored: [doc('d9', 'z')], enumerate: items('a', 'b') } },
    timeBudgetFromCaller: { opts: { now: NOW - 5_000, timeBudgetMs: 4_000 }, env: { enumerate: items('a') } },
    timeBudgetNotSpent: { opts: { now: NOW - 5_000, timeBudgetMs: 6_000 }, env: { enumerate: items('a') } },
    partialList: { env: { partial: true, stored: [doc('d1', 'a'), doc('d2', 'b')], enumerate: items('a'), unchanged: true, precheck: { changed: true, cursor: 'c4' } } },
    // after the pass
    labelFails: { env: { enumerate: items('a', 'b'), summariseThrows: 'new_a' } },
    labelWithoutSummary: { env: { enumerate: items('a'), summary: null } },
    originalNotKept: { env: { enumerate: items('a'), fetched: { a: FULL }, keep: { kept: false, reason: 'too_large' } } },
    originalKeepFails: { env: { enumerate: items('a'), fetched: { a: FULL }, keepThrows: true } },
    originalsOff: { env: { kb: { ...KB, keep_originals: false }, enumerate: items('a'), fetched: { a: FULL } } },
    datatableVersion: { source: source({ kind: 'datatable', config: { datatableId: 'dt1' } }), env: { enumerate: items('a'), relatedTables: { dt2: 5 }, dataVersion: 12 } },
    datatableVersionZero: { source: source({ kind: 'datatable', config: { datatableId: 'dt1' } }), env: { enumerate: items('a'), dataVersion: 0, relatedTables: 'x' } },
    datatableVersionUnknown: { source: source({ kind: 'datatable', config: { datatableId: 'dt1' } }), env: { enumerate: items('a'), dataVersion: null } },
    datatableWithoutId: { source: source({ kind: 'datatable', config: {} }), env: { enumerate: items('a') } },
    datatableNoConfig: { source: source({ kind: 'datatable', config: null }), env: { enumerate: items('a') } },
    datatableVersionFails: { source: source({ kind: 'datatable', config: { datatableId: 'dt1' } }), env: { enumerate: items('a'), dataVersionThrows: true } },
    datatableCancelled: { source: source({ kind: 'datatable', config: { datatableId: 'dt1' } }), env: { enumerate: items('a'), cancelAfter: 0, dataVersion: 3 } },
    datatableTruncated: { source: source({ kind: 'datatable', config: { datatableId: 'dt1' } }), opts: { maxItems: 1 }, env: { enumerate: items('a', 'b'), dataVersion: 3 } },
    datatableVersionThenCursor: { source: source({ kind: 'datatable', config: { datatableId: 'dt1' } }), env: { enumerate: items('a'), dataVersion: 4, precheck: { changed: true, cursor: 'c8' } } },
    tableIdOnAnotherKind: { source: source({ config: { datatableId: 'dt1' } }), env: { enumerate: items('a'), dataVersion: 4 } },
    cursorSaved: { env: { precheck: { changed: true, cursor: 'c5' }, enumerate: items('a') } },
    cursorSaveFails: { env: { precheck: { changed: true, cursor: 'c6' }, enumerate: items('a'), cursorThrows: true } },
    cursorNotAfterAFailure: { env: { precheck: { changed: true, cursor: 'c7' }, enumerate: items('a'), fetchThrows: 'a' } },
    manualSource: { source: source({ refreshMode: 'manual' }), env: { enumerate: items('a') } },
    cronSource: { source: source({ refreshCron: '0 6 * * 1', refreshTz: 'Europe/Amsterdam' }), env: { enumerate: items('a') } },
    reasonAndLogFromCaller: { opts: { reason: 'manual' }, env: { enumerate: items('a'), stored: [doc('d0', null)] } },
};

/**
 * @param {Record<string, any>} env
 * @param {unknown[][]} calls
 */
function wiring(env, calls) {
    const brief = (/** @type {unknown} */ value) => JSON.parse(JSON.stringify(value === undefined ? '<undefined>' : value, (k, v) => {
        if (v === undefined) return '<undefined>';
        if (typeof v === 'function') return '<function>';
        if (v && typeof v === 'object' && v.type === 'Buffer' && Array.isArray(v.data)) return `<buffer ${v.data.length}>`;
        if (v && typeof v === 'object' && v.source && typeof v.deadline === 'number') {
            return { ctx: { tenantId: v.tenantId, kbId: v.kbId, reason: v.reason, maxItems: v.maxItems, deadline: v.deadline - NOW, partial: v.partial, relatedTables: v.relatedTables } };
        }
        if (v && typeof v === 'object' && v.kbStore && v.helpers) return '<deps>';
        if (Array.isArray(v) && v.length > 12 && k !== '') return [`<${v.length} items>`, v[0], v[v.length - 1]];
        return v;
    }));
    const record = (/** @type {string} */ name, /** @type {unknown[]} */ ...args) => { calls.push([name, ...brief([null, ...args]).slice(1)]); };
    const stored = env.stored || [];
    let cancelChecks = 0;
    const deps = {
        kbStore: {
            getKB: async (/** @type {string} */ id) => { record('kb.getKB', id); return 'kb' in env ? env.kb : KB; },
            listDocuments: async (/** @type {string} */ kbId, /** @type {{ limit: number, offset: number }} */ q) => {
                record('kb.listDocuments', kbId, q);
                return stored.slice(q.offset, q.offset + q.limit);
            },
            bumpKBVersion: async (/** @type {string} */ id) => { record('kb.bumpKBVersion', id); },
            replaceDocumentContent: async (/** @type {unknown[]} */ ...a) => { record('kb.replaceDocumentContent', ...a); },
        },
        kbSourcesStore: {
            isCancelRequested: async (/** @type {string} */ id) => {
                cancelChecks += 1;
                const cancelled = env.cancelAfter !== undefined && cancelChecks > env.cancelAfter;
                record('sources.isCancelRequested', id, cancelled);
                return cancelled;
            },
            setSeenDataVersion: async (/** @type {unknown[]} */ ...a) => { record('sources.setSeenDataVersion', ...a); },
            setSyncCursor: async (/** @type {unknown[]} */ ...a) => { record('sources.setSyncCursor', ...a); if (env.cursorThrows) throw new Error('cursor write failed'); },
        },
        helpers: {
            ingestDocument: async (/** @type {any[]} */ ...a) => {
                record('helpers.ingestDocument', ...a);
                if (env.ingestThrows === a[6].externalId) throw new Error('embedding failed');
                return 'ingest' in env ? env.ingest : { document: { id: `new_${a[6].externalId}` }, status: 'processed' };
            },
            reingestDocument: async (/** @type {unknown[]} */ ...a) => {
                record('helpers.reingestDocument', ...a);
                if (env.reingestThrows) throw new Error('embedding failed');
                return 'reingest' in env ? env.reingest : { status: 'processed' };
            },
            deleteDocumentChunks: async (/** @type {any[]} */ ...a) => {
                record('helpers.deleteDocumentChunks', ...a);
                if (env.deleteThrows === a[1]) throw new Error('delete failed');
            },
        },
        datatableStore: {
            getDataVersion: async (/** @type {string} */ id) => {
                record('datatables.getDataVersion', id);
                if (env.dataVersionThrows) throw new Error('table gone');
                return 'dataVersion' in env ? env.dataVersion : 1;
            },
        },
        extractSummary: {
            summarise: async (/** @type {any} */ a) => {
                record('summarise', a);
                if (env.summariseThrows && a.title === 'a') throw new Error('rate limited');
                return 'summary' in env ? env.summary : { summary: `about ${a.title}` };
            },
        },
        keepOriginal: async (/** @type {unknown} */ a) => { record('keepOriginal', a); if (env.keepThrows) throw new Error('storage down'); return env.keep || { kept: true }; },
        deleteOriginal: async (/** @type {unknown} */ a) => { record('deleteOriginal', a); },
    };
    const adapter = {
        enumerate: async (/** @type {any} */ s, /** @type {any} */ ctx, /** @type {unknown} */ d) => {
            record('adapter.enumerate', s.id, ctx, d);
            if (env.enumerateThrows) throw new Error('listing failed');
            if (env.partial) ctx.partial = true;
            if ('relatedTables' in env) ctx.relatedTables = env.relatedTables;
            return 'enumerate' in env ? env.enumerate : [];
        },
        isUnchanged: (/** @type {any} */ item, /** @type {any} */ storedDoc) => {
            record('adapter.isUnchanged', item, storedDoc.id);
            if (env.unchangedThrows) throw new Error('bad stamp');
            return env.unchangedIds ? env.unchangedIds.includes(String(item.externalId)) : !!env.unchanged;
        },
        fetch: async (/** @type {any} */ item, /** @type {any} */ storedDoc, /** @type {unknown} */ ctx, /** @type {unknown} */ d) => {
            record('adapter.fetch', item, storedDoc && storedDoc.id, ctx, d);
            if (env.fetchThrows === String(item.externalId)) throw new Error('fetch failed');
            const id = String(item.externalId);
            return env.fetched && id in env.fetched ? env.fetched[id] : { content: `fresh ${id}`, title: id };
        },
        ...('dedupe' in env ? { dedupe: env.dedupe } : {}),
        ...('maxItems' in env ? { maxItems: env.maxItems } : {}),
        ...('precheck' in env || env.precheckThrows ? {
            precheck: async (/** @type {any} */ s, /** @type {unknown} */ ctx, /** @type {unknown} */ d) => {
                record('adapter.precheck', s.id, ctx, d);
                if (env.precheckThrows) throw new Error('etag unavailable');
                return env.precheck;
            },
        } : {}),
    };
    return { deps, adapter, log: (/** @type {unknown[]} */ ...a) => record('log', ...a) };
}

/** @param {string} name */
async function runCase(name) {
    const c = CASES[name];
    const env = c.env || {};
    /** @type {unknown[][]} */
    const calls = [];
    const { deps, adapter, log } = wiring(env, calls);
    const opts = { ...(c.opts || {}), deps, log, ...(env.noAdapter ? {} : { adapter }) };
    try {
        return { result: await syncSource(c.source || source(), opts), calls };
    } catch (err) {
        return { threw: /** @type {Error} */ (err).message, calls };
    }
}

test('syncSource: counters and every call of the pass per scenario match the golden file', async () => {
    /** @type {Record<string, unknown>} */
    const actual = {};
    for (const name of Object.keys(CASES)) actual[name] = await runCase(name);
    const text = `${JSON.stringify(actual, null, 1)}\n`;
    if (process.env.UPDATE_GOLDEN === '1') fs.writeFileSync(GOLDEN, text);
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const name of Object.keys(CASES)) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(actual[name])), golden[name], `scenario ${name}`);
    }
    assert.deepStrictEqual(Object.keys(golden), Object.keys(CASES));
});

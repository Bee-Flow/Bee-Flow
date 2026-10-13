'use strict';

/**
 * knowledgeBases — the golden behaviour, pinned before the store was split
 * into stores/kb/ (model, schema, catalog, access, documents, favorites,
 * versions) behind the knowledgeBases barrel.
 *
 * '../db' (the DDL runner, stores/lib/_ddl.js, sends through it too), the
 * stage write guard, the kbSources schema hook
 * and solutionStageStore are swapped for recording doubles BEFORE the barrel
 * is required. Every statement the store sends (run / getOne / getAll / exec /
 * the DDL batches) and every guard call lands in ONE ordered trace, with each public
 * function's return value or error next to it. The trace is compared with
 * knowledgeBases.characterisation.golden.json: a pure move must leave the boot
 * DDL order, every statement, every bind and every answer exactly as is. The
 * export surface (keys, their order and types) is pinned too, and so is the
 * self-dispatch: a method replaced on the exported object is what the other
 * methods call (tests and callers swap getKB, snapshotDocumentVersion, ...).
 *
 * Regenerate (only for a deliberate behaviour change):
 *   UPDATE_GOLDEN=1 node --test stores/knowledgeBases.characterisation.test.js
 *
 * Run: cd server && node --test stores/knowledgeBases.characterisation.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.NODE_ENV = 'test';

const { installResolveStub } = require('../testUtils/stubRequire');
const realParts = require('./lib/managedParts');

const GOLDEN = path.join(__dirname, 'knowledgeBases.characterisation.golden.json');

const TRACE = [];
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const rec = (via, sql, params) => TRACE.push({ via, sql: norm(sql), params: params === undefined ? null : params });

const KB_ID = '11111111-1111-4111-8111-111111111111';
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const KB_ROW = { id: KB_ID, tenant_id: 'alice', name: 'Base', description: 'd', category_id: 'cat', icon: null, usage_contexts: ['agent'], organization_id: 'orgA' };
const DOC_ROW = { id: DOC_ID, knowledge_base_id: KB_ID, tenant_id: 'alice', title: 'T', source_type: 'text', source_uri: 'u', content_hash: 'h', original_content: 'secret body' };

// Canned answers per statement shape; `fail` makes the next matching statement throw.
let fail = null;
function answer(sql) {
    if (fail && fail.test(sql)) { fail = null; throw new Error('boom'); }
    if (/information_schema\.columns/.test(sql)) return null;
    if (/^SELECT knowledge_base_id FROM documents/.test(sql)) return { knowledge_base_id: KB_ID };
    if (/^SELECT \* FROM knowledge_bases WHERE id/.test(sql)) return { ...KB_ROW };
    if (/COALESCE\(MAX\(version_number\)/.test(sql)) return { v: 4 };
    if (/^SELECT original_content/.test(sql)) return { original_content: 'body' };
    if (/^SELECT COUNT\(\*\)::int AS n/.test(sql)) return { n: 7 };
    if (/document_count_all/.test(sql) && /FROM documents WHERE knowledge_base_id/.test(sql)) return { document_count: '3', document_count_all: 5, total_chunks: null };
    if (/GROUP BY source_id/.test(sql)) return [{ source_id: 's1', document_count: 2, processed_count: '1', redacted_count: 0, skipped_count: 1, error_count: 0, duplicate_count: 0, pii_found_count: 1, total_chunks: 9 }];
    if (/^SELECT kb_id FROM kb_favorites/.test(sql)) return [{ kb_id: 'k1' }, { kb_id: 'k2' }];
    if (/FROM documents WHERE id = \$1/.test(sql) && /^SELECT id, tenant_id/.test(sql)) return { ...DOC_ROW };
    if (/external_id = \$2/.test(sql)) return [{ id: 'e1' }, { id: 'e2' }];
    if (/content_hash = \$2/.test(sql)) return { id: 'canon', title: 'C', source_id: null, status: 'processed' };
    if (/^DELETE FROM kb_document_versions/.test(sql)) return { rowCount: 6 };
    return undefined;
}
const shape = (sql, kind, params) => {
    const a = answer(norm(sql), params);
    if (kind === 'getOne') return a === undefined ? { echo: params ?? null } : (Array.isArray(a) ? a[0] : a);
    if (kind === 'getAll') return a === undefined ? [] : (Array.isArray(a) ? a : [a]);
    if (kind === 'run') return a && a.rowCount !== undefined ? a : { rowCount: 1, rows: [] };
    return undefined;
};
const db = {
    run: async (sql, params) => { rec('run', sql, params); return shape(sql, 'run', params); },
    getOne: async (sql, params) => { rec('getOne', sql, params); return shape(sql, 'getOne', params); },
    getAll: async (sql, params) => { rec('getAll', sql, params); return shape(sql, 'getAll', params); },
    exec: async (sql) => { rec('exec', sql); return undefined; },
    getClient: async () => null,
};
let managed = null; // { contentMode, stageProjectId } for every base, or null
const partsStub = {
    changedKeysOf: realParts.changedKeysOf,
    managedInfoForKb: async (kbId) => { TRACE.push({ guard: 'managedInfoForKb', kbId }); return managed; },
    assertManagedWrite: async (args) => {
        TRACE.push({ guard: 'assertManagedWrite', args });
        if (!args.managedWrite) { const e = new Error('managed'); e.status = 409; e.code = 'managed_part'; throw e; }
    },
};
const sourcesStub = { ensureSchema: async () => { TRACE.push({ hook: 'kbSources.ensureSchema' }); } };
const stageStub = { managedPayloadFor: async (args) => { TRACE.push({ hook: 'managedPayloadFor', args }); return { stage: 'uat' }; } };

const restore = installResolveStub({
    '../db': db,
    './managedPartsDefault': partsStub,
    './kbSources': sourcesStub,
    './solutionStageStore': stageStub,
});
const store = require('./knowledgeBases');
after(() => restore());

async function step(name, fn) {
    TRACE.push({ step: name });
    try {
        const out = await fn();
        TRACE.push({ result: out === undefined ? '<undefined>' : JSON.parse(JSON.stringify(out)) });
    } catch (e) {
        TRACE.push({ threw: { message: e.message, code: e.code ?? null, status: e.status ?? null } });
    }
}

test('golden trace of every public path', async () => {
    TRACE.push({ step: 'exports', surface: Object.entries(store).map(([k, v]) => [k, Array.isArray(v) ? 'array' : typeof v]) });
    TRACE.push({ step: 'constants', DOC_STATUSES: store.DOC_STATUSES, ACTIVE_DOC_STATUSES: store.ACTIVE_DOC_STATUSES, PII_STATUSES: store.PII_STATUSES, DOCUMENT_COLUMNS: store.DOCUMENT_COLUMNS, frozen: [Object.isFrozen(store.DOC_STATUSES), Object.isFrozen(store.DOCUMENT_COLUMNS)] });

    await step('initDB', () => store.initDB());
    await step('whenReady (memoised)', () => store.whenReady());

    // ── KB CRUD ──
    await step('createKB defaults', () => store.createKB('alice', 'Base'));
    await step('createKB extra', () => store.createKB('alice', 'Sys', 'x', 'orgA', { sourceKind: 'system_managed', usageContexts: ['webpage'], categoryId: 'c', icon: 'i', systemSlug: 'nl-law' }));
    await step('getSystemKBBySlug empty', () => store.getSystemKBBySlug(''));
    await step('getSystemKBBySlug', () => store.getSystemKBBySlug('nl-law'));
    await step('listSystemKBs', () => store.listSystemKBs());
    await step('isSystemKB', () => [store.isSystemKB({ source_kind: 'system_managed' }), store.isSystemKB(null), store.isSystemKB({ source_kind: 'manual' })]);
    await step('isProjectFilesKB', () => [store.isProjectFilesKB({ source_kind: 'project_files' }), store.isProjectFilesKB(undefined)]);
    await step('listKBs legacy', () => store.listKBs('alice'));
    await step('listKBs legacy filters+system', () => store.listKBs('alice', undefined, { sourceKind: ['manual', 'x'], usageContext: 'agent', excludeContext: 'webpage', systemSlugs: ['nl-law'] }));
    await step('listKBs super admin', () => store.listKBs('alice', null));
    await step('listKBs super admin all kinds', () => store.listKBs('alice', null, { sourceKind: null }));
    await step('listKBs super admin system', () => store.listKBs('alice', null, { sourceKind: null, systemSlugs: ['s'], usageContext: 'agent' }));
    await step('listKBs no org', () => store.listKBs('alice', new Set(), { excludeContext: 'webpage' }));
    await step('listKBs org member', () => store.listKBs('alice', new Set(['orgA', 'orgB']), { usageContext: 'direct_chat', systemSlugs: ['s'] }));
    await step('listKBs org admin', () => store.listKBs('alice', new Set(['orgA']), { isOrgAdmin: true, sourceKind: null }));

    // ── access ──
    const kbs = [
        { id: 'own', tenant_id: 'alice', is_published: false },
        { id: 'sys', source_kind: 'system_managed' },
        { id: 'pf', source_kind: 'project_files', tenant_id: 'bob', organization_id: 'orgA', is_published: true },
        { id: 'pfOwn', source_kind: 'project_files', tenant_id: 'alice' },
        { id: 'draft', tenant_id: 'bob', organization_id: 'orgA', is_published: false },
        { id: 'pub', tenant_id: 'bob', organization_id: 'orgA', is_published: true, shared_groups: '[]' },
        { id: 'grp', tenant_id: 'bob', organization_id: 'orgA', is_published: true, shared_groups: '["g1"]' },
        { id: 'badgrp', tenant_id: 'bob', organization_id: 'orgA', is_published: true, shared_groups: 'not json' },
        { id: 'other', tenant_id: 'bob', organization_id: 'orgB', is_published: true },
        { id: 'personal', tenant_id: 'bob', organization_id: null, is_published: true },
    ];
    const ids = (list) => list.map(k => k.id);
    await step('filterByGroupAccess non-array', () => store.filterByGroupAccess(null, 'alice'));
    await step('filterByGroupAccess member', () => ids(store.filterByGroupAccess(kbs, 'alice', ['g1'], { orgIds: new Set(['orgA']) })));
    await step('filterByGroupAccess no groups', () => ids(store.filterByGroupAccess(kbs, 'alice')));
    await step('filterByGroupAccess org admin', () => ids(store.filterByGroupAccess(kbs, 'alice', [], { orgIds: new Set(['orgA']), isOrgAdmin: true })));
    await step('filterByGroupAccess super admin', () => ids(store.filterByGroupAccess(kbs, 'alice', [], { orgIds: null })));
    await step('canUserAccessKB null', () => store.canUserAccessKB(null, 'alice'));
    await step('canUserManageKB matrix', () => kbs.flatMap(kb => [
        store.canUserManageKB(kb, 'alice', new Set(['orgA']), true),
        store.canUserManageKB(kb, 'alice', new Set(['orgA']), false),
        store.canUserManageKB(kb, 'alice', null, false),
        store.canUserManageKB(kb, 'alice', undefined, true),
    ]).concat([store.canUserManageKB(null, 'alice', null, true)]));
    // Self-dispatch: filterByGroupAccess calls the exported canUserAccessKB.
    await step('filterByGroupAccess self-dispatch', () => {
        const orig = store.canUserAccessKB;
        store.canUserAccessKB = (kb) => kb.id === 'other';
        try { return ids(store.filterByGroupAccess(kbs, 'alice')); } finally { store.canUserAccessKB = orig; }
    });

    await step('getKB bad id', () => store.getKB('nope'));
    await step('getKB empty', () => store.getKB(null));
    await step('getKB', () => store.getKB(KB_ID));
    await step('updateKB unmanaged', () => store.updateKB(KB_ID, { name: 'N', categoryId: null, usageContexts: ['agent'], organizationId: 'orgB' }));
    await step('updateKB unmanaged no changes', () => store.updateKB(KB_ID, {}));
    managed = { contentMode: 'shell', stageProjectId: 'p-uat' };
    await step('updateKB managed refused', () => store.updateKB(KB_ID, { name: 'Other', icon: null, categoryId: null }));
    await step('updateKB managed same values', () => store.updateKB(KB_ID, { name: 'Base', description: null }));
    await step('updateKB managed with capability', () => store.updateKB(KB_ID, { description: 'new' }, { managedWrite: { deploymentId: 'd1' } }));
    await step('updateKB managed self-dispatch getKB', async () => {
        const orig = store.getKB;
        store.getKB = async () => null;
        try { return await store.updateKB(KB_ID, { name: 'X' }); } finally { store.getKB = orig; }
    });
    managed = null;
    await step('setPublished keep groups', () => store.setPublished(KB_ID, 1));
    await step('setPublished groups', () => store.setPublished(KB_ID, false, ['g1']));
    await step('setPublished non-array groups', () => store.setPublished(KB_ID, true, 'g1'));
    await step('listKBCategories personal', () => store.listKBCategories(null));
    await step('listKBCategories org', () => store.listKBCategories('orgA'));
    await step('createKBCategory', () => store.createKBCategory({ id: 'c1', name: 'Cat' }));
    await step('deleteKBCategory', () => store.deleteKBCategory('c1'));
    await step('assertKbWrite unmanaged', () => store.assertKbWrite(KB_ID, ['delete']));
    await step('assertKbWrite no keys', () => store.assertKbWrite(KB_ID, []));
    managed = { contentMode: 'carry', stageProjectId: 'p-prd' };
    await step('assertKbWrite carry refused', () => store.assertKbWrite(KB_ID, ['name']));
    await step('assertKbWrite carry ok', () => store.assertKbWrite(KB_ID, ['name'], { deploymentId: 'd' }, { carryOnly: true }));
    await step('managedPayload', () => store.managedPayload(KB_ID));
    await step('deleteKB managed refused', () => store.deleteKB(KB_ID));
    managed = { contentMode: 'shell', stageProjectId: 'p-uat' };
    await step('assertKbWrite carryOnly on shell', () => store.assertKbWrite(KB_ID, ['documents'], null, { carryOnly: true }));
    managed = null;
    await step('managedPayload empty id', () => store.managedPayload(''));
    await step('managedPayload unmanaged', () => store.managedPayload(KB_ID));
    await step('deleteKB', () => store.deleteKB(KB_ID));
    fail = /^UPDATE projects/;
    await step('deleteKB projects missing', () => store.deleteKB(KB_ID));
    await step('bumpKBVersion', () => store.bumpKBVersion(KB_ID));

    // ── documents ──
    await step('createDocument legacy', () => store.createDocument('alice', KB_ID, 'T', 'text', 'u', 'h'));
    await step('createDocument extra', () => store.createDocument('alice', KB_ID, 'T', 'file', 'u', 'h', 3, { a: 1 }, '42', {
        sourceId: 's1', externalId: 9, sourceModifiedAt: '2026-01-01', sizeBytes: '12', pageCount: 'x', sheetCount: '', mime: 'm',
        createdBy: 'alice', status: 'redacted', statusReason: 'r'.repeat(600), extractSummary: 'sum', piiStatus: 'found', piiCategories: ['email'], overlapsDocumentId: 'o',
    }));
    await step('createDocument bad status', () => store.createDocument('alice', KB_ID, 'T', 'text', 'u', 'h', 0, null, null, { status: 'nope', piiStatus: 'nope' }));
    managed = { contentMode: 'carry', stageProjectId: 'p-prd' };
    await step('createDocument carried refused', () => store.createDocument('alice', KB_ID, 'T', 'text', 'u', 'h'));
    await step('recordDuplicate carried ok', () => store.recordDuplicate('alice', KB_ID, 'T', 'text', 'u', 'h', 'canon', null, { managedWrite: { deploymentId: 'd' } }));
    await step('replaceDocumentContent carried refused', () => store.replaceDocumentContent(DOC_ID, { title: 'x' }));
    await step('deleteDocument carried refused', () => store.deleteDocument(DOC_ID));
    managed = null;
    await step('recordDuplicate', () => store.recordDuplicate('alice', KB_ID, 'T', 'text', 'u', 'h', 'canon', { m: 1 }, { statusReason: 'dup', sourceId: 's', externalId: 0, createdBy: 'a', sizeBytes: 5, mime: 'm' }));
    await step('recordDuplicate null extra', () => store.recordDuplicate('alice', KB_ID, 'T', 'text', 'u', 'h', 'canon', null, null));
    await step('findNearDuplicateBySimhash null', () => store.findNearDuplicateBySimhash(KB_ID, null));
    await step('findNearDuplicateBySimhash', () => store.findNearDuplicateBySimhash(KB_ID, '99'));
    await step('updateDocumentStatus bad', () => store.updateDocumentStatus(DOC_ID, { status: 'nope' }));
    await step('updateDocumentStatus', () => store.updateDocumentStatus(DOC_ID, { status: 'error', statusReason: 'why', chunkCount: '4' }));
    await step('replaceDocumentContent empty', () => store.replaceDocumentContent(DOC_ID));
    await step('replaceDocumentContent bad id', () => store.replaceDocumentContent('not-a-uuid', { title: 'x' }));
    await step('replaceDocumentContent full', () => store.replaceDocumentContent(DOC_ID, {
        title: 'x', contentHash: 'h2', simhash: '1', duplicateOf: null, chunkCount: '5', sizeBytes: 'bad', pageCount: 2, sheetCount: null,
        mime: 'm', sourceModifiedAt: 'd', externalId: 7, status: 'zzz', statusReason: '', extractSummary: 's', piiStatus: 'none',
        piiCategories: null, overlapsDocumentId: 'o', metadata: { a: 1 }, id: 'ignored', unknown: 1, managedWrite: null,
    }));
    await step('findDocumentsBySourceExternalId none', () => store.findDocumentsBySourceExternalId(null, 'x'));
    await step('findDocumentsBySourceExternalId', () => store.findDocumentsBySourceExternalId('s1', 12));
    await step('findDocumentBySourceExternalId', () => store.findDocumentBySourceExternalId('s1', 12));
    await step('findDocumentBySourceExternalId self-dispatch', async () => {
        const orig = store.findDocumentsBySourceExternalId;
        store.findDocumentsBySourceExternalId = async () => [];
        try { return await store.findDocumentBySourceExternalId('s1', 12); } finally { store.findDocumentsBySourceExternalId = orig; }
    });
    await step('countsBySource empty', () => store.countsBySource([null, '']));
    await step('countsBySource', () => store.countsBySource(['s1', 's1', 's2']));
    await step('countDocumentsByStatus', () => store.countDocumentsByStatus(KB_ID));
    await step('listDocuments', () => store.listDocuments(KB_ID));
    await step('listDocuments filters', () => store.listDocuments(KB_ID, { limit: 5, offset: 10, filters: {
        sender: 'bob', threadId: 't', hasAttachment: true, dateFrom: 'a', dateTo: 'b', sourceType: 'email', sourceId: 's', noSource: true,
        status: 'processed, error,bogus', pii: 'found', q: '50%_off\\',
    } }));
    await step('listDocuments status array + exact pii', () => store.listDocuments(KB_ID, { filters: { status: ['skipped'], pii: 'none' } }));
    await step('listDocuments bad status + bad pii', () => store.listDocuments(KB_ID, { filters: { status: 'bogus', pii: 'weird' } }));
    await step('countDocuments', () => store.countDocuments(KB_ID, { sourceId: 's' }));
    await step('listThreads', () => store.listThreads(KB_ID));
    await step('listThreads limit', () => store.listThreads(KB_ID, { limit: 3 }));
    await step('listDocumentsByThread', () => store.listDocumentsByThread(KB_ID, 't'));
    await step('getDocument bad', () => store.getDocument('x'));
    await step('getDocument', () => store.getDocument(DOC_ID));
    await step('getDocumentOriginalContent', () => store.getDocumentOriginalContent(DOC_ID));
    await step('deleteDocument', () => store.deleteDocument(DOC_ID, { deletedBy: 'alice' }));
    await step('deleteDocument skip snapshot, bad id', () => store.deleteDocument('x', { skipSnapshot: true }));
    await step('deleteDocument self-dispatch snapshot throws', async () => {
        const orig = store.snapshotDocumentVersion;
        store.snapshotDocumentVersion = async (id, by) => { TRACE.push({ swapped: 'snapshotDocumentVersion', id, by }); throw new Error('snap'); };
        try { return await store.deleteDocument(DOC_ID); } finally { store.snapshotDocumentVersion = orig; }
    });
    await step('updateDocumentSourceUri', () => store.updateDocumentSourceUri(DOC_ID, 'new'));
    await step('hasContentHash', () => store.hasContentHash(KB_ID, 'h'));
    await step('hasContentHash self-dispatch', async () => {
        const orig = store.findDocumentByContentHash;
        store.findDocumentByContentHash = async () => null;
        try { return await store.hasContentHash(KB_ID, 'h'); } finally { store.findDocumentByContentHash = orig; }
    });
    await step('findDocumentByContentHash none', () => store.findDocumentByContentHash(KB_ID, ''));
    await step('findDocumentBySourceUri none', () => store.findDocumentBySourceUri(null, 'u'));
    await step('findDocumentBySourceUri', () => store.findDocumentBySourceUri(KB_ID, 'u'));
    await step('updateChunkCount', () => store.updateChunkCount(DOC_ID, 8));
    await step('hashContent', () => store.hashContent('hello'));

    // ── favorites ──
    await step('listFavorites', () => store.listFavorites('alice'));
    await step('addFavorite', () => store.addFavorite('alice', KB_ID));
    await step('removeFavorite', () => store.removeFavorite('alice', KB_ID));

    // ── versions ──
    await step('snapshotKBVersion', () => store.snapshotKBVersion(KB_ID, 'alice', 'rename'));
    fail = /^SELECT \* FROM knowledge_bases WHERE id/;
    await step('snapshotKBVersion failing', () => store.snapshotKBVersion(KB_ID));
    await step('listKBVersions', () => store.listKBVersions(KB_ID));
    await step('listKBVersions paged', () => store.listKBVersions(KB_ID, { limit: 2, offset: 4 }));
    await step('getKBVersion', () => store.getKBVersion(KB_ID, 2));
    await step('snapshotDocumentVersion', () => store.snapshotDocumentVersion(DOC_ID, 'alice'));
    fail = /^INSERT INTO kb_document_versions/;
    await step('snapshotDocumentVersion failing', () => store.snapshotDocumentVersion(DOC_ID));
    await step('pruneDocumentVersions', () => store.pruneDocumentVersions());
    await step('pruneDocumentVersions args', () => store.pruneDocumentVersions('x', '-5'));
    await step('listDeletedDocuments', () => store.listDeletedDocuments(KB_ID));
    await step('listDeletedDocuments limit', () => store.listDeletedDocuments(KB_ID, { limit: 3 }));

    const actual = JSON.parse(JSON.stringify(TRACE));
    if (process.env.UPDATE_GOLDEN) {
        fs.writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 1)}\n`);
        return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    assert.strictEqual(actual.length, golden.length, 'same number of trace entries');
    for (let i = 0; i < golden.length; i++) assert.deepStrictEqual(actual[i], golden[i], `trace entry ${i}`);
});

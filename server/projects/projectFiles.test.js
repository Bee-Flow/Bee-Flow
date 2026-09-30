'use strict';

/**
 * Project files (projects/projectFiles.js), with every collaborator injected:
 * an in-memory knowledge-base store and project store, and recording fakes
 * for the ingestion helpers and the Privacy Shield. No module mocking.
 *
 * Proven:
 *   - the first upload creates ONE files base (project owner, project org,
 *     kind project_files, "<project> · Files"), records it race-safely and
 *     lists it in knowledge_base_ids with a compare-and-swap; a lost race
 *     deletes its own base and uses the winner's;
 *   - a file is accepted as `processing` and then extracted, screened BEFORE
 *     it is hashed, deduplicated and embedded under the same row;
 *   - a redaction is stored as redacted; a hold is a failed file with the
 *     policy's reason and nothing embedded; an extraction failure and a
 *     duplicate are failed files with a reason; a row that stalled is failed;
 *   - a file removed while processing has its chunks purged;
 *   - removing a file only ever touches this project's files base;
 *   - a recorded id that is not this project's files base is refused;
 *   - the per-project file cap; deleting the whole base with its chunks.
 *
 * Run: cd server && node --test projects/projectFiles.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { makeProjectFiles, QUEUED_REASON, STALE_AFTER_MS, toFile, cleanName } = require('./projectFiles');
const { friendlyError } = require('../core/kb/friendlyError');

const uuid = () => crypto.randomUUID();
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** An in-memory world: projects, knowledge bases, documents, and a call log. */
function world({ projects = {}, now = Date.parse('2026-09-29T12:00:00Z') } = {}) {
    const calls = [];
    const kbs = new Map();
    const docs = new Map();
    const projectRows = new Map(Object.entries(projects).map(([id, p]) => [id, {
        id, name: 'Launch', ownerId: 'u_owner', organizationId: 'org1', knowledgeBaseIds: [],
        filesKbId: null, version: 3, kind: 'workspace', ...p,
    }]));
    const state = { setFilesKbIdOverride: null, conflictsLeft: 0, shield: { outcome: 'pass' }, extractFails: false, afterReingest: null };

    const kbStore = {
        async createKB(tenantId, name, description, organizationId, extra) {
            const kb = { id: uuid(), tenant_id: tenantId, name, description, organization_id: organizationId, source_kind: extra.sourceKind, usage_contexts: extra.usageContexts };
            kbs.set(kb.id, kb);
            calls.push(['createKB', kb]);
            return kb;
        },
        async getKB(id) { return kbs.get(id) || null; },
        async deleteKB(id) { calls.push(['deleteKB', id]); kbs.delete(id); for (const [k, d] of docs) if (d.knowledge_base_id === id) docs.delete(k); },
        async createDocument(tenantId, kbId, title, sourceType, sourceUri, contentHash, chunkCount, metadata, simhash, x) {
            const doc = {
                id: uuid(), tenant_id: tenantId, knowledge_base_id: kbId, title, source_type: sourceType, source_uri: sourceUri,
                content_hash: contentHash, chunk_count: chunkCount, status: x.status, status_reason: x.statusReason || null,
                source_id: x.sourceId, external_id: x.externalId, size_bytes: x.sizeBytes, mime: x.mime, created_by: x.createdBy,
                pii_status: 'unscanned', created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
            };
            docs.set(doc.id, doc);
            return { ...doc };
        },
        async getDocument(id) { const d = docs.get(id); return d ? { ...d } : null; },
        async listDocuments(kbId) { return [...docs.values()].filter(d => d.knowledge_base_id === kbId).reverse().map(d => ({ ...d })); },
        async countDocuments(kbId) { return [...docs.values()].filter(d => d.knowledge_base_id === kbId).length; },
        async updateDocumentStatus(id, { status, statusReason }) {
            const d = docs.get(id); if (!d) return null;
            Object.assign(d, { status, status_reason: statusReason || null, chunk_count: 0 });
            return { ...d };
        },
        async replaceDocumentContent(id, patch) {
            const d = docs.get(id); if (!d) return null;
            calls.push(['replaceDocumentContent', id, patch]);
            if (patch.status) d.status = patch.status;
            if ('statusReason' in patch) d.status_reason = patch.statusReason;
            if (patch.piiStatus) d.pii_status = patch.piiStatus;
            return { ...d };
        },
        async findDocumentByContentHash(kbId, h) {
            return [...docs.values()].find(d => d.knowledge_base_id === kbId && d.content_hash === h
                && (d.status === 'processed' || d.status === 'redacted')) || null;
        },
        hashContent: hash,
        async snapshotDocumentVersion(id, by) { calls.push(['snapshot', id, by]); },
    };

    const projectStore = {
        async getProject(id) { const p = projectRows.get(id); return p ? { ...p, knowledgeBaseIds: [...p.knowledgeBaseIds] } : null; },
        async setFilesKbId(projectId, kbId, opts) {
            calls.push(['setFilesKbId', projectId, kbId, opts]);
            const p = projectRows.get(projectId); if (!p) return null;
            if (state.setFilesKbIdOverride) { p.filesKbId = state.setFilesKbIdOverride; return p.filesKbId; }
            if (p.filesKbId === null || (opts && opts.expected === p.filesKbId)) p.filesKbId = kbId;
            return p.filesKbId;
        },
        async updateProject(id, updates, { expectedVersion }) {
            calls.push(['updateProject', id, updates, expectedVersion]);
            const p = projectRows.get(id); if (!p) return null;
            if (state.conflictsLeft > 0) { state.conflictsLeft -= 1; p.version += 1; return { conflict: true }; }
            if (p.version !== expectedVersion) return { conflict: true };
            Object.assign(p, updates, { version: p.version + 1 });
            return { ...p };
        },
    };

    const helpers = {
        async extractFileContentWithMeta(buffer, mime, name) {
            calls.push(['extract', name]);
            if (state.extractFails) throw new Error('Unsupported file type: image/png');
            return { text: buffer.toString('utf8'), meta: { pageCount: 2, pages: [{ pageNumber: 1, text: 'p1' }] } };
        },
        async reingestDocument(tenantId, kbId, docId, text, opts) {
            calls.push(['reingest', { tenantId, kbId, docId, text, opts }]);
            const d = docs.get(docId);
            if (!d) throw Object.assign(new Error('Document not found'), { code: 'NOT_FOUND' });
            Object.assign(d, { status: opts.status, status_reason: null, content_hash: hash(text), chunk_count: 3, pii_status: opts.piiStatus || d.pii_status });
            const result = { document: { ...d }, chunks: 3, status: opts.status };
            if (state.afterReingest) await state.afterReingest(docId);
            return result;
        },
        async purgeDocumentChunks(kbId, docId) { calls.push(['purge', kbId, docId]); },
        async deleteDocumentChunks(kbId, docId, tenantId, opts) { calls.push(['deleteDocumentChunks', kbId, docId, tenantId, opts]); docs.delete(docId); },
        friendlyError,
    };

    const applyShield = async (p) => {
        calls.push(['shield', { orgId: p.orgId, userId: p.userId, text: p.text }]);
        const s = state.shield;
        if (s.outcome === 'redacted') return { outcome: 'redacted', text: p.text.replace(/Anna/g, '[person_1]'), piiStatus: 'redacted', piiCategories: ['Person'], reason: null };
        if (s.outcome === 'skipped') return { outcome: 'skipped', text: null, piiStatus: 'found', piiCategories: ['BSN'], reason: 'Contains personal data (BSN) and this organisation does not store it' };
        return { outcome: 'pass', text: p.text, piiStatus: 'none', piiCategories: null, reason: null };
    };

    const transients = [];
    const files = makeProjectFiles({
        kbStore, projectStore, helpers,
        // The real module's vocabulary (core/kb/ingestPrivacy OUTCOME).
        ingestPrivacy: { applyShield, OUTCOME: { PASS: 'pass', REDACTED: 'redacted', SKIPPED: 'skipped' } },
        ensureKbSource: async (kbId, kind) => ({ id: `src_${kind}_${kbId}` }),
        publishTransient: async (projectId, ev) => { transients.push([projectId, ev]); },
        resolveKbProvider: async () => 'remote',
        deleteChunksLocally: async (tenantId, kbId) => { calls.push(['deleteChunksLocally', tenantId, kbId]); },
        maxKbIds: 50,
        now: () => now,
        log: { info() {}, warn() {}, error() {} },
    });
    return { files, calls, kbs, docs, projectRows, state, transients, project: (id = 'p1') => projectStore.getProject(id) };
}

const upload = (text, name = 'plan.txt', mimetype = 'text/plain') => ({
    originalname: name, mimetype, size: Buffer.byteLength(text), buffer: Buffer.from(text),
});

async function addAndProcess(w, text, name) {
    const added = await w.files.addFile(await w.project(), upload(text, name), { userId: 'u_editor' });
    let status = null;
    await added.start({ onDone: (s) => { status = s; } });
    return { added, status };
}

test('the first upload creates one files base, records it and lists it on the project', async () => {
    const w = world({ projects: { p1: { knowledgeBaseIds: ['kb_attached'] } } });
    const { added, status } = await addAndProcess(w, 'The launch is in May.');

    const [, kb] = w.calls.find(c => c[0] === 'createKB');
    assert.strictEqual(kb.tenant_id, 'u_owner', 'owned by the project owner, not the uploader');
    assert.strictEqual(kb.organization_id, 'org1');
    assert.strictEqual(kb.source_kind, 'project_files');
    assert.strictEqual(kb.name, 'Launch · Files');
    assert.deepStrictEqual(kb.usage_contexts, ['agent', 'direct_chat']);

    const p = await w.project();
    assert.strictEqual(p.filesKbId, kb.id);
    assert.deepStrictEqual(p.knowledgeBaseIds, ['kb_attached', kb.id]);
    const cas = w.calls.find(c => c[0] === 'updateProject');
    assert.strictEqual(cas[3], 3, 'written against the version that was read');
    assert.deepStrictEqual(w.transients.map(([, ev]) => ev.kind), ['project_updated']);

    assert.strictEqual(added.file.status, 'processing');
    assert.strictEqual(added.file.uploadedBy, 'u_editor');
    assert.strictEqual(status, 'ready');
    const { files, kbId } = await w.files.listFiles(p);
    assert.strictEqual(kbId, kb.id);
    assert.deepStrictEqual(files.map(f => [f.name, f.status, f.redacted]), [['plan.txt', 'ready', false]]);
});

test('a second upload reuses the base and writes nothing to the project', async () => {
    const w = world({ projects: { p1: {} } });
    await addAndProcess(w, 'first file text');
    const before = w.calls.filter(c => c[0] === 'updateProject').length;
    await addAndProcess(w, 'second file text', 'notes.md');
    assert.strictEqual(w.calls.filter(c => c[0] === 'createKB').length, 1);
    assert.strictEqual(w.calls.filter(c => c[0] === 'updateProject').length, before);
    assert.strictEqual((await w.files.listFiles(await w.project())).files.length, 2);
});

test('two first uploads at once: the loser deletes its own base and uses the winner\'s', async () => {
    const w = world({ projects: { p1: {} } });
    const winner = { id: uuid(), tenant_id: 'u_owner', organization_id: 'org1', source_kind: 'project_files' };
    w.kbs.set(winner.id, winner);
    w.state.setFilesKbIdOverride = winner.id;
    const added = await w.files.addFile(await w.project(), upload('text of the file'), { userId: 'u_editor' });
    const created = w.calls.find(c => c[0] === 'createKB')[1];
    assert.ok(w.calls.some(c => c[0] === 'deleteKB' && c[1] === created.id), 'the redundant base is removed');
    assert.strictEqual(w.docs.get(added.file.id).knowledge_base_id, winner.id);
    await added.start();
});

test('the listing CAS retries on a colleague\'s write and keeps it', async () => {
    const w = world({ projects: { p1: { knowledgeBaseIds: ['kb_a'] } } });
    w.state.conflictsLeft = 1;
    await addAndProcess(w, 'text of a file');
    const writes = w.calls.filter(c => c[0] === 'updateProject');
    assert.strictEqual(writes.length, 2);
    assert.strictEqual(writes[1][3], 4, 'the retry reads the new version');
    assert.deepStrictEqual((await w.project()).knowledgeBaseIds.slice(0, 1), ['kb_a']);
});

test('a project at the knowledge-base cap still gets its files base, just not in the list', async () => {
    const full = Array.from({ length: 50 }, (_, i) => `kb_${i}`);
    const w = world({ projects: { p1: { knowledgeBaseIds: full } } });
    const { status } = await addAndProcess(w, 'text of a file');
    assert.strictEqual(status, 'ready');
    assert.strictEqual(w.calls.filter(c => c[0] === 'updateProject').length, 0);
    assert.ok((await w.project()).filesKbId);
});

test('the text is screened before it is hashed and embedded; a redaction is stored as redacted', async () => {
    const w = world({ projects: { p1: {} } });
    w.state.shield = { outcome: 'redacted' };
    const { added, status } = await addAndProcess(w, 'Anna signs the contract on Monday.');
    assert.strictEqual(status, 'ready');
    const shield = w.calls.find(c => c[0] === 'shield')[1];
    assert.deepStrictEqual({ orgId: shield.orgId, userId: shield.userId }, { orgId: 'org1', userId: 'u_editor' });
    const re = w.calls.find(c => c[0] === 'reingest')[1];
    assert.strictEqual(re.text, '[person_1] signs the contract on Monday.', 'only the screened text is embedded');
    assert.strictEqual(re.opts.status, 'redacted');
    assert.strictEqual(re.opts.piiStatus, 'redacted');
    assert.strictEqual(re.opts.onFailure, 'record');
    assert.strictEqual(re.opts.pages.length, 1, 'the extractor\'s pages travel for page stamping');
    const file = (await w.files.listFiles(await w.project())).files.find(f => f.id === added.file.id);
    assert.strictEqual(file.redacted, true);
});

test('a file the privacy policy holds back is failed with the policy\'s reason, and nothing is embedded', async () => {
    const w = world({ projects: { p1: {} } });
    w.state.shield = { outcome: 'skipped' };
    const { status } = await addAndProcess(w, 'BSN 123456782 of the customer');
    assert.strictEqual(status, 'failed');
    assert.ok(!w.calls.some(c => c[0] === 'reingest'));
    const [file] = (await w.files.listFiles(await w.project())).files;
    assert.strictEqual(file.status, 'failed');
    assert.match(file.statusReason, /personal data/);
});

test('an unreadable file is failed with a friendly reason', async () => {
    const w = world({ projects: { p1: {} } });
    w.state.extractFails = true;
    const { status } = await addAndProcess(w, 'binary', 'photo.png');
    assert.strictEqual(status, 'failed');
    const [file] = (await w.files.listFiles(await w.project())).files;
    assert.strictEqual(file.statusReason, 'Could not read this file format.');
    assert.ok(!w.calls.some(c => c[0] === 'shield'), 'nothing to screen');
});

test('the same content twice: the second is a failed duplicate, not a second embedding', async () => {
    const w = world({ projects: { p1: {} } });
    await addAndProcess(w, 'identical text in both files', 'a.txt');
    const { status } = await addAndProcess(w, 'identical text in both files', 'b.txt');
    assert.strictEqual(status, 'failed');
    assert.strictEqual(w.calls.filter(c => c[0] === 'reingest').length, 1);
    const dup = (await w.files.listFiles(await w.project())).files.find(f => f.name === 'b.txt');
    assert.strictEqual(dup.statusReason, 'The same file is already in this project.');
});

test('a file removed while it was being embedded has its chunks purged', async () => {
    const w = world({ projects: { p1: {} } });
    const added = await w.files.addFile(await w.project(), upload('text being embedded'), { userId: 'u_editor' });
    // The row goes away after its chunks were written, before the job looks again.
    w.state.afterReingest = async (docId) => { w.docs.delete(docId); };
    let status;
    await added.start({ onDone: (s) => { status = s; } });
    assert.strictEqual(status, 'removed');
    assert.ok(w.calls.some(c => c[0] === 'purge' && c[2] === added.file.id), 'deleted text must not stay searchable');
});

test('a file removed before it was embedded is simply dropped', async () => {
    const w = world({ projects: { p1: {} } });
    const added = await w.files.addFile(await w.project(), upload('text never embedded'), { userId: 'u_editor' });
    w.docs.delete(added.file.id);
    let status;
    await added.start({ onDone: (s) => { status = s; } });
    assert.strictEqual(status, 'removed');
});

test('removing a file touches only this project\'s files base', async () => {
    const w = world({ projects: { p1: {} } });
    const { added } = await addAndProcess(w, 'a file to remove');
    const stranger = { id: uuid(), knowledge_base_id: 'another-kb', title: 'x' };
    w.docs.set(stranger.id, stranger);

    assert.strictEqual(await w.files.removeFile(await w.project(), stranger.id, { userId: 'u_editor' }), null);
    assert.ok(w.docs.has(stranger.id), 'another base\'s document is untouched');
    assert.strictEqual(await w.files.removeFile(await w.project(), uuid(), { userId: 'u_editor' }), null);

    const removed = await w.files.removeFile(await w.project(), added.file.id, { userId: 'u_editor' });
    assert.strictEqual(removed.id, added.file.id);
    assert.ok(w.calls.some(c => c[0] === 'snapshot' && c[1] === added.file.id && c[2] === 'u_editor'));
    const del = w.calls.find(c => c[0] === 'deleteDocumentChunks');
    assert.deepStrictEqual(del.slice(3), ['u_owner', { skipSnapshot: true }]);
    assert.deepStrictEqual((await w.files.listFiles(await w.project())).files, []);
});

test('the activity feed names a file when it is read, only while the file is still in the project', async () => {
    const w = world({ projects: { p1: {} } });
    const { added: kept } = await addAndProcess(w, 'the plan', 'plan.pdf');
    const { added: gone } = await addAndProcess(w, 'a sick note', 'Sick note J. de Vries BSN 123456789.pdf');
    const stranger = { id: uuid(), knowledge_base_id: 'another-kb', title: 'Elsewhere.pdf' };
    w.docs.set(stranger.id, stranger);
    await w.files.removeFile(await w.project(), gone.file.id, { userId: 'u_editor' });

    const row = (id, action, details = {}) => ({ id: `a-${id}`, action, targetType: 'file', targetId: id, details: { targetType: 'file', targetId: id, ...details } });
    const items = [
        row(kept.file.id, 'file.added'),
        row(gone.file.id, 'file.added'),
        // A row written before names were left out: the stored name is dropped.
        row(gone.file.id, 'file.removed', { name: 'Sick note J. de Vries BSN 123456789.pdf' }),
        row(stranger.id, 'file.added'),
        { id: 'a-other', action: 'member_added', targetType: 'user', targetId: 'bob', details: { role: 'viewer' } },
    ];
    const named = await w.files.nameFileActivity(await w.project(), items);

    assert.strictEqual(named[0].details.name, 'plan.pdf', 'a file still in the project is named');
    assert.ok(!('name' in named[1].details), 'a removed file stays unnamed');
    assert.ok(!('name' in named[2].details), 'a stored name of a removed file is never shown');
    assert.ok(!('name' in named[3].details), 'a document of another base is never named through this project');
    assert.strictEqual(named[4], items[4], 'other rows pass through untouched');
    assert.ok(!JSON.stringify(named).includes('Vries'), 'the removed file\'s name is nowhere in the feed');
});

test('naming the feed never fails it: an unreadable files base leaves the rows unnamed', async () => {
    const w = world({ projects: { p1: {} } });
    const { added } = await addAndProcess(w, 'the plan', 'plan.pdf');
    const project = await w.project();
    const broken = makeProjectFiles({
        kbStore: { getKB: async () => { throw new Error('kb store down'); } },
        log: { info() {}, warn() {}, error() {} },
    });
    const items = [{ id: 'a1', action: 'file.added', targetType: 'file', targetId: added.file.id, details: { name: 'old.pdf' } }];
    const named = await broken.nameFileActivity(project, items);
    assert.deepStrictEqual(named[0].details, {});
    // No file rows: nothing is read at all.
    const plain = [{ id: 'a2', action: 'kb_added', details: {} }];
    assert.strictEqual(await broken.nameFileActivity(project, plain), plain);
    assert.deepStrictEqual(await w.files.fileNames(project, []), new Map());
});

test('a project without a files base lists nothing and removes nothing', async () => {
    const w = world({ projects: { p1: {} } });
    assert.deepStrictEqual(await w.files.listFiles(await w.project()), { files: [], kbId: null });
    assert.strictEqual(await w.files.removeFile(await w.project(), uuid(), { userId: 'u' }), null);
});

test('a recorded id that is not this project\'s files base is refused, never uploaded into', async () => {
    const foreign = { id: uuid(), tenant_id: 'someone', organization_id: 'org1', source_kind: 'manual' };
    const w = world({ projects: { p1: { filesKbId: foreign.id } } });
    w.kbs.set(foreign.id, foreign);
    await assert.rejects(
        w.files.addFile(await w.project(), upload('text'), { userId: 'u_editor' }),
        (e) => e.status === 409 && e.code === 'FILES_UNAVAILABLE',
    );
    assert.strictEqual(w.docs.size, 0);
    assert.deepStrictEqual(await w.files.listFiles(await w.project()), { files: [], kbId: null });
});

test('a recorded base that was deleted is replaced, only if it is still the one recorded', async () => {
    const w = world({ projects: { p1: { filesKbId: uuid() } } });
    const stale = (await w.project()).filesKbId;
    await addAndProcess(w, 'text after the base was deleted');
    const set = w.calls.find(c => c[0] === 'setFilesKbId');
    assert.deepStrictEqual(set[3], { expected: stale });
    assert.notStrictEqual((await w.project()).filesKbId, stale);
});

test('the per-project file cap', async () => {
    const w = world({ projects: { p1: {} } });
    await addAndProcess(w, 'the first file');
    const kbId = (await w.project()).filesKbId;
    for (let i = 0; i < 499; i++) w.docs.set(`d${i}`, { id: `d${i}`, knowledge_base_id: kbId, status: 'processed' });
    await assert.rejects(
        w.files.addFile(await w.project(), upload('one too many'), { userId: 'u_editor' }),
        (e) => e.status === 409 && e.code === 'too_many_files',
    );
});

test('removing the whole files base purges every chunk first', async () => {
    const w = world({ projects: { p1: {} } });
    const { added } = await addAndProcess(w, 'a file in a project being deleted');
    const kbId = (await w.project()).filesKbId;
    assert.strictEqual(await w.files.removeFilesKb(await w.project()), true);
    assert.ok(w.calls.some(c => c[0] === 'purge' && c[2] === added.file.id));
    assert.ok(w.calls.some(c => c[0] === 'deleteChunksLocally' && c[2] === kbId));
    assert.ok(w.calls.some(c => c[0] === 'deleteKB' && c[1] === kbId));
    assert.strictEqual(await w.files.removeFilesKb(await w.project()), false, 'nothing left to remove');
});

test('the outside shape: a queued row is processing until it stalls; never the text', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const queued = {
        id: 'd1', title: 'plan.pdf', mime: 'application/pdf', size_bytes: '2048', status: 'skipped',
        status_reason: QUEUED_REASON, created_by: 'u1', created_at: new Date(now - 1000).toISOString(),
        updated_at: new Date(now - 1000).toISOString(), original_content: 'SECRET BODY',
    };
    const file = toFile(queued, now);
    assert.deepStrictEqual(file, {
        id: 'd1', name: 'plan.pdf', mimeType: 'application/pdf', size: 2048, status: 'processing',
        statusReason: null, redacted: false, uploadedBy: 'u1', createdAt: queued.created_at,
    });
    const stalled = toFile({ ...queued, updated_at: new Date(now - STALE_AFTER_MS - 1).toISOString() }, now);
    assert.strictEqual(stalled.status, 'failed');
    assert.match(stalled.statusReason, /did not finish/);
    assert.strictEqual(toFile({ ...queued, status: 'error', status_reason: 'Timed out' }, now).statusReason, 'Timed out');
    assert.strictEqual(cleanName(' a\tb\u0000c.pdf '), 'a b c.pdf');
    assert.strictEqual(cleanName(''), 'Untitled file');
});

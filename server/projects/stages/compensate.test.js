/**
 * Compensation (design 6.5), journal-driven, with every store injected.
 *
 * Pinned:
 *   - newest write first; `done` and `pending` rows are both undone (a write
 *     may have landed before its row was marked);
 *   - a created part is deleted with the deployment's capability, by kind;
 *   - an automation's working copy is reset to its live definition (and its
 *     labels to what the journal recorded); an app to its published
 *     definition; an agent to its published prompt and config; a page's new
 *     snapshot is deleted and its grants and metadata put back;
 *   - an additive app data model and a template revision stay;
 *   - a `remove` deployment's switch-offs are switched back on;
 *   - one failing undo never stops the others, and every undo is journaled.
 *
 * Run: cd server && node --test projects/stages/compensate.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { compensate } = require('./compensate');

const STAGE = { projectId: 'p_uat', solutionId: 'p_dev', stage: 'uat', organizationId: 'org1', runAsUserId: 'so' };
const DEPLOYMENT = { id: 'dep_1' };
const MW = { deploymentId: 'dep_1' };

function harness(steps) {
    const log = [];
    const journal = [];
    const deps = {
        solutionStageStore: {
            listSteps: async (id, opts) => { assert.deepStrictEqual(opts, { phase: 'prepare' }); return steps; },
            appendStep: async (id, step) => { journal.push(step); return { seq: journal.length }; },
            updateStep: async () => null,
        },
        automationStore: {
            deleteAutomation: async (id, opts) => { log.push(['delete_automation', id, opts.managedWrite]); return true; },
            getAutomation: async (id) => ({ id, version: 5, liveVersion: 4, title: 'New title', description: '', liveDefinition: { steps: ['live'] }, isActive: false }),
            updateAutomation: async (id, updates, actor, opts) => { log.push(['reset_automation', id, updates, actor, opts.managedWrite]); return {}; },
        },
        studioAppStore: {
            getStudioApp: async (id) => ({ id, name: 'Desk', publishedDefinition: { screens: ['published'] } }),
            saveDefinition: async (id, owner, def, opts) => { log.push(['reset_app', id, def, opts.managedWrite]); },
            deleteStudioApp: async (id, owner, opts) => { log.push(['delete_app', id, opts.managedWrite]); },
        },
        agentStore: {
            getAgentViews: async () => ({ draft: { name: 'Draft', embed_enabled: true }, runtime: { system_prompt: 'published prompt', config: { temperature: 0.2 } } }),
            updateAgent: async (...args) => { log.push(['reset_agent', args[0], args[1], args[3], args[11], args[12], args[16].managedWrite]); return { ok: true }; },
        },
        webpageStore: {
            getWebpageRaw: async (id) => ({ id, publishedVersionId: 'ver_old' }),
            deleteVersion: async (owner, versionId, id, opts) => { log.push(['delete_version', versionId, id, opts.managedWrite]); },
            updateBridgeGrants: async (id, owner, grants) => { log.push(['grants', id, grants.automations]); },
            updateWebpageMetadata: async (id, owner, meta) => { log.push(['page_meta', id, meta.name]); },
            setWebpagePublished: async (id, on) => { log.push(['page_published', id, on]); },
        },
        datatableStore: { orgScope: (id) => ({ kind: 'org', id }) },
        datatableDbStore: { dropDatatable: async (id, scope, opts) => { log.push(['drop_table', id, scope.id, opts.managedWrite]); } },
        goLive: { activateCore: async ({ automation }) => { log.push(['reactivate', automation.id]); return { ok: true }; } },
        aiActState: {},
    };
    return { log, journal, deps };
}

test('compensation undoes the journal newest first, with the capability, and journals each undo', async () => {
    const steps = [
        { seq: 1, action: 'create', kind: 'datatable', ref: 'dt_1', entityId: 'tbl_new', status: 'done' },
        { seq: 2, action: 'create', kind: 'automation', ref: 'aut_2', entityId: 'u-aut-new', status: 'done' },
        { seq: 3, action: 'write_working', kind: 'automation', ref: 'aut_1', entityId: 'u-aut-1', status: 'done',
            before: { version: 4, liveVersion: 4, title: 'Old title', description: '' } },
        { seq: 4, action: 'write_definition', kind: 'app', ref: 'app_1', entityId: 'u-app-1', status: 'pending', before: {} },
        { seq: 5, action: 'data_model', kind: 'app', ref: 'app_1', entityId: 'u-app-1', status: 'done' },
        { seq: 6, action: 'write_agent', kind: 'agent', ref: 'agt_1', entityId: 'u-agt-1', status: 'done', before: { name: 'Before' } },
        { seq: 7, action: 'webpage_version', kind: 'webpage', ref: 'web_1', entityId: 'u-web-1', status: 'done',
            detail: { versionId: 'ver_new' }, before: { grants: { automations: ['u-aut-1'], tables: [], integrations: [], agentId: null }, name: 'Page', knowledgeBaseIds: [] } },
        { seq: 8, action: 'template_version', kind: 'document', ref: 'doc_1', entityId: 'u-doc', status: 'done' },
        { seq: 9, action: 'create', kind: 'automation', ref: 'aut_x', entityId: null, status: 'failed' },
    ];
    const h = harness(steps);
    const out = await compensate({ deployment: DEPLOYMENT, stage: STAGE }, h.deps);
    assert.deepStrictEqual(h.log.map(e => e[0]), ['delete_version', 'grants', 'page_meta', 'reset_agent', 'reset_app',
        'reset_automation', 'delete_automation', 'drop_table']);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'reset_automation').slice(1),
        ['u-aut-1', { definition: { steps: ['live'] }, title: 'Old title' }, 'so', MW]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'reset_app').slice(2), [{ screens: ['published'] }, MW]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'reset_agent').slice(1), ['u-agt-1', 'Before', 'published prompt', { temperature: 0.2 }, true, MW]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'delete_version').slice(1), ['ver_new', 'u-web-1', MW]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'grants')[2], [{ automationId: 'u-aut-1' }]);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'drop_table').slice(1), ['tbl_new', 'org1', MW]);
    assert.deepStrictEqual(out, { undone: 6, failed: 0, skipped: 2 });
    assert.ok(h.journal.every(j => j.phase === 'compensate' && j.status === 'done' && /^undo_/.test(j.action)));
    assert.deepStrictEqual(h.journal.map(j => j.detail.undoes), [7, 6, 4, 3, 2, 1], 'newest first; the data model and the revision stay');
});

test('a page snapshot the stage already pins is kept', async () => {
    const h = harness([{ seq: 1, action: 'webpage_version', kind: 'webpage', entityId: 'u-web-1', status: 'done', detail: { versionId: 'ver_old' } }]);
    await compensate({ deployment: DEPLOYMENT, stage: STAGE }, h.deps);
    assert.ok(!h.log.some(e => e[0] === 'delete_version'));
});

test('one failing undo is journaled as failed and the others still run', async () => {
    const h = harness([
        { seq: 1, action: 'create', kind: 'automation', ref: 'aut_1', entityId: 'u-1', status: 'done' },
        { seq: 2, action: 'create', kind: 'automation', ref: 'aut_2', entityId: 'u-2', status: 'done' },
    ]);
    h.deps.automationStore.deleteAutomation = async (id) => { if (id === 'u-2') throw new Error('locked'); h.log.push(['delete_automation', id]); };
    const out = await compensate({ deployment: DEPLOYMENT, stage: STAGE }, h.deps);
    assert.deepStrictEqual(out, { undone: 1, failed: 1, skipped: 0 });
    assert.deepStrictEqual(h.log, [['delete_automation', 'u-1']]);
    assert.deepStrictEqual(h.journal.map(j => [j.action, j.status, j.ref]), [['undo_create', 'failed', 'aut_2'], ['undo_create', 'done', 'aut_1']]);
});

test('a removal that failed before its commit switches the stage back on', async () => {
    const h = harness([
        { seq: 1, action: 'deactivate', kind: 'automation', ref: 'aut_1', entityId: 'u-aut-1', status: 'done', before: { isActive: true } },
        { seq: 2, action: 'unpublish', kind: 'webpage', ref: 'web_1', entityId: 'u-web-1', status: 'done', before: { isPublished: true } },
    ]);
    const out = await compensate({ deployment: DEPLOYMENT, stage: STAGE }, h.deps);
    assert.deepStrictEqual(h.log, [['page_published', 'u-web-1', true], ['reactivate', 'u-aut-1']]);
    assert.strictEqual(out.undone, 2);
});

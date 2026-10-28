/**
 * The stores and engines an install reaches, swapped for recorders, and the
 * one-call `install` helper the install tests drive the real module through.
 *
 * Shared by install.test.js and install.golden.test.js. Requiring this file
 * installs every fake in `require.cache` BEFORE install.js is loaded, so the
 * lazy requires inside the install modules pick the fakes up.
 */

'use strict';

const projectStorePath = require.resolve('../../stores/projectStore');
const automationStorePath = require.resolve('../../stores/automationStore');
const studioAppStorePath = require.resolve('../../stores/studioAppStore');
const webpageStorePath = require.resolve('../../stores/webpageStore');
const blueprintStorePath = require.resolve('../../stores/blueprintStore');

const calls = [];
const record = (name, args) => calls.push({ name, args });
let seq = 0;
/**
 * @param {string} p
 */
const nextId = (p) => `${p}_${++seq}`;
const live = new Map();      // id -> the stored automation, for the patch pass
const liveApps = new Map();  // id -> the stored app definition, for the stamp pass
const liveSlots = new Map(); // webpage id -> its three files, for the stamp pass
// Projects that are a Solution STAGE: the store guards refuse to file a part
// into one without a deployment's capability (stores/lib/managedParts.js).
const stageProjects = new Set();
const guardStage = (projectId, opts) => {
    if (projectId && stageProjects.has(projectId) && !opts?.managedWrite) {
        throw Object.assign(new Error('This part is managed by a deployment.'), { status: 409, code: 'managed_part' });
    }
};

require.cache[projectStorePath] = {
    id: projectStorePath, filename: projectStorePath, loaded: true,
    exports: {
        createProject: async (args) => { record('createProject', args); return { id: 'proj_new' }; },
    },
};
require.cache[automationStorePath] = {
    id: automationStorePath, filename: automationStorePath, loaded: true,
    exports: {
        createAutomation: async (args) => {
            record('createAutomation', args);
            const id = nextId('aut');
            live.set(id, { id, definition: args.definition });
            return { id };
        },
        createStep: async (args) => {
            record('createStep', args);
            const id = nextId('aut');
            live.set(id, { id, kind: 'block', definition: args.definition });
            return { id };
        },
        getAutomation: async (id) => live.get(id) || null,
        updateAutomation: async (id, updates, userId, opts) => {
            record('updateAutomation', { id, updates, userId, opts });
            guardStage(updates.projectId, opts);
            if (updates.definition) live.get(id).definition = updates.definition;
        },
    },
};
require.cache[studioAppStorePath] = {
    id: studioAppStorePath, filename: studioAppStorePath, loaded: true,
    exports: {
        createStudioApp: async (args) => {
            record('createStudioApp', args);
            const id = nextId('app');
            liveApps.set(id, args.definition);
            return { id };
        },
        setAppProject: async (...a) => record('setAppProject', a),
        saveDefinition: async (id, ownerId, definition, opts) => {
            record('saveDefinition', { id, ownerId, definition, opts });
            liveApps.set(id, definition);
        },
        getStudioApp: async (id) => (liveApps.has(id) ? { id, definition: liveApps.get(id) } : null),
    },
};
require.cache[webpageStorePath] = {
    id: webpageStorePath, filename: webpageStorePath, loaded: true,
    exports: {
        createWebpage: async (args) => {
            record('createWebpage', args);
            const id = nextId('web');
            liveSlots.set(id, { html: '', css: '', js: '' });
            return { id };
        },
        writeSlot: async (...a) => {
            record('writeSlot', a);
            const [, id, slot, content] = a;
            const key = { 'index.html': 'html', 'style.css': 'css', 'script.js': 'js' }[slot];
            if (liveSlots.has(id) && key) liveSlots.get(id)[key] = content;
        },
        setWebpageProject: async (...a) => record('setWebpageProject', a),
        updateBridgeGrants: async (id, userId, patch, opts) => record('updateBridgeGrants', { id, userId, patch, opts }),
        getWebpageRaw: async (id) => (liveSlots.has(id) ? { id, userId: 'installer' } : null),
        readAllSlots: async (userId, id) => ({ ...liveSlots.get(id) }),
    },
};

// The gallery rows `verifyClaimedBlueprint` can find. Meta only: that
// function reads nothing but `solutionKey` and returns a boolean.
const gallery = new Map();
require.cache[blueprintStorePath] = {
    id: blueprintStorePath, filename: blueprintStorePath, loaded: true,
    exports: {
        upsertStamp: async (client, args) => record('upsertStamp', args),
        // What planUpgrade reads back: the stamps this install wrote.
        listStamps: async (projectId) => new Map(calls
            .filter(c => c.name === 'upsertStamp' && c.args.projectId === projectId)
            .map(c => [c.args.ref, { ...c.args }])),
        getBlueprintById: async (id, opts) => {
            record('getBlueprintById', { id, opts });
            return gallery.get(id) || null;
        },
    },
};

// ── The three kinds a Solution gained in O1 ─────────────────────────────────
//
// The datatable path is stubbed at the STORE and the ENGINE, but not at the
// normaliser: `normalizeFields` is pure and is what decides whether a column
// list is installable at all, so the real one runs and a bad column list fails
// here the way it would in production.
const datatableStorePath = require.resolve('../../stores/datatableStore');
const datatableDbStorePath = require.resolve('../../stores/datatableDbStore');
const datatableLimitsPath = require.resolve('../../core/dataEngine/datatableLimits');
const migrationPlanPath = require.resolve('../../core/dataEngine/dataModel/migrationPlan');
const ddlPath = require.resolve('../../core/dataEngine/dataModel/ddl');
const dbPath = require.resolve('../../db');
const agentStorePath = require.resolve('../../stores/agentStore');
const knowledgeBasesPath = require.resolve('../../stores/knowledgeBases');
const kbMembershipPath = require.resolve('../knowledgeBaseMembership');
const skillStorePath = require.resolve('../../stores/skillStore');
const documentStorePath = require.resolve('../../stores/documentStore');
const solutionTemplatesPath = require.resolve('../../stores/document/solutionTemplates');
const membershipPath = require.resolve('../membership');

const fx = {
    createDatatableThrows: false, kbFiled: true, filed: true,
    // Keys the (scope, key) unique index already holds, for the F7 clash.
    takenKeys: new Set(),
    bindingsThrow: false,
    dataModelResult: { ok: true, version: 1 },
};

require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: {
        withTransaction: async (fn) => fn({ marker: 'tx' }),
        // stores/webpage/bridgeGrants is loaded FOR REAL below — its normalizer
        // is what the grant assertions close the loop through — so the facade it
        // requires has to exist. None of these are reached: every assertion runs
        // over normalizeBridgeGrants, which is pure.
        exec: async () => {}, run: async () => ({ rowCount: 0 }), getOne: async () => null,
        getAll: async () => [],
    },
};
// …and its schema module, which otherwise fires DDL at require time.
const webpageSchemaPath = require.resolve('../../stores/webpage/schema');
require.cache[webpageSchemaPath] = {
    id: webpageSchemaPath, filename: webpageSchemaPath, loaded: true,
    exports: { initDB: async () => {}, ready: Promise.resolve() },
};
require.cache[datatableStorePath] = {
    id: datatableStorePath, filename: datatableStorePath, loaded: true,
    exports: {
        orgScope: (id) => ({ kind: 'org', id }),
        userScope: (id) => ({ kind: 'user', id }),
        createDatatable: async (args, opts) => {
            record('createDatatable', args);
            record('createDatatableOpts', { managedWrite: opts?.managedWrite });
            if (fx.createDatatableThrows) throw new Error('quota reached');
            guardStage(args.projectId, opts);
            if (fx.takenKeys.has(args.key)) {
                throw new Error('duplicate key value violates unique constraint "uq_datatables_scope_key"');
            }
            if (opts?.assertQuota) await opts.assertQuota({ tables: 1, rows: 0, bytes: 0 });
            if (opts?.applyPhysical) {
                await opts.applyPhysical(opts.client, {
                    before: { tables: [] },
                    next: { tables: [{ id: 'tbl_new', key: args.key, fields: args.fields }] },
                    modelVersion: 2,
                });
            }
            return { id: nextId('tbl') };
        },
    },
};
require.cache[datatableDbStorePath] = {
    id: datatableDbStorePath, filename: datatableDbStorePath, loaded: true,
    exports: {
        scopeKey: (scope) => `${scope.kind}:${scope.id}`,
        applyMigration: async (a, b, statements, opts) => record('applyMigration', { scopeKey: a, statements, client: opts?.client }),
        invalidate: () => record('invalidate', {}),
    },
};
require.cache[datatableLimitsPath] = {
    id: datatableLimitsPath, filename: datatableLimitsPath, loaded: true,
    exports: { assertDatatableQuota: async () => record('assertQuota', {}) },
};
require.cache[migrationPlanPath] = {
    id: migrationPlanPath, filename: migrationPlanPath, loaded: true,
    exports: { migrationPlan: () => ['CREATE TABLE …'] },
};
require.cache[ddlPath] = {
    id: ddlPath, filename: ddlPath, loaded: true,
    exports: { ddlForTable: () => 'ENSURE …' },
};
require.cache[agentStorePath] = {
    id: agentStorePath, filename: agentStorePath, loaded: true,
    exports: {
        createAgent: async (...args) => { record('createAgent', args); return { id: nextId('agt') }; },
        setAgentProject: async (...a) => record('setAgentProject', a),
        getAgent: async (id) => ({ id, name: 'live', config: {}, avatar: null }),
        updateAgent: async (...args) => { record('updateAgent', args); return { ok: true, rev: 2 }; },
    },
};
require.cache[knowledgeBasesPath] = {
    id: knowledgeBasesPath, filename: knowledgeBasesPath, loaded: true,
    exports: {
        createKB: async (...args) => { record('createKB', args); return { id: nextId('kb') }; },
        getKB: async (id) => ({ id, organization_id: 'org1' }),
    },
};
require.cache[kbMembershipPath] = {
    id: kbMembershipPath, filename: kbMembershipPath, loaded: true,
    exports: {
        setKnowledgeBaseProject: async (kbId, userId, projectId, ctx) => {
            record('setKnowledgeBaseProject', { kbId, userId, projectId, hasReq: !!ctx?.req, ctxProjectId: ctx?.projectId, managedWrite: ctx?.managedWrite });
            return fx.kbFiled;
        },
    },
};

// Skills and document templates. The registry's setProject is the way in: it
// is swapped here for a recorder (the real one reads the database for the stage
// gate; membership.test.js covers it against pglite).
require.cache[skillStorePath] = {
    id: skillStorePath, filename: skillStorePath, loaded: true,
    exports: { createSkill: async (args) => { record('createSkill', args); return { id: nextId('skl') }; } },
};
require.cache[documentStorePath] = {
    id: documentStorePath, filename: documentStorePath, loaded: true,
    exports: {
        createDocument: async (args) => {
            record('createDocument', args);
            const id = nextId('doc');
            return { id, versionId: `ver_of_${id}` };
        },
    },
};
require.cache[solutionTemplatesPath] = {
    id: solutionTemplatesPath, filename: solutionTemplatesPath, loaded: true,
    exports: {
        writeManagedTemplate: async (client, input, opts) => {
            record('writeManagedTemplate', { client, input, opts });
            const id = nextId('doc');
            return { id, versionId: `ver_of_${id}`, created: true };
        },
    },
};
require.cache[membershipPath] = {
    id: membershipPath, filename: membershipPath, loaded: true,
    exports: {
        getKind: (kind) => ({
            setProject: async (id, userId, projectId, ctx) => {
                record('membership.setProject', { kind, id, userId, projectId, ctx });
                return fx.filed;
            },
        }),
    },
};

// An app's own data model (F13) goes through the store's save path.
const studioAppDataStorePath = require.resolve('../../stores/studioAppDataStore');
require.cache[studioAppDataStorePath] = {
    id: studioAppDataStorePath, filename: studioAppDataStorePath, loaded: true,
    exports: {
        saveDataModel: async (appId, ownerId, model, opts) => {
            record('saveDataModel', { appId, ownerId, model, opts });
            return fx.dataModelResult;
        },
    },
};


const { installBlueprint } = require('./install');
const { buildManifest } = require('../../core/packaging/manifest');


const AUTOMATION = (ref, kind = 'automation', over = {}) => ({
    ref, kind, title: `Automation ${ref}`, description: '',
    triggerType: 'manual',
    definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [] },
    ...over,
});

function reset() {
    calls.length = 0; seq = 0; live.clear(); liveApps.clear(); liveSlots.clear(); gallery.clear(); stageProjects.clear();
    fx.createDatatableThrows = false; fx.kbFiled = true; fx.filed = true; fx.takenKeys = new Set(); fx.bindingsThrow = false;
    fx.dataModelResult = { ok: true, version: 1 };
}

/**
 * Where the installer's choices are kept (solution_bindings), handed in rather
 * than reached for: installBlueprint takes `deps.bindings`.
 */
const bindingsFake = {
    upsertBindings: async (projectId, rows, actorId) => {
        record('upsertBindings', { projectId, rows, actorId });
        if (fx.bindingsThrow) throw new Error('bindings table missing');
        return rows;
    },
};
const DEPS = { bindings: bindingsFake };
const called = (name) => calls.filter(c => c.name === name);

const install = (entities, opts = {}) => installBlueprint({
    manifest: buildManifest({ project: { id: 'p1', name: 'Onboarding' }, entities }),
    ownerId: 'installer', organizationId: 'org1', deps: DEPS, ...opts,
});

module.exports = {
    calls, record, nextId, live, liveApps, liveSlots, stageProjects, guardStage, gallery, fx,
    reset, bindingsFake, DEPS, called, install, AUTOMATION, studioAppStorePath, blueprintStorePath,
};

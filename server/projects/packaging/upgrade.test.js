/**
 * Upgrading an installed Solution.
 *
 * The safety property under test is that an upgrade CANNOT DESTROY WORK:
 *
 *   - An entity nobody touched is replaced.
 *   - An entity somebody touched is left exactly as it was, and named.
 *   - An entity the new version adds is created.
 *   - Nothing is ever deleted — not an entity the new version dropped, not one
 *     somebody deleted by hand and does not want back.
 *
 * And it is decided PER ENTITY. A project-level hash would let one hand-edited
 * app freeze the whole Solution, refusing every unrelated update.
 *
 * Run: cd server && node --test projects/packaging/upgrade.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const blueprintStorePath = require.resolve('../../stores/blueprintStore');
const automationStorePath = require.resolve('../../stores/automationStore');
const studioAppStorePath = require.resolve('../../stores/studioAppStore');
const webpageStorePath = require.resolve('../../stores/webpageStore');
const projectStorePath = require.resolve('../../stores/projectStore');

const calls = [];
const record = (name, args) => calls.push({ name, args });
const stamps = new Map();
/** Entiteits-id's waarvan de LEES gooit — geen ontbrekende entiteit, een kapotte lees. */
const readThrows = new Set();
const liveAutomations = new Map();
const liveApps = new Map();
const livePages = new Map();

require.cache[blueprintStorePath] = {
    id: blueprintStorePath, filename: blueprintStorePath, loaded: true,
    exports: {
        listStamps: async () => stamps,
        upsertStamp: async (client, a) => record('upsertStamp', a),
    },
};
require.cache[automationStorePath] = {
    id: automationStorePath, filename: automationStorePath, loaded: true,
    exports: {
        getAutomation: async (id) => {
            // Een store die GOOIT is iets anders dan een entiteit die er niet
            // meer is; het plan moet die twee uit elkaar houden.
            if (readThrows.has(id)) throw new Error('de automatisering is niet te lezen');
            return liveAutomations.get(id) || null;
        },
        updateAutomation: async (id, updates, userId, opts) => {
            record('updateAutomation', { id, updates, userId, opts });
            if (fx.failUpdate.has(id)) throw new Error('connection reset');
            const row = liveAutomations.get(id);
            if (row && updates.definition) row.definition = updates.definition;
        },
        createAutomation: async (args) => {
            record('createAutomation', args);
            const id = `aut_new_${called('createAutomation').length}`;
            liveAutomations.set(id, { id, kind: args.kind || 'automation', definition: args.definition });
            return { id };
        },
        publishStep: async (id, userId) => record('publishStep', { id, userId }),
    },
};
require.cache[studioAppStorePath] = {
    id: studioAppStorePath, filename: studioAppStorePath, loaded: true,
    exports: {
        getStudioApp: async (id) => liveApps.get(id) || null,
        saveDefinition: async (id, ownerId, definition) => {
            record('saveDefinition', { id, ownerId, definition });
            const row = liveApps.get(id);
            if (row) liveApps.set(id, { ...row, definition, definitionVersion: (row.definitionVersion || 1) + 1 });
        },
        createStudioApp: async (args) => { record('createStudioApp', args); return { id: 'app_new' }; },
        setAppProject: async (...a) => record('setAppProject', a),
        setStudioAppPublished: async (...a) => record('setStudioAppPublished', a),
    },
};
require.cache[webpageStorePath] = {
    id: webpageStorePath, filename: webpageStorePath, loaded: true,
    exports: {
        getWebpageRaw: async (id) => livePages.get(id) || null,
        readAllSlots: async () => ({ html: '', css: '', js: '' }),
        writeSlot: async (...a) => record('writeSlot', a),
        createVersion: async (...a) => { record('createVersion', a); return { id: 'ver_new' }; },
        setPublishedVersion: async (...a) => { record('setPublishedVersion', a); return true; },
        createWebpage: async (args) => { record('createWebpage', args); return { id: 'web_new' }; },
        setWebpageProject: async (...a) => record('setWebpageProject', a),
    },
};
require.cache[projectStorePath] = {
    id: projectStorePath, filename: projectStorePath, loaded: true,
    exports: { createProject: async () => ({ id: 'proj' }) },
};

// ── The three kinds a Solution gained in O1 ─────────────────────────────────
const datatableStorePath = require.resolve('../../stores/datatableStore');
const datatableDbStorePath = require.resolve('../../stores/datatableDbStore');
const datatableLimitsPath = require.resolve('../../core/dataEngine/datatableLimits');
const migrationPlanPath = require.resolve('../../core/dataEngine/dataModel/migrationPlan');
const ddlPath = require.resolve('../../core/dataEngine/dataModel/ddl');
const dbPath = require.resolve('../../db');
const agentStorePath = require.resolve('../../stores/agentStore');
const knowledgeBasesPath = require.resolve('../../stores/knowledgeBases');
const kbMembershipPath = require.resolve('../knowledgeBaseMembership');

const liveAgents = new Map();

require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { withTransaction: async (fn) => fn({ marker: 'tx' }) },
};
require.cache[datatableStorePath] = {
    id: datatableStorePath, filename: datatableStorePath, loaded: true,
    exports: {
        orgScope: (id) => ({ kind: 'org', id }),
        userScope: (id) => ({ kind: 'user', id }),
        createDatatable: async (args) => { record('createDatatable', args); return { id: 'tbl_new' }; },
    },
};
require.cache[datatableDbStorePath] = {
    id: datatableDbStorePath, filename: datatableDbStorePath, loaded: true,
    exports: { scopeKey: (s) => `${s.kind}:${s.id}`, applyMigration: async () => {}, invalidate: () => {} },
};
require.cache[datatableLimitsPath] = {
    id: datatableLimitsPath, filename: datatableLimitsPath, loaded: true,
    exports: { assertDatatableQuota: async () => {} },
};
require.cache[migrationPlanPath] = {
    id: migrationPlanPath, filename: migrationPlanPath, loaded: true,
    exports: { migrationPlan: () => [] },
};
require.cache[ddlPath] = { id: ddlPath, filename: ddlPath, loaded: true, exports: { ddlForTable: () => 'ENSURE' } };
require.cache[agentStorePath] = {
    id: agentStorePath, filename: agentStorePath, loaded: true,
    exports: {
        createAgent: async (...args) => { record('createAgent', args); return { id: 'agt_new' }; },
        setAgentProject: async (...a) => record('setAgentProject', a),
        getAgent: async (id) => liveAgents.get(id) || null,
        updateAgent: async (...args) => { record('updateAgent', args); return { ok: true, rev: 2 }; },
        publishAgentVersion: async (id, opts) => { record('publishAgentVersion', { id, opts }); return { ok: true }; },
    },
};
require.cache[knowledgeBasesPath] = {
    id: knowledgeBasesPath, filename: knowledgeBasesPath, loaded: true,
    exports: { createKB: async (...a) => { record('createKB', a); return { id: 'kb_new' }; } },
};
require.cache[kbMembershipPath] = {
    id: kbMembershipPath, filename: kbMembershipPath, loaded: true,
    exports: { setKnowledgeBaseProject: async (...a) => { record('setKnowledgeBaseProject', a); return true; } },
};

const { planUpgrade, applyUpgrade, isNewer } = require('./upgrade');
const { buildManifest } = require('./manifest');
const { hashDefinition } = require('../../appStudio/templateUpgrade');

const DEF_V1 = { schemaVersion: 2, steps: [{ id: 's1', type: 'code' }] };
const DEF_V2 = { schemaVersion: 2, steps: [{ id: 's1', type: 'code' }, { id: 's2', type: 'code' }] };

const fx = { bindings: [], bindingsThrow: false, failUpdate: new Set() };

function reset() {
    calls.length = 0;
    stamps.clear();
    readThrows.clear();
    liveAutomations.clear();
    liveApps.clear();
    livePages.clear();
    liveAgents.clear();
    fx.bindings = [];
    fx.bindingsThrow = false;
    fx.failUpdate = new Set();
}
function called(n) { return calls.filter(c => c.name === n); }

/**
 * What applyUpgrade reaches through `deps` rather than through a module: the
 * kept choices (solution_bindings), the go-live core, the page database flush
 * and the project's installed version.
 */
const DEPS = {
    bindings: {
        listBindings: async (projectId) => {
            record('listBindings', { projectId });
            if (fx.bindingsThrow) throw new Error('bindings table missing');
            return fx.bindings;
        },
    },
    goLive: {
        planGoLive: (automation, definition, opts) => {
            record('planGoLive', { id: automation.id, opts });
            return { ok: true, columns: { triggerType: 'manual', isDraft: false } };
        },
        convergeAfterPublish: async (args) => { record('convergeAfterPublish', { id: args.automation.id, reason: args.reason }); return { warnings: [] }; },
    },
    webpageDb: { flush: async (...a) => record('flush', a) },
    projectStore: { setInstalledVersion: async (...a) => record('setInstalledVersion', a) },
};
const apply = (args) => applyUpgrade({ deps: DEPS, ...args });

const manifestWith = (entities, version = 2) =>
    buildManifest({ project: { id: 'p1', name: 'Onboarding' }, entities, version });

// ═══ Newer, and only newer ═══════════════════════════════════════════

test('the same version is not an upgrade', () => {
    // Re-applying it would replace a pristine entity with an identical copy and
    // then claim it updated something.
    assert.strictEqual(isNewer({ installedVersion: 2, blueprintVersion: 2 }), false);
    assert.strictEqual(isNewer({ installedVersion: 2, blueprintVersion: 3 }), true);
    assert.strictEqual(isNewer({ installedVersion: 3, blueprintVersion: 2 }), false);
});

// ═══ Deciding ════════════════════════════════════════════════════════

test('an untouched entity is up for replacement', async () => {
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });

    const { plan } = await planUpgrade({ projectId: 'p1', manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }) });
    assert.deepStrictEqual(plan.replace.map(r => r.ref), ['aut_1']);
    assert.strictEqual(plan.skip.length, 0);
});

test('an edited entity is left alone, and said so', async () => {
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    liveAutomations.set('a1', { id: 'a1', definition: { schemaVersion: 2, steps: [{ id: 's1', type: 'code', edited: true }] } });

    const { plan } = await planUpgrade({ projectId: 'p1', manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }) });
    assert.strictEqual(plan.replace.length, 0);
    assert.deepStrictEqual(plan.skip.map(s => s.ref), ['aut_1']);
    assert.match(plan.skip[0].why, /edited since it was installed/);
});

test('one edited entity does not freeze the rest', async () => {
    reset();
    // A project-level hash would refuse everything because of the one change.
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    stamps.set('aut_2', { ref: 'aut_2', kind: 'automation', entityId: 'a2', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    liveAutomations.set('a1', { id: 'a1', definition: { schemaVersion: 2, steps: [{ id: 'x', type: 'code' }] } });
    liveAutomations.set('a2', { id: 'a2', definition: DEF_V1 });

    const { plan } = await planUpgrade({
        projectId: 'p1',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }, { ref: 'aut_2', definition: DEF_V2 }] }),
    });
    assert.deepStrictEqual(plan.skip.map(s => s.ref), ['aut_1']);
    assert.deepStrictEqual(plan.replace.map(r => r.ref), ['aut_2']);
});

test('an entity the new version adds is an addition, not a replacement', async () => {
    reset();
    const { plan } = await planUpgrade({ projectId: 'p1', manifest: manifestWith({ automations: [{ ref: 'aut_new', definition: DEF_V2 }] }) });
    assert.deepStrictEqual(plan.add.map(a => a.ref), ['aut_new']);
});

test('an entity somebody deleted is reported, never resurrected', async () => {
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'gone', installHash: 'h', installedVersion: 1 });
    const { plan } = await planUpgrade({ projectId: 'p1', manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }) });
    assert.deepStrictEqual(plan.missing.map(m => m.ref), ['aut_1']);
    assert.strictEqual(plan.replace.length, 0);
    assert.strictEqual(plan.add.length, 0, 'deleting it was a decision, not damage');
});

test('a Blueprint that does not read back is refused before planning anything', async () => {
    reset();
    const bad = buildManifest({ project: { id: 'p1' }, entities: { apps: [{ ref: 'app_1', definition: { go: { $ref: 'nope' } } }] } });
    const result = await planUpgrade({ projectId: 'p1', manifest: bad });
    assert.strictEqual(result.ok, false);
});

// ═══ Applying ════════════════════════════════════════════════════════

test('replacing writes through the store and re-stamps', async () => {
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });

    const result = await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }),
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.report.replaced.map(r => r.ref), ['aut_1']);
    assert.deepStrictEqual(called('updateAutomation')[0].args.updates.definition, DEF_V2);
    // Re-stamped at the NEW version, or the same upgrade would be offered again.
    assert.strictEqual(called('upsertStamp')[0].args.installedVersion, 2);
});

test('nothing is deleted, ever', async () => {
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    stamps.set('aut_2', { ref: 'aut_2', kind: 'automation', entityId: 'a2', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });
    liveAutomations.set('a2', { id: 'a2', definition: DEF_V1 });

    // The new version dropped aut_2 entirely.
    await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }),
    });
    assert.strictEqual(calls.some(c => /delete/i.test(c.name)), false,
        'somebody can delete what they no longer want; nobody can un-delete');
});

test('additions land before replacements, so a new reference resolves', async () => {
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });

    await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({
            automations: [
                { ref: 'aut_1', kind: 'automation', title: 'Existing', definition: DEF_V2 },
                { ref: 'aut_2', kind: 'automation', title: 'Brand new', triggerType: 'manual', definition: DEF_V1 },
            ],
        }),
    });
    const order = calls.filter(c => c.name === 'createAutomation' || c.name === 'updateAutomation').map(c => c.name);
    assert.strictEqual(order[0], 'createAutomation');
});

test('an edited entity survives an apply untouched', async () => {
    reset();
    const edited = { schemaVersion: 2, steps: [{ id: 'mine', type: 'code' }] };
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    liveAutomations.set('a1', { id: 'a1', definition: edited });

    const result = await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }),
    });
    assert.strictEqual(called('updateAutomation').length, 0, 'their work is not overwritten');
    assert.deepStrictEqual(result.report.skipped.map(s => s.ref), ['aut_1']);
});

test('an upgrade with no installer is refused', async () => {
    reset();
    const result = await apply({ projectId: 'p1', manifest: manifestWith({}) });
    assert.strictEqual(result.ok, false);
});

// ═══ Tables and knowledge bases: added, never rewritten ══════════════

const TABLE = (ref = 'dt_1') => ({ ref, key: 'invoices', name: 'Invoices', description: 'billed', columns: [] });
const KB = (ref = 'kb_1') => ({ ref, name: 'Handbook', description: '' });

test('a table the new version ADDS is created', async () => {
    reset();
    const result = await apply({
        projectId: 'p1', manifest: manifestWith({ datatables: [TABLE()] }), ownerId: 'owner', organizationId: 'org1',
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(called('createDatatable').length, 1);
    assert.strictEqual(result.report.added.datatables.length, 1);
});

test('a table that is ALREADY installed is left alone, and said so', async () => {
    // Replacing a table's schema would rewrite something with rows under it: a
    // column the new version dropped takes its data with it. Add-only, and the
    // report says why rather than staying quiet about it.
    reset();
    stamps.set('dt_1', { entityId: 'tbl_live', installHash: 'anything', installedVersion: 1 });

    const planned = await planUpgrade({ projectId: 'p1', manifest: manifestWith({ datatables: [TABLE()] }) });
    assert.strictEqual(planned.plan.replace.length, 0);
    assert.strictEqual(planned.plan.add.length, 0);
    assert.strictEqual(planned.plan.skip.length, 1);
    assert.match(planned.plan.skip[0].why, /never rewrites one/);

    const result = await apply({ projectId: 'p1', manifest: manifestWith({ datatables: [TABLE()] }), ownerId: 'owner' });
    assert.strictEqual(called('createDatatable').length, 0, 'and nothing was created a second time');
    assert.strictEqual(result.report.replaced.length, 0);
});

test('an installed knowledge base is never renamed or re-scoped by an update', async () => {
    reset();
    stamps.set('kb_1', { entityId: 'kb_live', installHash: 'anything', installedVersion: 1 });
    const result = await apply({ projectId: 'p1', manifest: manifestWith({ knowledgeBases: [KB()] }), ownerId: 'owner' });
    assert.strictEqual(called('createKB').length, 0);
    assert.strictEqual(result.report.replaced.length, 0);
    assert.strictEqual(result.report.skipped.length, 1);
});

test('a knowledge base the new version adds is created and filed', async () => {
    reset();
    await apply({ projectId: 'p1', manifest: manifestWith({ knowledgeBases: [KB()] }), ownerId: 'owner', organizationId: 'org1' });
    assert.strictEqual(called('createKB').length, 1);
    assert.strictEqual(called('setKnowledgeBaseProject').length, 1);
});

// ═══ Agents: replaceable, and never wider than they arrived ══════════

const AGENT = (ref, config) => ({ ref, name: 'Desk', description: '', systemPrompt: 'p', model: null, starterPrompts: [], config });

test('an untouched agent is replaced, and its grants land as viewer', async () => {
    reset();
    const installed = { tools: { gmail: { actions: '*', actAs: 'viewer' } } };
    liveAgents.set('agt_live', { id: 'agt_live', name: 'Desk', config: installed, avatar: null });
    stamps.set('agt_1', { entityId: 'agt_live', installHash: hashDefinition(installed), installedVersion: 1 });

    // The newer Blueprint asks for `owner` — the shape a hand-edited file has.
    const manifest = manifestWith({ agents: [AGENT('agt_1', { tools: { gmail: { actions: '*', actAs: 'owner' } } })] });
    const result = await apply({ projectId: 'p1', manifest, ownerId: 'owner' });

    assert.strictEqual(result.report.replaced.length, 1);
    const config = called('updateAgent')[0].args[11];
    assert.strictEqual(config.tools.gmail.actAs, 'viewer', 'an update is as much a way to widen a grant as a create');
    assert.strictEqual(called('updateAgent')[0].args[12], false, 'and an update never switches embedding on');
});

test('an agent somebody has edited survives the update untouched', async () => {
    reset();
    liveAgents.set('agt_live', { id: 'agt_live', name: 'Desk', config: { tools: { gmail: { actions: ['send'], actAs: 'viewer' } } } });
    stamps.set('agt_1', { entityId: 'agt_live', installHash: hashDefinition({ tools: {} }), installedVersion: 1 });

    const result = await apply({
        projectId: 'p1', manifest: manifestWith({ agents: [AGENT('agt_1', { tools: {} })] }), ownerId: 'owner',
    });
    assert.strictEqual(called('updateAgent').length, 0);
    assert.ok(result.report.skipped.some(s => s.ref === 'agt_1' && /edited since/.test(s.why)));
});

test('an upgrade builds from the CHECKED manifest, not the caller\'s own object', async () => {
    // sanitizeManifest hands back a copy with the never-installable keys
    // removed. Reading the raw input here would quietly reinstate them for
    // everything the upgrade adds.
    reset();
    const manifest = manifestWith({
        webpages: [{ ref: 'web_1', name: 'Status', files: {}, bridgeGrants: { ai: { publicEnabled: true }, integrations: [{ tool: 't', fixedArgs: { k: 'LEAK-CANARY' } }] } }],
    });
    await apply({ projectId: 'p1', manifest, ownerId: 'owner' });
    assert.ok(!JSON.stringify(calls).includes('LEAK-CANARY'));
    assert.ok(!JSON.stringify(calls).includes('publicEnabled'));
});

test('een entiteit die niet te LEZEN is, is niet "door jou verwijderd"', async () => {
    // `.catch(() => null)` maakte van een storefout precies hetzelfde antwoord
    // als "bestaat niet meer", en de client zet daar de stelligste zin van de
    // dialoog bij: "{n} thing you deleted is not brought back — deleting them
    // was a decision". De eigenaar kreeg dan te horen dat hij iets had
    // weggegooid dat er gewoon staat, en de upgrade sloeg het over.
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: 'h', installedVersion: 1 });
    readThrows.add('a1');

    const { plan } = await planUpgrade({
        projectId: 'p1', manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }),
    });
    assert.deepStrictEqual(plan.missing, [], 'niet als verwijderd gerapporteerd');
    assert.deepStrictEqual(plan.replace, [], 'en zeker niet overschreven');
    assert.deepStrictEqual(plan.skip.map(x => x.ref), ['aut_1']);

    // De client splitst `skip` op twee signalen: de soort moet vergelijkbaar
    // zijn ÉN de `why` moet het woord "edited" bevatten (upgradeClient.planRows).
    // Deze reden bevat het NIET, dus de rij landt in "niet te bepalen" — de
    // derde toestand — in plaats van in "jij hebt dit aangepast".
    const why = plan.skip[0].why;
    assert.ok(!/\bedited\b/i.test(why), `"${why}" mag niet als "jij hebt dit aangepast" lezen`);
    assert.match(why, /could not be read/);
});

// ═══ What install chose survives the update (design 7: F3, F4, F5, F10, F11) ═══

const { applyRenameMap, wiringFromBindings } = require('./upgrade');

const TRIGGER = { id: 't', type: 'trigger', kind: 'webhook' };
const HTTP = (id) => ({ id, type: 'http_request', method: 'GET', url: 'https://example.test', auth: null });
const APPROVAL = (id) => ({ id, type: 'approval', approval: { details: 'Sign off?' } });

/** A stamp as install writes it now: pristine for `definition`, with its rename map. */
function stampFor(ref, entityId, definition, extra = {}) {
    stamps.set(ref, { ref, kind: 'automation', entityId, installHash: hashDefinition(definition), installedVersion: 1, ...extra });
}

test('an upgrade keeps the installer\'s connection and approver (F3)', async () => {
    reset();
    const installed = { schemaVersion: 2, trigger: TRIGGER, steps: [{ ...HTTP('s1'), auth: { connectionId: 'conn_mine' } }] };
    liveAutomations.set('a1', { id: 'a1', kind: 'automation', definition: installed });
    stampFor('aut_1', 'a1', installed);
    fx.bindings = [
        { slot: 'connection:aut_1:/s1', kind: 'connection', value: { ref: 'aut_1', layerKey: null, stepId: 's1', connectionId: 'conn_mine' } },
        { slot: 'seats:aut_1:/s2', kind: 'approver_seats', value: { ref: 'aut_1', layerKey: null, stepId: 's2', assignee: { groupId: 'g_finance' } } },
    ];

    // The newer file has the same holes the first one had, and a new approval step.
    const result = await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: { schemaVersion: 2, trigger: TRIGGER, steps: [HTTP('s1'), APPROVAL('s2')] } }] }),
    });
    assert.deepStrictEqual(result.report.replaced.map(r => r.ref), ['aut_1']);
    const written = called('updateAutomation')[0].args.updates.definition;
    assert.deepStrictEqual(written.steps[0].auth, { connectionId: 'conn_mine' }, 'the credential is not emptied by the update');
    assert.deepStrictEqual(written.steps[1].approval.assignee, { groupId: 'g_finance' });
    assert.strictEqual(result.report.resolved.length, 2);
    assert.deepStrictEqual(called('listBindings').map(c => c.args.projectId), ['p1']);
});

test('choices that cannot be read stop the update before anything is written', async () => {
    reset();
    stampFor('aut_1', 'a1', DEF_V1);
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });
    fx.bindingsThrow = true;
    // A server fault, so a 503 with a fixed sentence: never an `ok: false`
    // (the route answers that with a 400 echoing the text) and never the
    // driver's own message.
    await assert.rejects(
        apply({ projectId: 'p1', ownerId: 'alice', manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }) }),
        (err) => err.status === 503 && err.code === 'bindings_unavailable'
            && /could not be read, so nothing was updated/.test(err.message)
            && !/bindings table missing/.test(err.message),
    );
    assert.strictEqual(called('updateAutomation').length, 0);
    assert.strictEqual(called('upsertStamp').length, 0);
});

test('a webhook\'s trigger_step_id survives an upgrade: the installed step ids come back (F10)', async () => {
    reset();
    // Install renamed t → trg_inst and s1 → s1_inst, and kept the map.
    const installed = {
        schemaVersion: 2, trigger: { ...TRIGGER, id: 'trg_inst' },
        steps: [{ id: 's1_inst', type: 'code' }],
        edges: [{ from: 'trg_inst', to: 's1_inst' }],
    };
    liveAutomations.set('a1', { id: 'a1', kind: 'automation', definition: installed });
    const stepIdMap = { root: { t: 'trg_inst', s1: 's1_inst' }, layers: {} };
    stampFor('aut_1', 'a1', installed, { stepIdMap });

    const v2 = {
        schemaVersion: 2, trigger: TRIGGER,
        steps: [{ id: 's1', type: 'code' }, { id: 's2', type: 'notification', title: 'Done', body: 'Result: {{steps.s1.output}}' }],
        edges: [{ from: 't', to: 's1' }, { from: 's1', to: 's2' }],
    };
    await apply({ projectId: 'p1', ownerId: 'alice', manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: v2 }] }) });

    const written = called('updateAutomation')[0].args.updates.definition;
    assert.strictEqual(written.trigger.id, 'trg_inst', 'the webhook row points at this id');
    assert.strictEqual(written.steps[0].id, 's1_inst');
    const added = written.steps[1].id;
    assert.notStrictEqual(added, 's2', 'a step the new version adds gets a fresh id, like any install');
    assert.strictEqual(written.steps[1].body, 'Result: {{steps.s1_inst.output}}');
    assert.deepStrictEqual(written.edges, [{ from: 'trg_inst', to: 's1_inst' }, { from: 's1_inst', to: added }]);

    const stamp = called('upsertStamp').find(c => c.args.ref === 'aut_1').args;
    assert.deepStrictEqual(stamp.stepIdMap.root, { t: 'trg_inst', s1: 's1_inst', s2: added }, 'the new step joins the map');
    assert.strictEqual(stamp.installedVersion, 2);
});

test('an OLD install (no rename map, no bindings) upgrades exactly as it always did', async () => {
    // Installed before maps and bindings were kept: the definition is written as
    // the file has it, nothing is filled in, and the stamp's map stays NULL.
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1, stepIdMap: null });
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });
    const v2 = { schemaVersion: 2, trigger: TRIGGER, steps: [HTTP('s1'), APPROVAL('s2')] };

    const result = await apply({ projectId: 'p1', ownerId: 'alice', manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: v2 }] }) });
    assert.deepStrictEqual(called('updateAutomation')[0].args.updates, { definition: v2 });
    assert.deepStrictEqual(result.report.resolved, []);
    assert.strictEqual(called('updateAutomation')[0].args.updates.definition.steps[0].auth, null);
    const stamp = called('upsertStamp')[0].args;
    assert.ok(!('stepIdMap' in stamp), 'NULL stays NULL: the stamp write does not touch the map');
    assert.strictEqual(stamp.installedVersion, 2);
});

test('installed_version follows the upgrade (F5)', async () => {
    reset();
    stampFor('aut_1', 'a1', DEF_V1);
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });
    const result = await apply({ projectId: 'p1', ownerId: 'alice', manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }, 3) });
    assert.deepStrictEqual(called('setInstalledVersion').map(c => c.args), [['p1', 3]]);
    assert.strictEqual(result.versionRecorded, true);
});

test('a part that failed keeps the old installed_version, so the same release can be retried', async () => {
    // The route refuses a release that is not newer than installed_version
    // (409 not_newer). Recording it over a failed part would strand that part
    // until somebody published again.
    reset();
    stampFor('aut_1', 'a1', DEF_V1);
    stampFor('aut_2', 'a2', DEF_V1);
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });
    liveAutomations.set('a2', { id: 'a2', definition: DEF_V1 });
    fx.failUpdate.add('a2');
    const manifest = manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }, { ref: 'aut_2', definition: DEF_V2 }] }, 3);

    const result = await apply({ projectId: 'p1', ownerId: 'alice', manifest });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.report.failed.map(f => f.ref), ['aut_2']);
    assert.deepStrictEqual(called('setInstalledVersion'), [], 'installed_version stays put');
    assert.strictEqual(result.versionRecorded, false);
    assert.ok(result.report.warnings.some(w => /apply this update again/.test(w)));

    // The retry of the same release finds the landed part pristine and the
    // failed one still replaceable, and now records the version.
    fx.failUpdate.clear();
    for (const c of called('upsertStamp')) stamps.set(c.args.ref, { ...stamps.get(c.args.ref), ...c.args });
    calls.length = 0;
    const again = await apply({ projectId: 'p1', ownerId: 'alice', manifest });
    assert.deepStrictEqual(again.report.replaced.map(r => r.ref).sort(), ['aut_1', 'aut_2']);
    assert.deepStrictEqual(called('setInstalledVersion').map(c => c.args), [['p1', 3]]);
});

test('a deliberate skip (capability the plan lacks) does not hold the version back', async () => {
    // A retry of the same release would refuse the app again; holding the
    // version back would only let this release be re-applied without end.
    reset();
    stampFor('aut_1', 'a1', DEF_V1);
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });
    const result = await apply({
        projectId: 'p1', ownerId: 'alice', can: (cap) => cap !== 'app_studio',
        manifest: manifestWith({
            automations: [{ ref: 'aut_1', definition: DEF_V2 }],
            apps: [{ ref: 'app_1', name: 'Desk', definition: { actions: {} } }],
        }, 3),
    });
    assert.deepStrictEqual(result.report.failed.map(f => [f.ref, f.permanent]), [['app_1', true]]);
    assert.deepStrictEqual(called('setInstalledVersion').map(c => c.args), [['p1', 3]]);
    assert.strictEqual(result.versionRecorded, true);
});

test('an added app arrives with every {$ref} resolved, existing and added targets alike (F11)', async () => {
    reset();
    stampFor('aut_1', 'a1', DEF_V1);
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });
    const result = await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({
            automations: [
                { ref: 'aut_1', definition: DEF_V1 },
                { ref: 'aut_2', kind: 'automation', title: 'New', triggerType: 'manual', definition: DEF_V1 },
            ],
            apps: [{ ref: 'app_1', name: 'Desk', definition: { actions: {
                old: { kind: 'run_automation', automationId: { $ref: 'aut_1' } },
                fresh: { kind: 'run_automation', automationId: { $ref: 'aut_2' } },
            } } }],
        }),
    });
    const patched = called('saveDefinition').find(c => c.args.id === 'app_new');
    assert.ok(patched, 'the added app was patched');
    assert.ok(!JSON.stringify(patched.args.definition).includes('$ref'));
    assert.strictEqual(patched.args.definition.actions.old.automationId, 'a1');
    assert.strictEqual(patched.args.definition.actions.fresh.automationId, result.report.added.automations[0].id);
    // And it is stamped as it is stored, so it is pristine for the next one.
    assert.ok(called('upsertStamp').some(c => c.args.ref === 'app_1' && c.args.entityId === 'app_new'));
});

// ── Uniform go-live (F4): an update changes what runs, never whether it runs ──

test('a LIVE automation goes live on the new version; a draft stays a draft', async () => {
    reset();
    stampFor('aut_1', 'a_live', DEF_V1);
    stampFor('aut_2', 'a_draft', DEF_V1);
    liveAutomations.set('a_live', { id: 'a_live', kind: 'automation', definition: DEF_V1, liveVersion: 4, isActive: true });
    liveAutomations.set('a_draft', { id: 'a_draft', kind: 'automation', definition: DEF_V1, liveVersion: null, isActive: false });
    await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }, { ref: 'aut_2', definition: DEF_V2 }] }),
    });
    const byId = new Map(called('updateAutomation').map(c => [c.args.id, c.args]));
    assert.strictEqual(byId.get('a_live').opts.goLive, true);
    assert.strictEqual(byId.get('a_live').updates.triggerType, 'manual', 'the trigger columns move with it');
    assert.strictEqual(byId.get('a_live').updates.isActive, undefined, 'on/off is never touched');
    assert.strictEqual(byId.get('a_draft').opts.goLive, false);
    assert.deepStrictEqual(Object.keys(byId.get('a_draft').updates), ['definition']);
    assert.deepStrictEqual(called('convergeAfterPublish').map(c => c.args), [{ id: 'a_live', reason: 'upgrade' }]);
    assert.deepStrictEqual(called('planGoLive').map(c => c.args.opts.willBeActive), [true]);
});

test('a published Step gets its new version published; an unpublished one does not', async () => {
    reset();
    stampFor('aut_1', 'b_pub', DEF_V1);
    stampFor('aut_2', 'b_draft', DEF_V1);
    liveAutomations.set('b_pub', { id: 'b_pub', kind: 'block', definition: DEF_V1, publishedVersion: 3 });
    liveAutomations.set('b_draft', { id: 'b_draft', kind: 'block', definition: DEF_V1, publishedVersion: null });
    await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', kind: 'block', definition: DEF_V2 }, { ref: 'aut_2', kind: 'block', definition: DEF_V2 }] }),
    });
    assert.deepStrictEqual(called('publishStep').map(c => c.args.id), ['b_pub']);
    assert.strictEqual(called('convergeAfterPublish').length, 0);
});

test('a published app serves the new version; an unpublished one stays unpublished', async () => {
    reset();
    const appV1 = { screens: [] };
    for (const [id, isPublished] of [['app_pub', true], ['app_draft', false]]) {
        liveApps.set(id, { id, definition: appV1, definitionVersion: 1, isPublished, userId: 'installer' });
    }
    stamps.set('app_1', { ref: 'app_1', kind: 'app', entityId: 'app_pub', installHash: hashDefinition(appV1), installedVersion: 1 });
    stamps.set('app_2', { ref: 'app_2', kind: 'app', entityId: 'app_draft', installHash: hashDefinition(appV1), installedVersion: 1 });
    const appV2 = { screens: [{ id: 'home' }] };
    await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ apps: [{ ref: 'app_1', name: 'A', definition: appV2 }, { ref: 'app_2', name: 'B', definition: appV2 }] }),
    });
    const published = called('setStudioAppPublished').map(c => c.args);
    assert.strictEqual(published.length, 1);
    const [id, isPublished, owner, groups, org, def, version] = published[0];
    assert.deepStrictEqual([id, isPublished, owner, groups, org], ['app_pub', true, 'installer', undefined, undefined]);
    assert.deepStrictEqual(def, appV2);
    assert.strictEqual(version, 2);
});

test('a published page pins a snapshot of the new files; an unpublished page gets none', async () => {
    reset();
    for (const [id, pin] of [['web_pub', 'ver_old'], ['web_draft', null]]) {
        livePages.set(id, { id, userId: 'installer', publishedVersionId: pin });
        stamps.set(id === 'web_pub' ? 'web_1' : 'web_2', { ref: id === 'web_pub' ? 'web_1' : 'web_2', kind: 'webpage', entityId: id, installHash: hashDefinition({ html: '', css: '', js: '' }), installedVersion: 1 });
    }
    await apply({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ webpages: [
            { ref: 'web_1', name: 'P', files: { html: '<h1>v2</h1>' } },
            { ref: 'web_2', name: 'D', files: { html: '<h1>v2</h1>' } },
        ] }),
    });
    assert.deepStrictEqual(called('createVersion').map(c => [c.args[0], c.args[1], c.args[4]]), [['installer', 'web_pub', 'published']]);
    assert.deepStrictEqual(called('setPublishedVersion').map(c => c.args), [['web_pub', 'installer', 'ver_new']]);
    assert.deepStrictEqual(called('flush').map(c => c.args), [['installer', 'web_pub']]);
    assert.ok(called('writeSlot').every(c => c.args[0] === 'installer'), 'written into the page owner\'s files');
});

test('a published agent publishes the new config, and keeps its embedding', async () => {
    reset();
    const installed = { tools: {} };
    liveAgents.set('agt_pub', { id: 'agt_pub', name: 'Desk', config: installed, published_version: 2, embed_enabled: true });
    liveAgents.set('agt_draft', { id: 'agt_draft', name: 'Desk', config: installed, published_version: 0, embed_enabled: false });
    stamps.set('agt_1', { ref: 'agt_1', kind: 'agent', entityId: 'agt_pub', installHash: hashDefinition(installed), installedVersion: 1 });
    stamps.set('agt_2', { ref: 'agt_2', kind: 'agent', entityId: 'agt_draft', installHash: hashDefinition(installed), installedVersion: 1 });
    await apply({
        projectId: 'p1', ownerId: 'owner',
        manifest: manifestWith({ agents: [AGENT('agt_1', { tools: {}, temperature: 0.2 }), AGENT('agt_2', { tools: {} })] }),
    });
    const embeds = new Map(called('updateAgent').map(c => [c.args[0], c.args[12]]));
    assert.strictEqual(embeds.get('agt_pub'), true, 'an update never takes embedding away (F3)');
    assert.strictEqual(embeds.get('agt_draft'), false, 'nor switches it on');
    assert.deepStrictEqual(called('publishAgentVersion').map(c => c.args.id), ['agt_pub']);
    assert.strictEqual(called('publishAgentVersion')[0].args.opts.config.temperature, 0.2);
});

// ── The two helpers, on their own ──

test('applyRenameMap: no map is identity, and the input is never mutated', () => {
    const def = { schemaVersion: 2, trigger: TRIGGER, steps: [{ id: 's1', type: 'code' }] };
    const before = JSON.stringify(def);
    const out = applyRenameMap(def, null);
    assert.deepStrictEqual(out, { definition: def, renameMap: null });
    assert.notStrictEqual(out.definition, def);
    applyRenameMap(def, { root: { s1: 'x_1' }, layers: {} });
    assert.strictEqual(JSON.stringify(def), before);
});

test('applyRenameMap maps a layer with its own map, and keeps entries of steps that left', () => {
    const def = {
        schemaVersion: 2, trigger: TRIGGER,
        steps: [{ id: 's1', type: 'call_layer', layerKey: 'lk' }],
        layers: { lk: { steps: [{ id: 's1', type: 'code' }, { id: 'l2', type: 'stop_error', message: 'from {{steps.s1.output}}' }] } },
    };
    const map = { root: { t: 'T1', s1: 'R1', gone: 'G1' }, layers: { lk: { s1: 'L1' } } };
    const { definition, renameMap } = applyRenameMap(def, map);
    assert.strictEqual(definition.steps[0].id, 'R1');
    assert.strictEqual(definition.steps[0].layerKey, 'lk', 'a layer key is not a step id');
    assert.strictEqual(definition.layers.lk.steps[0].id, 'L1', 'the layer has its own map');
    assert.strictEqual(definition.layers.lk.steps[1].message, 'from {{steps.L1.output}}');
    assert.strictEqual(renameMap.root.gone, 'G1', 'a step that comes back later comes back under its id');
    assert.strictEqual(renameMap.layers.lk.l2, definition.layers.lk.steps[1].id);
});

test('applyRenameMap never rewrites text that merely contains an id', () => {
    const def = { schemaVersion: 2, trigger: TRIGGER, steps: [{ id: 's1', type: 'notification', title: 's1', body: 'see s1 and steps.s1x' }] };
    const { definition } = applyRenameMap(def, { root: { s1: 'R1', t: 'T1' }, layers: {} });
    assert.strictEqual(definition.steps[0].id, 'R1');
    assert.strictEqual(definition.steps[0].title, 's1');
    assert.strictEqual(definition.steps[0].body, 'see s1 and steps.s1x');
});

test('wiringFromBindings: nothing kept is no wiring; a stage\'s own slots are not resolutions', () => {
    assert.strictEqual(wiringFromBindings([]), null);
    assert.strictEqual(wiringFromBindings([
        { slot: 'connection:cn_1', kind: 'connection', value: { connectionId: 'c', allowedHosts: [] } },
        { slot: 'notify:aut_1', kind: 'approver_seats', value: {} },
    ]), null);
    const wiring = wiringFromBindings([{ slot: 'table:invoices', kind: 'table', value: { datatableId: 'tbl_mine' } }]);
    assert.deepStrictEqual(wiring.resolutions.tables, [{ key: 'invoices', datatableId: 'tbl_mine' }]);
    assert.ok(wiring.freshTableIds.has('tbl_mine'), 'checked at install time, not warned about again');
});

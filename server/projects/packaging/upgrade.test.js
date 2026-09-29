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

require.cache[blueprintStorePath] = {
    id: blueprintStorePath, filename: blueprintStorePath, loaded: true,
    exports: {
        listStamps: async () => stamps,
        stampEntity: async (a) => record('stampEntity', a),
    },
};
require.cache[automationStorePath] = {
    id: automationStorePath, filename: automationStorePath, loaded: true,
    exports: {
        getAutomation: async (id) => {
            // Een store die GOOIT is iets anders dan een entiteit die er niet
            // meer is; het plan moet die twee uit elkaar houden.
            if (readThrows.has(id)) throw new Error('de routine is niet te lezen');
            return liveAutomations.get(id) || null;
        },
        updateAutomation: async (id, updates, userId) => record('updateAutomation', { id, updates, userId }),
        createAutomation: async (args) => { record('createAutomation', args); return { id: 'aut_new' }; },
    },
};
require.cache[studioAppStorePath] = {
    id: studioAppStorePath, filename: studioAppStorePath, loaded: true,
    exports: {
        getStudioApp: async (id) => liveApps.get(id) || null,
        saveDefinition: async (id, ownerId, definition) => record('saveDefinition', { id, ownerId, definition }),
        createStudioApp: async (args) => { record('createStudioApp', args); return { id: 'app_new' }; },
        setAppProject: async (...a) => record('setAppProject', a),
    },
};
require.cache[webpageStorePath] = {
    id: webpageStorePath, filename: webpageStorePath, loaded: true,
    exports: {
        getWebpageRaw: async () => null,
        readAllSlots: async () => ({ html: '', css: '', js: '' }),
        writeSlot: async (...a) => record('writeSlot', a),
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

function reset() {
    calls.length = 0;
    stamps.clear();
    readThrows.clear();
    liveAutomations.clear();
    liveApps.clear();
    liveAgents.clear();
}
const called = (n) => calls.filter(c => c.name === n);

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

    const result = await applyUpgrade({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }),
    });

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.report.replaced.map(r => r.ref), ['aut_1']);
    assert.deepStrictEqual(called('updateAutomation')[0].args.updates.definition, DEF_V2);
    // Re-stamped at the NEW version, or the same upgrade would be offered again.
    assert.strictEqual(called('stampEntity')[0].args.installedVersion, 2);
});

test('nothing is deleted, ever', async () => {
    reset();
    stamps.set('aut_1', { ref: 'aut_1', kind: 'automation', entityId: 'a1', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    stamps.set('aut_2', { ref: 'aut_2', kind: 'automation', entityId: 'a2', installHash: hashDefinition(DEF_V1), installedVersion: 1 });
    liveAutomations.set('a1', { id: 'a1', definition: DEF_V1 });
    liveAutomations.set('a2', { id: 'a2', definition: DEF_V1 });

    // The new version dropped aut_2 entirely.
    await applyUpgrade({
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

    await applyUpgrade({
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

    const result = await applyUpgrade({
        projectId: 'p1', ownerId: 'alice',
        manifest: manifestWith({ automations: [{ ref: 'aut_1', definition: DEF_V2 }] }),
    });
    assert.strictEqual(called('updateAutomation').length, 0, 'their work is not overwritten');
    assert.deepStrictEqual(result.report.skipped.map(s => s.ref), ['aut_1']);
});

test('an upgrade with no installer is refused', async () => {
    reset();
    const result = await applyUpgrade({ projectId: 'p1', manifest: manifestWith({}) });
    assert.strictEqual(result.ok, false);
});

// ═══ Tables and knowledge bases: added, never rewritten ══════════════

const TABLE = (ref = 'dt_1') => ({ ref, key: 'invoices', name: 'Invoices', description: 'billed', columns: [] });
const KB = (ref = 'kb_1') => ({ ref, name: 'Handbook', description: '' });

test('a table the new version ADDS is created', async () => {
    reset();
    const result = await applyUpgrade({
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

    const result = await applyUpgrade({ projectId: 'p1', manifest: manifestWith({ datatables: [TABLE()] }), ownerId: 'owner' });
    assert.strictEqual(called('createDatatable').length, 0, 'and nothing was created a second time');
    assert.strictEqual(result.report.replaced.length, 0);
});

test('an installed knowledge base is never renamed or re-scoped by an update', async () => {
    reset();
    stamps.set('kb_1', { entityId: 'kb_live', installHash: 'anything', installedVersion: 1 });
    const result = await applyUpgrade({ projectId: 'p1', manifest: manifestWith({ knowledgeBases: [KB()] }), ownerId: 'owner' });
    assert.strictEqual(called('createKB').length, 0);
    assert.strictEqual(result.report.replaced.length, 0);
    assert.strictEqual(result.report.skipped.length, 1);
});

test('a knowledge base the new version adds is created and filed', async () => {
    reset();
    await applyUpgrade({ projectId: 'p1', manifest: manifestWith({ knowledgeBases: [KB()] }), ownerId: 'owner', organizationId: 'org1' });
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
    const result = await applyUpgrade({ projectId: 'p1', manifest, ownerId: 'owner' });

    assert.strictEqual(result.report.replaced.length, 1);
    const config = called('updateAgent')[0].args[11];
    assert.strictEqual(config.tools.gmail.actAs, 'viewer', 'an update is as much a way to widen a grant as a create');
    assert.strictEqual(called('updateAgent')[0].args[12], false, 'and an update never switches embedding on');
});

test('an agent somebody has edited survives the update untouched', async () => {
    reset();
    liveAgents.set('agt_live', { id: 'agt_live', name: 'Desk', config: { tools: { gmail: { actions: ['send'], actAs: 'viewer' } } } });
    stamps.set('agt_1', { entityId: 'agt_live', installHash: hashDefinition({ tools: {} }), installedVersion: 1 });

    const result = await applyUpgrade({
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
    await applyUpgrade({ projectId: 'p1', manifest, ownerId: 'owner' });
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

/**
 * Installing a Blueprint.
 *
 * The load-bearing behaviours:
 *
 *   1. TWO PASSES. A `{ $ref }` can only resolve once its target has a real id,
 *      so everything is created first and the references are patched after. If
 *      this regressed, every install would produce entities that do not know
 *      about each other — which is precisely what a Blueprint exists to avoid.
 *   2. NOTHING ARRIVES LIVE. An installed automation must not start firing
 *      schedules and webhooks; an installed page must not be published.
 *   3. ONE OWNER. A cross-owner edge refuses at the moment someone presses the
 *      button, so an install that spread ownership would be born broken.
 *   4. A MISSING CAPABILITY SKIPS, IT DOES NOT FAIL. A Blueprint with apps
 *      landing without App Studio still installs its automations, and says what it
 *      could not install.
 *
 * Run: cd server && node --test projects/packaging/install.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    calls, live, liveApps, stageProjects, gallery, fx, reset, DEPS, called, install, AUTOMATION,
    studioAppStorePath, blueprintStorePath,
} = require('./installTestHarness');

const { installBlueprint, collectGrantRequires, safeInstallGrants } = require('./install');
const { buildManifest } = require('../../core/packaging/manifest');
// The REAL normalizer and the REAL default. What install hands the store is
// only half the proof — these two turn a patch into the row that would actually
// be written, so the assertions below are about what a page ENDS UP with.
const { normalizeBridgeGrants, DEFAULT_BRIDGE_GRANTS } = require('../../stores/webpage/bridgeGrants');

// ═══ Two passes ══════════════════════════════════════════════════════

test('an app arrives knowing which automation it runs', async () => {
    reset();
    const result = await install({
        automations: [AUTOMATION('aut_1')],
        apps: [{ ref: 'app_1', name: 'Desk', definition: { actions: { go: { kind: 'run_automation', automationId: { $ref: 'aut_1' } } } } }],
    });

    assert.strictEqual(result.ok, true);
    const patch = called('saveDefinition')[0];
    const realId = called('createAutomation').length ? 'aut_1' : null;
    assert.ok(realId, 'the automation was created');
    // The $ref is gone and a real id is in its place.
    assert.strictEqual(patch.args.definition.actions.go.automationId, 'aut_1');
});

test('a webpage grant is reconnected too — when it points INSIDE the bundle', async () => {
    // The one grant an install can vouch for: the automation it names is an automation
    // this same install just created, under this same installer.
    reset();
    await install({
        automations: [AUTOMATION('aut_1')],
        webpages: [{ ref: 'web_1', name: 'Status', bridgeGrants: { automations: [{ automationId: { $ref: 'aut_1' }, label: 'Run' }] } }],
    });
    const patch = called('updateBridgeGrants')[0];
    assert.strictEqual(patch.args.patch.automations[0].automationId, 'aut_1');
    assert.strictEqual(patch.args.patch.automations[0].label, 'Run');
});

test('a call_block is reconnected inside the automation that calls it', async () => {
    reset();
    await install({
        automations: [
            AUTOMATION('aut_1', 'block'),
            AUTOMATION('aut_2', 'automation', {
                definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'call_block', blockId: { $ref: 'aut_1' } }] },
            }),
        ],
    });
    const patched = called('updateAutomation').filter(c => c.args.updates.definition);
    assert.strictEqual(patched.length, 1, 'only the automation that had a $ref is re-saved');
    assert.strictEqual(patched[0].args.updates.definition.steps[0].blockId, 'aut_1');
});

test('blocks are created before the automations that call them', async () => {
    reset();
    await install({ automations: [AUTOMATION('aut_2', 'automation'), AUTOMATION('aut_1', 'block')] });
    const order = calls.filter(c => c.name === 'createStep' || c.name === 'createAutomation').map(c => c.args.title);
    assert.deepStrictEqual(order, ['Automation aut_1', 'Automation aut_2'], 'the block first, whatever order the file listed');
});

test('a block is created as a block (createStep), an automation as an automation', async () => {
    reset();
    const result = await install({ automations: [AUTOMATION('aut_1', 'block'), AUTOMATION('aut_2', 'automation')] });
    assert.strictEqual(called('createStep').length, 1);
    assert.strictEqual(called('createStep')[0].args.userId, 'installer');
    assert.strictEqual(called('createStep')[0].args.title, 'Automation aut_1');
    assert.strictEqual(called('createAutomation').length, 1);
    assert.strictEqual(called('createAutomation')[0].args.title, 'Automation aut_2');
    assert.ok(result.report.installed.automations.some(a => a.ref === 'aut_1'));
});

test('a reference to something that was not installed is DROPPED and named', async () => {
    reset();
    // App Studio is off, so the app never lands — and the page pointing at it
    // must not be left holding a plausible-looking id. It used to be written
    // back as `automationId: null`; a grant is not a field with a null in it,
    // it is authority, so the entry goes entirely. Still NAMED, which is the
    // half that must not regress.
    const result = await install(
        { apps: [{ ref: 'app_1', name: 'Desk', definition: {} }],
          webpages: [{ ref: 'web_1', name: 'Status', bridgeGrants: { automations: [{ automationId: { $ref: 'app_1' } }] } }] },
        { can: (f) => f !== 'app_studio' },
    );
    const patch = called('updateBridgeGrants')[0];
    assert.deepStrictEqual(patch.args.patch.automations, []);
    assert.ok(result.report.warnings.some(w => /could not be connected/.test(w)));
});

// ═══ Nothing arrives live, and it all belongs to one person ══════════

test('automations are created through the path that makes them inactive', async () => {
    reset();
    await install({ automations: [AUTOMATION('aut_1')] });
    const args = called('createAutomation')[0].args;
    // createAutomation inserts is_active FALSE / is_draft TRUE. Install must not
    // be the thing that changes that, so it passes no activation of any kind.
    assert.strictEqual(args.isActive, undefined);
    assert.strictEqual(args.nextRunAt, undefined);
    assert.strictEqual(called('updateAutomation').some(c => c.args.updates.isActive), false);
});

test('a webpage is never published on arrival', async () => {
    reset();
    await install({ webpages: [{ ref: 'web_1', name: 'Status', files: { html: '<h1>Hi</h1>' } }] });
    const args = called('createWebpage')[0].args;
    assert.strictEqual(args.isPublished, undefined);
    assert.strictEqual(args.sharedGroups, undefined);
    assert.strictEqual(called('writeSlot')[0].args[2], 'html');
});

test('a webpage writes its files into the store slot names html / css / js', async () => {
    reset();
    await install({ webpages: [{ ref: 'web_1', name: 'Status', files: { html: '<h1>Hi</h1>', css: 'h1{}', js: 'x()' } }] });
    assert.deepStrictEqual(called('writeSlot').map(c => c.args[2]), ['html', 'css', 'js']);
});

test('an installed Blueprint is a Studio Solution, never a collaborative project', async () => {
    reset();
    await install({ automations: [AUTOMATION('aut_1')] });
    assert.strictEqual(called('createProject')[0].args.kind, 'solution',
        'it must list under Studio Solutions only, not on the Projects page');
});

test('everything is created under the installer', async () => {
    reset();
    await install({
        automations: [AUTOMATION('aut_1')],
        apps: [{ ref: 'app_1', name: 'Desk', definition: {} }],
        webpages: [{ ref: 'web_1', name: 'Status' }],
    });
    assert.strictEqual(called('createProject')[0].args.ownerId, 'installer');
    assert.strictEqual(called('createAutomation')[0].args.userId, 'installer');
    assert.strictEqual(called('createStudioApp')[0].args.userId, 'installer');
    assert.strictEqual(called('createWebpage')[0].args.userId, 'installer');
});

test('every entity is filed into the new project', async () => {
    reset();
    await install({
        automations: [AUTOMATION('aut_1')],
        apps: [{ ref: 'app_1', name: 'Desk', definition: {} }],
        webpages: [{ ref: 'web_1', name: 'Status' }],
    });
    assert.strictEqual(called('updateAutomation')[0].args.updates.projectId, 'proj_new');
    assert.strictEqual(called('setAppProject')[0].args[2], 'proj_new');
    assert.strictEqual(called('setWebpageProject')[0].args[2], 'proj_new');
});

// ═══ Skip, never fail ════════════════════════════════════════════════

test('a locked capability skips its kind and installs the rest', async () => {
    reset();
    const result = await install(
        { automations: [AUTOMATION('aut_1')], apps: [{ ref: 'app_1', name: 'Desk', definition: {} }] },
        { can: (f) => f !== 'app_studio' },
    );
    assert.strictEqual(result.ok, true, 'a partly-usable Solution beats an unusable one');
    assert.strictEqual(result.report.installed.automations.length, 1);
    assert.strictEqual(result.report.installed.apps.length, 0);
    assert.deepStrictEqual(result.report.skipped, [{ ref: 'app_1', kind: 'app', why: 'App Studio is not part of this plan.', permanent: true }]);
});

test('one entity failing does not take the install down, and is named', async () => {
    reset();
    const store = require.cache[studioAppStorePath].exports;
    const original = store.createStudioApp;
    store.createStudioApp = async () => { throw new Error('disk full'); };
    try {
        const result = await install({ automations: [AUTOMATION('aut_1')], apps: [{ ref: 'app_1', name: 'Desk', definition: {} }] });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.report.skipped[0].why, 'disk full', 'an install that half-worked and said nothing is worse');
    } finally { store.createStudioApp = original; }
});

// ═══ Refusals ════════════════════════════════════════════════════════

test('a Blueprint whose refs do not resolve is refused before anything is created', async () => {
    reset();
    const result = await installBlueprint({
        manifest: buildManifest({ project: { id: 'p1' }, entities: { apps: [{ ref: 'app_1', definition: { go: { $ref: 'aut_9' } } }] } }),
        ownerId: 'installer',
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls.length, 0, 'nothing half-created');
});

test('a foreign file is refused', async () => {
    reset();
    const result = await installBlueprint({ manifest: { format: 'something.else' }, ownerId: 'installer' });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(calls.length, 0);
});

test('an install with no installer is refused', async () => {
    reset();
    const result = await installBlueprint({ manifest: buildManifest({ project: { id: 'p1' } }) });
    assert.strictEqual(result.ok, false);
});

test('what the installer still has to supply is carried into the report', async () => {
    reset();
    const manifest = buildManifest({
        project: { id: 'p1', name: 'Onboarding' },
        requires: [{ kind: 'approver', count: 3 }],
    });
    const result = await installBlueprint({ manifest, ownerId: 'installer' });
    assert.ok(result.report.warnings.some(w => /3 approver\(s\) supplying/.test(w)));
});

// ═══ Stamps, so a later upgrade can tell touched from untouched ══════

test('every installed entity records what it looked like on arrival', async () => {
    reset();
    await install({
        automations: [AUTOMATION('aut_1')],
        apps: [{ ref: 'app_1', name: 'Desk', definition: { a: 1 } }],
        webpages: [{ ref: 'web_1', name: 'Status', files: { html: '<h1>Hi</h1>' } }],
    });

    const stamps = called('upsertStamp').map(c => c.args);
    assert.deepStrictEqual(stamps.map(s => s.ref).sort(), ['app_1', 'aut_1', 'web_1']);
    for (const stamp of stamps) {
        assert.strictEqual(stamp.projectId, 'proj_new');
        assert.ok(stamp.installHash, `${stamp.ref} has no hash to compare against later`);
        assert.strictEqual(stamp.installedVersion, 1);
    }
});

test('a stamp that cannot be written does not fail the install', async () => {
    reset();
    const store = require.cache[blueprintStorePath].exports;
    const original = store.upsertStamp;
    store.upsertStamp = async () => { throw new Error('table missing'); };
    try {
        const result = await install({ automations: [AUTOMATION('aut_1')] });
        // A Solution that installed but cannot be auto-upgraded later is a
        // smaller problem than one that refused to install at all.
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.report.installed.automations.length, 1);
        assert.ok(result.report.warnings.some(w => /will not be offered future updates/.test(w)));
    } finally { store.upsertStamp = original; }
});

test('two entities never share a stamp slot', async () => {
    reset();
    await install({ automations: [AUTOMATION('aut_1'), AUTOMATION('aut_2')] });
    const refs = called('upsertStamp').map(c => c.args.ref);
    assert.strictEqual(new Set(refs).size, refs.length);
});

// ═══ Tables, agents and knowledge bases ══════════════════════════════

test('a table is created in ONE transaction, filed at INSERT, columns and all', async () => {
    reset();
    const result = await install({
        datatables: [{
            ref: 'dt_1', key: 'invoices', name: 'Invoices', description: 'what we billed',
            rowScope: 'all', retentionDays: 90, retentionField: 'created_at',
            columns: [{ key: 'amount', name: 'Amount', type: 'number' }],
        }],
    });

    assert.strictEqual(result.ok, true);
    const create = called('createDatatable')[0].args;
    assert.deepStrictEqual(create.scope, { kind: 'org', id: 'org1' }, 'the installer\'s organisation, decided here');
    assert.strictEqual(create.ownerUserId, 'installer');
    assert.strictEqual(create.projectId, 'proj_new', 'stamped at INSERT, never patched afterwards');
    assert.strictEqual(create.key, 'invoices');
    assert.strictEqual(create.retentionDays, 90, 'a retention window protects the recipient, so it travels');
    assert.strictEqual(create.fields.length, 1);
    assert.match(create.fields[0].id, /^fld_/, 'the real normaliser minted a stable column id');

    // The physical DDL ran on the transaction's own client. Split across two
    // commits, a DDL failure leaves a table the picker lists and every read
    // 500s on — which is exactly what happened before applyPhysical existed.
    const migration = called('applyMigration')[0].args;
    assert.deepStrictEqual(migration.client, { marker: 'tx' });
    assert.ok(migration.statements.length >= 1);
});

test('a table without the plan for it is skipped, and the rest still installs', async () => {
    reset();
    const result = await install(
        { datatables: [{ ref: 'dt_1', key: 't', name: 'T', columns: [] }], automations: [AUTOMATION('aut_1')] },
        { can: (f) => f !== 'automations' },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(called('createDatatable').length, 0);
    assert.strictEqual(called('createAutomation').length, 1, 'a missing capability skips its own kind only');
    assert.ok(result.report.skipped.some(x => x.kind === 'datatable' && /not part of this plan/.test(x.why)));
});

test('a table that could not be created is NAMED, never silently absent', async () => {
    reset();
    fx.createDatatableThrows = true;
    const result = await install({ datatables: [{ ref: 'dt_1', key: 't', name: 'T', columns: [] }] });
    assert.strictEqual(result.ok, true);
    assert.ok(result.report.skipped.some(x => x.ref === 'dt_1' && /quota reached/.test(x.why)));
    assert.ok(called('invalidate').length >= 1, 'the engine memo goes with the rolled-back transaction');
});

test('a column list the normaliser refuses stops that table, not the install', async () => {
    reset();
    const result = await install({
        datatables: [{ ref: 'dt_1', key: 't', name: 'T', columns: [{ key: 'Not A Key', name: 'x', type: 'text' }] }],
    });
    assert.strictEqual(called('createDatatable').length, 0);
    assert.ok(result.report.skipped.some(x => x.ref === 'dt_1' && /column key/.test(x.why)));
});

test('AN INSTALLED AGENT NEVER ACTS AS ANYONE BUT ITS USER', async () => {
    // The rights proof at the receiving end. Capture already writes 'viewer',
    // so this file says `owner` the way a HAND-EDITED Blueprint would — the
    // case the whole belt-and-braces exists for.
    reset();
    await install({
        agents: [{
            ref: 'agt_1', name: 'Desk agent', description: 'helps', systemPrompt: 'be brief',
            model: 'tier:fast', starterPrompts: ['hi'],
            threadsEnabled: true, copyEnabled: true, workspaceEnabled: false,
            config: { tools: { gmail: { actions: '*', actAs: 'owner', confirm: 'direct' } } },
        }],
    });

    const args = called('createAgent')[0].args;
    const [name, description, systemPrompt, ownerId, model, starters, threads, copy, workspace, config, orgId, sharedGroups, categoryId] = args;
    assert.strictEqual(config.tools.gmail.actAs, 'viewer', 'the file said owner; the install says viewer');
    assert.strictEqual(name, 'Desk agent');
    assert.strictEqual(description, 'helps');
    assert.strictEqual(systemPrompt, 'be brief');
    assert.strictEqual(ownerId, 'installer', 'one owner: whoever installed it');
    assert.strictEqual(model, 'tier:fast');
    assert.deepStrictEqual(starters, ['hi']);
    assert.strictEqual(threads, true);
    assert.strictEqual(copy, true);
    assert.strictEqual(workspace, false);
    assert.strictEqual(orgId, 'org1');
    assert.deepStrictEqual(sharedGroups, [], 'shared with nobody until somebody says so');
    assert.strictEqual(categoryId, null, 'and filed under a category that is not theirs');
    // createAgent HAS no embed parameter, and the column defaults to FALSE —
    // so an installed agent is not embeddable because nothing said it was.
    assert.strictEqual(args.length, 13, 'no fourteenth argument crept in');

    const filed = called('setAgentProject')[0].args;
    assert.deepStrictEqual(filed, ['agt_1', 'installer', 'proj_new']);
});

test('an agent grant list that is junk installs as no grant, not as every grant', async () => {
    reset();
    await install({ agents: [{ ref: 'agt_1', name: 'A', config: { tools: { gmail: 'not-an-object' } } }] });
    const config = called('createAgent')[0].args[9];
    assert.strictEqual(config.tools.gmail, 'not-an-object', 'stored as given — the runtime re-clamps what it reads');
});

test('a knowledge base installs as a shell and is filed through the adapter', async () => {
    reset();
    await install({
        knowledgeBases: [{ ref: 'kb_1', name: 'Handbook', description: 'how we work', icon: '📘', usageContexts: ['chat'] }],
    });
    const [tenantId, name, description, organizationId, extra] = called('createKB')[0].args;
    assert.strictEqual(tenantId, 'installer');
    assert.strictEqual(name, 'Handbook');
    assert.strictEqual(description, 'how we work');
    assert.strictEqual(organizationId, 'org1');
    assert.strictEqual(extra.categoryId, null, 'a category id names a row this install does not have');
    assert.strictEqual(extra.sourceKind, 'manual');
    assert.deepStrictEqual(extra.usageContexts, ['chat']);

    // Through the adapter, so the compare-and-swap on projects.version applies
    // to an install exactly as it does to a person clicking the button.
    const filed = called('setKnowledgeBaseProject')[0].args;
    assert.strictEqual(filed.kbId, 'kb_1');
    assert.strictEqual(filed.ctxProjectId, 'proj_new');
});

test('a base that could not be filed is reported, not left silently loose', async () => {
    reset();
    fx.kbFiled = false;
    const result = await install({ knowledgeBases: [{ ref: 'kb_1', name: 'Handbook' }] });
    assert.ok(result.report.warnings.some(w => /could not be filed into the Solution/.test(w)));
});

// ═══ Bridge grants are REQUIRES, not data ════════════════════════════
//
// A page's bridge_grants say what its script.js may call, and those bridges run
// AS THE PAGE'S AUTHOR — who, after an install, is the installer. So a granted
// tool in a Blueprint is not a description of the page: it is a request for
// authority over the account of whoever presses the button. Install writes only
// what it can vouch for and SHOWS the rest.
//
// Every assertion here goes through the REAL normalizeBridgeGrants, because the
// patch install hands the store is only half the story: the store rebuilds the
// whole column from that patch, and the column is what a runtime check reads.

/** What would actually land in the bridge_grants column for this patch. */
const stored = (patch) => normalizeBridgeGrants(patch);

test('A BLUEPRINT FROM ANOTHER ORG CANNOT PRE-ARM ANYTHING', async () => {
    // The whole threat model in one file. Live before this: capture cloned
    // bridge_grants whole, install wrote them back through updateBridgeGrants,
    // and the store accepts publicEnabled with a spend cap up to $50/day and an
    // integrations list whose tool names are executed as the page's author.
    // A hand-made file from anywhere could arrive pre-armed.
    reset();
    const result = await install({
        automations: [AUTOMATION('aut_1')],
        webpages: [{
            ref: 'web_1', name: 'Status',
            bridgeGrants: {
                ai: {
                    enabled: true, publicEnabled: true, publicGroundOnPage: true,
                    publicSpendCapUsd: 50, publicDefaultTier: 'balanced',
                    public_iets_nieuws: 'LEAK-CANARY',
                },
                integrations: [
                    { tool: 'nextcloud_upload_file', fixedArgs: { token: 'LEAK-CANARY-ARGS' } },
                    { tool: 'gmail_send' },
                ],
                // An id from the installation this file came FROM. It is a
                // plain string, so no $ref rewriting ever looks at it.
                automations: [{ automationId: 'aut_from_their_instance', label: 'Send invoices' }],
                // Two grant kinds the column DOES know (W3): a table binding
                // and an agent. install rebuilds the patch from its own
                // allow-list, so neither can ride along either.
                tables: [{ datatableId: 'tbl_theirs', mode: 'readwrite', columns: ['bsn'], publicColumns: ['bsn'] }],
                agent: { agentId: 'agt_theirs' },
            },
        }],
    });

    assert.strictEqual(result.ok, true);
    const patch = called('updateBridgeGrants')[0].args.patch;
    const row = stored(patch);

    // 1. Public AI is OFF, whatever the file said. This is the assertion the
    //    plan names: publicEnabled:true installs as publicEnabled:false.
    assert.strictEqual(row.ai.publicEnabled, false, 'a file may not arm anonymous spending on the installer\'s account');
    assert.strictEqual(row.ai.publicGroundOnPage, false);
    assert.strictEqual(row.ai.publicSpendCapUsd, DEFAULT_BRIDGE_GRANTS.ai.publicSpendCapUsd,
        'and it may not raise the cap either — the store\'s own default, not the file\'s $50');

    // 2. No integration grant at all. The TOOL NAME is the grant: it does not
    //    matter that fixedArgs were stripped upstream, `gmail_send` running as
    //    the installer is the thing being refused.
    assert.deepStrictEqual(row.integrations, []);

    // 3. An automation id from another installation is not a reference to
    //    anything in this bundle, so it is not carried.
    assert.deepStrictEqual(row.automations, []);

    // 4. Nothing else survives either. The column has exactly the keys the
    //    normalizer knows, and the two kinds this file DOES name by their real
    //    names land on their empty starting value instead of on what was
    //    asked. A kind the normalizer does not know yet starts absent.
    assert.deepStrictEqual(Object.keys(row).sort(), ['agent', 'ai', 'automations', 'integrations', 'tables']);
    assert.deepStrictEqual(row.tables, [], 'a file may not pre-bind one of the installer\'s tables');
    assert.strictEqual(row.agent, null, 'nor aim the page at an agent in the installer\'s account');
    assert.ok(!JSON.stringify(row).includes('tbl_theirs'));
    assert.ok(!JSON.stringify(row).includes('agt_theirs'));

    // 5. And no canary reached the store on any path.
    assert.ok(!JSON.stringify(calls).includes('LEAK-CANARY'));
});

test('what it refused to grant is REPORTED, not swallowed', async () => {
    // Dropping a request silently turns "we do not grant this for you" into
    // "this Solution is broken and nobody said why". These rows are what the
    // install wizard's Connect step lists.
    reset();
    const result = await install({
        webpages: [{
            ref: 'web_1', name: 'Status',
            bridgeGrants: {
                ai: { publicEnabled: true, publicSpendCapUsd: 50 },
                integrations: [{ tool: 'gmail_send', label: 'Mail it' }],
                automations: [{ automationId: 'aut_from_their_instance' }],
            },
        }],
    });

    const rows = result.report.grantRequires;
    assert.strictEqual(rows.length, 3, 'a tool, an out-of-bundle automation and the public-AI request');

    const tool = rows.find(r => r.kind === 'integration');
    assert.strictEqual(tool.tool, 'gmail_send');
    assert.strictEqual(tool.name, 'Status', 'named on the page that asked for it');
    assert.strictEqual(tool.ref, 'web_1');

    const foreign = rows.find(r => r.kind === 'automation');
    assert.strictEqual(foreign.automationId, 'aut_from_their_instance');

    const publicAi = rows.find(r => r.kind === 'public_ai');
    assert.strictEqual(publicAi.flags.publicEnabled, true);
    assert.strictEqual(publicAi.flags.publicSpendCapUsd, 50,
        'the size of the request travels: $2 and $50 are not the same decision');

    // Said in words too, so the plain install button is not silent about it.
    assert.ok(result.report.warnings.some(w => /Status.*never grants those on your behalf/s.test(w)));
});

test('fixedArgs are never echoed back onto a screen either', async () => {
    reset();
    const result = await install({
        webpages: [{
            ref: 'web_1', name: 'Status',
            bridgeGrants: { integrations: [{ tool: 'nextcloud_upload_file', fixedArgs: { token: 'LEAK-CANARY-ARGS' } }] },
        }],
    });
    // The tool name is what the installer has to re-grant; the arguments can
    // hold a path, an id or a token, so the row that names the tool does not
    // carry them.
    assert.strictEqual(result.report.grantRequires[0].tool, 'nextcloud_upload_file');
    assert.strictEqual(result.report.grantRequires[0].fixedArgs, undefined);
    assert.ok(!JSON.stringify(result.report).includes('LEAK-CANARY-ARGS'));
    assert.ok(!JSON.stringify(calls).includes('LEAK-CANARY-ARGS'));
});

test('an in-bundle grant is not reported as something to re-assign', async () => {
    // The complement: install DOES carry this one, so listing it in the wizard
    // would ask somebody to grant what they already have.
    reset();
    const result = await install({
        automations: [AUTOMATION('aut_1')],
        webpages: [{ ref: 'web_1', name: 'Status', bridgeGrants: { automations: [{ automationId: { $ref: 'aut_1' } }] } }],
    });
    assert.deepStrictEqual(result.report.grantRequires, []);
    assert.strictEqual(stored(called('updateBridgeGrants')[0].args.patch).automations[0].automationId, 'aut_1');
});

test('a page with no grants at all still lands on the store default', async () => {
    // The `ai` block is WRITTEN, not omitted. Leaving it out would work today —
    // an absent key means "keep what is there" — but that makes the safety of an
    // install depend on a default two modules away staying what it is.
    reset();
    await install({ webpages: [{ ref: 'web_1', name: 'Status' }] });
    const patch = called('updateBridgeGrants')[0].args.patch;
    assert.deepStrictEqual(patch.ai, { ...DEFAULT_BRIDGE_GRANTS.ai }, 'said out loud, not inherited');
    assert.deepStrictEqual(patch.integrations, []);
    assert.deepStrictEqual(patch.automations, []);
});

// ═══ collectGrantRequires, on its own ════════════════════════════════

test('the requires are read off the RAW manifest, before the public keys are stripped', () => {
    // sanitizeManifest removes every `ai.public*` key from the copy install
    // builds from. Reading the rows off THAT copy would show nothing was asked
    // for — which is precisely the fact worth showing.
    const manifest = buildManifest({
        project: { id: 'p1' },
        entities: {
            webpages: [{ ref: 'web_1', name: 'Status', bridgeGrants: { ai: { publicEnabled: true } } }],
        },
    });
    const { sanitizeManifest } = require('../../core/packaging/manifest');
    assert.strictEqual(collectGrantRequires(manifest).length, 1, 'the raw file asked for it');
    assert.strictEqual(collectGrantRequires(sanitizeManifest(manifest).manifest).length, 0,
        'and the checked copy no longer carries the evidence — so install must not read from it');
});

test('a public flag nobody has invented yet is reported by shape', () => {
    // Matched the way manifest.stripNeverInstallable matches: any key under
    // `ai` starting with `public` that is switched ON.
    const rows = collectGrantRequires(buildManifest({
        project: { id: 'p1' },
        entities: { webpages: [{ ref: 'w', name: 'P', bridgeGrants: { ai: { publicSomethingNew: true } } }] },
    }));
    assert.strictEqual(rows[0].kind, 'public_ai');
    assert.strictEqual(rows[0].flags.publicSomethingNew, true);
});

test('a public cap without public AI switched on is not a request for anything', () => {
    // A cap or a tier alone opens no door; a row for it would be noise on a
    // screen whose whole job is to be read.
    const rows = collectGrantRequires(buildManifest({
        project: { id: 'p1' },
        entities: { webpages: [{ ref: 'w', name: 'P', bridgeGrants: { ai: { publicEnabled: false, publicSpendCapUsd: 50, publicDefaultTier: 'balanced' } } }] },
    }));
    assert.deepStrictEqual(rows, []);
});

test('collectGrantRequires survives a file that is not shaped like a Blueprint', () => {
    // It runs on the RAW input, which is whatever somebody uploaded.
    assert.deepStrictEqual(collectGrantRequires(null), []);
    assert.deepStrictEqual(collectGrantRequires({}), []);
    assert.deepStrictEqual(collectGrantRequires({ solution: { entities: { webpages: 'nope' } } }), []);
    assert.deepStrictEqual(collectGrantRequires({ solution: { entities: { webpages: [{ ref: 'w', bridgeGrants: 'nope' }] } } }), []);
});

// ═══ safeInstallGrants, on its own — belt and braces ═════════════════
//
// The install path above is protected TWICE, and the outer layer hides the
// inner one: sanitizeManifest strips every `ai.public*` key before install ever
// sees the manifest, so an end-to-end test cannot tell whether install's own
// rule is doing anything. It is the same argument as the agent test above —
// capture already writes `actAs: 'viewer'`, and the install re-applies it
// anyway, because a rule that is only enforced upstream is a rule that
// disappears the day somebody adds a second way in (upgrade, a script, a repair
// tool). So the rule is asserted HERE, against a raw entity that still carries
// everything a hand-made file could carry.

test('safeInstallGrants writes the store default over ANY public-AI request', () => {
    const patch = safeInstallGrants(
        { bridgeGrants: { ai: { enabled: true, publicEnabled: true, publicGroundOnPage: true, publicSpendCapUsd: 50 } } },
        new Map(),
    );
    assert.deepStrictEqual(patch.ai, { ...DEFAULT_BRIDGE_GRANTS.ai });
    const row = normalizeBridgeGrants(patch);
    assert.strictEqual(row.ai.publicEnabled, false);
    assert.strictEqual(row.ai.publicGroundOnPage, false);
    assert.strictEqual(row.ai.publicSpendCapUsd, DEFAULT_BRIDGE_GRANTS.ai.publicSpendCapUsd);
});

test('safeInstallGrants never carries an integration grant, fixedArgs or not', () => {
    const patch = safeInstallGrants(
        { bridgeGrants: { integrations: [{ tool: 'gmail_send' }, { tool: 'nextcloud_upload_file', fixedArgs: { path: '/x' } }] } },
        new Map(),
    );
    assert.deepStrictEqual(patch.integrations, [],
        'the bridge runs as the page author — a tool name IS the authority being asked for');
});

test('safeInstallGrants keeps an in-bundle ref and drops everything else', () => {
    const refMap = new Map([['aut_1', 'real_aut_1']]);
    const unresolved = [];
    const patch = safeInstallGrants({
        bridgeGrants: {
            automations: [
                { automationId: { $ref: 'aut_1' }, label: 'Run' },   // in bundle → kept
                { automationId: { $ref: 'aut_gone' } },              // in file, never landed → dropped + named
                { automationId: 'aut_from_their_instance' },         // another installation's row → dropped
                { automationId: null },
                'not-even-an-object',
            ],
        },
    }, refMap, unresolved);

    assert.deepStrictEqual(patch.automations, [{ automationId: 'real_aut_1', label: 'Run' }]);
    assert.deepStrictEqual(unresolved, ['aut_gone'], 'a grant that could not be connected is named, not silently gone');
});

test('safeInstallGrants writes its five keys and only those', () => {
    // updateBridgeGrants replaces the WHOLE column, so a grant kind install does
    // not vouch for starts EMPTY on an installed page rather than arriving from
    // a file. A table or agent named by a bare id (another installation's row)
    // is such a grant; a kind the normalizer does not know (somethingNew) too.
    const patch = safeInstallGrants(
        { bridgeGrants: {
            tables: [{ datatableId: 't', mode: 'readwrite' }],
            agent: { agentId: 'a' },
            somethingNew: true,
        } },
        new Map(),
    );
    assert.deepStrictEqual(Object.keys(patch).sort(), ['agent', 'ai', 'automations', 'integrations', 'tables']);

    const column = normalizeBridgeGrants(patch);
    assert.deepStrictEqual(Object.keys(column).sort(), ['agent', 'ai', 'automations', 'integrations', 'tables']);
    assert.deepStrictEqual(column.tables, [], 'a bare table id names nothing in this bundle');
    assert.strictEqual(column.agent, null);
    assert.strictEqual(column.somethingNew, undefined);
});

test('safeInstallGrants carries an in-bundle table and agent, never public columns (F14)', () => {
    const unresolved = [];
    const patch = safeInstallGrants(
        { bridgeGrants: {
            tables: [
                { datatableId: { $ref: 'dt_1' }, mode: 'readwrite', columns: ['name', 7], publicColumns: ['name'] },
                { datatableId: { $ref: 'dt_gone' }, mode: 'read' },
                { datatableId: null, mode: 'read' },
            ],
            agent: { agentId: { $ref: 'agt_1' } },
        } },
        new Map([['dt_1', 'tbl_real'], ['agt_1', 'agt_real']]),
        unresolved,
    );
    assert.deepStrictEqual(patch.tables, [{ datatableId: 'tbl_real', mode: 'readwrite', columns: ['name'], publicColumns: [] }]);
    assert.deepStrictEqual(patch.agent, { agentId: 'agt_real' });
    assert.deepStrictEqual(unresolved, ['dt_gone']);
    // And it survives the store's normaliser as written.
    assert.deepStrictEqual(normalizeBridgeGrants(patch).tables, patch.tables);
});

test('safeInstallGrants treats a page with no grants and a page with junk grants alike', () => {
    const empty = safeInstallGrants({}, new Map());
    assert.deepStrictEqual(empty, {
        ai: { ...DEFAULT_BRIDGE_GRANTS.ai }, automations: [], integrations: [], tables: [], agent: null,
    });
    assert.deepStrictEqual(safeInstallGrants({ bridgeGrants: 'nope' }, new Map()), empty);
    assert.deepStrictEqual(safeInstallGrants({ bridgeGrants: { automations: 'nope', integrations: 'nope', tables: 'nope', agent: 'nope' } }, new Map()), empty);
});

// ═══ Where a Solution came from ══════════════════════════════════════

test('installing from the gallery records which Blueprint it was', async () => {
    reset();
    await install({ automations: [AUTOMATION('aut_1')] }, { blueprintId: 'bp_abc' });
    assert.strictEqual(called('createProject')[0].args.installedFromBlueprintId, 'bp_abc',
        'written at INSERT, so a Solution can always say where it came from');
});

test('a file install claims no provenance', async () => {
    // `null`, not a guess: an installation nobody can trace back to a Blueprint
    // must not appear under "Installed" and must never be offered an update.
    // A file that DOES carry a `source` block is a different case — it is a
    // CLAIM, and what happens to a claim is the section below.
    reset();
    await install({ automations: [AUTOMATION('aut_1')] });
    assert.strictEqual(called('createProject')[0].args.installedFromBlueprintId, null);
});

// ═══ O4: a manifest is INPUT, not authorisation ════════════════════
//
// The provenance block (`manifest.source`) travels in a file that anyone with a text editor can
// change. This section pins exactly what happens with such a claim — recorded, never believed — and
// what does NOT happen with it.

const { provenanceOf } = require('./install');

/** Een manifest dat over zichzelf beweert ergens vandaan te komen. */
const withClaim = (source, over = {}) => buildManifest({
    project: { id: 'p1', name: 'Onboarding' },
    entities: { automations: [AUTOMATION('aut_1')] },
    source,
    ...over,
});

test('een bestandsinstallatie legt de bewering vast ZODRA zij klopt, zodat zij mee kan tellen', async () => {
    // This is the only way in which a forwarded file can couple itself to its Blueprint; without this
    // coupling no file installation counts towards "how often is this installed". But the
    // coupling is first verified — see the test that follows.
    reset();
    gallery.set('bp_abc', { id: 'bp_abc', solutionKey: 'sol_p1' });
    await installBlueprint({
        manifest: withClaim({ blueprintId: 'bp_abc', orgId: 'org_sender', orgName: 'Acme', version: 3 }),
        ownerId: 'installer', organizationId: 'org_receiver',
    });
    const args = called('createProject')[0].args;
    assert.strictEqual(args.installedFromBlueprintId, 'bp_abc');
    assert.strictEqual(args.installedFromOrgId, 'org_sender');
    // Meta only: de galerijrij kan megabytes JSONB dragen en er is hier niets
    // van nodig behalve de solution_key.
    assert.deepStrictEqual(called('getBlueprintById')[0].args.opts, { includeManifest: false });
});

test('een bewering die naar de Blueprint van een ANDERE Oplossing wijst, telt niet mee', async () => {
    // THE FORGERY. Organisation A sends away two files: file-X (bp_x) and
    // file-Y (bp_y). Whoever opened file-X in a text editor and put `bp_y` in it
    // used to make the counter of bp_y rise while bp_y had been installed zero times — and the
    // screen presents that number as a LOWER bound. The `solution_key` of the gallery row is what
    // makes that impossible: file-X claims to be `sol_p1` and bp_y carries `sol_p9`.
    reset();
    gallery.set('bp_y', { id: 'bp_y', solutionKey: 'sol_p9' });
    await installBlueprint({
        manifest: withClaim({ blueprintId: 'bp_y', orgId: 'org_slachtoffer' }),
        ownerId: 'installer', organizationId: 'org_receiver',
    });
    const args = called('createProject')[0].args;
    assert.strictEqual(args.installedFromBlueprintId, null, 'geen koppeling, dus geen telling');
    assert.strictEqual(args.installedFromOrgId, null, 'en dus ook geen organisatie-id van een andere tenant');
});

test('een bewering die naar niets wijst, telt ook niet mee', async () => {
    reset();
    await installBlueprint({
        manifest: withClaim({ blueprintId: 'bp_bestaat_niet' }),
        ownerId: 'installer', organizationId: 'org_receiver',
    });
    assert.strictEqual(called('createProject')[0].args.installedFromBlueprintId, null);
});

test('een galerij-installatie loopt geen bewering na — de server heeft de rij zelf gelezen', async () => {
    reset();
    gallery.set('bp_x', { id: 'bp_x', solutionKey: 'sol_p1' });
    await installBlueprint({
        manifest: withClaim({ blueprintId: 'bp_x' }),
        blueprintId: 'bp_echt', blueprintOrgId: 'org_echt',
        ownerId: 'installer', organizationId: 'org_receiver',
    });
    assert.deepStrictEqual(called('getBlueprintById'), [], 'geen extra lees op het vastgestelde pad');
    assert.strictEqual(called('createProject')[0].args.installedFromBlueprintId, 'bp_echt');
});

test('een vijandig manifest verhuist zijn installatie niet naar de organisatie die het noemt', async () => {
    // THE CORE. `source.orgId` is a claim; the organisation of the PROJECT
    // is that of the installer, and nothing in the file changes that. Were that otherwise, a file
    // would grant itself the read rights of another organisation.
    reset();
    await installBlueprint({
        manifest: withClaim({ blueprintId: 'bp_victim', orgId: 'org_victim', orgName: 'Not Us' }),
        ownerId: 'installer', organizationId: 'org_receiver',
    });
    const args = called('createProject')[0].args;
    assert.strictEqual(args.organizationId, 'org_receiver',
        'de installatie hoort bij de installateur, niet bij de organisatie die het bestand noemt');
    // And the claim itself is not even written down: there is no gallery row
    // `bp_victim` that carries this Solution, so it cannot be verified. Were it to be, it would be history and
    // still no right — who may see the installation count is decided by the owner role on the source project.
    assert.strictEqual(args.installedFromOrgId, null);
});

test('een vijandig manifest kan zijn eigen versienummer niet opblazen', async () => {
    // Two numbers in the same file: `solution.version` (which every stamp carries) and
    // `source.version`. Exactly ONE of them is read, otherwise the project says something different from
    // its own stamps — and then a lagging installation reads as up to date.
    reset();
    await installBlueprint({
        manifest: withClaim({ blueprintId: 'bp_abc', version: 99 }, { version: 2 }),
        ownerId: 'installer', organizationId: 'org_receiver',
    });
    assert.strictEqual(called('createProject')[0].args.installedVersion, 2);
    const stamps = called('upsertStamp').map(c => c.args.installedVersion);
    assert.deepStrictEqual(stamps, [2], 'project en stempels dragen hetzelfde nummer');
});

test('wat de server zelf heeft gelezen wint van wat het bestand beweert', () => {
    // On the gallery path resolveManifest has itself read the row (after canRead).
    // The file's claim may not write over that.
    const claimed = { blueprintId: 'bp_fake', orgId: 'org_fake', orgName: 'Fake', version: 9 };
    assert.deepStrictEqual(
        provenanceOf({
            blueprintId: 'bp_real', blueprintOrgId: 'org_real',
            manifest: withClaim(claimed, { version: 4 }),
        }),
        { installedFromBlueprintId: 'bp_real', installedFromOrgId: 'org_real', installedVersion: 4 },
    );
});

test('een galerijrij zonder organisatie erft die niet uit het bestand', () => {
    // A personal Blueprint has organization_id NULL. Were the claim to fill it in,
    // a personal installation would quietly be assigned an organisation it never had.
    const out = provenanceOf({
        blueprintId: 'bp_real', blueprintOrgId: null,
        manifest: withClaim({ orgId: 'org_fake' }),
    });
    assert.strictEqual(out.installedFromOrgId, null);
});

test('een onzinnige bewering wordt niets, en laat de installatie gewoon doorgaan', async () => {
    reset();
    const manifest = withClaim(null);
    // Zoals een handgemaakt bestand hem zou kunnen aanleveren: objecten,
    // arrays, getallen — niets waar een string hoort.
    manifest.source = { blueprintId: { $ref: 'aut_1' }, orgId: ['org1'], orgName: 42, version: -3 };
    const result = await installBlueprint({ manifest, ownerId: 'installer', organizationId: 'org_receiver' });
    assert.strictEqual(result.ok, true, 'een rare bewering is geen reden om een geldige Blueprint te weigeren');
    const args = called('createProject')[0].args;
    assert.strictEqual(args.installedFromBlueprintId, null);
    assert.strictEqual(args.installedFromOrgId, null);
});

test('de galerij-installatie legt óók de organisatie van de bron vast', async () => {
    reset();
    await install({ automations: [AUTOMATION('aut_1')] }, { blueprintId: 'bp_abc', blueprintOrgId: 'org_source' });
    const args = called('createProject')[0].args;
    assert.strictEqual(args.installedFromBlueprintId, 'bp_abc');
    assert.strictEqual(args.installedFromOrgId, 'org_source');
    assert.strictEqual(args.installedVersion, 1);
});

// ═══ What the INSTALLER supplies ═════════════════════════════════════
//
// The mirror image of the bridge-grants section above. Those are things the
// file ASKS FOR and install refuses; these are things the file deliberately
// does not carry — which table a step uses, which HTTP credential, who
// approves — and the wizard's Connect step is where somebody supplies them.
//
// Every assertion here reads the definition that was actually STORED, because
// rekeyDefinition renames every step on the way in: asserting on the manifest
// would prove nothing about what a run will find.

const DT_STEP = (id, key) => ({ id, type: 'datatable', op: 'find_rows', datatableId: '', datatableKey: key });
const HTTP_STEP = (id) => ({ id, type: 'http_request', method: 'GET', url: 'https://example.test', auth: null });
const APPROVAL_STEP = (id) => ({ id, type: 'approval', approval: { details: 'Sign off?' } });

const withSteps = (ref, steps) => AUTOMATION(ref, 'automation', {
    definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps },
});

const TABLE = (ref, key) => ({ ref, key, name: key, description: '', columns: [] });

/** The definition as it was STORED, found by step type rather than by id. */
function storedStep(type) {
    const stored = [...live.values()].map(a => a.definition);
    for (const definition of stored) {
        const found = (definition.steps || []).find(s => s.type === type);
        if (found) return found;
    }
    return null;
}

test('an automation that ships with its own table arrives WIRED to it', async () => {
    // Live before this: install created the table AND the automation, and left the
    // step pointing at nothing — a Solution that could not run out of the box
    // and said nothing about why.
    reset();
    const result = await install({
        datatables: [TABLE('dt_1', 'invoices')],
        automations: [withSteps('aut_1', [DT_STEP('s1', 'invoices')])],
    });
    const tableId = result.report.installed.datatables[0].id;
    assert.strictEqual(storedStep('datatable').datatableId, tableId);
    // And silent: there is nothing for the installer to double-check about a
    // table that arrived in the same file.
    assert.ok(!result.report.warnings.some(w => /invoices/.test(w)), result.report.warnings.join(' | '));
});

test('a table the installer PICKED is used, and they are told to check it', async () => {
    reset();
    const result = await install(
        { automations: [withSteps('aut_1', [DT_STEP('s1', 'invoices')])] },
        { resolutions: { tables: [{ key: 'invoices', datatableId: 'tbl_theirs' }] } },
    );
    assert.strictEqual(storedStep('datatable').datatableId, 'tbl_theirs');
    // Their pick, their check — rebindDatatables' own sentence, not a second
    // one written here.
    assert.ok(result.report.warnings.some(w => /Check it is the right one/.test(w)));
});

test('a datatable step nobody could bind is NAMED, never left silently dangling', async () => {
    reset();
    const result = await install({ automations: [withSteps('aut_1', [DT_STEP('s1', 'invoices')])] });
    assert.strictEqual(storedStep('datatable').datatableId, '');
    assert.ok(result.report.warnings.some(w => /no such table here/.test(w)));
});

test('the SOLUTION\'s own table wins a key clash with one the installer picked', async () => {
    // A slug collision must not point a Solution at somebody else's data.
    reset();
    const result = await install(
        {
            datatables: [TABLE('dt_1', 'invoices')],
            automations: [withSteps('aut_1', [DT_STEP('s1', 'invoices')])],
        },
        { resolutions: { tables: [{ key: 'invoices', datatableId: 'tbl_theirs' }] } },
    );
    assert.strictEqual(storedStep('datatable').datatableId, result.report.installed.datatables[0].id);
    assert.notStrictEqual(storedStep('datatable').datatableId, 'tbl_theirs');
    assert.ok(result.report.warnings.some(w => /brings its own table for "invoices"/.test(w)));
});

test('a resolution cannot RE-POINT a step the file already bound', async () => {
    // rebindDatatables rule 1, reached through the install path: only an EMPTY
    // id is filled. A hand-edited manifest plus a crafted resolutions body must
    // not be able to redirect a write.
    reset();
    await install(
        { automations: [withSteps('aut_1', [{ ...DT_STEP('s1', 'invoices'), datatableId: 'tbl_named_in_the_file' }])] },
        { resolutions: { tables: [{ key: 'invoices', datatableId: 'tbl_mine' }] } },
    );
    assert.strictEqual(storedStep('datatable').datatableId, 'tbl_named_in_the_file');
});

test('an empty table the installer asked for is created, and is NOT stamped as part of the Blueprint', async () => {
    reset();
    const result = await install(
        { automations: [withSteps('aut_1', [DT_STEP('s1', 'contacts')])] },
        { resolutions: { tables: [{ key: 'contacts', create: true }] } },
    );
    const created = called('createDatatable').find(c => c.args.key === 'contacts');
    assert.ok(created, 'the table was created through the one path that creates tables');
    assert.strictEqual(created.args.projectId, 'proj_new', 'and filed into the Solution');

    const row = result.report.installed.datatables.find(d => d.forKey === 'contacts');
    assert.strictEqual(row.ref, null, 'it belongs to no entry in the Blueprint, and says so');
    assert.strictEqual(storedStep('datatable').datatableId, row.id);

    // A stamp would offer this table updates from a file that never mentions
    // it, so there is none — and no synthetic ref reached the stamp table.
    assert.ok(!called('upsertStamp').some(c => /contacts|requested:/.test(String(c.args.ref))));
});

test('a table the installer asked for that could not be created is reported, and the rest installs', async () => {
    reset();
    fx.createDatatableThrows = true;
    const result = await install(
        { automations: [withSteps('aut_1', [DT_STEP('s1', 'contacts')])] },
        { resolutions: { tables: [{ key: 'contacts', create: true }] } },
    );
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.report.installed.automations.length, 1);
    assert.ok(result.report.skipped.some(s => /empty table "contacts" you asked for could not be created/.test(s.why)));
});

test('a connection the installer picked lands on the step it was meant for', async () => {
    reset();
    const result = await install(
        { automations: [withSteps('aut_1', [HTTP_STEP('s1')])] },
        { resolutions: { connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_mine' }] } },
    );
    assert.deepStrictEqual(storedStep('http_request').auth, { connectionId: 'conn_mine' });
    assert.deepStrictEqual(result.report.resolved,
        [{ kind: 'connection', ref: 'aut_1', stepId: 's1', layerKey: null }]);
});

test('an approver seat the installer filled is on the stored automation', async () => {
    reset();
    await install(
        { automations: [withSteps('aut_1', [APPROVAL_STEP('s1')])] },
        { resolutions: { approvers: [{ ref: 'aut_1', stepId: 's1', seat: { groupId: 'g_finance' } }] } },
    );
    assert.deepStrictEqual(storedStep('approval').approval.assignee, { groupId: 'g_finance' });
});

test('a choice that missed is SAID, not silently dropped', async () => {
    // The wizard read that address off the manifest. If install cannot find it,
    // the two disagree about what is in the file — and the installer is the one
    // who has to go and set it by hand.
    reset();
    const result = await install(
        { automations: [withSteps('aut_1', [HTTP_STEP('s1')])] },
        { resolutions: { connections: [{ ref: 'aut_1', stepId: 's_gone', connectionId: 'conn_mine' }] } },
    );
    assert.deepStrictEqual(result.report.resolved, []);
    assert.ok(result.report.warnings.some(w => /"s_gone".*was not used \(no such step\)/.test(w)));
});

test('AN INSTALL NEVER APPLIES A RESOLUTION NOBODY SENT', async () => {
    // The narrow default: no resolutions body means nothing is filled in, and
    // an install with none behaves exactly as it did before this existed.
    reset();
    const result = await install({ automations: [withSteps('aut_1', [HTTP_STEP('s1'), APPROVAL_STEP('s2')])] });
    assert.strictEqual(storedStep('http_request').auth, null);
    assert.strictEqual(storedStep('approval').approval.assignee, undefined);
    assert.deepStrictEqual(result.report.resolved, []);
});

test('A RESOLUTIONS BODY CANNOT GRANT WHAT THE FILE ASKED FOR', async () => {
    // The sharpest one in this file. A Blueprint from another organisation asks
    // for public AI at $50/day and a pinned-argument integration grant; a
    // request body arrives alongside it claiming to "resolve" exactly those.
    // Both halves have to fail: the file may not pre-arm, and the second input
    // may not become a back door into the same column.
    reset();
    const result = await installBlueprint({
        manifest: buildManifest({
            project: { id: 'p_theirs', name: 'Theirs' },
            entities: {
                automations: [withSteps('aut_1', [HTTP_STEP('s1')])],
                webpages: [{
                    ref: 'web_1', name: 'Status',
                    bridgeGrants: {
                        ai: { publicEnabled: true, publicGroundOnPage: true, publicSpendCapUsd: 50 },
                        integrations: [{ tool: 'gmail_send', fixedArgs: { to: 'LEAK-CANARY@example.test' } }],
                        automations: [{ automationId: 'aut_from_their_instance' }],
                    },
                }],
            },
        }),
        ownerId: 'installer', organizationId: 'org1', deps: DEPS,
        resolutions: {
            // Every shape a caller might hope reaches the grants column.
            grants: [{ ref: 'web_1', integrations: [{ tool: 'gmail_send' }], ai: { publicEnabled: true } }],
            bridgeGrants: { web_1: { ai: { publicEnabled: true, publicSpendCapUsd: 50 } } },
            integrations: [{ ref: 'web_1', tool: 'gmail_send', fixedArgs: { to: 'LEAK-CANARY@example.test' } }],
            ai: { publicEnabled: true },
            // …next to one that IS understood, so the body is not simply ignored.
            connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_mine' }],
        },
    });

    assert.strictEqual(result.ok, true);
    const row = stored(called('updateBridgeGrants')[0].args.patch);
    assert.strictEqual(row.ai.publicEnabled, false, 'not from the file, and not from the request either');
    assert.strictEqual(row.ai.publicSpendCapUsd, DEFAULT_BRIDGE_GRANTS.ai.publicSpendCapUsd);
    assert.deepStrictEqual(row.integrations, [], 'a tool name is authority; no body may hand it over here');
    assert.deepStrictEqual(row.automations, []);
    assert.ok(!JSON.stringify(calls).includes('LEAK-CANARY'));

    // The understood half DID apply, so this is a test about the boundary and
    // not about resolutions being inert.
    assert.deepStrictEqual(storedStep('http_request').auth, { connectionId: 'conn_mine' });

    // And the refused grants are still shown to whoever installs.
    assert.strictEqual(result.report.grantRequires.length, 3);
});

test('provenanceOf leest een RUW herkomstblok, niet alleen een genormaliseerd', async () => {
    // `provenanceOf` is pure and exported "so that the hostile cases can be tested on their own" — but every
    // test above feeds it the output of buildManifest or checked.manifest, and both have already passed
    // through readSource. The normalisation in provenanceOf is therefore redundant today, and a next caller
    // with an UNCHECKED manifest would get an object or a string of 10,000 characters in installed_from_blueprint_id.
    const raw = {
        solution: { key: 'sol_p1', version: 3 },
        source: { blueprintId: 'bp_' + 'x'.repeat(400), orgId: { $ne: null }, orgName: [1, 2], version: 'negen' },
    };
    const out = provenanceOf({ manifest: raw, claimVerified: true });
    assert.strictEqual(typeof out.installedFromBlueprintId, 'string');
    assert.ok(out.installedFromBlueprintId.length <= 64, 'afgekapt, niet doorgegeven');
    assert.strictEqual(out.installedFromOrgId, null, 'een object is geen organisatie-id');
    assert.strictEqual(out.installedVersion, 3, 'het nummer komt uit solution.version, nooit uit source');
});

test('provenanceOf legt een bewering pas vast als iemand haar heeft nagelopen', () => {
    const manifest = { solution: { key: 'sol_p1', version: 2 }, source: { blueprintId: 'bp_c', orgId: 'org_c' } };
    assert.deepStrictEqual(provenanceOf({ manifest }), {
        installedFromBlueprintId: null, installedFromOrgId: null, installedVersion: 2,
    });
    assert.deepStrictEqual(provenanceOf({ manifest, claimVerified: true }), {
        installedFromBlueprintId: 'bp_c', installedFromOrgId: 'org_c', installedVersion: 2,
    });
});

test('verifyClaimedBlueprint geeft een boolean, en niets uit de galerijrij', async () => {
    const { verifyClaimedBlueprint } = require('./install');
    reset();
    gallery.set('bp_a', { id: 'bp_a', solutionKey: 'sol_p1', name: 'Orders', organizationId: 'org_a' });

    assert.strictEqual(await verifyClaimedBlueprint({ claimedId: 'bp_a', solutionKey: 'sol_p1' }), true);
    assert.strictEqual(await verifyClaimedBlueprint({ claimedId: 'bp_a', solutionKey: 'sol_p9' }), false);
    assert.strictEqual(await verifyClaimedBlueprint({ claimedId: 'bp_weg', solutionKey: 'sol_p1' }), false);
    assert.strictEqual(await verifyClaimedBlueprint({ claimedId: null, solutionKey: 'sol_p1' }), false);
    assert.strictEqual(await verifyClaimedBlueprint({ claimedId: 'bp_a', solutionKey: null }), false);
});

// ═══ Stage-ready install engine (design 7: F2, F3, F7, F10, F13, F14) ═══

const { hashDefinition } = require('../../appStudio/templateUpgrade');
const { installOne, makeInstallCtx, stampAll } = require('./install');

test('a cross-referencing app and automation pair is PRISTINE right after install (F2)', async () => {
    // The stamps used to be written before the references were patched in, so
    // the hash was of a payload with `$ref`s in it, and the very first upgrade
    // called an untouched app "edited" and left it alone.
    reset();
    const manifest = buildManifest({
        project: { id: 'p1', name: 'Onboarding' },
        entities: {
            automations: [
                AUTOMATION('aut_1', 'block'),
                AUTOMATION('aut_2', 'automation', {
                    definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'call_block', blockId: { $ref: 'aut_1' } }] },
                }),
            ],
            apps: [{ ref: 'app_1', name: 'Desk', definition: { actions: { go: { kind: 'run_automation', automationId: { $ref: 'aut_2' } } } } }],
        },
    });
    const result = await installBlueprint({ manifest, ownerId: 'installer', organizationId: 'org1', deps: DEPS });
    assert.strictEqual(result.ok, true);

    const stamps = called('upsertStamp').map(c => c.args);
    assert.deepStrictEqual(stamps.map(s => s.ref).sort(), ['app_1', 'aut_1', 'aut_2']);
    const appId = result.report.installed.apps[0].id;
    const app = stamps.find(s => s.ref === 'app_1');
    assert.strictEqual(app.installHash, hashDefinition(liveApps.get(appId)), 'the app is stamped as it is stored, refs resolved');
    const caller = stamps.find(s => s.ref === 'aut_2');
    assert.strictEqual(caller.installHash, hashDefinition(live.get(caller.entityId).definition));

    // And the upgrade planner agrees: nothing reads as edited.
    const { planUpgrade } = require('./upgrade');
    const planned = await planUpgrade({ projectId: 'proj_new', manifest });
    assert.deepStrictEqual(planned.plan.skip, [], JSON.stringify(planned.plan.skip));
    assert.deepStrictEqual(planned.plan.replace.map(r => r.ref).sort(), ['app_1', 'aut_1', 'aut_2']);
});

test('the rename map install chose is kept on the stamp (F10)', async () => {
    reset();
    await install({ automations: [withSteps('aut_1', [HTTP_STEP('s1')])] });
    const stamp = called('upsertStamp')[0].args;
    const stored = [...live.values()][0].definition;
    assert.ok(stamp.stepIdMap && stamp.stepIdMap.root, 'a map, not identity');
    assert.notStrictEqual(stamp.stepIdMap.root.s1, 's1', 'install gave the step a fresh id');
    assert.strictEqual(stored.steps[0].id, stamp.stepIdMap.root.s1, 'and the map names the id that was stored');
    assert.strictEqual(stored.trigger.id, stamp.stepIdMap.root.t);
});

test('rekey:false keeps every step id, and the stamp says identity', async () => {
    // A stage copy keeps Dev's step ids (design D3); the stage engine installs
    // a missing part through installOne with a ctx that says so.
    reset();
    const ctx = makeInstallCtx({ ownerId: 'runas', organizationId: 'org1', projectId: 'stage_uat', rekey: false, deps: DEPS });
    const report = {};
    const id = await installOne('automation', withSteps('aut_1', [HTTP_STEP('s1'), APPROVAL_STEP('s2')]), ctx, report);
    assert.ok(id);
    const created = called('createAutomation')[0].args;
    assert.strictEqual(created.userId, 'runas');
    assert.deepStrictEqual(created.definition.steps.map(s => s.id), ['s1', 's2']);
    assert.strictEqual(created.definition.trigger.id, 't');
    assert.deepStrictEqual(called('updateAutomation')[0].args.updates, { projectId: 'stage_uat' });

    assert.strictEqual(called('upsertStamp').length, 0, 'stamps wait for stampAll');
    await stampAll(ctx, report);
    const stamp = called('upsertStamp')[0].args;
    assert.strictEqual(stamp.projectId, 'stage_uat');
    assert.strictEqual(stamp.stepIdMap, null);
    assert.strictEqual(stamp.installHash, hashDefinition(live.get(id).definition));
});

test('installOne takes the stage\'s key rule and scope for a table, and records the logical key', async () => {
    reset();
    const ctx = makeInstallCtx({
        ownerId: 'runas', organizationId: 'org1', projectId: 'stage_prd', rekey: false,
        scope: { kind: 'org', id: 'org1' },
        datatableKeyFor: (entity) => `${entity.key}__prd`,
    });
    const report = {};
    const id = await installOne('datatable', TABLE('dt_1', 'invoices'), ctx, report);
    assert.ok(id);
    const args = called('createDatatable')[0].args;
    assert.strictEqual(args.key, 'invoices__prd');
    assert.strictEqual(args.logicalKey, 'invoices');
    assert.deepStrictEqual(args.scope, { kind: 'org', id: 'org1' });
    assert.strictEqual(args.projectId, 'stage_prd');
    assert.strictEqual(report.installed.datatables[0].id, id);
    await assert.rejects(installOne('notebook', {}, ctx, report), /no installer/);
});

test('installOne files an automation and a table INTO a stage with the deployment\'s capability', async () => {
    // The stage engine's prepare creates a missing part filed into the stage
    // project; the store guards refuse that write without `managedWrite`.
    reset();
    stageProjects.add('stage_uat');
    const managedWrite = { deploymentId: 'dep_1' };
    const ctx = makeInstallCtx({ ownerId: 'runas', organizationId: 'org1', projectId: 'stage_uat', rekey: false, managedWrite, deps: DEPS });
    const report = {};
    const automation = await installOne('automation', AUTOMATION('aut_1'), ctx, report);
    const table = await installOne('datatable', TABLE('dt_1', 'invoices'), ctx, report);
    const base = await installOne('knowledge_base', { ref: 'kb_1', name: 'Handbook', description: '' }, ctx, report);
    assert.ok(automation && table && base, JSON.stringify(report.skipped));
    assert.deepStrictEqual(report.skipped, []);
    assert.deepStrictEqual(called('updateAutomation')[0].args.opts, { managedWrite });
    assert.deepStrictEqual(called('createDatatableOpts')[0].args.managedWrite, managedWrite);
    assert.deepStrictEqual(called('setKnowledgeBaseProject')[0].args.managedWrite, managedWrite);
});

test('installOne without the capability is refused by the stage guard, and says so', async () => {
    reset();
    stageProjects.add('stage_uat');
    const ctx = makeInstallCtx({ ownerId: 'runas', organizationId: 'org1', projectId: 'stage_uat', rekey: false, deps: DEPS });
    const report = {};
    assert.strictEqual(await installOne('automation', AUTOMATION('aut_1'), ctx, report), null);
    assert.strictEqual(await installOne('datatable', TABLE('dt_1', 'invoices'), ctx, report), null);
    assert.deepStrictEqual(report.skipped.map(s => [s.ref, /managed by a deployment/.test(s.why)]), [['aut_1', true], ['dt_1', true]]);
});

test('the reference pass carries the capability to every guarded write', async () => {
    reset();
    const { patchReferences } = require('./install');
    const managedWrite = { deploymentId: 'dep_1' };
    const manifest = buildManifest({
        project: { id: 'p1', name: 'Onboarding' },
        entities: {
            automations: [AUTOMATION('aut_1', 'automation', {
                definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps: [{ id: 's1', type: 'call_block', blockId: { $ref: 'aut_1' } }] },
            })],
            apps: [{ ref: 'app_1', name: 'Desk', definition: { actions: {} } }],
            webpages: [{ ref: 'web_1', name: 'Status', files: {} }],
        },
    });
    live.set('a_live', { id: 'a_live', definition: manifest.solution.entities.automations[0].definition });
    const ctx = makeInstallCtx({
        ownerId: 'runas', projectId: 'stage_uat', managedWrite,
        refMap: new Map([['aut_1', 'a_live'], ['app_1', 'app_live'], ['web_1', 'web_live']]),
    });
    await patchReferences(manifest, ctx, { warnings: [] });
    assert.deepStrictEqual(called('saveDefinition')[0].args.opts, { managedWrite });
    assert.deepStrictEqual(called('updateAutomation')[0].args.opts, { goLive: true, managedWrite });
    assert.deepStrictEqual(called('updateBridgeGrants')[0].args.opts, { managedWrite });
});

test('a gallery install passes no capability anywhere', async () => {
    reset();
    await install({ automations: [AUTOMATION('aut_1')], datatables: [TABLE('dt_1', 'invoices')] });
    assert.deepStrictEqual(called('updateAutomation')[0].args.opts, {});
    assert.strictEqual(called('createDatatableOpts')[0].args.managedWrite, undefined);
});

test('a second install in one organisation gets "<key>_2", keeps the logical key, and is still wired (F7)', async () => {
    reset();
    fx.takenKeys = new Set(['invoices']);
    const result = await install({
        datatables: [TABLE('dt_1', 'invoices')],
        automations: [withSteps('aut_1', [DT_STEP('s1', 'invoices')])],
    });
    const tries = called('createDatatable').map(c => [c.args.key, c.args.logicalKey]);
    assert.deepStrictEqual(tries, [['invoices', null], ['invoices_2', 'invoices']]);
    const table = result.report.installed.datatables[0];
    assert.strictEqual(table.key, 'invoices_2');
    assert.strictEqual(storedStep('datatable').datatableId, table.id, 'the automation reaches its own copy, whatever its key');
    assert.ok(result.report.warnings.some(w => /created as "invoices_2"/.test(w)));
});

test('a clash on every suffix is reported, and nothing else is', async () => {
    reset();
    fx.takenKeys = new Set(['invoices', ...[2, 3, 4, 5, 6, 7, 8, 9].map(n => `invoices_${n}`)]);
    const result = await install({ datatables: [TABLE('dt_1', 'invoices')] });
    assert.strictEqual(called('createDatatable').length, 9);
    assert.strictEqual(result.report.installed.datatables.length, 0);
    assert.ok(result.report.skipped.some(s => s.ref === 'dt_1' && /uq_datatables_scope_key/.test(s.why)));
});

test('a datatable $ref in an automation lands on the bundled table, without a rebind warning', async () => {
    reset();
    const result = await install({
        datatables: [TABLE('dt_1', 'invoices')],
        automations: [withSteps('aut_1', [{ id: 's1', type: 'datatable', op: 'find_rows', datatableId: { $ref: 'dt_1' }, datatableKey: 'invoices' }])],
    });
    assert.strictEqual(storedStep('datatable').datatableId, result.report.installed.datatables[0].id);
    assert.ok(!result.report.warnings.some(w => /invoices/.test(w)), result.report.warnings.join(' | '));
});

test('the installer\'s choices are kept as bindings for later updates (F3)', async () => {
    reset();
    const result = await install(
        { automations: [withSteps('aut_1', [HTTP_STEP('s1'), APPROVAL_STEP('s2'), DT_STEP('s3', 'contacts')])] },
        { resolutions: {
            connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_mine' }],
            approvers: [{ ref: 'aut_1', stepId: 's2', seat: { userId: 'u_boss' } }],
            tables: [{ key: 'contacts', create: true }],
        } },
    );
    const saved = called('upsertBindings');
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].args.projectId, 'proj_new');
    assert.strictEqual(saved[0].args.actorId, 'installer');
    const createdTable = result.report.installed.datatables.find(t => t.forKey === 'contacts').id;
    assert.deepStrictEqual(saved[0].args.rows, [
        { slot: 'table:contacts', kind: 'table', value: { datatableId: createdTable } },
        { slot: 'connection:aut_1:/s1', kind: 'connection', value: { ref: 'aut_1', layerKey: null, stepId: 's1', connectionId: 'conn_mine' } },
        { slot: 'seats:aut_1:/s2', kind: 'approver_seats', value: { ref: 'aut_1', layerKey: null, stepId: 's2', assignee: { userId: 'u_boss' } } },
    ]);
});

test('only the choices that LANDED are kept, so an update never repeats "was not used" (F3)', async () => {
    reset();
    await install(
        { automations: [withSteps('aut_1', [HTTP_STEP('s1'), { ...HTTP_STEP('s2'), auth: { connectionId: 'conn_file' } }])] },
        { resolutions: { connections: [
            { ref: 'aut_1', stepId: 's1', connectionId: 'conn_mine' },        // applied
            { ref: 'aut_1', stepId: 's2', connectionId: 'conn_other' },       // step already wired
            { ref: 'aut_1', stepId: 's_gone', connectionId: 'conn_mine' },    // no such step
            { ref: 'aut_9', stepId: 's1', connectionId: 'conn_mine' },        // no such automation
        ] } },
    );
    const rows = called('upsertBindings')[0].args.rows;
    assert.deepStrictEqual(rows.map(r => r.slot), ['connection:aut_1:/s1']);
});

test('a choice for an automation that failed to install is not kept', async () => {
    reset();
    const { installAutomations, makeInstallCtx: mk } = require('./install');
    const { normalizeResolutions } = require('./resolutions');
    const ctx = mk({ ownerId: 'u', projectId: 'p', wiring: {
        resolutions: normalizeResolutions({ connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_mine' }] }),
        tables: [], freshTableIds: new Set(), createdForKey: new Map(), applied: [],
    } });
    stageProjects.add('p');                                  // the filing write is refused
    const report = { installed: { automations: [] }, skipped: [], warnings: [], resolved: [] };
    await installAutomations([withSteps('aut_1', [HTTP_STEP('s1')])], ctx, report);
    assert.strictEqual(report.skipped.length, 1);
    assert.deepStrictEqual(ctx.wiring.applied, []);
});

test('an install with no choices keeps no bindings, and a failed save is said, not fatal', async () => {
    reset();
    await install({ automations: [AUTOMATION('aut_1')] });
    assert.strictEqual(called('upsertBindings').length, 0);

    reset();
    fx.bindingsThrow = true;
    const result = await install(
        { automations: [withSteps('aut_1', [HTTP_STEP('s1')])] },
        { resolutions: { connections: [{ ref: 'aut_1', stepId: 's1', connectionId: 'conn_mine' }] } },
    );
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(storedStep('http_request').auth, { connectionId: 'conn_mine' });
    assert.ok(result.report.warnings.some(w => /could not be saved for later updates/.test(w)));
});

test('an app arrives with its own data model, linked to the bundle\'s table (F13)', async () => {
    reset();
    const result = await install({
        datatables: [TABLE('dt_1', 'invoices')],
        apps: [{
            ref: 'app_1', name: 'Desk', definition: {},
            dataModel: {
                tables: [
                    { id: 'tbl_aaaa1111', key: 'own', fields: [] },
                    { id: 'tbl_bbbb2222', key: 'linked', fields: [], source: { kind: 'datatable', datatableId: { $ref: 'dt_1' }, mode: 'read' } },
                    { id: 'tbl_cccc3333', key: 'outside', fields: [], source: { kind: 'datatable', datatableId: null, mode: 'read' } },
                ],
            },
        }],
    });
    const saved = called('saveDataModel');
    assert.strictEqual(saved.length, 1);
    assert.strictEqual(saved[0].args.appId, result.report.installed.apps[0].id);
    assert.strictEqual(saved[0].args.ownerId, 'installer');
    const keys = saved[0].args.model.tables.map(t => t.key);
    assert.deepStrictEqual(keys, ['own', 'linked'], 'a table linked outside the bundle is left out');
    assert.strictEqual(saved[0].args.model.tables[1].source.datatableId, result.report.installed.datatables[0].id);
    assert.ok(result.report.warnings.some(w => /"outside"/.test(w) && /data settings/.test(w)));
});

test('a data model the store refuses is reported, and the app still installs', async () => {
    reset();
    fx.dataModelResult = { ok: false, invalid: true, errors: ['tables[0].key is not valid'] };
    const result = await install({ apps: [{ ref: 'app_1', name: 'Desk', definition: {}, dataModel: { tables: [{ id: 'x', key: '!', fields: [] }] } }] });
    assert.strictEqual(result.report.installed.apps.length, 1);
    assert.ok(result.report.warnings.some(w => /data model of "Desk" could not be set up \(tables\[0\]\.key is not valid\)/.test(w)));
});

test('a page gets its in-bundle knowledge bases, and never a bare id', async () => {
    reset();
    const result = await install({
        knowledgeBases: [{ ref: 'kb_1', name: 'Handbook', description: '' }],
        webpages: [{ ref: 'web_1', name: 'Status', files: { html: '<h1>Hi</h1>' }, knowledgeBaseIds: [{ $ref: 'kb_1' }, 'kb_from_their_instance'] }],
    });
    const kbId = result.report.installed.knowledgeBases[0].id;
    assert.deepStrictEqual(called('createWebpage')[0].args.knowledgeBaseIds, [kbId]);
});

test('a page\'s table grant arrives on the bundled table, its public columns do not (F14)', async () => {
    reset();
    const result = await install({
        datatables: [TABLE('dt_1', 'invoices')],
        webpages: [{
            ref: 'web_1', name: 'Status', files: {},
            bridgeGrants: { tables: [{ datatableId: { $ref: 'dt_1' }, mode: 'read', columns: ['amount'], publicColumns: ['amount'] }] },
        }],
    });
    const row = stored(called('updateBridgeGrants')[0].args.patch);
    assert.deepStrictEqual(row.tables, [{ datatableId: result.report.installed.datatables[0].id, mode: 'read', columns: ['amount'], publicColumns: [] }]);
    assert.ok(result.report.warnings.some(w => /anonymous visitors/.test(w)));
});

// ═══ Skills and document templates ═══════════════════════════════════

const SKILL = (ref, over = {}) => ({
    ref, name: `Skill ${ref}`, description: 'd', instructions: 'Be brief.', workflow: '', rules: '', examples: '',
    steps: [], rules_v2: [], examples_v2: [], output_schema: null, icon: '📝', dynamic_activation: true,
    knowledge_base_ids: [], allowed_automation_ids: [], automation_id: null, ...over,
});
const TEMPLATE = (ref, over = {}) => ({
    ref, name: `Template ${ref}`, doc_type: 'document', kind: 'template', description: 'An offer', body_html: '<p>x</p>', css: '.a{}',
    settings: { margin: 12 }, ...over,
});
const fillAutomation = (ref, steps) => AUTOMATION(ref, 'automation', {
    definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger', kind: 'manual' }, steps },
});

test('a skill and a template are installed under the installer, filed through the registry, and linked', async () => {
    reset();
    const result = await install({
        knowledgeBases: [{ ref: 'kb_1', name: 'Handbook' }],
        automations: [
            AUTOMATION('aut_1'),
            fillAutomation('aut_2', [
                { id: 'f1', type: 'fill_document', documentId: { $ref: 'doc_1' }, documentVersionId: 'a-stale-dev-id', values: {} },
                { id: 'ai', type: 'ai_step', prompt: 'x', skillIds: [{ $ref: 'skl_1' }] },
            ]),
        ],
        skills: [SKILL('skl_1', {
            knowledge_base_ids: [{ $ref: 'kb_1' }], allowed_automation_ids: [{ $ref: 'aut_1' }], automation_id: { $ref: 'aut_1' },
            steps: [{ id: 's1', text: 'Read', refs: [{ kind: 'kb', id: { $ref: 'kb_1' } }, { kind: 'kb', id: 'bare-id' }] }],
        })],
        documents: [TEMPLATE('doc_1')],
        agents: [{ ref: 'agt_1', name: 'Helper', config: { attachedSkillIds: [{ $ref: 'skl_1' }] } }],
    });
    assert.strictEqual(result.ok, true);

    const id = (list, ref) => result.report.installed[list].find(x => x.ref === ref).id;
    const [kbId, autId, docId, sklId] = [id('knowledgeBases', 'kb_1'), id('automations', 'aut_1'), id('documents', 'doc_1'), id('skills', 'skl_1')];
    const skill = called('createSkill')[0].args;
    assert.strictEqual(skill.userId, 'installer');
    assert.strictEqual(skill.orgId, 'org1');
    assert.strictEqual(skill.isShared, false);
    assert.deepStrictEqual(skill.sharedGroups, []);
    assert.deepStrictEqual(skill.enabledIntegrations, [], 'a connected app is a requirement, never a switch');
    assert.deepStrictEqual(skill.knowledgeBaseIds, [kbId]);
    assert.deepStrictEqual(skill.allowedAutomationIds, [autId]);
    assert.strictEqual(skill.automationId, autId);
    assert.deepStrictEqual(skill.steps[0].refs, [{ kind: 'kb', id: kbId }],
        'a bare id in a step reference does not survive');
    assert.ok(!('workflow' in skill), 'the structured form is sent once, the store regenerates the text');
    assert.strictEqual(skill.dynamicActivation, true);

    const doc = called('createDocument')[0].args;
    assert.strictEqual(doc.userId, 'installer');
    assert.strictEqual(doc.visibility, 'private');
    assert.deepStrictEqual(
        { name: doc.name, docType: doc.docType, kind: doc.kind, bodyHtml: doc.bodyHtml, css: doc.css, settings: doc.settings },
        { name: 'Template doc_1', docType: 'document', kind: 'template', bodyHtml: '<p>x</p>', css: '.a{}', settings: { margin: 12 } },
    );
    assert.ok(!('projectId' in doc), 'a template is never filed as project content');

    const filed = called('membership.setProject').map(c => [c.args.kind, c.args.id, c.args.userId, c.args.projectId]);
    assert.deepStrictEqual(filed, [['document_template', docId, 'installer', 'proj_new'], ['skill', sklId, 'installer', 'proj_new']]);

    const automation = called('updateAutomation').filter(c => c.args.updates.definition).pop().args.updates.definition;
    assert.strictEqual(automation.steps[0].documentId, docId);
    assert.strictEqual(automation.steps[0].documentVersionId, `ver_of_${docId}`, 'pinned to the installed revision, not to Dev\'s');
    assert.deepStrictEqual(automation.steps[1].skillIds, [sklId]);

    const agentConfig = called('createAgent')[0].args[9];
    assert.deepStrictEqual(agentConfig.attachedSkillIds, [sklId]);

    assert.deepStrictEqual(result.report.installed.skills, [{ ref: 'skl_1', id: sklId, name: 'Skill skl_1' }]);
    assert.deepStrictEqual(result.report.installed.documents, [{ ref: 'doc_1', id: docId, name: 'Template doc_1', versionId: `ver_of_${docId}` }]);
    const stamps = called('upsertStamp').map(c => [c.args.ref, c.args.kind, c.args.entityId]);
    assert.ok(stamps.some(x => x.join() === `skl_1,skill,${sklId}`));
    assert.ok(stamps.some(x => x.join() === `doc_1,document,${docId}`));
});

test('bare ids in a hand-edited skill are dropped, and a ref with nothing behind it is named', async () => {
    reset();
    const { skillFieldsOf, installSkills } = require('./install');
    const entity = SKILL('skl_1', {
        knowledge_base_ids: ['kb_of_somebody_else', { $ref: 'kb_9' }], automation_id: 'aut_of_somebody_else',
        steps: [{ id: 's', text: 'x', refs: [{ kind: 'table', id: { $ref: 'dt_9' } }, { kind: 'kb', id: 'bare' }] }],
    });
    const unresolved = [];
    const fields = skillFieldsOf(entity, new Map(), unresolved);
    assert.deepStrictEqual(fields.knowledgeBaseIds, []);
    assert.strictEqual(fields.automationId, null);
    assert.deepStrictEqual(fields.steps[0].refs, []);
    assert.deepStrictEqual(unresolved.sort(), ['dt_9', 'kb_9']);

    // The install says so in the report.
    const ctx = require('./install').makeInstallCtx({ ownerId: 'installer', organizationId: 'org1', projectId: 'p' });
    const report = { installed: {}, skipped: [], warnings: [] };
    await installSkills([entity], ctx, report);
    assert.ok(report.warnings.some(w => /"kb_9" in the skill "Skill skl_1"/.test(w)));
    assert.ok(report.warnings.some(w => /"dt_9" in the skill "Skill skl_1"/.test(w)));
});

test('a skill or template the registry will not file is said out loud, not lost', async () => {
    reset();
    fx.filed = false;
    const result = await install({ skills: [SKILL('skl_1')], documents: [TEMPLATE('doc_1')] });
    assert.strictEqual(result.ok, true);
    assert.ok(result.report.warnings.some(w => /"Skill skl_1" was created but could not be filed/.test(w)));
    assert.ok(result.report.warnings.some(w => /"Template doc_1" was created but could not be filed/.test(w)));
});

test('a page is never installed as a template, and one bad part does not stop the others', async () => {
    reset();
    const result = await install({ documents: [TEMPLATE('doc_1', { doc_type: 'page' }), TEMPLATE('doc_2')] });
    assert.deepStrictEqual(result.report.skipped.map(x => [x.ref, x.kind, x.permanent]), [['doc_1', 'document', true]]);
    assert.deepStrictEqual(result.report.installed.documents.map(d => d.ref), ['doc_2']);
});

test('each body facet is sent once: structure when there is some, the written-out text otherwise', () => {
    const { skillFieldsOf } = require('./install');
    const fields = skillFieldsOf(SKILL('skl_1', {
        steps: [], workflow: '1. Read the file', rules_v2: [{ id: 'r', polarity: 'must', text: 'cite' }], rules: 'must cite', examples_v2: [], examples: '',
        output_schema: { type: 'object' },
    }), new Map());
    assert.strictEqual(fields.workflow, '1. Read the file');
    assert.ok(!('steps' in fields));
    assert.deepStrictEqual(fields.rulesV2, [{ id: 'r', polarity: 'must', text: 'cite' }]);
    assert.ok(!('rules' in fields));
    assert.ok(!('examples' in fields) && !('examplesV2' in fields), 'nothing to say, nothing sent');
    assert.deepStrictEqual(fields.outputSchema, { type: 'object' });
    assert.ok(!('enabledIntegrations' in fields) && !('isShared' in fields));
});

test('stage path: a skill is only computed, a template is written with the deploy\'s capability and pinned', async () => {
    reset();
    const { makeInstallCtx, installOne, resolveRefs } = require('./install');
    const managedWrite = { deploymentId: 'dep_1' };
    const ctx = makeInstallCtx({ ownerId: 'run-as', organizationId: 'org1', projectId: 'p-uat', rekey: false, managedWrite });
    const report = {};
    ctx.refMap.set('kb_1', 'kb-uat');
    ctx.refMap.set('aut_1', 'aut-uat');

    const skillId = await installOne('skill', SKILL('skl_1', { knowledge_base_ids: [{ $ref: 'kb_1' }], automation_id: { $ref: 'aut_1' } }), ctx, report);
    assert.ok(skillId, 'an id is allocated so automations and agents can point at it');
    assert.strictEqual(ctx.refMap.get('skl_1'), skillId);
    assert.deepStrictEqual(called('createSkill'), [], 'no row is written before the commit');
    assert.deepStrictEqual(called('membership.setProject'), []);
    assert.strictEqual(report.computed.skills.length, 1);
    assert.strictEqual(report.computed.skills[0].id, skillId);
    assert.deepStrictEqual(report.computed.skills[0].fields.knowledgeBaseIds, ['kb-uat']);
    assert.strictEqual(report.computed.skills[0].fields.automationId, 'aut-uat');
    assert.deepStrictEqual(report.installed.skills.map(x => x.ref), ['skl_1']);

    const docId = await installOne('document', TEMPLATE('doc_1'), ctx, report);
    const write = called('writeManagedTemplate')[0].args;
    assert.deepStrictEqual(write.opts, { managedWrite });
    assert.deepStrictEqual(
        { ownerId: write.input.ownerId, orgId: write.input.orgId, projectId: write.input.projectId, name: write.input.fields.name, docType: write.input.fields.docType },
        { ownerId: 'run-as', orgId: 'org1', projectId: 'p-uat', name: 'Template doc_1', docType: 'document' },
    );
    assert.strictEqual(ctx.templateVersions.get(docId), `ver_of_${docId}`);
    assert.deepStrictEqual(called('createDocument'), [], 'the stage never goes through the owner\'s createDocument');

    // The stage engine resolves an automation with the same pin.
    const payload = { definition: { steps: [{ id: 'f1', type: 'fill_document', documentId: { $ref: 'doc_1' }, documentVersionId: 'dev-version' }] } };
    resolveRefs('automation', payload, ctx.refMap, [], ctx.templateVersions);
    assert.strictEqual(payload.definition.steps[0].documentId, docId);
    assert.strictEqual(payload.definition.steps[0].documentVersionId, `ver_of_${docId}`);
});

test('pinTemplateVersions leaves a fill_document step that names another document alone', () => {
    const { pinTemplateVersions } = require('./install');
    const definition = { steps: [
        { id: 'a', type: 'fill_document', documentId: 'mine', documentVersionId: 'old' },
        { id: 'b', type: 'fill_document', documentId: 'theirs', documentVersionId: 'keep' },
        { id: 'c', type: 'generate_document', documentId: 'mine' },
    ] };
    pinTemplateVersions(definition, new Map([['mine', 'v9']]));
    assert.deepStrictEqual(definition.steps.map(x => x.documentVersionId), ['v9', 'keep', undefined]);
    pinTemplateVersions(definition, null);
    pinTemplateVersions(null, new Map([['mine', 'v9']]));
});

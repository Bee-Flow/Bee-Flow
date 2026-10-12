/**
 * Automations over MCP — the tool surface and the call envelope.
 *
 * What is worth pinning here is not that the builder tools work (builderTools's
 * own suites cover that) but the things this layer alone is responsible for:
 * the gate is really a gate, the shared TOOL_SCHEMAS constant is not mutated
 * while automationId is spliced in, a call cannot reach a builder tool without
 * an automation to act on, and the tools whose other half lives in the SSE route
 * are not advertised.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mcpBuilder = require('./mcpBuilder');
const { TOOL_SCHEMAS, MUTATING_TOOLS } = require('./builderTools');

function withEnv(value, fn) {
    const prev = process.env.AUTOMATION_MCP_ENABLED;
    if (value === undefined) delete process.env.AUTOMATION_MCP_ENABLED;
    else process.env.AUTOMATION_MCP_ENABLED = value;
    try { return fn(); } finally {
        if (prev === undefined) delete process.env.AUTOMATION_MCP_ENABLED;
        else process.env.AUTOMATION_MCP_ENABLED = prev;
    }
}

test('the endpoint is off unless the flag is exactly "1"', () => {
    withEnv(undefined, () => assert.equal(mcpBuilder.isEnabled(), false));
    withEnv('', () => assert.equal(mcpBuilder.isEnabled(), false));
    withEnv('0', () => assert.equal(mcpBuilder.isEnabled(), false));
    // Deliberately strict: a surface that authors executable logic from a
    // static token should not switch itself on for "true"/"yes"/"on".
    withEnv('true', () => assert.equal(mcpBuilder.isEnabled(), false));
    withEnv('yes', () => assert.equal(mcpBuilder.isEnabled(), false));
    withEnv('1', () => assert.equal(mcpBuilder.isEnabled(), true));
});

test('splicing automationId into the schemas never mutates the shared constant', () => {
    // TOOL_SCHEMAS is sent on every in-product builder turn and its byte
    // stability is what keeps the prompt cache warm (schemas.js says so). If
    // this layer mutated it, enabling MCP would silently change the cache key
    // of every builder turn on the instance.
    const before = JSON.stringify(TOOL_SCHEMAS);
    mcpBuilder.buildToolList();
    mcpBuilder.buildToolList();
    assert.equal(JSON.stringify(TOOL_SCHEMAS), before);
});

test('every builder_* tool requires an automationId; the entry points do not', () => {
    const tools = mcpBuilder.buildToolList();
    assert.ok(tools.length > 25, 'the whole builder surface should be advertised');

    for (const tool of tools) {
        const required = tool.inputSchema.required || [];
        if (mcpBuilder.AUTOMATIONLESS_TOOLS.has(tool.name)) {
            assert.ok(!required.includes('automationId'), `${tool.name} should not demand an automationId`);
            assert.ok(!tool.inputSchema.properties.automationId, `${tool.name} should not offer an automationId`);
        } else {
            assert.ok(required.includes('automationId'), `${tool.name} must require an automationId`);
            assert.equal(tool.inputSchema.properties.automationId.type, 'string');
        }
    }
});

test('a tool whose other half lives in the SSE route is not advertised', () => {
    // builder_set_plan drives a per-turn to-do list and
    // builder_generate_layer[s] spawn sub-agents through the route's
    // runDelegationTool. Advertising them here would teach a client a protocol
    // this endpoint does not implement.
    const names = new Set(mcpBuilder.buildToolList().map(t => t.name));
    for (const routeOnly of mcpBuilder.ROUTE_ONLY_TOOLS) {
        assert.ok(!names.has(routeOnly), `${routeOnly} must not be advertised over MCP`);
    }
    // …and the ones the route only POST-processes must still be there.
    assert.ok(names.has('builder_request_dry_run'));
    assert.ok(names.has('builder_finalize'));
});

test('read-only hints match what the dispatcher actually persists on', () => {
    for (const tool of mcpBuilder.buildToolList()) {
        const writes = MUTATING_TOOLS.has(tool.name)
            || tool.name === 'builder_finalize'
            || tool.name === 'automations_create';
        assert.equal(
            tool.annotations.readOnlyHint, !writes,
            `${tool.name}: readOnlyHint disagrees with whether the call writes`,
        );
    }
});

test('a builder call without an automationId is refused before it reaches a tool', async () => {
    const { result } = await mcpBuilder.callTool('builder_add_ai_step', { prompt: 'hi' }, { userId: 'u1' });
    assert.match(result.error, /needs an automationId/);
    // And it names the way out rather than just complaining.
    assert.match(result.error, /automations_list|automations_create/);
});

test('an unknown tool is a described error, not a throw', async () => {
    // A coding agent recovers from a described error and cannot recover from a
    // transport-level exception.
    const { result } = await mcpBuilder.callTool('builder_do_magic', {}, { userId: 'u1' });
    assert.match(result.error, /Unknown tool/);
});

test('automations_create refuses an empty title instead of minting "Untitled"', async () => {
    const { result } = await mcpBuilder.callTool('automations_create', { title: '   ' }, { userId: 'u1' });
    assert.match(result.error, /title is required/i);
});

test('automations_list.stepCount excludes notes — a canvas annotation is not a step (BFSF-411)', async () => {
    const automationStore = require('../stores/automationStore');
    const original = automationStore.getAutomationsForUser;
    automationStore.getAutomationsForUser = async () => [{
        id: 'a1', title: 'T', description: '', kind: 'automation', triggerType: 'manual',
        isDraft: false, isActive: true, lastRunAt: null, lastStatus: null, updatedAt: '2026-01-01',
        definition: {
            trigger: { id: 'trg' },
            steps: [
                { id: 's1', type: 'notification' },
                { id: 'note_1', type: 'note', text: 'why this exists' },
                { id: 's2', type: 'set' },
                { id: 'note_2', type: 'note', text: 'todo' },
            ],
        },
    }];
    try {
        const { result } = await mcpBuilder.callTool('automations_list', {}, { userId: 'u1' });
        assert.equal(result.automations.length, 1);
        assert.equal(result.automations[0].stepCount, 2, 'the two notes are not counted as steps');
    } finally {
        automationStore.getAutomationsForUser = original;
    }
});

test('automations_get_guide ships the "This turn" note the guide refers to — with the timezone — since MCP has no turn to send it in', async () => {
    // buildFullSystemPrompt says the timezone and the other per-turn
    // preferences "arrive in a This turn note right before the user's
    // message"; the chat route sends that per turn, this surface has none.
    const builderCatalog = require('./builderCatalog');
    const triggerBus = require('./triggerBus');
    const savedCatalog = builderCatalog.buildCatalogForUser;
    const savedSession = triggerBus.loadSession;
    builderCatalog.buildCatalogForUser = async () => ({ apps: [], triggers: [] });
    triggerBus.loadSession = async () => null;
    try {
        const { result, text } = await mcpBuilder.callTool('automations_get_guide', {}, { userId: 'u1' });
        assert.equal(text, result.guide);
        assert.match(result.guide, /arrive in a "This turn" note/);
        assert.match(result.guide, /\n\n## This turn\n\n- All times use the user's timezone: Europe\/Amsterdam\.$/);
    } finally {
        builderCatalog.buildCatalogForUser = savedCatalog;
        triggerBus.loadSession = savedSession;
    }
});

test('automations_get_guide carries the id lists the guide tells the model to take ids from — and a failed list says so', async () => {
    // The full prompt says "an id from the Agents you may use block"; the chat
    // route puts that block in its per-turn message, an MCP client has none, so
    // the guide ships it. A failed read must not read as "none".
    const builderCatalog = require('./builderCatalog');
    const triggerBus = require('./triggerBus');
    const pickers = require('./builderPickerCatalog');
    const saved = { cat: builderCatalog.buildCatalogForUser, session: triggerBus.loadSession, pick: pickers.buildPickerCatalogsForUser };
    builderCatalog.buildCatalogForUser = async () => ({ apps: [], triggers: [] });
    triggerBus.loadSession = async () => null;
    try {
        pickers.buildPickerCatalogsForUser = async () => ({
            agents: [{ id: 'agt_7', name: 'Sales helper', canUse: true, scope: 'personal' }], agentsError: null,
            knowledgeBases: [], knowledgeBasesError: 'store down',
            appEventProviders: [{ id: 'gmail', label: 'Gmail', events: [{ id: 'mail.new' }] }], appEventProvidersError: null,
        });
        const { result } = await mcpBuilder.callTool('automations_get_guide', {}, { userId: 'u1' });
        assert.match(result.guide, /## Agents you may use[^\n]*\n\n- agt_7 · "Sales helper"/);
        assert.match(result.guide, /## Knowledge bases you may use\n\n_\(the list of knowledge bases could not be read just now/);
        assert.match(result.guide, /- gmail \(Gmail\): mail\.new/);
        assert.match(result.guide, /\n\n## This turn\n\n- All times use the user's timezone: Europe\/Amsterdam\.$/, 'the turn note stays last');
        assert.ok(result.guide.indexOf('## Agents you may use') > result.guide.indexOf('## Catalog'), 'after the static guide');
    } finally {
        builderCatalog.buildCatalogForUser = saved.cat;
        triggerBus.loadSession = saved.session;
        pickers.buildPickerCatalogsForUser = saved.pick;
    }
});

test('builder_inspect_tool over MCP names the input params of the tools the user has', async () => {
    // It answered `inputs: null` for every tool: the MCP draftWrap carried no catalog.
    const automationStore = require('../stores/automationStore');
    const builderCatalog = require('./builderCatalog');
    const orig = { get: automationStore.getAutomation, cat: builderCatalog.buildCatalogForUser };
    automationStore.getAutomation = async () => ({ id: 'a1', userId: 'u1', title: 'T', definition: {} });
    builderCatalog.buildCatalogForUser = async () => ({
        apps: [{ id: 'nc', actions: [{ name: 'nextcloud_mail_list_mailboxes', inputSchema: { type: 'object', properties: { accountId: { type: 'number' }, x: { type: 'string' } }, required: ['accountId'] } }] }],
        toolNames: new Set(['nextcloud_mail_list_mailboxes']),
    });
    try {
        const { result } = await mcpBuilder.callTool('builder_inspect_tool', { automationId: 'a1', tools: ['nextcloud_mail_list_mailboxes'] }, { userId: 'u1' });
        const r = result.results.nextcloud_mail_list_mailboxes;
        assert.deepEqual(Object.keys(r.inputs), ['accountId', 'x']);
        assert.deepEqual(r.requiredInputs, ['accountId']);
    } finally {
        automationStore.getAutomation = orig.get;
        builderCatalog.buildCatalogForUser = orig.cat;
    }
});

// ── tables over MCP ─────────────────────────────────────────────────────────
//
// The MCP caller is the user's own agent: loadDraft sets neither the staging
// flag nor the consent Set, so a create is direct, a same-named table is
// returned, and binding is not gated. It still shares the forged-id refusal
// and the type change.

const { applyToolCall: applyDirect, emptyDefinition } = require('./builderTools');

/** The wrap loadDraft builds, with a table list. */
const mcpWrap = (over = {}) => ({
    userId: 'u1', orgId: 'orgA', automationId: 'a1', def: emptyDefinition(),
    _datatables: [{ id: 'tbl_old', key: 'facturen', name: 'Facturen', canWrite: true, columns: [{ key: 'datum', name: 'Datum', type: 'date' }] }],
    ...over,
});

/** Stand-ins for the principal, the permission and the create itself. */
function patchCreateEnv() {
    const access = require('../auth/datatableAccess');
    const perms = require('../auth/permissions');
    const create = require('../core/dataEngine/createStudioDatatable');
    const orig = { resolve: access.resolveDatatablePrincipalForUser, has: perms.hasPermission, create: create.createStudioDatatable };
    const created = [];
    access.resolveDatatablePrincipalForUser = async (userId) => ({ userId, orgId: 'orgA', identityError: null });
    perms.hasPermission = async () => true;
    create.createStudioDatatable = async (args) => {
        created.push(args);
        return { ok: true, table: { id: 'tbl_made', key: 'klanten', name: args.name, scope: { kind: 'org', id: 'orgA' }, fields: args.fields.map(f => ({ key: f.key, name: f.name, type: f.type })) } };
    };
    return { created, restore() { access.resolveDatatablePrincipalForUser = orig.resolve; perms.hasPermission = orig.has; create.createStudioDatatable = orig.create; } };
}

test('over MCP a create is direct (never staged), and a same-named table is returned, not asked about', async () => {
    const env = patchCreateEnv();
    try {
        const wrap = mcpWrap();
        const made = await applyDirect('builder_create_datatable', { name: 'Klanten', fields: [{ name: 'Naam', type: 'text' }] }, wrap);
        assert.equal(made.created, true);
        assert.equal(made.datatableId, 'tbl_made');
        assert.equal(env.created.length, 1);
        const again = await applyDirect('builder_create_datatable', { name: 'facturen', fields: [{ name: 'X', type: 'text' }] }, wrap);
        assert.equal(again.datatableId, 'tbl_old');
        assert.match(again.note, /already exists/);
        assert.equal(env.created.length, 1, 'no second table');
    } finally { env.restore(); }
});

test('over MCP the organisation of the automation must match the one the table would be created in', async () => {
    const env = patchCreateEnv();
    try {
        const r = await applyDirect('builder_create_datatable', { name: 'Klanten', fields: [{ name: 'Naam', type: 'text' }] }, mcpWrap({ orgId: 'orgB' }));
        assert.equal(r.code, 'datatable_org_mismatch');
        assert.equal(env.created.length, 0);
    } finally { env.restore(); }
});

test('over MCP binding an existing table is not gated; a forged pending id is refused', async () => {
    const wrap = mcpWrap();
    const bound = await applyDirect('builder_add_datatable', { op: 'find_rows', datatableId: 'tbl_old' }, wrap);
    assert.ok(!bound.error, JSON.stringify(bound));
    const forged = await applyDirect('builder_add_datatable', { op: 'find_rows', datatableId: 'pending:1' }, wrap);
    assert.match(forged.error, /pending ids exist only inside the proposal/);
});

test('over MCP builder_update_step performs a type change (Nextcloud Tables row to a datatable step)', async () => {
    const wrap = mcpWrap();
    wrap.def.steps = [{ id: 'row', type: 'integration_action', tool: 'nextcloud_tables_create_row', inputs: { tableId: { kind: 'literal', value: 'Facturen' }, values: { Datum: { kind: 'literal', value: '2026-01-01' } } } }];
    wrap.def.edges = [{ from: 'trg', to: 'row' }];
    const r = await applyDirect('builder_update_step', { stepId: 'row', patch: { tool: 'datatable', datatableId: 'tbl_old', datatableKey: 'facturen' } }, wrap);
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepEqual(r.replacedType, { from: 'integration_action', to: 'datatable' });
    assert.deepEqual([wrap.def.steps[0].type, wrap.def.steps[0].op, Object.keys(wrap.def.steps[0].values)], ['datatable', 'add_row', ['datum']]);
});

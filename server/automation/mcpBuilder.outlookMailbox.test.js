// @typecheck strict
/**
 * The automations MCP can build Outlook flows on a shared mailbox: the field
 * is in every Outlook tool's schema as builder_inspect_tool returns it, in the
 * per-user app-event lines the guide appends (builder_propose_trigger's
 * description points there since the per-provider catalogue left it), and in
 * the guide.
 *
 * Run: cd server && node --test automation/mcpBuilder.outlookMailbox.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const mcpBuilder = require('./mcpBuilder');
const { buildFullSystemPrompt } = require('./builderPrompt');
const { OUTLOOK_TOOLS } = require('../integrations/outlookTools');

const NAMES = OUTLOOK_TOOLS.map(t => t.function.name);

test('builder_inspect_tool over MCP offers the optional mailbox on every Outlook tool', async () => {
    const automationStore = require('../stores/automationStore');
    const builderCatalog = require('./builderCatalog');
    const orig = { get: automationStore.getAutomation, cat: builderCatalog.buildCatalogForUser };
    automationStore.getAutomation = async () => /** @type {any} */ ({ id: 'a1', userId: 'u1', title: 'T', definition: {} });
    // The catalog carries the tools' own OpenAI `parameters` as inputSchema (builderCatalog.js).
    builderCatalog.buildCatalogForUser = /** @type {any} */ (async () => ({
        apps: [{ id: 'outlook', actions: OUTLOOK_TOOLS.map(t => ({ name: t.function.name, inputSchema: t.function.parameters })) }],
        toolNames: new Set(NAMES),
    }));
    try {
        const { result } = /** @type {any} */ (await mcpBuilder.callTool('builder_inspect_tool', { automationId: 'a1', tools: NAMES }, { userId: 'u1' }));
        for (const name of NAMES) {
            const mailbox = result.results[name]?.inputs?.mailbox;
            assert.ok(mailbox, `${name} offers mailbox`);
            assert.equal(mailbox.type, 'string');
            assert.equal(mailbox.required, false);
            assert.match(mailbox.description, /"me" \(the default\).*shared mailbox/);
        }
    } finally {
        automationStore.getAutomation = orig.get;
        builderCatalog.buildCatalogForUser = orig.cat;
    }
});

test('the shared-mailbox trigger is documented where builder_propose_trigger sends an MCP client', () => {
    const propose = mcpBuilder.buildToolList().find(t => t.name === 'builder_propose_trigger');
    assert.ok(propose);
    assert.match(JSON.stringify(propose), /over MCP at the end of automations_get_guide/);
    // The lines the guide's "App events you may use" block renders for a user with Microsoft 365.
    const { renderAppEventProviderLines } = require('./builderPrompt/triggerBlock');
    const msgraph = { id: 'msgraph', label: 'Microsoft 365 (Outlook)', events: [{ id: 'mail.new', deliverability: 'ok' }] };
    const text = renderAppEventProviderLines([msgraph]);
    assert.match(text, /Microsoft 365 \(Outlook\)/);
    assert.match(text, /mail\.new \[mailbox \(a shared mailbox address; omit = the user's own inbox\)\]/);
    assert.match(text, /mailbox: trigger\.output\.mailbox/);
    assert.match(text, /goes out FROM the shared mailbox/);
});

test('the guide tells the builder that every outlook_* tool takes a mailbox', () => {
    const guide = buildFullSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: false });
    assert.match(guide, /Every `outlook_\*` tool takes an optional `mailbox`/);
    assert.match(guide, /trigger\.output\.mailbox/);
});

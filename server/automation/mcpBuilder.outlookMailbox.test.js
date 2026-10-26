// @typecheck
/**
 * The automations MCP can build Outlook flows on a shared mailbox: the field
 * is in every Outlook tool's schema as builder_inspect_tool returns it, in the
 * trigger docs of builder_propose_trigger, and in the guide.
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

test('builder_propose_trigger over MCP documents the shared-mailbox trigger', () => {
    const propose = mcpBuilder.buildToolList().find(t => t.name === 'builder_propose_trigger');
    assert.ok(propose);
    const text = JSON.stringify(propose);
    assert.match(text, /Microsoft 365 \(Outlook\)/);
    assert.match(text, /filter:\{mailbox:\\"support@example\.com\\"\}/);
    assert.match(text, /mailbox: trigger\.output\.mailbox/);
});

test('the guide tells the builder that every outlook_* tool takes a mailbox', () => {
    const guide = buildFullSystemPrompt({ catalog: { apps: [] }, codeStepEnabled: false });
    assert.match(guide, /Every `outlook_\*` tool takes an optional `mailbox`/);
    assert.match(guide, /trigger\.output\.mailbox/);
});

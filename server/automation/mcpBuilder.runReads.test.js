/**
 * The run-inspection tools as the MCP dispatcher exposes them: advertised as
 * read-only, no automationId spliced into the ones that name a run, routed
 * before any draft is loaded, and described in the guide.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mcpBuilder = require('./mcpBuilder');

const RUN_TOOLS = ['automations_list_runs', 'automations_get_run_steps', 'automations_get_step_output', 'automations_list_run_files'];

test('the run tools are advertised, read-only and non-destructive', () => {
    const tools = new Map(mcpBuilder.buildToolList().map((t) => [t.name, t]));
    for (const name of RUN_TOOLS) {
        const tool = tools.get(name);
        assert.ok(tool, `${name} must be advertised`);
        assert.equal(tool.annotations.readOnlyHint, true, name);
        assert.equal(tool.annotations.destructiveHint, false, name);
        assert.ok(mcpBuilder.TOOL_NAMES.has(name));
    }
});

test('automations_list_runs takes an automationId; the tools that name a run do not', () => {
    const tools = new Map(mcpBuilder.buildToolList().map((t) => [t.name, t]));
    assert.ok(tools.get('automations_list_runs').inputSchema.required.includes('automationId'));
    for (const name of ['automations_get_run_steps', 'automations_get_step_output', 'automations_list_run_files']) {
        assert.ok(mcpBuilder.AUTOMATIONLESS_TOOLS.has(name), name);
        assert.ok(!tools.get(name).inputSchema.properties.automationId, name);
        assert.ok(tools.get(name).inputSchema.required.includes('runId'), name);
    }
});

test('callTool routes a run read to the run module: a run of nobody\'s is a described 404, not a throw', async () => {
    const automationStore = require('../stores/automationStore');
    const original = automationStore.getRun;
    automationStore.getRun = async () => null;
    try {
        const { result } = await mcpBuilder.callTool('automations_get_run_steps', { runId: 'run_none' }, { userId: 'u1' });
        assert.equal(result.code, 'not_found');
        assert.match(result.error, /not found/);
    } finally {
        automationStore.getRun = original;
    }
});

test('automations_get_guide lists the run tools', async () => {
    const triggerBus = require('./triggerBus');
    const catalogMod = require('./builderCatalog');
    const pickers = require('./builderPickerCatalog');
    const saved = [triggerBus.loadSession, catalogMod.buildCatalogForUser, pickers.buildPickerCatalogsForUser];
    triggerBus.loadSession = async () => null;
    catalogMod.buildCatalogForUser = async () => ({ apps: [], toolNames: new Set() });
    pickers.buildPickerCatalogsForUser = async () => ({});
    try {
        const { result } = await mcpBuilder.callTool('automations_get_guide', {}, { userId: 'u_stub' });
        for (const name of RUN_TOOLS) assert.ok(result.guide.includes(name), `the guide should mention ${name}`);
    } finally {
        [triggerBus.loadSession, catalogMod.buildCatalogForUser, pickers.buildPickerCatalogsForUser] = saved;
    }
});

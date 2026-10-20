/**
 * The form-scenario tools as the MCP dispatcher exposes them: advertised with
 * an automationId, routed before any draft is loaded, never throwing, and
 * described in the guide. Synthetic data only.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const mcpBuilder = require('./mcpBuilder');

const SCENARIO_TOOLS = ['automations_list_form_scenarios', 'automations_dry_run_form_scenario'];

test('the scenario tools are advertised and take an automationId', () => {
    const tools = new Map(mcpBuilder.buildToolList().map((t) => [t.name, t]));
    for (const name of SCENARIO_TOOLS) {
        const tool = tools.get(name);
        assert.ok(tool, `${name} must be advertised`);
        assert.ok(mcpBuilder.TOOL_NAMES.has(name));
        assert.ok(!mcpBuilder.AUTOMATIONLESS_TOOLS.has(name), name);
        assert.ok(tool.inputSchema.required.includes('automationId'), name);
        assert.equal(tool.inputSchema.properties.automationId.type, 'string');
    }
    assert.deepEqual(tools.get('automations_dry_run_form_scenario').inputSchema.required, ['automationId', 'scenarioId']);
});

test('callTool routes a scenario tool to its module: an automation of nobody\'s is a described 404, not a throw', async () => {
    const automationStore = require('../stores/automationStore');
    const original = automationStore.getAutomation;
    automationStore.getAutomation = async () => null;
    try {
        for (const name of SCENARIO_TOOLS) {
            const { result } = await mcpBuilder.callTool(name, { automationId: 'auto_none', scenarioId: 'fsc_1' }, { userId: 'u1' });
            assert.equal(result.code, 'not_found', name);
        }
    } finally {
        automationStore.getAutomation = original;
    }
});

test('automations_get_guide describes the form scenarios', async () => {
    const triggerBus = require('./triggerBus');
    const catalogMod = require('./builderCatalog');
    const pickers = require('./builderPickerCatalog');
    const saved = [triggerBus.loadSession, catalogMod.buildCatalogForUser, pickers.buildPickerCatalogsForUser];
    triggerBus.loadSession = async () => null;
    catalogMod.buildCatalogForUser = async () => ({ apps: [], toolNames: new Set() });
    pickers.buildPickerCatalogsForUser = async () => ({});
    try {
        const { result } = await mcpBuilder.callTool('automations_get_guide', {}, { userId: 'u_stub' });
        assert.ok(result.guide.includes('## Form scenarios (dry run)'));
        for (const name of SCENARIO_TOOLS) assert.ok(result.guide.includes(name), name);
    } finally {
        [triggerBus.loadSession, catalogMod.buildCatalogForUser, pickers.buildPickerCatalogsForUser] = saved;
    }
});

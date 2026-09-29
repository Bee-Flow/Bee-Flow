/**
 * BFSF-354 — the Automation Builder's webpage tools honour the Privacy
 * Shield's tool block lists.
 *
 * With the webpages beta and the full tool menu, the builder's model may call
 * the org's own webpage tools (webpage_db_query, webpage_file_read, ...): the
 * very tools direct chat dispatches, where a call whose arguments carry an
 * "Own server" category is refused and what the model reads of a result has
 * those categories stripped. The builder ran them with neither.
 *
 * The route is driven through testUtils/builderStreamHarness; the real gate
 * runs with its detector injected and the real orgShield classifying the
 * tools. Synthetic data.
 *
 * Run: cd server && node --test routes/ai/automationBuilder/chatStream.toolPiiGate.test.js
 */

'use strict';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { createBuilderStream, call } = require('../../../testUtils/builderStreamHarness');
const {
    SYNTH_EMAIL, OWN_SERVER_EMAIL, REFUSED_FOR_EMAIL, injectEmailDetector, assertStripped, assertRefusalAudited,
} = require('../../../testUtils/toolPiiGateHarness');

// Before anything that could load the stores the harness replaces.
const h = createBuilderStream();

const SERVER_DIR = path.join(__dirname, '..', '..', '..');
const fx = { shield: null, executed: [], guardrailRows: [] };

// The guardrail rows the gate writes. The route reads the store's export at
// call time, and its database is the harness's silent double.
const guardrailEventStore = require(path.join(SERVER_DIR, 'stores/guardrailEventStore'));
const realLogGuardrailEvent = guardrailEventStore.logGuardrailEvent;
guardrailEventStore.logGuardrailEvent = async (row) => { fx.guardrailRows.push(row); };

// The org's webpage tools: the real menu, a recording executor.
const webpageTools = require(path.join(SERVER_DIR, 'integrations/webpageAutomationTools'));
const realExecute = webpageTools.executeWebpageAutomationTool;
webpageTools.executeWebpageAutomationTool = async (name, args) => {
    fx.executed.push({ name, args });
    return { rows: [{ id: 1, contact: SYNTH_EMAIL }], columns: ['id', 'contact'] };
};

// The turn's shield; the rest of orgShield (tool classes, matching) stays real.
const orgShield = require(path.join(SERVER_DIR, 'core/privacy/orgShield'));
const realResolveShieldFor = orgShield.resolveShieldFor;
orgShield.resolveShieldFor = async () => fx.shield;

const toolPiiGate = require(path.join(SERVER_DIR, 'core/privacy/toolPiiGate'));
const realDetectPii = toolPiiGate._deps.detectPii;
injectEmailDetector(require('../../../core/privacy/toolPiiGate'));

after(() => {
    toolPiiGate._deps.detectPii = realDetectPii;
    orgShield.resolveShieldFor = realResolveShieldFor;
    webpageTools.executeWebpageAutomationTool = realExecute;
    guardrailEventStore.logGuardrailEvent = realLogGuardrailEvent;
    h.restore();
});

beforeEach(() => {
    fx.shield = null;
    fx.executed = [];
    fx.guardrailRows = [];
});

/** One builder turn whose first round calls `toolName` with `args`. */
async function turnCalling(toolName, args) {
    const run = await h.run({
        message: 'Schrijf elke nieuwe aanvraag weg in de database van de webpagina.',
        modelId: 'claude-sonnet-4-5',
        betaFeatures: ['automations', 'webpages'],
        rounds: [{ toolCalls: [call(toolName, args)] }, { text: 'Klaar.' }],
    });
    const toolMessages = run.roundMessages(1).filter((m) => m.role === 'tool');
    return { run, toolMessage: toolMessages.at(-1) };
}

test('a webpage tool whose arguments carry an own-server category is refused, never run', async () => {
    fx.shield = OWN_SERVER_EMAIL;
    const { run, toolMessage } = await turnCalling('webpage_db_query', {
        webpageId: 'wp-1', sql: 'SELECT * FROM leads WHERE email = ?', params: [SYNTH_EMAIL],
    });
    assert.deepStrictEqual(fx.executed, [], 'a refused tool must not run');
    assert.match(toolMessage.content, REFUSED_FOR_EMAIL);
    assert.match(JSON.stringify(run.dataOf('tool_call')), /was not called/);
    assert.strictEqual(fx.guardrailRows.length, 1);
    assertRefusalAudited(fx.guardrailRows, 'automation_builder');
    assert.strictEqual(fx.guardrailRows[0].organization_id, 'org1');
});

test('an own-server category in a webpage tool result is stripped from what the model reads', async () => {
    fx.shield = OWN_SERVER_EMAIL;
    const { run, toolMessage } = await turnCalling('webpage_db_query', { webpageId: 'wp-1', sql: 'SELECT * FROM leads' });
    assert.strictEqual(fx.executed.length, 1);
    assertStripped(toolMessage.content);
    // The builder panel is the user's own view and keeps the full result.
    assert.ok(JSON.stringify(run.dataOf('tool_call')).includes(SYNTH_EMAIL));
    assert.strictEqual(fx.guardrailRows.at(-1).action_taken, 'tool_result_redacted');
});

test('no shield: the webpage tool runs and its result reaches the model untouched', async () => {
    const { toolMessage } = await turnCalling('webpage_db_query', {
        webpageId: 'wp-1', sql: 'SELECT * FROM leads WHERE email = ?', params: [SYNTH_EMAIL],
    });
    assert.strictEqual(fx.executed.length, 1);
    assert.ok(toolMessage.content.includes(SYNTH_EMAIL));
    assert.deepStrictEqual(fx.guardrailRows, []);
});

test('the builder\'s own tools are not held to the lists', async () => {
    fx.shield = OWN_SERVER_EMAIL;
    const run = await h.run({
        message: 'Stuur een mail naar de klant.',
        modelId: 'claude-sonnet-4-5',
        betaFeatures: ['automations', 'webpages'],
        rounds: [{ toolCalls: [call('builder_set_plan', { todos: [{ text: `mail ${SYNTH_EMAIL}` }] })] }, { text: 'Klaar.' }],
    });
    const toolMessage = run.roundMessages(1).filter((m) => m.role === 'tool').at(-1);
    assert.ok(toolMessage.content.includes(SYNTH_EMAIL));
    assert.deepStrictEqual(fx.guardrailRows, []);
});

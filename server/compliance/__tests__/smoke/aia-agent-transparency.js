/**
 * Smoke scenarios — AI Act transparency towards the user:
 * Art. 50 (AI disclosure) and Art. 13 (agent description).
 */

const { t, assertStatus, resetState, _state, checks } = require('./harness');
const log = require('../../../telemetry/log');

module.exports = async function aiaAgentTransparency() {
    log.info('\n▶ AIA Art. 50 — AI disclosure');
    await t('not_applicable when 0 agents', async () => {
        resetState();
        _state.dbRows = [{ query: /FROM agents/, rows: [] }];
        assertStatus(await checks.aiDisclosure.evaluate('x'), 'not_applicable', 'no agents');
    });
    await t('warn when agent says "helpful assistant" only', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{ id: '1', name: 'Agent', system_prompt: 'You are a helpful assistant.', starter_prompts: '[]', config: '{}', organization_id: 'x' }],
        }];
        assertStatus(await checks.aiDisclosure.evaluate('x'), 'warn', 'bare assistant');
    });
    await t('pass when agent says "I am an AI assistant"', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{ id: '1', name: 'Agent', system_prompt: 'I am an AI assistant that helps.', starter_prompts: '[]', config: '{}', organization_id: 'x' }],
        }];
        assertStatus(await checks.aiDisclosure.evaluate('x'), 'pass', 'explicit disclosure');
    });
    await t('pass when disclosure is inside starter_prompts JSON array', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{
                id: '1', name: 'Agent',
                system_prompt: 'Short prompt.',
                starter_prompts: JSON.stringify(['Hi, I am an AI assistant']),
                config: '{}', organization_id: 'x',
            }],
        }];
        assertStatus(await checks.aiDisclosure.evaluate('x'), 'pass', 'starter_prompts JSON');
    });

    log.info('\n▶ AIA Art. 13 — Transparency / agent description');
    await t('not_applicable when 0 agents', async () => {
        resetState();
        _state.dbRows = [{ query: /FROM agents/, rows: [] }];
        assertStatus(await checks.transparency.evaluate('x'), 'not_applicable', 'no agents');
    });
    await t('pass with long description', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{ id: '1', name: 'A', description: 'This agent helps with drafting proposals for clients.', organization_id: 'x' }],
        }];
        assertStatus(await checks.transparency.evaluate('x'), 'pass', 'long desc');
    });
    await t('fail with null description', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [{ id: '1', name: 'A', description: null, organization_id: 'x' }],
        }];
        assertStatus(await checks.transparency.evaluate('x'), 'fail', 'null desc');
    });
    await t('warn when mix of short and long', async () => {
        resetState();
        _state.dbRows = [{
            query: /FROM agents/,
            rows: [
                { id: '1', name: 'A', description: 'Too short', organization_id: 'x' },
                { id: '2', name: 'B', description: 'This is a sufficiently long description of what it does.', organization_id: 'x' },
            ],
        }];
        assertStatus(await checks.transparency.evaluate('x'), 'warn', 'mixed');
    });
};

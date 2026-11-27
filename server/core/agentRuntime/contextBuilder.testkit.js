// @typecheck strict
/**
 * The harness of the prompt-cache split tests of ./contextBuilder.js (./contextBuilder.test.js and the cowork
 * module's ./contextBuilder.cowork.test.js): the DB-backed dependencies (tool hints, skills, house style, the open
 * document) mocked through the require cache, and `build`, which builds a system prompt for a fixed agent.
 * Require it before anything that loads ./contextBuilder.
 */

const Module = require('module');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-session-secret-0123456789abcdef';

function mock(/** @type {string} */ id, /** @type {unknown} */ exports) {
    const p = require.resolve(id);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

mock('../integrations/integrationTools', { buildToolHint: async () => '\n\n[TOOLS]\nweb search available.' });
/** @type {{ systemPromptAddendum: string, staticCount: number, dynamicSkillIds: string[], tools: unknown[] }} */
const NO_SKILLS = { systemPromptAddendum: '', staticCount: 0, dynamicSkillIds: [], tools: [] };
/** What the skill injection answers; a test that needs skills sets `skills.answer` and puts it back. */
const skills = { answer: NO_SKILLS };
mock('../tools/skillInjection', {
    buildSkillInjection: async () => skills.answer,
});
mock('../../stores/houseStyleStore', { getDefaultForOrg: async () => null });
// The open-document block reads through the store (readable for u1 only).
mock('../../stores/documentStore', {
    getDocument: async (/** @type {string} */ id, /** @type {string} */ userId) => (id === 'doc1' && userId === 'u1'
        ? { id: 'doc1', name: 'Offerte', docType: 'quote', bodyHtml: '<h1>Titel</h1><p>Inhoud <b>hier</b></p>' }
        : null),
});

const { buildSystemPrompt } = require('./contextBuilder');
const { systemPrefixFingerprint } = require('../llm/promptCacheStability');

const AGENT = { system_prompt: 'You are Bee Flow. It is {DateTime}.' };

const build = (over = {}) => buildSystemPrompt({
    agent: AGENT,
    tools: [],
    userId: 'u1',
    messageMetadata: { timezone: 'UTC' },
    memoryContext: '',
    isStrictKnowledge: false,
    ...over,
});

module.exports = { AGENT, NO_SKILLS, skills, build, buildSystemPrompt, systemPrefixFingerprint };

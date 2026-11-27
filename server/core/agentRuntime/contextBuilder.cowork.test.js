// @typecheck strict
/**
 * The system prompt as a Cowork run sees it (./contextBuilder.js): the run notes the static skills the prompt carried,
 * never the dynamic ones. Moved out of ./contextBuilder.test.js unchanged; it belongs to the cowork module. The
 * harness is ./contextBuilder.testkit.js.
 *
 * Run: node --test core/agentRuntime/contextBuilder.cowork.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { AGENT, NO_SKILLS, skills, build } = require('./contextBuilder.testkit');

test('a Cowork run notes the static skills the prompt carried, never the dynamic ones', async () => {
    const { createRunActivity } = require('../cowork/runActivity.mts');
    skills.answer = { systemPromptAddendum: '\n\n[ACTIVE SKILLS]\n### SKILL', staticCount: 1, dynamicSkillIds: ['d1'], tools: [] };
    try {
        const coworkRun = createRunActivity();
        await build({ agent: { ...AGENT, config: { attachedSkillIds: ['s1', 'd1'] } }, messageMetadata: { timezone: 'UTC', coworkRun } });
        assert.deepStrictEqual([...coworkRun.staticSkills], ['s1']);
        assert.deepStrictEqual([...coworkRun.activatedSkills], []);
    } finally {
        skills.answer = NO_SKILLS;
    }
});

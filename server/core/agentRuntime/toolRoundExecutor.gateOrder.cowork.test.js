// @typecheck
/**
 * The tool-round gate order (./toolRoundExecutor.gateOrder.test.js) as a Cowork run sees it: every settled call is
 * noted by name and outcome, a refusal with its gate, and the dispatcher gets the run context. Moved out of that file
 * unchanged; it belongs to the cowork module. The harness is ./toolRoundExecutor.gateOrder.testkit.js.
 *
 * Synthetic data. Run: node --test core/agentRuntime/toolRoundExecutor.gateOrder.cowork.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { REAL_EMAIL, TOKEN, S, reset, call, round, SHIELD, REGEX } = require('./toolRoundExecutor.gateOrder.testkit');

test('a Cowork run notes every settled call by name and outcome, a refusal with its gate, and the dispatcher gets the run context', async () => {
    const { createRunActivity, summariseActivity } = require('../cowork/runActivity.mts');
    reset({
        classOf: { outlook_create_draft: 'external' },
        argPii: (text) => (text.includes(REAL_EMAIL)
            ? { hasPii: true, entities: [{ text: REAL_EMAIL, category: 'Email', label: 'Email Address', offset: 0, length: 1 }] }
            : { hasPii: false, entities: [] }),
        verdicts: { not_mine: { action: 'refuse', reason: 'not_offered', enforced: true } },
    });
    const coworkRun = createRunActivity({ appOf: () => null });
    await round([
        call('c-1', 'outlook_create_draft', { to: TOKEN }),
        call('c-2', 'web_lookup', { q: 'opening hours' }),
        call('c-3', 'not_mine', {}),
    ], {
        dlpShield: SHIELD({ toolPiiPolicy: { external: { blockCategories: ['Email'] } } }),
        messageMetadata: { coworkRun },
    });
    const byName = Object.fromEntries(summariseActivity(coworkRun, new Map()).tools.map((t) => [t.name, t]));
    assert.deepStrictEqual([byName.outlook_create_draft.refused, byName.outlook_create_draft.reasons], [1, ['privacy_shield']]);
    assert.strictEqual(byName.web_lookup.ok, 1);
    assert.deepStrictEqual(byName.not_mine.reasons, ['not_offered']);
    assert.strictEqual(S.dispatchCtx.find((d) => d.name === 'web_lookup').ctx.coworkRun, coworkRun);

    reset({ regexIn: true });
    const guarded = createRunActivity({ appOf: () => null });
    await round([call('c-1', 'web_lookup', {})], { regexConfig: REGEX, messageMetadata: { coworkRun: guarded } });
    assert.deepStrictEqual(summariseActivity(guarded, new Map()).tools[0].reasons, ['guardrail']);
});

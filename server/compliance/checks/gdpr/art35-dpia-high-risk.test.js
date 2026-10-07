/**
 * GDPR-Art35-dpia-high-risk — the finding sentence reads as a sentence.
 *
 * The details say `required because it <reason>`, so every risk reason the
 * heuristic produces must complete that clause: "required because it has
 * automated decision-making switched on", never "because it
 * automated_decision_making flag". The subject (an agent) is listed with its
 * reason; evaluate() turns that into the sentence.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art35-dpia-high-risk.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const fx = { agents: [], dpia: null, current: true };
const restore = installResolveStub({
    '../../../db': { getAll: async () => fx.agents },
    '../../../stores/dpiaStore': {
        getLatestForAgent: async () => fx.dpia,
        isCurrent: () => fx.current,
    },
});
const check = require('./art35-dpia-high-risk');
test.after(restore);

const agent = (over) => ({ id: 'ag_1', name: 'Claims bot', model: 'local/llama', system_prompt: '', config: '{}', organization_id: 'org1', ...over });

test('every risk reason completes "required because it …"', async () => {
    fx.agents = [
        agent({ id: 'a1', config: JSON.stringify({ automated_decision_making: true }) }),
        agent({ id: 'a2', system_prompt: 'You approve or reject claims.' }),
        agent({ id: 'a3', config: JSON.stringify({ pii_categories: ['health', 'address'] }) }),
        agent({ id: 'a4', model: 'openai/gpt-5' }),
        agent({ id: 'a5' }),
    ];
    const subjects = await check.listSubjects('org1');
    assert.deepEqual(subjects.map(s => [s.id, s.risk_reason]), [
        ['a1', 'has automated decision-making switched on'],
        ['a2', 'has a system prompt that mentions automated decisions'],
        ['a3', 'processes PII categories: health, address'],
        ['a4', 'routes data to external provider (openai)'],
    ], 'a5 is not high-risk and is not listed');
    for (const s of subjects) assert.match(s.risk_reason, /^[a-z]+ /, `${s.id}: a clause that starts with a verb`);
});

test('a missing DPIA says why it is required, in one sentence', async () => {
    fx.agents = [agent({ id: 'a1', name: 'Schadebeoordeling', config: JSON.stringify({ automated_decision_making: true }) })];
    fx.dpia = null;
    const [subject] = await check.listSubjects('org1');
    const r = await check.evaluate('org1', subject);
    assert.equal(r.status, 'fail');
    assert.equal(r.details, 'No DPIA on record for "Schadebeoordeling" — required because it has automated decision-making switched on.');
    assert.doesNotMatch(r.details, /automated_decision_making|flag/);
});

test('another organisation\'s agents are not this organisation\'s subjects', async () => {
    fx.agents = [agent({ id: 'x1', organization_id: 'org2', config: JSON.stringify({ automated_decision_making: true }) })];
    assert.deepEqual(await check.listSubjects('org1'), []);
});

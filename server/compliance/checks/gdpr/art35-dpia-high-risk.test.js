// @typecheck
/**
 * GDPR-Art35-dpia-high-risk — the finding sentence reads as a sentence.
 *
 * The details say `required because it <reason>`, so every risk reason the
 * heuristic produces must complete that clause: "required because it has
 * automated decision-making switched on", never "because it
 * automated_decision_making flag". The subject (an agent) is listed with its
 * reason; evaluate() turns that into the sentence.
 *
 * Against a real Postgres: the boot ladder's schema on PGlite
 * (testUtils/pgliteTemplate.js ladderPglite) behind db.js's pool, with the
 * real dpiaStore.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art35-dpia-high-risk.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { failReads } = require('../../../testUtils/pgliteFaults');

const { pg, close } = usePglitePool(ladderPglite());
const dpiaStore = require('../../../stores/dpiaStore');
const check = require('./art35-dpia-high-risk');
test.after(close);
test.beforeEach(() => pg.exec('DELETE FROM agents; DELETE FROM dpia_assessments'));

/** @param {Record<string, unknown>} over */
async function agent(over) {
    const r = { id: 'ag_1', name: 'Claims bot', owner_id: 'owner', model: 'local/llama', system_prompt: '', config: '{}', organization_id: 'org1', is_published: true, ...over };
    const cols = Object.keys(r);
    await pg.query(`INSERT INTO agents (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(r));
}

test('every risk reason completes "required because it …"', async () => {
    await agent({ id: 'a1', config: JSON.stringify({ automated_decision_making: true }) });
    await agent({ id: 'a2', system_prompt: 'You approve or reject claims.' });
    await agent({ id: 'a3', config: JSON.stringify({ pii_categories: ['health', 'address'] }) });
    await agent({ id: 'a4', model: 'openai/gpt-5' });
    await agent({ id: 'a5' });
    await agent({ id: 'a6', config: JSON.stringify({ automated_decision_making: true }), is_published: false });
    const subjects = await check.listSubjects('org1');
    assert.deepEqual(subjects.map(s => [s.id, s.risk_reason]).sort(), [
        ['a1', 'has automated decision-making switched on'],
        ['a2', 'has a system prompt that mentions automated decisions'],
        ['a3', 'processes PII categories: health, address'],
        ['a4', 'routes data to external provider (openai)'],
    ], 'a5 is not high-risk and a6 is not published: neither is listed');
    for (const s of subjects) assert.match(s.risk_reason, /^[a-z]+ /, `${s.id}: a clause that starts with a verb`);
});

test('what RUNS is assessed: the published config wins over the draft', async () => {
    await agent({ id: 'a1', config: JSON.stringify({ automated_decision_making: true }), published_config: JSON.stringify({}) });
    await agent({ id: 'a2', config: '{}', published_config: JSON.stringify({ automated_decision_making: true }) });
    assert.deepEqual((await check.listSubjects('org1')).map(s => s.id), ['a2']);
});

test('a missing DPIA says why it is required, in one sentence', async () => {
    await agent({ id: 'a1', name: 'Schadebeoordeling', config: JSON.stringify({ automated_decision_making: true }) });
    const [subject] = await check.listSubjects('org1');
    const r = await check.evaluate('org1', subject);
    assert.equal(r.status, 'fail');
    assert.equal(r.details, 'No DPIA on record for "Schadebeoordeling" — required because it has automated decision-making switched on.');
    assert.doesNotMatch(r.details, /automated_decision_making|flag/);
});

test('a DPIA on record passes, an expired one warns, and another organisation\'s does not count', async () => {
    await agent({ id: 'a1', name: 'Claims bot', config: JSON.stringify({ automated_decision_making: true }) });
    const [subject] = await check.listSubjects('org1');
    await dpiaStore.upsertAssessment('org2', 'a1', { mode: 'attestation' });
    assert.equal((await check.evaluate('org1', subject)).status, 'fail');
    await dpiaStore.upsertAssessment('org1', 'a1', { mode: 'attestation', expires_at: '2020-01-01T00:00:00Z' });
    assert.equal((await check.evaluate('org1', subject)).status, 'warn');
    await pg.exec('DELETE FROM dpia_assessments');
    await dpiaStore.upsertAssessment('org1', 'a1', { mode: 'attestation' });
    assert.equal((await check.evaluate('org1', subject)).status, 'pass');
});

test('another organisation\'s agents are not this organisation\'s subjects', async () => {
    await agent({ id: 'x1', organization_id: 'org2', config: JSON.stringify({ automated_decision_making: true }) });
    assert.deepEqual(await check.listSubjects('org1'), []);
});

test('an agent without an organisation is the default bucket\'s subject, never every tenant\'s', async () => {
    // `a.organization_id && a.organization_id !== orgId` kept every org-less
    // agent for every organisation: tenant A's legacy agent showed up by name
    // in tenant B's DPIA list and evidence. Only org-less users see such an
    // agent, and the scheduler sweeps them as 'default' (same convention as
    // AIA Art. 13, 50 and 53).
    await agent({ id: 'x', name: 'Legacy agent', organization_id: null, model: 'openai/gpt-4o' });
    await agent({ id: 'e', name: 'Empty org', organization_id: '', model: 'openai/gpt-4o' });
    await agent({ id: 'b', name: 'Org B agent', organization_id: 'orgB', model: 'openai/gpt-4o' });
    assert.deepEqual((await check._highRiskAgents('orgA')).map(s => s.id), []);
    assert.deepEqual((await check._highRiskAgents('default')).map(s => s.id).sort(), ['e', 'x']);
    assert.deepEqual((await check._highRiskAgents('orgB')).map(s => s.id), ['b']);
});

test('the list is the whole population: a read error throws, and vanished agents are retired', async () => {
    const { _asListing } = require('../../runner');
    const restore = await failReads(pg, 'agents', '08006', 'connection refused');
    try {
        await assert.rejects(() => check.listSubjects('org1'), 'a failed read must not read as "no high-risk agents"');
    } finally {
        await restore();
    }
    assert.equal(check.retiresVanished, true);
    assert.match(check.retiredDetails, /No longer a published high-risk agent/);
    assert.equal(_asListing(check, [{ id: 'a1' }]).complete, true);
});

/**
 * AIA-Art26-human-oversight — the oversight answer is evidence that someone is
 * named, not the name itself.
 *
 * The DPIA question is "Who checks the output, and when?", so the answer is
 * usually a person. Check results are written into the append-only evidence
 * chain, which cannot forget that person later.
 *
 * Run: cd server && node --test compliance/checks/aia/art26-human-oversight.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const fx = { dpia: null, current: true };
const restore = installResolveStub({
    '../../../stores/dpiaStore': {
        getLatestForAgent: async () => fx.dpia,
        isCurrent: () => fx.current,
    },
    '../gdpr/art35-dpia-high-risk': { _highRiskAgents: async () => [] },
});
const check = require('./art26-human-oversight');
test.after(restore);

const SUBJECT = { id: 'ag_1', label: 'Recruitment screener', risk_reason: 'automated_decision_making flag' };

test('a named overseer: pass, and the answer does not reach details or evidence', async () => {
    fx.dpia = { mode: 'questionnaire', answers: { human_oversight: 'Recruiter Jan Jansen reviews every result' } };
    const r = await check.evaluate('org1', SUBJECT);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.human_oversight_recorded, true);
    assert.doesNotMatch(JSON.stringify(r), /Jan Jansen|reviews every result/);
});

test('a non-string answer is not a named person: warn', async () => {
    for (const value of [true, {}, 42, '   ']) {
        fx.dpia = { mode: 'questionnaire', answers: { human_oversight: value } };
        const r = await check.evaluate('org1', SUBJECT);
        assert.equal(r.status, 'warn', JSON.stringify(value));
    }
});

test('no current DPIA: fail', async () => {
    fx.dpia = null;
    assert.equal((await check.evaluate('org1', SUBJECT)).status, 'fail');
});

test('the high-risk list is the whole population: a vanished agent is retired, not kept failing', () => {
    // art35._highRiskAgents throws on a failed read, so an empty list really
    // means "no high-risk agent left" and the runner may retire the slots.
    assert.equal(check.retiresVanished, true);
    assert.equal(typeof check.retiredDetails, 'string');
    assert.ok(check.retiredDetails.length > 0);
});

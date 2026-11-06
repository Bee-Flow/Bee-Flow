'use strict';

/**
 * The attestation check: every field named when missing, a DPIA id looked up per organisation, and the stored
 * value holds enum values and an id only.
 *
 * Run: cd server && node --test core/kb/queryLog/attestation.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateAttestation } = require('./attestation.mts');
const { ATTESTATION } = require('../../../testUtils/kbQueryLogAttestation');

const lookup = async (org, id) => org === 'org1' && id === '7';

test('a complete attestation passes and is normalised', async () => {
    const r = await validateAttestation({ ...ATTESTATION, free: 'text is dropped' }, 'org1', lookup);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { ...ATTESTATION, dpiaId: null });
});

test('nothing, or junk, names every field', async () => {
    for (const raw of [undefined, null, 'x', [], {}]) {
        const r = await validateAttestation(raw, 'org1', lookup);
        assert.equal(r.ok, false);
        assert.deepEqual(r.missing.sort(), ['dpia', 'privacyNoticeUpdated', 'purpose', 'worksCouncil']);
    }
});

test('works council: pending is not an answer; not_applicable needs a known reason; consent needs none', async () => {
    assert.deepEqual((await validateAttestation({ ...ATTESTATION, worksCouncil: 'pending' }, 'org1', lookup)).missing, ['worksCouncil']);
    assert.deepEqual((await validateAttestation({ ...ATTESTATION, worksCouncilReason: undefined }, 'org1', lookup)).missing, ['worksCouncilReason']);
    const ok = await validateAttestation({ ...ATTESTATION, worksCouncil: 'consent', worksCouncilReason: 'ignored' }, 'org1', lookup);
    assert.equal(ok.ok, true);
    assert.equal(ok.value.worksCouncilReason, null);
});

test('dpia done needs a DPIA id that exists in THIS organisation', async () => {
    const att = { ...ATTESTATION, dpia: 'done' };
    assert.deepEqual((await validateAttestation(att, 'org1', lookup)).missing, ['dpiaId']);
    assert.deepEqual((await validateAttestation({ ...att, dpiaId: '7' }, 'org2', lookup)).missing, ['dpiaId']);
    assert.deepEqual((await validateAttestation({ ...att, dpiaId: '8' }, 'org1', lookup)).missing, ['dpiaId']);
    const ok = await validateAttestation({ ...att, dpiaId: 7 }, 'org1', lookup);
    assert.equal(ok.value.dpiaId, '7');
    const boom = await validateAttestation({ ...att, dpiaId: '7' }, 'org1', async () => { throw new Error('db'); });
    assert.deepEqual(boom.missing, ['dpiaId']);
});

test('not_required drops a stray dpia id', async () => {
    const ok = await validateAttestation({ ...ATTESTATION, dpiaId: '7' }, 'org1', lookup);
    assert.equal(ok.value.dpiaId, null);
});

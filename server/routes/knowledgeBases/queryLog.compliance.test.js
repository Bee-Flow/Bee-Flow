'use strict';

/**
 * The KB query-log routes, the compliance half: a settings change goes into the compliance evidence
 * chain, and an attestation's DPIA comes from the DPIA register (stores/dpiaStore), both the
 * compliance module's. Over the world of queryLog.test.js (queryLog.testkit.js).
 *
 * Run: cd server && node --test routes/knowledgeBases/queryLog.compliance.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ATTESTATION, enableBody } = require('../../testUtils/kbQueryLogAttestation');
const {
    useQueryLogWorld, pg, as, put, enabledNow, ORG, ORG_OTHER, OWNER, READER, OUTSIDER, FREE_OWNER,
} = require('./queryLog.testkit');

const world = useQueryLogWorld();

test('a valid attestation is put into the evidence', async () => {
    const res = await put(enableBody({ retentionDays: 180 }));
    assert.equal(res.status, 200);
    const ev = (await pg.query(`SELECT payload FROM compliance_evidence WHERE check_id = 'GDPR-Art5-kb-query-log' AND subject_id = $1`, [world.kbId])).rows;
    const p = typeof ev[0].payload === 'string' ? JSON.parse(ev[0].payload) : ev[0].payload;
    assert.equal(p.attDpia, 'not_required');
    assert.equal(p.attWorksCouncil, 'not_applicable');
    assert.equal(p.attPrivacyNoticeUpdated, true);
});

test('dpia done needs a DPIA of THIS organisation; one of another organisation is refused', async () => {
    const dpiaStore = require('../../stores/dpiaStore');
    const mine = await dpiaStore.upsertAssessment(ORG, 'agent-ql', { approved_by: OWNER.id });
    const foreign = await dpiaStore.upsertAssessment(ORG_OTHER, 'agent-ql-other', { approved_by: OUTSIDER.id });
    const att = (dpiaId) => ({ ...ATTESTATION, dpia: 'done', dpiaId });

    let res = await put({ enabled: true, attestation: att(String(foreign.id)) });
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.details.missing, ['dpiaId']);
    res = await put({ enabled: true, attestation: att('999999') });
    assert.equal(res.status, 400);
    res = await put({ enabled: true, attestation: att(undefined) });
    assert.equal(res.status, 400);
    assert.equal(await enabledNow(), false);

    res = await put({ enabled: true, attestation: att(String(mine.id)) });
    assert.equal(res.status, 200);
    assert.equal(res.body.attestation.dpiaId, String(mine.id));
});

test('GET /query-log/dpias: managers of the organisation get their own organisation\'s DPIAs only; others get a 404', async () => {
    const dpiaStore = require('../../stores/dpiaStore');
    const mine = await dpiaStore.upsertAssessment(ORG, 'agent-dpias', { approved_by: OWNER.id });
    await dpiaStore.upsertAssessment(ORG_OTHER, 'agent-theirs', { approved_by: OUTSIDER.id });
    // The outsider manages knowledge in their own organisation (owns a base there), as they do in
    // queryLog.test.js once its acknowledge test ran: so their answer is a list, not a 404.
    await require('../../stores/knowledgeBases').createKB(OUTSIDER.id, 'Foreign', '', ORG_OTHER, { isPublished: true });

    const ok = await world.api.call('GET', '/query-log/dpias', as(OWNER));
    assert.equal(ok.status, 200);
    const ids = ok.body.dpias.map((d) => d.id);
    assert.ok(ids.includes(String(mine.id)));
    assert.ok(ok.body.dpias.every((d) => Object.keys(d).sort().join() === 'id,status,title'));
    assert.ok(!JSON.stringify(ok.body).includes('agent-theirs'), 'no other organisation');

    assert.equal((await world.api.call('GET', '/query-log/dpias', as(READER))).status, 404, 'a reader who manages nothing');
    assert.equal((await world.api.call('GET', '/query-log/dpias', as(FREE_OWNER))).status, 403, 'licence');
    assert.equal((await world.api.call('GET', '/query-log/dpias', { user: null })).status, 401);
    const theirs = (await world.api.call('GET', '/query-log/dpias', as(OUTSIDER))).body.dpias;
    assert.ok(!theirs.some((d) => d.id === String(mine.id)));
});

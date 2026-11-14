'use strict';

/**
 * Journey: a data subject's access request, from the public form to the dossier.
 *
 * Somebody without an account files an access request (GDPR Art. 15) with
 * their address; the organisation the address belongs to gets it, and the
 * subject gets the acknowledgement mail with an identity link. The subject
 * follows the link (the token verifies them, once); the organisation's admin
 * sees the request, fulfils it, and the result mail goes to the subject. The
 * dossier the admin downloads describes the handling and carries none of the
 * subject's data: not the address, not the note they typed, not the summary.
 * An admin of another organisation does not see the request at all.
 *
 * The mail provider is the only thing recorded instead of used.
 *
 * Run: cd server && npm run test:journeys
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openWorld } = require('./journeyWorld.testkit');

const PW = 'Marble-sparrow-9041!';
const SUBJECT = 'dsr-subject@journey.test';
const NOTE = 'Please send me everything you hold about me, my case number is 4471.';
const SUMMARY = 'Sent the export of the chat history and profile to the subject.';

/** @type {Awaited<ReturnType<typeof openWorld>>} */
let world;
/** @type {Array<{ kind: string, mail: any }>} */
const mails = [];
/** @type {(mail: any) => void} */
let ackArrived = () => {};
const ack = new Promise((resolve) => { ackArrived = resolve; });

before(async () => {
    world = await openWorld({ mounts: ['auth', 'dsr'] });
    await world.seedOrg({ id: 'org-dsr-a', name: 'Privacy org A' });
    await world.seedOrg({ id: 'org-dsr-b', name: 'Privacy org B' });
    await world.seedUser({ id: 'dsr-admin', password: PW, organizationId: 'org-dsr-a', orgRole: 'org_admin' });
    await world.seedUser({ id: 'dsr-other-admin', password: PW, organizationId: 'org-dsr-b', orgRole: 'org_admin' });
    // The data subject is a person the organisation holds data about.
    await world.seedUser({ id: 'dsr-subject', password: PW, organizationId: 'org-dsr-a', orgRole: 'member', email: SUBJECT });

    const emailService = require('../utils/emailService');
    world.swaps.swap(emailService, 'sendDsrAckEmail', async (/** @type {any} */ mail) => { mails.push({ kind: 'ack', mail }); ackArrived(mail); return { success: true }; });
    world.swaps.swap(emailService, 'sendDsrResultEmail', async (/** @type {any} */ mail) => { mails.push({ kind: 'result', mail }); return { success: true }; });
}, { timeout: 120_000 });

after(() => world?.close());

test('public intake → identity link → admin fulfils → result mail → the dossier carries no personal data', { timeout: 60_000 }, async () => {
    const subject = world.anonymous();
    const filed = await subject.call('POST', '/api/dsr/requests', { body: { subject_email: SUBJECT, request_type: 'access', notes: NOTE } });
    assert.equal(filed.status, 201, filed.text);
    const id = filed.body.id;

    // The acknowledgement is sent after the answer; the journey waits for the mail itself.
    const ackMail = await ack;
    assert.equal(ackMail.to, SUBJECT);
    const link = new URL(ackMail.verifyUrl);
    const token = link.searchParams.get('token');
    assert.ok(token, ackMail.verifyUrl);

    const verified = await subject.call('POST', `/api/dsr/requests/${id}/verify`, { body: { token } });
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.body.identity_status, 'verified_email_link');
    const replay = await subject.call('POST', `/api/dsr/requests/${id}/verify`, { body: { token } });
    assert.equal(replay.status, 400, 'an identity link works once');

    const admin = await world.login('dsr-admin', PW);
    const listed = await admin.call('GET', '/api/dsr/requests');
    assert.equal(listed.status, 200, listed.text);
    assert.ok(JSON.stringify(listed.body).includes(String(id)), 'the organisation of the address got the request');

    const other = await world.login('dsr-other-admin', PW);
    const foreign = await other.call('GET', `/api/dsr/requests/${id}`);
    assert.ok(foreign.status === 403 || foreign.status === 404, `another organisation's admin: ${foreign.status} ${foreign.text.slice(0, 200)}`);
    const foreignList = await other.call('GET', '/api/dsr/requests');
    assert.ok(!JSON.stringify(foreignList.body ?? '').includes(SUBJECT), 'another organisation\'s list does not name the subject');

    const fulfilled = await admin.call('POST', `/api/dsr/requests/${id}/fulfil`, { body: { status: 'fulfilled', result_summary: SUMMARY } });
    assert.equal(fulfilled.status, 200, fulfilled.text);
    assert.equal(fulfilled.body.status, 'fulfilled');
    const result = mails.find((m) => m.kind === 'result');
    assert.equal(result?.mail.to, SUBJECT, 'the result goes to the subject, by e-mail');

    const dossier = await admin.call('GET', `/api/dsr/requests/${id}/export`);
    assert.equal(dossier.status, 200, dossier.text);
    assert.equal(dossier.body.request.status, 'fulfilled');
    for (const personal of [SUBJECT, 'dsr-subject', NOTE, SUMMARY, 'case number']) {
        assert.ok(!dossier.text.includes(personal), `the dossier carries ${JSON.stringify(personal)}`);
    }
});

/**
 * The egress rule, tested from the outside.
 *
 * The regression worth guarding here is not a bug in today's code — it is a
 * future contributor helpfully putting "customer" back into the description
 * template, or adding a column to support_threads that the payload picks up.
 * So the central test populates EVERY personal field on the thread and asserts
 * none of those values appear anywhere in the payload, rather than checking
 * that a particular field was omitted.
 */

const test = require('node:test');
const assert = require('assert');
const Module = require('module');

// The guard service is not running in tests, and the point of these cases is
// the construction control, not the scan. Stub detectPii to "not installed"
// (null) by default; the scan cases override it per test.
let stubDetect = async () => null;
// What getConfig hands back for the subject switch: the parsed value, as the
// real store returns it, so the 'true' the route saves arrives as true.
let storedSubject = null;
const origLoad = Module._load;
Module._load = function (request, _parent, _isMain) {
    if (request.endsWith('piiDetection/detect')) {
        return { detectPii: (...args) => stubDetect(...args) };
    }
    if (request.endsWith('stores/configStore')) {
        return { getConfig: async () => storedSubject };
    }
    return origLoad.apply(this, arguments);
};

const egress = require('./issueEgress');

Module._load = origLoad;

// A thread with something identifying in every slot the schema offers.
const HOT_THREAD = {
    id: '11111111-2222-3333-4444-555555555555',
    ticket_ref: 'BF-2451',
    source: 'email',
    subject: 'Invoice for Jan de Vries at Acme Holding is wrong',
    created_at: '2026-08-20T09:15:00.000Z',
    requester_email: 'jan.devries@acme-holding.nl',
    requester_name: 'Jan de Vries',
    requester_org_name: 'Acme Holding',
    requester_org_role: 'org_admin',
    requester_ip: '203.0.113.44',
    requester_ua: 'Mozilla/5.0 (Macintosh)',
    requester_user_id: 'user_9f3a',
    assignee_user_id: 'staff_2',
};

const SECRETS = [
    'jan.devries@acme-holding.nl',
    'Jan de Vries',
    'Acme Holding',
    '203.0.113.44',
    'Mozilla/5.0',
    'user_9f3a',
];

test('payload carries the reference and the link, and nothing that identifies anyone', () => {
    const p = egress.buildIssuePayload({
        thread: HOT_THREAD,
        summary: 'Invoice total ignores the annual discount',
        description: 'Totals are computed before the discount is applied.',
    });

    const whole = `${p.summary}\n${p.description}`;
    for (const secret of SECRETS) {
        assert.ok(!whole.includes(secret), `payload leaked ${JSON.stringify(secret)}`);
    }

    assert.match(p.description, /BF-2451/);
    assert.match(p.description, /\/app\/admin\/support\/11111111-2222-3333-4444-555555555555/);
    assert.strictEqual(p.ticketRef, 'BF-2451');
});

test('the subject is withheld unless an admin turned it on', () => {
    const off = egress.buildIssuePayload({ thread: HOT_THREAD, summary: 'x' });
    assert.ok(!off.description.includes('Jan de Vries'));
    assert.ok(!/^Subject:/m.test(off.description));

    const on = egress.buildIssuePayload({ thread: HOT_THREAD, summary: 'x', includeSubject: true });
    assert.match(on.description, /^Subject: Invoice for Jan de Vries/m);
    // Turning it on is a deliberate choice that the screen still has to clear —
    // this subject would not survive screenText, and that is the design.
});

test('a thread with no ticket_ref is refused rather than sent without one', () => {
    assert.throws(
        () => egress.buildIssuePayload({ thread: { ...HOT_THREAD, ticket_ref: null }, summary: 'x' }),
        /ticket_ref/,
    );
});

test('summary is required and length-capped', () => {
    assert.throws(() => egress.buildIssuePayload({ thread: HOT_THREAD, summary: '   ' }), /summary/);
    const long = egress.buildIssuePayload({ thread: HOT_THREAD, summary: 'a'.repeat(500) });
    assert.strictEqual(long.summary.length, 250);
});

test('screenText catches the customer pasted into free text, with no guard running', async () => {
    stubDetect = async () => null; // guard not installed

    const bad = await egress.screenText(
        'Jan de Vries says the invoice is wrong, reach him at jan.devries@acme-holding.nl',
        { thread: HOT_THREAD },
    );
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.scanned, false, 'no guard ran, and the result must say so');
    const labels = bad.findings.map(f => f.label);
    assert.ok(labels.includes('customer name'));
    assert.ok(labels.includes('email address'));

    const clean = await egress.screenText('Totals ignore the annual discount.', { thread: HOT_THREAD });
    assert.strictEqual(clean.ok, true);
});

test('a surname alone is still the customer; a short particle is not', async () => {
    stubDetect = async () => null;

    // The leak this catches: an agent drops the first name and thinks that
    // anonymises it. Each name part of real length is matched on its own.
    for (const text of ['Vries reports the same thing', 'de Vries reports it', 'Jan reports it']) {
        const r = await egress.screenText(text, { thread: HOT_THREAD });
        assert.strictEqual(r.ok, false, `should have blocked: ${text}`);
    }

    // 'de' is two characters and appears in ordinary Dutch prose. Matching it
    // would block every second sentence, so the floor is four characters.
    const particle = await egress.screenText('de factuur klopt niet', { thread: HOT_THREAD });
    assert.strictEqual(particle.ok, true);
});

test('the email local part is treated as the person', async () => {
    stubDetect = async () => null;
    const r = await egress.screenText('user jan.devries hit this', { thread: HOT_THREAD });
    assert.strictEqual(r.ok, false);
});

test('guard findings block, and only for categories that identify a person', async () => {
    stubDetect = async () => ({
        hasPii: true,
        entities: [
            { category: 'Person', text: 'someone' },
            { category: 'Person', text: 'else' },
            { category: 'URL', text: 'https://beeflow.nl' },
        ],
    });
    const r = await egress.screenText('unrelated text', { thread: null });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.scanned, true);
    assert.deepStrictEqual(r.findings, [{ category: 'Person', label: 'Person', count: 2 }]);

    // Our own staff link is a URL by design and must not trip the gate.
    stubDetect = async () => ({ hasPii: true, entities: [{ category: 'URL', text: 'https://beeflow.nl' }] });
    const urlOnly = await egress.screenText('see https://beeflow.nl/app/admin/support/x', { thread: null });
    assert.strictEqual(urlOnly.ok, true);
});

test('a guard that throws is unscanned, not clean', async () => {
    stubDetect = async () => { throw new Error('guard exploded'); };
    const r = await egress.screenText('anything at all', { thread: null });
    assert.strictEqual(r.scanned, false);
    assert.strictEqual(r.ok, true, 'construction is the control that cannot fail; this one fails open');
});

test('findings render as something an agent can act on', () => {
    assert.strictEqual(
        egress.describeFindings([
            { category: 'KnownIdentifier', label: 'customer name', count: 1 },
            { category: 'PhoneNumber', label: 'PhoneNumber', count: 2 },
        ]),
        "the customer's customer name, PhoneNumber (2)",
    );
    assert.strictEqual(egress.describeFindings([]), '');
});

test('word matching does not fire on a longer word that merely starts the same', async () => {
    stubDetect = async () => null;
    const thread = { ...HOT_THREAD, requester_name: 'Jan Bakker', requester_email: 'jb@acme-holding.nl' };

    // 'Janssen' and 'January' both begin with the customer's first name. A
    // substring match would block both and teach agents to ignore the warning.
    for (const text of ['Janssen from support looked at it', 'happens every January']) {
        const r = await egress.screenText(text, { thread });
        assert.strictEqual(r.ok, true, `should not have blocked: ${text}`);
    }
    const hit = await egress.screenText('Jan opened this yesterday', { thread });
    assert.strictEqual(hit.ok, false);
});

test('names with diacritics match as whole words', async () => {
    stubDetect = async () => null;
    const thread = { ...HOT_THREAD, requester_name: 'José Müller', requester_email: 'jm@acme-holding.nl' };

    for (const text of ['José reported it', 'Müller reported it', 'reported by MÜLLER']) {
        const r = await egress.screenText(text, { thread });
        assert.strictEqual(r.ok, false, `should have blocked: ${text}`);
    }
    // JS's own \b would split on the accent and match the fragment; the
    // Unicode lookarounds must not.
    const near = await egress.screenText('Müllerstrasse is the address', { thread });
    assert.strictEqual(near.ok, true);
});

test('the subject switch reads back as the route saved it', async () => {
    storedSubject = true;
    assert.strictEqual(await egress.includeSubjectEnabled(), true);
    storedSubject = false;
    assert.strictEqual(await egress.includeSubjectEnabled(), false);
    // Never set: the subject stays home.
    storedSubject = null;
    assert.strictEqual(await egress.includeSubjectEnabled(), false);
});

// @typecheck
'use strict';

/**
 * formJourney.paused (WI-12, D4c): when a form journey pauses, every visitor
 * session of it is held open to the pause deadline + 1 h, and a page that
 * becomes due right after an approval is announced to the submitter: one bell,
 * one e-mail, to them only, once, with nothing in it but the form title and
 * their own link.
 *
 * The stores, the bell and the mailbox are fakes handed to makeFormJourney;
 * the SQL is pinned in stores/automationStore/formJourneyStore.pg.test.js and
 * the whole journey in routes/automation/formPublic/formJourney.e2e.test.js.
 *
 * Run: cd server && node --test automation/formJourney.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
    makeFormJourney, sessionUntil, formPageLink, formTitleOf, SESSION_GRACE_MS, NO_DEADLINE_HOLD_MS,
} = require('./formJourney.mts');

const NOW = Date.parse('2026-11-03T09:00:00.000Z');
const TTL = 8 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = 'a'.repeat(48);
const SID = 'c'.repeat(48);

const AUTOMATION = {
    id: 'auto1',
    title: 'Quote requests',
    definition: {
        trigger: { id: 'trg', kind: 'form', form: { title: 'Request a quote', fields: [] } },
        steps: [
            { id: 'gate', type: 'approval', approval: {} },
            { id: 'fp2', type: 'form_page', form: { title: 'Page two', fields: [] } },
            { id: 'fp3', type: 'form_page', form: { title: 'Page three', fields: [] } },
        ],
    },
};

/** @param {{ sessions?: any[], runs?: Record<string, any>, claimed?: Set<string>, profile?: any, emailResult?: boolean | null }} [over] */
function harness(over = {}) {
    const rec = { extended: /** @type {any[]} */ ([]), bells: /** @type {any[]} */ ([]), emails: /** @type {any[]} */ ([]), settled: /** @type {any[]} */ ([]), warns: /** @type {string[]} */ ([]) };
    const claimed = over.claimed || new Set();
    const sessions = over.sessions || [{ id: SID, formPageId: TOKEN, isTest: false, expiresAt: null }];
    const runs = over.runs || { root: { id: 'root', rootRunId: 'root', submittedByUserId: 'visitor1', rootStepId: null } };
    const journey = makeFormJourney({
        now: () => NOW,
        sessionTtlMs: TTL,
        sessionsOfJourney: async () => sessions,
        extendSessionUntil: async (id, until) => { rec.extended.push({ id, until: until.toISOString() }); },
        getRun: async (id) => runs[id] || null,
        profileOf: () => over.profile || { kind: 'production', origin: 'trigger' },
        claimNotice: async ({ runId }) => {
            if (claimed.has(runId)) return null;
            claimed.add(runId);
            return `claim_${runId}`;
        },
        settleNotice: async (claimId, r) => { rec.settled.push({ claimId, ...r }); },
        bell: async (p) => { rec.bells.push(p); },
        email: async (p) => { rec.emails.push(p); return over.emailResult === undefined ? true : over.emailResult; },
        absoluteUrl: (path) => `https://bee.example${path}`,
        warn: (m) => { rec.warns.push(m); },
    });
    return { journey, rec, claimed };
}

/** The leg that continued from the approval and paused on page 2. */
const LEG2 = { id: 'leg2', parentRunId: 'root', rootRunId: 'root', automationId: 'auto1' };
const PAGE2_PAUSE = { run: LEG2, status: 'awaiting_form', expiresAt: new Date(NOW + 7 * DAY).toISOString(), automation: AUTOMATION, resumedFromStepId: 'gate' };

test('an approval pause holds the session until its deadline + 1 h, not the 8 h idle limit', async () => {
    const { journey, rec } = harness();
    const deadline = new Date(NOW + 7 * DAY).toISOString();
    const r = await journey.paused({ run: { id: 'root', rootRunId: 'root' }, status: 'awaiting_approval', expiresAt: deadline, automation: AUTOMATION });
    assert.deepStrictEqual(rec.extended, [{ id: SID, until: new Date(NOW + 7 * DAY + SESSION_GRACE_MS).toISOString() }]);
    assert.strictEqual(r.extended, 1);
    assert.strictEqual(r.notified, false, 'an approval pause tells the visitor nothing: the page already said so');
    assert.deepStrictEqual(rec.bells, []);
    assert.deepStrictEqual(rec.emails, []);
});

test('sessionUntil: never below the idle TTL; no deadline holds at most 30 days', () => {
    assert.strictEqual(sessionUntil(NOW, TTL, new Date(NOW + 60_000).toISOString()).getTime(), NOW + TTL, 'a short pause keeps the 8 h');
    assert.strictEqual(sessionUntil(NOW, TTL, new Date(NOW + 2 * DAY).toISOString()).getTime(), NOW + 2 * DAY + SESSION_GRACE_MS);
    assert.strictEqual(sessionUntil(NOW, TTL, null).getTime(), NOW + NO_DEADLINE_HOLD_MS);
    assert.strictEqual(sessionUntil(NOW, TTL, 'not a date').getTime(), NOW + NO_DEADLINE_HOLD_MS);
});

test('page 2 due after the approval: the submitter gets ONE bell and ONE e-mail with their link, and nothing else', async () => {
    const { journey, rec } = harness();
    const r = await journey.paused(PAGE2_PAUSE);
    assert.strictEqual(r.notified, true);
    const link = `/f/${TOKEN}?s=${SID}`;
    assert.deepStrictEqual(rec.bells, [{ userId: 'visitor1', title: 'Request a quote: the next page is ready', message: 'Open the form to continue where you left off.', link }]);
    assert.deepStrictEqual(rec.emails, [{
        userId: 'visitor1',
        subject: 'Request a quote: the next page is ready',
        text: `Request a quote: the next page is ready.\n\nContinue here: https://bee.example${link}`,
    }]);
    assert.deepStrictEqual(rec.settled, [{ claimId: 'claim_leg2', bell: true, email: true }]);
    // The session is held to page 2's own deadline + 1 h as well.
    assert.deepStrictEqual(rec.extended, [{ id: SID, until: new Date(NOW + 7 * DAY + SESSION_GRACE_MS).toISOString() }]);
});

test('exactly once: a second finalize of the same leg sends nothing', async () => {
    const { journey, rec } = harness();
    await journey.paused(PAGE2_PAUSE);
    const again = await journey.paused(PAGE2_PAUSE);
    assert.strictEqual(again.notified, false);
    assert.strictEqual(rec.bells.length, 1);
    assert.strictEqual(rec.emails.length, 1);
});

test('nothing for page 1, or for a page right after another page (the visitor is still there)', async () => {
    const { journey, rec } = harness();
    // Page 2 reached in the first leg (no continuation).
    await journey.paused({ run: { id: 'root', rootRunId: 'root' }, status: 'awaiting_form', expiresAt: null, automation: AUTOMATION });
    // Page 3 reached in the leg that continued from page 2's answers.
    await journey.paused({ ...PAGE2_PAUSE, run: { ...LEG2, id: 'leg3', parentRunId: 'leg2' }, resumedFromStepId: 'fp2' });
    assert.deepStrictEqual(rec.bells, []);
    assert.deepStrictEqual(rec.emails, []);
    assert.strictEqual(rec.extended.length, 2, 'the sessions are still held open');
});

test('nothing for a builder run without a session: no session, nothing at all', async () => {
    const { journey, rec } = harness({ sessions: [] });
    const r = await journey.paused(PAGE2_PAUSE);
    assert.deepStrictEqual(r, { extended: 0, notified: false });
    assert.deepStrictEqual(rec.extended, []);
    assert.deepStrictEqual(rec.bells, []);
});

test('nothing for an anonymous submission (no submitter on the root run)', async () => {
    const { journey, rec } = harness({ runs: { root: { id: 'root', rootRunId: 'root', submittedByUserId: null } } });
    const r = await journey.paused(PAGE2_PAUSE);
    assert.strictEqual(r.notified, false);
    assert.deepStrictEqual(rec.bells, []);
    assert.deepStrictEqual(rec.emails, []);
});

test('a session that already expired gets no link sent (it would not open)', async () => {
    const { journey, rec } = harness({ sessions: [{ id: SID, formPageId: TOKEN, isTest: false, expiresAt: new Date(NOW - 1000).toISOString() }] });
    assert.strictEqual((await journey.paused(PAGE2_PAUSE)).notified, false);
    assert.deepStrictEqual(rec.bells, []);
});

test('a test link journey tells its tester; the builder and a dry run tell nobody', async () => {
    let h = harness({ profile: { kind: 'test', origin: 'test_link' } });
    assert.strictEqual((await h.journey.paused(PAGE2_PAUSE)).notified, true);
    h = harness({ profile: { kind: 'test', origin: 'builder' } });
    assert.strictEqual((await h.journey.paused(PAGE2_PAUSE)).notified, false);
    h = harness({ profile: { kind: 'dry', origin: 'trigger' } });
    assert.strictEqual((await h.journey.paused(PAGE2_PAUSE)).notified, false);
});

test('no service mailbox: the bell still rings and the ledger records no e-mail attempt', async () => {
    const { journey, rec } = harness({ emailResult: null });
    await journey.paused(PAGE2_PAUSE);
    assert.strictEqual(rec.bells.length, 1);
    assert.deepStrictEqual(rec.settled, [{ claimId: 'claim_leg2', bell: true, email: null }]);
});

test('a failing store never throws into the run', async () => {
    const journey = makeFormJourney({
        now: () => NOW, sessionTtlMs: TTL,
        sessionsOfJourney: async () => { throw new Error('db down'); },
        extendSessionUntil: async () => {}, getRun: async () => null, profileOf: () => ({}),
        claimNotice: async () => null, settleNotice: async () => {}, bell: async () => {}, email: async () => null,
        absoluteUrl: (p) => p, warn: () => {},
    });
    assert.deepStrictEqual(await journey.paused(PAGE2_PAUSE), { extended: 0, notified: false });
});

test('a terminal run is not a pause: nothing happens', async () => {
    const { journey, rec } = harness();
    await journey.paused({ ...PAGE2_PAUSE, status: 'success' });
    assert.deepStrictEqual(rec.extended, []);
});

test('the link and the title: the token and session only; the form title, else the automation title', () => {
    assert.strictEqual(formPageLink(TOKEN, SID), `/f/${TOKEN}?s=${SID}`);
    assert.strictEqual(formTitleOf(AUTOMATION, null), 'Request a quote');
    const second = { ...AUTOMATION, definition: { ...AUTOMATION.definition, triggers: [{ id: 't2', kind: 'form', form: { title: 'Second form' } }] } };
    assert.strictEqual(formTitleOf(second, 't2'), 'Second form');
    assert.strictEqual(formTitleOf({ title: 'Quote requests', definition: { trigger: { kind: 'form', form: {} } } }, null), 'Quote requests');
});

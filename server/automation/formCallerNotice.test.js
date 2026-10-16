'use strict';

/**
 * A members-only form on an automation that runs on the submitter's own
 * connections refuses the submission, with a sentence that says what to do,
 * until the submitter has confirmed the one-time notice. A public form (no
 * submitter passed) is a system start and never asks.
 *
 * Run: node --test automation/formCallerNotice.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { assertFormStartAllowed } = require('./formCallerNotice');

const automation = (connections) => ({
    id: 'a1', userId: 'owner',
    definition: { trigger: { id: 't', kind: 'form' }, steps: [{ id: 's', type: 'integration_action', tool: 'gmail_search' }], ...(connections ? { runPolicy: { connections } } : {}) },
});
const store = (ack) => ({ getCallerNoticeAck: async () => ack, getAutomation: async () => null });

test('a members-only submitter who has not confirmed the notice is refused before anything is recorded', async () => {
    await assert.rejects(
        () => assertFormStartAllowed({ automation: automation('caller'), submitterId: 'member', store: store(null) }),
        (e) => e.status === 409 && e.code === 'caller_notice_required' && /Run right/.test(e.message),
    );
});

test('a confirmed submitter, an ordinary automation, the owner and a public form pass', async () => {
    await assertFormStartAllowed({ automation: automation('caller'), submitterId: 'member', store: store(['app:google']) });
    await assertFormStartAllowed({ automation: automation(null), submitterId: 'member', store: store(null) });
    await assertFormStartAllowed({ automation: automation('caller'), submitterId: 'owner', store: store(null) });
    await assertFormStartAllowed({ automation: automation('caller'), submitterId: null, store: store(null) });
});

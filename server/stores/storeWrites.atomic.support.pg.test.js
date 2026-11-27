/**
 * A store write that touches two tables lands together or not at all (module "support"): support message + the thread's clock.
 * The core's cases: storeWrites.atomic.pg.test.js; the set-up: testUtils/refuseWrites.js.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/storeWrites.atomic.support.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { useRefusingPglite } = require('../testUtils/refuseWrites');

const { refuse, count, REFUSED, setUp } = useRefusingPglite();
const supportStore = require('./supportStore');

before(() => setUp([supportStore.initDB]));

test('appendMessage: a failing thread update leaves no message', async () => {
    const thread = await supportStore.createThread({ requesterEmail: 'requester@example.test', source: 'in_app', subject: REFUSED });
    await refuse('support_threads', 'BEFORE UPDATE', `NEW.subject = '${REFUSED}'`);
    await assert.rejects(() => supportStore.appendMessage({ threadId: thread.id, authorKind: 'requester', body: 'hello' }), /write refused/);
    assert.strictEqual(await count('SELECT COUNT(*)::int AS n FROM support_messages WHERE thread_id = $1', [thread.id]), 0);
    // An internal note does not move the clock, so it lands.
    assert.ok(await supportStore.appendMessage({ threadId: thread.id, authorKind: 'staff', body: 'note', internalNote: true }));
});

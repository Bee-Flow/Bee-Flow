// @typecheck
/**
 * support_threads against a REAL Postgres (@electric-sql/pglite, in-process)
 * and the store's own schema.
 *
 *   A. A staff reply moves the ticket to awaiting_user. The SLA clock pauses
 *      while a ticket waits on the customer (updateThread derives sla_paused
 *      from the status), but firstStaffReplyTransition set the status without
 *      the pause, so the resolution SLA of an answered ticket kept running and
 *      was flagged as breached while the customer had the ball.
 *   B. The inbox search text went into ILIKE as it was typed, so "100%" or
 *      "a_b" matched as wildcards and returned tickets that do not contain it.
 *
 *   C. The company IMAP mailbox: its tickets are not "mailbox residue", and
 *      reply correlation stays inside the company inbox.
 *
 * Run: cd server && node --test stores/supportStore/threads.pg.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { newPglite } = require('../../testUtils/pgliteTemplate');
const { usePglitePool } = require('../../testUtils/pglitePool');

const pg = newPglite();
const { query, restore: restorePool } = usePglitePool(pg);
const threads = require('./threads');
const sla = require('./sla');
const messages = require('./messages');

async function newThread(subject = 'Synthetic subject') {
    const row = await threads.createThread({ requesterEmail: 'requester@example.test', source: 'in_app', subject });
    return row.id;
}

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await threads.getThread('00000000-0000-0000-0000-000000000000'); // the store's own schema init
});

beforeEach(async () => { await query('DELETE FROM support_threads'); });

after(async () => {
    restorePool();
    await pg.close();
});

test('A: a staff reply pauses the SLA clock, like every other move to awaiting_user', async () => {
    const id = await newThread();
    const row = await threads.firstStaffReplyTransition(id, 'staff-1');
    assert.strictEqual(row.status, 'awaiting_user');
    assert.strictEqual(row.sla_paused, true);
    assert.strictEqual(row.assignee_user_id, 'staff-1');
    assert.ok(row.first_response_at);
});

test('A: an answered ticket whose resolution deadline passes is not flagged while it waits on the customer', async () => {
    const answered = await newThread('answered');
    const untouched = await newThread('untouched');
    await query(`UPDATE support_threads SET sla_resolution_due_at = now() - interval '1 hour'`);
    await threads.firstStaffReplyTransition(answered, 'staff-1');

    const flagged = await sla.flagResolutionBreaches();
    assert.deepStrictEqual(flagged.map((r) => r.id), [untouched]);

    // The customer answers: the clock runs again and the breach is seen.
    await threads.updateThread(answered, { status: 'awaiting_agent' });
    assert.deepStrictEqual((await sla.flagResolutionBreaches()).map((r) => r.id), [answered]);
});

test('B: % and _ in the inbox search are text, not wildcards', async () => {
    await newThread('Discount 100% off');
    await newThread('Discount 1000 off');
    await newThread('file a_b.txt');
    await newThread('file axb.txt');

    assert.deepStrictEqual((await threads.listThreads({ q: '100%' })).map((t) => t.subject), ['Discount 100% off']);
    assert.deepStrictEqual((await threads.listThreads({ q: 'a_b' })).map((t) => t.subject), ['file a_b.txt']);
    assert.strictEqual((await threads.listThreads({ q: 'discount' })).length, 2, 'a plain search is still a substring match');
});

test('C: tickets the company IMAP mailbox filed are not mailbox residue: not counted, not purged', async () => {
    const residue = await threads.createThread({ requesterEmail: 'requester@example.test', source: 'email', subject: 'left behind' });
    await messages.appendMessage({ threadId: residue.id, authorKind: 'requester', body: 'x', providerMessageId: 'gmail-123' });
    const filed = await threads.createThread({ requesterEmail: 'requester@example.test', source: 'email', subject: 'came in on IMAP' });
    await messages.appendMessage({ threadId: filed.id, authorKind: 'requester', body: 'y', providerMessageId: 'imap:42:7' });

    assert.strictEqual((await threads.getCompanyMailboxSummary()).count, 1);
    assert.strictEqual(await threads.deleteMailboxThreads({ companyMailbox: true }), 1);
    assert.ok(await threads.getThread(filed.id), 'the IMAP ticket stays');
    assert.strictEqual(await threads.getThread(residue.id), null);
});

test('C: findCompanyThreadByRfcMessageId finds company tickets by a stored Message-ID, never a tenant inbox ticket', async () => {
    const company = await threads.createThread({ requesterEmail: 'requester@example.test', source: 'email', subject: 'company', rfc822MessageId: '<first@c>' });
    await messages.appendMessage({ threadId: company.id, authorKind: 'staff', body: 'reply', rfc822MessageId: '<ours@s>' });
    await query(`INSERT INTO support_threads (requester_email, source, subject, inbox_id, rfc822_message_id, status)
                 VALUES ('t@example.test', 'email', 'tenant', gen_random_uuid(), '<tenant@c>', 'open')`);
    assert.strictEqual((await threads.findCompanyThreadByRfcMessageId(['<ours@s>']))?.id, company.id);
    assert.strictEqual((await threads.findCompanyThreadByRfcMessageId(['<first@c>']))?.id, company.id);
    assert.strictEqual(await threads.findCompanyThreadByRfcMessageId(['<tenant@c>']), null);
    assert.strictEqual(await threads.findCompanyThreadByRfcMessageId([]), null);
});

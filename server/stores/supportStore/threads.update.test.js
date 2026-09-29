/**
 * supportStore.updateThread — where the column names come from.
 *
 * This write used to echo the CALLER'S key into the SQL (`${k} = $n`), with a
 * list of allowed key names as the only thing standing between a patch and an
 * arbitrary column. That is one edit away from a caller naming a column:
 * anything added to the list is a column name, and anything the list misses is
 * dropped in silence. The column literal now comes from a map and nothing else,
 * so an unknown key can neither name a column nor sneak SQL into one.
 *
 * The SLA derivation and the timestamp bump are locked here too, because both
 * are shapes a dynamic-UPDATE builder can change without anything failing.
 *
 * Run: cd server && node --test --test-force-exit stores/supportStore/threads.update.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const { installResolveStub } = require('../../testUtils/stubRequire');

const queries = [];
const stub = {
    pool: {
        async query(sql, params) {
            queries.push({ sql, params });
            return { rows: [{ id: 'thr-1' }], rowCount: 1 };
        },
    },
    async exec() {},
    async run() { return { rowCount: 0, rows: [] }; },
    async getOne() { return null; },
    async getAll() { return []; },
};

const restore = installResolveStub({ '../../db': stub });
after(() => restore());

const threads = require('./threads');

beforeEach(() => { queries.length = 0; });

const updates = () => queries.filter(q => /^UPDATE support_threads/i.test(q.sql.trim()));

test('a known field is written, and the timestamp goes with it', async () => {
    await threads.updateThread('thr-1', { priority: 'high' });
    const u = updates()[0];
    assert.match(u.sql, /^UPDATE support_threads SET priority = \$1, updated_at = now\(\)/i);
    assert.match(u.sql, /WHERE id = \$2/);
    assert.deepStrictEqual(u.params, ['high', 'thr-1']);
});

test('an unknown key names no column and reaches no SQL', async () => {
    await threads.updateThread('thr-1', {
        organization_id: 'other-org',
        "status = 'closed', assignee_user_id": 'attacker',
    });
    assert.strictEqual(updates().length, 0, 'nothing mapped changed → no UPDATE at all');
});

test('an unknown key alongside a known one does not widen the write', async () => {
    await threads.updateThread('thr-1', { subject: 'Re: factuur', organization_id: 'other-org' });
    const u = updates()[0];
    assert.ok(!/organization_id/.test(u.sql), 'the caller does not get to name a column');
    assert.deepStrictEqual(u.params, ['Re: factuur', 'thr-1']);
});

test('sla_paused is derived from the status transition, and an explicit value wins', async () => {
    await threads.updateThread('thr-1', { status: 'awaiting_user' });
    assert.ok(updates()[0].params.includes(true), 'waiting on the customer pauses the clock');

    queries.length = 0;
    await threads.updateThread('thr-1', { status: 'open' });
    assert.ok(updates()[0].params.includes(false), 'any other status resumes it');

    queries.length = 0;
    await threads.updateThread('thr-1', { status: 'awaiting_user', sla_paused: false });
    assert.ok(updates()[0].params.includes(false), 'an explicit sla_paused is not overruled');
});

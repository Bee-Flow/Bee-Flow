/** status_set: no emoji icon, partial updates keep the rest, validation before any write. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { json, installFakeNc, resetFakeNc } = require('./nextcloudToolFakes');

test.after(resetFakeNc);
const { executeNextcloudStatusTool } = require('./nextcloudStatusTools');

const FUTURE = '2099-01-01T10:00:00Z';

function install(current = { status: 'online', message: 'in a meeting', icon: '📅', clearAt: 4070908800 }, getStatus = 200) {
    return installFakeNc(({ method }) => {
        if (method === 'GET' && getStatus !== 200) return json(getStatus, {});
        return json(200, { ocs: { data: method === 'GET' ? current : {} } });
    });
}
const puts = (calls) => calls.filter(c => c.method === 'PUT');

test('a message without an emoji sends a null icon', async () => {
    const calls = install({ status: 'online' });
    await executeNextcloudStatusTool('nextcloud_status_set', { message: 'hello' }, 'u', {});
    assert.equal(puts(calls)[0].body.statusIcon, null);
    assert.equal(puts(calls)[0].body.message, 'hello');
});

test('setting only the emoji keeps the message and clearAt', async () => {
    const calls = install();
    await executeNextcloudStatusTool('nextcloud_status_set', { emoji: '🏖' }, 'u', {});
    assert.deepEqual(puts(calls)[0].body, { statusIcon: '🏖', message: 'in a meeting', clearAt: 4070908800 });
});

test('clearAt alone is accepted and keeps message and icon', async () => {
    const calls = install();
    const out = await executeNextcloudStatusTool('nextcloud_status_set', { clearAt: FUTURE }, 'u', {});
    assert.equal(out.success, true);
    const body = puts(calls)[0].body;
    assert.equal(body.message, 'in a meeting');
    assert.equal(body.statusIcon, '📅');
    assert.equal(body.clearAt, Math.floor(Date.parse(FUTURE) / 1000));
});

test('a past or unparsable clearAt fails before anything is written', async () => {
    for (const clearAt of ['2001-01-01T00:00:00Z', 'not a date']) {
        const calls = install();
        const out = await executeNextcloudStatusTool('nextcloud_status_set', { availability: 'dnd', message: 'm', clearAt }, 'u', {});
        assert.ok(out.error, clearAt);
        assert.equal(calls.length, 0, 'no request at all');
    }
});

test('status_set_predefined reports a past clearAt as such, not as an unknown status', async () => {
    const calls = install();
    const out = await executeNextcloudStatusTool('nextcloud_status_set_predefined', { messageId: 'meeting', clearAt: '2001-01-01T00:00:00Z' }, 'u', {});
    assert.match(out.error, /past/);
    assert.doesNotMatch(out.error, /Unknown predefined/);
    assert.equal(calls.length, 0);
});

test('clearAt null makes the status permanent', async () => {
    const calls = install();
    await executeNextcloudStatusTool('nextcloud_status_set', { clearAt: null }, 'u', {});
    assert.equal(puts(calls)[0].body.clearAt, null);
    assert.equal(puts(calls)[0].body.message, 'in a meeting');
});

test('a failing status read stops the update instead of wiping the message', async () => {
    const calls = install(undefined, 500);
    const out = await executeNextcloudStatusTool('nextcloud_status_set', { emoji: 'x' }, 'u', {});
    assert.ok(out.error);
    assert.equal(puts(calls).length, 0);
});

test('a 404 on the status read means no status yet and the update goes ahead', async () => {
    const calls = install(undefined, 404);
    await executeNextcloudStatusTool('nextcloud_status_set', { message: 'hi' }, 'u', {});
    assert.equal(puts(calls)[0].body.message, 'hi');
});

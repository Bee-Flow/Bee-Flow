const { test } = require('node:test');
const assert = require('node:assert');
const { withGroupGrants } = require('./userGrantedIntegrations.mts');

const ctx = { userId: 'u1', orgId: 'org-1' };

test('an app granted to one of the person\'s groups joins the organisation-wide list', async () => {
    const resolve = async () => ({ degraded: false, effective: { integration: ['outlook-readonly', 'outlook'] } });
    assert.deepStrictEqual(await withGroupGrants(['outlook-readonly', 'ms-calendar'], ctx, resolve), ['outlook-readonly', 'ms-calendar', 'outlook']);
});

test('the resolver is asked for this person in this organisation', async () => {
    let asked = null;
    await withGroupGrants([], ctx, async (c) => { asked = c; return null; });
    assert.deepStrictEqual(asked, ctx);
});

test('a degraded, empty or failing resolver adds nothing', async () => {
    const list = ['outlook-readonly'];
    assert.deepStrictEqual(await withGroupGrants(list, ctx, async () => ({ degraded: true, effective: { integration: ['outlook'] } })), list);
    assert.deepStrictEqual(await withGroupGrants(list, ctx, async () => null), list);
    assert.deepStrictEqual(await withGroupGrants(list, ctx, async () => { throw new Error('down'); }), list);
});

test('no restriction (null) stays no restriction', async () => {
    assert.strictEqual(await withGroupGrants(null, ctx, async () => ({ effective: { integration: ['outlook'] } })), null);
});

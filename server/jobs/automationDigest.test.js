/**
 * jobs/automationDigest: the "n more" bundles and the daily summary.
 * Everything injected; the real cron helper computes the slots.
 *
 * Run: cd server && node --test jobs/automationDigest.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { digestPass, latestSlot, DIGEST_GRACE_MS } = require('./automationDigest');
const cron = require('../automation/cron');

const nextSlot = (time, tz, fromTs) => {
    const [h, m] = time.split(':').map(Number);
    return cron.nextRunAt(`${m} ${h} * * *`, tz, fromTs);
};
// 17:05 in Amsterdam (CEST, UTC+2) on 2026-09-28.
const AT_1705 = Date.parse('2026-09-28T15:05:00Z');

function env(opts = {}) {
    const rec = { bells: [], mails: [], talk: [], rows: [], reported: [] };
    const automations = opts.automations || {};
    const deps = {
        events: {
            listPendingBundles: async () => opts.bundles || [],
            countRecentMessages: async () => opts.recent || 0,
            recordNotificationEvents: async (rows) => { rec.rows.push(...rows); return rows.length; },
            markEventsReported: async (ids) => { rec.reported.push(...ids); return ids.length; },
            listDigestAutomations: async () => opts.digestAutomations || [],
            lastDigestAt: async () => opts.lastDigestAt || null,
            digestRunStats: async ({ automationIds }) => new Map(automationIds.filter(id => opts.stats?.[id]).map(id => [id, opts.stats[id]])),
            listHeldForDigest: async () => opts.held || [],
            purgeNotificationEvents: async () => 0,
        },
        getAutomation: async (id) => automations[id] || null,
        listUsers: async () => opts.users || [],
        getUser: async (id) => ({ id, organizationId: 'org1' }),
        deliverBell: async (o) => { rec.bells.push(o); return { ok: true, via: 'inapp' }; },
        sendRunEmail: async (a, o) => { rec.mails.push({ kind: 'run', ...o }); return { sent: true }; },
        sendDigestEmail: async (o) => { rec.mails.push({ kind: 'digest', ...o }); return { sent: true }; },
        resolveNcContext: async () => null,
        postTalk: async (o) => { rec.talk.push(o); return { ok: true }; },
        nextSlot,
        absoluteUrl: (p) => `https://bee.example${p}`,
        appPaths: require('../utils/appPaths'),
    };
    return { deps, rec };
}

const A1 = { id: 'a1', userId: 'owner', organizationId: 'org1', title: 'Invoices', definition: {} };

test('latestSlot: today once the time has passed, yesterday before it', () => {
    assert.equal(new Date(latestSlot('17:00', 'Europe/Amsterdam', AT_1705, nextSlot)).toISOString(), '2026-09-28T15:00:00.000Z');
    assert.equal(new Date(latestSlot('17:00', 'Europe/Amsterdam', Date.parse('2026-09-28T14:00:00Z'), nextSlot)).toISOString(), '2026-09-27T15:00:00.000Z');
    assert.equal(latestSlot('17:00', 'Nowhere/Invalid', AT_1705, () => { throw new Error('bad tz'); }), null);
});

test('a bundle under the cap again goes out as one "n more" on its channels, then is reported', async () => {
    const { deps, rec } = env({
        automations: { a1: A1 },
        bundles: [{ automationId: 'a1', event: 'onError', recipient: 'owner', channels: ['bell', 'email'], count: 3, ids: ['e1', 'e2', 'e3'] }],
        recent: 0,
    });
    const out = await digestPass(deps, AT_1705);
    assert.equal(out.bundles, 1);
    assert.equal(rec.bells.length, 1);
    assert.equal(rec.bells[0].title, 'Invoices: 3 more errors in the last hour');
    assert.equal(rec.bells[0].link, '/app/studio/automations/a1?view=runs');
    assert.equal(rec.mails[0].subject, 'Invoices: 3 more errors in the last hour');
    assert.equal(rec.mails[0].userId, 'owner');
    assert.deepEqual(rec.reported, ['e1', 'e2', 'e3']);
    assert.deepEqual(rec.rows.map(r => [r.recipient, r.channel, r.delivered, !!r.bundled]), [['owner', 'bell', true, false], ['owner', 'email', true, false]],
        'the bundle message counts toward the next hour');
});

test('a bundle still over the cap waits', async () => {
    const { deps, rec } = env({
        automations: { a1: A1 },
        bundles: [{ automationId: 'a1', event: 'onError', recipient: 'owner', channels: ['bell'], count: 2, ids: ['e1'] }],
        recent: 1,
    });
    await digestPass(deps, AT_1705);
    assert.equal(rec.bells.length, 0);
    assert.deepEqual(rec.reported, []);
});

test('a Talk bundle goes into its conversation with the line and a link, no run data', async () => {
    const { deps, rec } = env({
        automations: { a1: A1 },
        bundles: [{ automationId: 'a1', event: 'onError', recipient: 'talk:room9', channels: ['talk'], count: 4, ids: ['t1'] }],
    });
    await digestPass(deps, AT_1705);
    assert.equal(rec.talk.length, 1);
    assert.equal(rec.talk[0].roomToken, 'room9');
    assert.equal(rec.talk[0].message, 'Invoices: 4 more errors in the last hour\nhttps://bee.example/app/studio/automations/a1?view=runs');
});

test('bundles of a trashed automation are dropped, not sent', async () => {
    const { deps, rec } = env({
        bundles: [{ automationId: 'gone', event: 'onError', recipient: 'owner', channels: ['bell'], count: 1, ids: ['x1'] }],
    });
    await digestPass(deps, AT_1705);
    assert.equal(rec.bells.length, 0);
    assert.deepEqual(rec.reported, ['x1']);
});

test('with a daily summary for that person the bundle waits for it', async () => {
    const withDigest = { ...A1, definition: { notificationSettings: { digest: { enabled: true, time: '17:00' } } } };
    const { deps, rec } = env({
        automations: { a1: withDigest },
        bundles: [{ automationId: 'a1', event: 'onError', recipient: 'owner', channels: ['bell'], count: 2, ids: ['e1'] }],
    });
    await digestPass(deps, Date.parse('2026-09-28T09:00:00Z'));
    assert.equal(rec.bells.length, 0);
    assert.deepEqual(rec.reported, []);
});

const DIGEST_AUTOMATIONS = [
    { id: 'a1', userId: 'owner', organizationId: 'org1', title: 'Invoices', scheduleTz: 'Europe/Amsterdam',
        notificationSettings: { digest: { enabled: true, time: '17:00' }, onError: { enabled: true, urgency: 'urgent', recipients: [{ type: 'owner' }, { type: 'user', id: 'ann' }] } } },
    { id: 'a2', userId: 'owner', organizationId: 'org1', title: 'Files', scheduleTz: 'Europe/Amsterdam',
        notificationSettings: { digest: { enabled: true, time: '17:00' } } },
];
const USERS = [{ id: 'owner', organizationId: 'org1' }, { id: 'ann', organizationId: 'org1' }];

test('the summary: one message per person over their automations, at the local time', async () => {
    const { deps, rec } = env({
        digestAutomations: DIGEST_AUTOMATIONS,
        users: USERS,
        stats: { a1: { runs: 12, failures: 1, waiting: 1 }, a2: { runs: 3, failures: 0, waiting: 0 } },
        held: [
            { id: 'h1', automationId: 'a2', createdAt: '2026-09-28T08:00:00.000Z' },
            { id: 'h2', automationId: 'a2', createdAt: '2026-09-28T08:00:00.000Z' },
        ],
    });
    const out = await digestPass(deps, AT_1705);
    assert.equal(out.digests, 2, 'owner and ann');
    const ownerBell = rec.bells.find(b => b.userId === 'owner');
    assert.equal(ownerBell.title, 'Your automations today: 15 runs, 1 failed, 1 still waiting');
    assert.equal(ownerBell.short, ownerBell.title, 'Nextcloud gets the totals only');
    assert.match(ownerBell.message, /Invoices: 12 runs, 1 failed, 1 waiting/);
    assert.match(ownerBell.message, /Files: 3 runs/);
    const annBell = rec.bells.find(b => b.userId === 'ann');
    assert.equal(annBell.title, 'Your automations today: 12 runs, 1 failed, 1 still waiting', 'ann only follows Invoices');
    const mails = rec.mails.filter(m => m.kind === 'digest');
    assert.deepEqual(mails.map(m => m.userId).sort(), ['ann', 'owner']);
    assert.equal(mails[0].subject, 'Your automations today');
    assert.match(mails[0].text, /https:\/\/bee\.example\/app\/studio\/automations/);
    assert.ok(rec.rows.every(r => r.event === 'digest'));
    assert.ok(rec.reported.includes('h1') && rec.reported.includes('h2'), 'held rows are reported with the summary');
    assert.match(ownerBell.message, /^15 runs, 1 failed, 1 still waiting\n/);
});

test('the summary is not sent twice for one slot, nor before its time, nor hours late', async () => {
    const sent = env({ digestAutomations: DIGEST_AUTOMATIONS, users: USERS, stats: { a1: { runs: 1, failures: 0, waiting: 0 } }, lastDigestAt: '2026-09-28T15:00:30.000Z' });
    assert.equal((await digestPass(sent.deps, AT_1705)).digests, 0);

    const early = env({ digestAutomations: DIGEST_AUTOMATIONS, users: USERS, stats: { a1: { runs: 1, failures: 0, waiting: 0 } } });
    const before = await digestPass(early.deps, Date.parse('2026-09-28T14:55:00Z'));
    assert.equal(before.digests, 0, 'yesterday\'s slot is more than the grace ago');

    const late = env({ digestAutomations: DIGEST_AUTOMATIONS, users: USERS, stats: { a1: { runs: 1, failures: 0, waiting: 0 } } });
    assert.equal((await digestPass(late.deps, Date.parse('2026-09-28T15:00:00Z') + DIGEST_GRACE_MS + 60_000)).digests, 0);
});

test('nothing happened: no message, but the slot is marked handled', async () => {
    const { deps, rec } = env({ digestAutomations: [DIGEST_AUTOMATIONS[1]], users: USERS });
    const out = await digestPass(deps, AT_1705);
    assert.equal(out.digests, 0);
    assert.equal(rec.bells.length + rec.mails.length, 0);
    assert.deepEqual(rec.rows.map(r => [r.recipient, r.event, r.channel]), [['owner', 'digest', 'none']]);
});

test('a summary is personal: it never goes to Talk', async () => {
    const { deps, rec } = env({ digestAutomations: DIGEST_AUTOMATIONS, users: USERS, stats: { a1: { runs: 5, failures: 2, waiting: 0 } } });
    await digestPass(deps, AT_1705);
    assert.equal(rec.talk.length, 0);
});

test('one failing part never ends the pass', async () => {
    const { deps, rec } = env({ digestAutomations: DIGEST_AUTOMATIONS, users: USERS, stats: { a1: { runs: 5, failures: 0, waiting: 0 } } });
    deps.events.listPendingBundles = async () => { throw new Error('db down'); };
    const out = await digestPass(deps, AT_1705);
    assert.equal(out.bundles, 0);
    assert.ok(out.digests >= 1);
    assert.ok(rec.bells.length >= 1);
});

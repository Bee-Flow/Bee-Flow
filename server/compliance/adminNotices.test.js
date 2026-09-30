'use strict';

/**
 * Admin notices — who is told (admins AND the DPO, active accounts, the
 * 'default' bucket for org-less installs) and how often (one per dedupe
 * window, across replicas; a failed claim still sends).
 *
 * The recipient SQL runs against a real Postgres (pglite); the stores are
 * injected.
 *
 * Run: cd server && node --test compliance/adminNotices.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const { makeAdminNotices, RECIPIENT_SQL, _windowKey } = require('./adminNotices');

const pg = new PGlite();
const getAll = async (sql, params) => (await pg.query(sql, params)).rows;

before(async () => {
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, role TEXT DEFAULT 'user', "orgRole" TEXT DEFAULT '', "organizationId" TEXT DEFAULT '', status TEXT DEFAULT 'active');
        INSERT INTO users (id, role, "orgRole", "organizationId", status) VALUES
            ('admin1', 'user', 'org_admin', 'org1', 'active'),
            ('legacy', 'user', 'admin', 'org1', NULL),
            ('dpo1', 'user', 'dpo', 'org1', 'active'),
            ('member', 'user', 'member', 'org1', 'active'),
            ('gone', 'user', 'org_admin', 'org1', 'suspended'),
            ('other', 'user', 'org_admin', 'org2', 'active'),
            ('solo', 'admin', '', '', 'active');
    `);
});
after(() => pg.close());

test('admins, legacy admins and the DPO of the org are told; members, suspended and other orgs are not', async () => {
    const { recipients } = makeAdminNotices({ getAll });
    assert.deepStrictEqual((await recipients('org1')).sort(), ['admin1', 'dpo1', 'legacy']);
    assert.deepStrictEqual(await recipients('default'), ['solo'], 'the bucket is the org-less install');
    assert.deepStrictEqual(await recipients(''), []);
    assert.match(RECIPIENT_SQL, /'dpo'/);
});

test('a dedupe key sends once per window; a new window sends again', async () => {
    const claims = new Set();
    const sent = [];
    let now = Date.parse('2026-09-29T10:15:00Z');
    const n = makeAdminNotices({
        getAll,
        now: () => now,
        notificationStore: { createNotification: async (x) => { sent.push(x); } },
        complianceStore: {
            markNotified: async (org, kind, id, offset) => {
                const k = [org, kind, id, offset].join('|');
                if (claims.has(k)) return false;
                claims.add(k);
                return true;
            },
        },
    });
    const notice = { category: 'heads_up', title: 'T', message: 'M', dedupe: { key: 'framework:nis2', window: 'day' } };
    assert.strictEqual(await n.notify('org1', notice), 3);
    assert.strictEqual(await n.notify('org1', notice), 0, 'the same day is one notice');
    now += 24 * 3600_000;
    assert.strictEqual(await n.notify('org1', notice), 3);
    assert.strictEqual(sent.length, 6);
    assert.deepStrictEqual(Object.keys(sent[0]).sort(), ['category', 'link', 'message', 'title', 'userId']);
});

test('a claim that cannot be written still sends, and nothing ever throws', async () => {
    const sent = [];
    const n = makeAdminNotices({
        getAll,
        notificationStore: { createNotification: async (x) => { sent.push(x); } },
        complianceStore: { markNotified: async () => { throw new Error('relation does not exist'); } },
    });
    assert.strictEqual(await n.notify('org1', { category: 'urgent', title: 'T', message: 'M', dedupe: { key: 'k' } }), 3);
    const broken = makeAdminNotices({ getAll: async () => { throw new Error('db down'); }, notificationStore: { createNotification: async () => {} } });
    assert.strictEqual(await broken.notify('org1', { category: 'urgent', title: 'T', message: 'M' }), 0);
});

test('the window key is the UTC day or hour', () => {
    const t = Date.parse('2026-09-29T23:59:59Z');
    assert.strictEqual(_windowKey('day', t), '2026-09-29');
    assert.strictEqual(_windowKey('hour', t), '2026-09-29T23');
});

'use strict';

/**
 * GDPR-Art5-1-e-storage-limitation — the orphan-memory count is the judged
 * organisation's own, never the instance's. Real Postgres (pglite behind
 * db.js's pool); the compliance store runs its own schema.
 *
 * Run: cd server && node --test compliance/checks/gdpr/art5-1-e-storage-limitation.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../../../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const check = require('./art5-1-e-storage-limitation');
const complianceStore = require('../../../stores/complianceStore');

before(async () => {
    await complianceStore.initDB();
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '');
        CREATE TABLE user_memories (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, status TEXT DEFAULT 'active',
            expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
        INSERT INTO users VALUES ('a1', 'org1'), ('b1', 'org2'), ('s1', '');
        INSERT INTO user_memories (id, user_id, created_at) VALUES
            ('m1', 'a1', NOW() - INTERVAL '400 days'),
            ('m2', 'b1', NOW() - INTERVAL '400 days'),
            ('m3', 'b1', NOW() - INTERVAL '400 days'),
            ('m4', 's1', NOW() - INTERVAL '400 days'),
            ('m5', 'a1', NOW() - INTERVAL '10 days');
    `);
    for (const org of ['org1', 'org2', 'default']) {
        await pg.query(`INSERT INTO compliance_settings (organization_id, last_retention_run_at) VALUES ($1, NOW())`, [org]);
    }
});
after(close);

test('each organisation sees its own orphan memories only', async () => {
    assert.strictEqual((await check.evaluate('org1')).evidence.orphan_memories, 1);
    assert.strictEqual((await check.evaluate('org2')).evidence.orphan_memories, 2);
    assert.strictEqual((await check.evaluate('default')).evidence.orphan_memories, 1, 'the bucket holds the org-less accounts');
    assert.strictEqual((await check.evaluate('org1')).status, 'warn');
});

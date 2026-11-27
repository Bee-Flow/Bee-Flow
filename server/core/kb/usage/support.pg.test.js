'use strict';

/**
 * The support module's part of "who uses this knowledge base?" (./support.js), against a REAL
 * Postgres (@electric-sql/pglite, in-process; ../kbUsage.pg.testkit.js): an inbox that answers from a base or distils into it depends on it, and the scrub clears both. Moved from
 * ../kbUsage.pg.test.js, which says why the scans are proved on Postgres.
 *
 * Run: cd server && node --test --test-force-exit core/kb/usage/support.pg.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const kit = require('../kbUsage.pg.testkit');
const { db, q } = kit.usePgKbUsage(test);
const { KB, INGEST_KB } = kit;
const { usageForKb, scrubReferences } = require('../kbUsage');

test('an inbox that DISTILS tickets into a base depends on it too', async () => {
    // A scalar column, not an array — missed entirely by an @> scan. The
    // inbox keeps running and every distilled ticket lands nowhere.
    await q(`INSERT INTO support_inboxes (id, display_name, created_by, kb_ingest_enabled, kb_ingest_kb_id)
             VALUES ('sb2','Sales inbox','u3',true,$1::uuid)`, [INGEST_KB]);
    const { rows } = await usageForKb(INGEST_KB, { db });
    const row = rows.find(r => r.kind === 'support');
    assert.ok(row, 'the ingest target is usage');
    assert.strictEqual(row.id, 'sb2');
    assert.strictEqual(row.role, 'ingest_target', 'and it reads differently from an answer source');
});

test('scrub removes the id from an inbox', async () => {
    const out = await scrubReferences(KB, { db });
    assert.strictEqual(out.support, 1);
});

test('scrubbing an ingest target switches the ingest off with it', async () => {
    // A null target with the flag still on is the silent version of the same
    // breakage: the automation runs and writes nowhere.
    await scrubReferences(INGEST_KB, { db });
    const row = (await q(`SELECT kb_ingest_enabled, kb_ingest_kb_id FROM support_inboxes WHERE id = 'sb2'`)).rows[0];
    assert.strictEqual(row.kb_ingest_kb_id, null);
    assert.strictEqual(row.kb_ingest_enabled, false);
});

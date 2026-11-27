/**
 * A store write that touches two tables lands together or not at all (module "webpages"): public-share view + its counter.
 * The core's cases: storeWrites.atomic.pg.test.js; the set-up: testUtils/refuseWrites.js.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test stores/storeWrites.atomic.webpages.pg.test.js
 */

'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert');
const { useRefusingPglite } = require('../testUtils/refuseWrites');

const { pg, refuse, count, setUp } = useRefusingPglite();
const shareStore = require('./webpagePublicShareStore');

before(() => setUp([shareStore.initDB]));

test('recordView: a failing counter update leaves no view row', async () => {
    await pg.query(`INSERT INTO webpages (id, user_id, name) VALUES ('wp-share', 'u1', 'p')`);
    await pg.query(`INSERT INTO webpage_public_shares (id, webpage_id, created_by, token_hash, snapshot_prefix, access_mode)
                    VALUES ('sh-refused', 'wp-share', 'u1', 'th-1', 'p/', 'public'), ('sh-ok', 'wp-share', 'u1', 'th-2', 'q/', 'public')`);
    await refuse('webpage_public_shares', 'BEFORE UPDATE', `NEW.id = 'sh-refused'`);
    await assert.rejects(() => shareStore.recordView('sh-refused', { ip: '192.0.2.1' }), /write refused/);
    assert.strictEqual(await count(`SELECT COUNT(*)::int AS n FROM webpage_public_share_views WHERE share_id = 'sh-refused'`), 0);
    await shareStore.recordView('sh-ok', { ip: '192.0.2.1' });
    assert.strictEqual(await count(`SELECT view_count::int AS n FROM webpage_public_shares WHERE id = 'sh-ok'`), 1);
});

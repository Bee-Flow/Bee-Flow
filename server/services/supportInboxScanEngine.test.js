/**
 * supportInboxScanEngine — the scan drain follows the runtime module switch.
 *
 * BFSF-438: boot started the historical-scan drain without any module check,
 * so removing Support in the admin Modules panel left already-queued scans
 * reading mailboxes. The drain tick now goes through the module gate; the
 * exported scanOneDue stays ungated.
 *
 * The store and the provider clients are stubbed through
 * testUtils/stubRequire; the gate is injected through start({ gate }).
 *
 * Run: cd server && node --test services/supportInboxScanEngine.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');
const { mountGated } = require('../testUtils/gatedStart');

let dueReads = 0;
const restore = installResolveStub({
    '../stores/supportInboxStore': {
        getDueScans: async () => { dueReads += 1; return []; },
    },
    './email/providerClients': {
        gmailClientFromTokens: async () => { throw new Error('not used in these tests'); },
        graphFetchFromTokens: async () => { throw new Error('not used in these tests'); },
    },
});
test.after(() => restore());

const engine = require('./supportInboxScanEngine');

test('scanOneDue itself stays ungated', async () => {
    dueReads = 0;
    await engine.scanOneDue();
    assert.strictEqual(dueReads, 1);
});

test('BFSF-438: the drain tick goes through the support module gate', async () => {
    const w = mountGated((opts) => engine.startSupportInboxScan(opts));
    try {
        assert.deepStrictEqual(w.state.consulted.map(c => [c.moduleId, c.fn]), [['support', engine.scanOneDue]]);
        assert.strictEqual(w.timers.length, 1);

        // Support removed in the Modules panel: queued scans stay queued.
        w.state.active = false;
        dueReads = 0;
        await w.fireAll();
        assert.strictEqual(dueReads, 0, 'a removed Support module still drained mailbox scans');

        w.state.active = true;
        await w.fireAll();
        assert.strictEqual(dueReads, 1, 'the gated tick no longer reaches the drain');
    } finally {
        engine.stopSupportInboxScan();
    }
});

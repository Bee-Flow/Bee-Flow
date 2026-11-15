/**
 * The per-file cap of a Windmill export (usecases/automation/windmillImport.mts):
 * one file may unpack to at most AUTOMATION_IMPORT_WINDMILL_MAX_FILE_BYTES
 * (8 MB by default), separately from the total the export may unpack to.
 *
 * Run: cd server && node --test usecases/automation/windmillImport.limits.test.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { convertWindmill, windmillLimits } = require('./windmillImport.mts');

const LIMITS = { maxBytes: 0, maxUnzippedBytes: 10_000_000, maxEntries: 0, maxFlows: 0, rpm: 0, briefPerItemChars: 0, briefTotalChars: 0 };

async function zipWithFlow(bytes) {
    const zip = new JSZip();
    const flow = { summary: 'x'.repeat(bytes), value: { modules: [] } };
    zip.file('f/demo/big.flow/flow.json', JSON.stringify(flow));
    return { kind: 'zip', data: await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }) };
}

test('one file larger than the per-file cap is refused, whatever the total allows', async () => {
    await assert.rejects(convertWindmill(await zipWithFlow(4000), { ...LIMITS, maxFileBytes: 2000 }), (e) => e.status === 400 && e.code === 'import.windmill.unreadable');
    const ok = await convertWindmill(await zipWithFlow(1000), { ...LIMITS, maxFileBytes: 2000 });
    assert.strictEqual(ok.flows.length, 1);
});

test('the per-file cap is its own setting, 8 MB by default', () => {
    const before = process.env.AUTOMATION_IMPORT_WINDMILL_MAX_FILE_BYTES;
    delete process.env.AUTOMATION_IMPORT_WINDMILL_MAX_FILE_BYTES;
    try {
        assert.strictEqual(windmillLimits().maxFileBytes, 8 * 1024 * 1024);
        assert.notStrictEqual(windmillLimits().maxFileBytes, windmillLimits().maxUnzippedBytes);
    } finally {
        if (before !== undefined) process.env.AUTOMATION_IMPORT_WINDMILL_MAX_FILE_BYTES = before;
    }
});

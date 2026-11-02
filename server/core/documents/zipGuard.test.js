/**
 * The shared zip guard (core/documents/zipGuard.js): a package is refused on
 * its own declarations before anything inflates, and a part is inflated as a
 * stream that stops at its cap, at its declared size and at the running
 * budget, so a bomb costs one chunk, never the inflated size.
 *
 * Run: cd server && node --test core/documents/zipGuard.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const JSZip = require('jszip');
const { openZipGuarded, readEntryCapped, createByteBudget, declaredEntryCount, ZipLimitError } = require('./zipGuard');

const MIB = 1024 * 1024;

/** @param {Record<string, Buffer | string>} files */
async function zipOf(files) {
    const zip = new JSZip();
    for (const [name, content] of Object.entries(files)) zip.file(name, content);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
}

test('a package that declares more than the budget is refused before any part inflates', async () => {
    // 64 MiB of zeros compress to a few kilobytes; the declaration says 64 MiB.
    const buf = await zipOf({ 'big.bin': Buffer.alloc(64 * MIB), 'small.txt': 'hello' });
    assert.ok(buf.length < MIB, `compressed to ${buf.length} bytes`);
    const t0 = Date.now();
    await assert.rejects(openZipGuarded(buf, { maxEntries: 100, maxTotalBytes: 8 * MIB, maxRatio: 0 }),
        (e) => e instanceof ZipLimitError && e.reason === 'total_too_large');
    assert.ok(Date.now() - t0 < 500, `refused in ${Date.now() - t0} ms`);
    // With the default ratio cap, zeros that compress a thousandfold are refused on that alone.
    await assert.rejects(openZipGuarded(buf, { maxEntries: 100, maxTotalBytes: 0 }), (e) => e.reason === 'ratio');
    // Under the budget it opens, and its declarations are reported.
    const { entries, declaredTotal } = await openZipGuarded(buf, { maxEntries: 100, maxTotalBytes: 0, maxRatio: 0 });
    assert.strictEqual(entries.length, 2);
    assert.strictEqual(declaredTotal, 64 * MIB + 5);
});

test('a part is cut off at its cap while inflating, with the budget charged for what came in', async () => {
    const buf = await zipOf({ 'big.bin': Buffer.alloc(32 * MIB), 'small.txt': 'hello' });
    const { zip } = await openZipGuarded(buf, { maxEntries: 100, maxTotalBytes: 0, maxRatio: 0 });
    const big = zip.file('big.bin');
    await assert.rejects(readEntryCapped(big, { maxBytes: 1 * MIB }), (e) => e instanceof ZipLimitError && e.reason === 'part_too_large');
    const budget = createByteBudget(2 * MIB);
    await assert.rejects(readEntryCapped(big, { budget }), (e) => e instanceof ZipLimitError && e.reason === 'total_too_large');
    assert.ok(budget.used >= 2 * MIB, 'the declared size was charged before inflating');
    // A small part reads whole and is charged exactly.
    const small = createByteBudget(1 * MIB);
    assert.strictEqual((await readEntryCapped(zip.file('small.txt'), { maxBytes: 1 * MIB, budget: small })).toString(), 'hello');
    assert.strictEqual(small.used, 5);
});

test('the entry count is read from the end record and refused before JSZip builds entries', async () => {
    const files = {};
    for (let i = 0; i < 300; i += 1) files[`f${i}.txt`] = 'x';
    const buf = await zipOf(files);
    assert.strictEqual(declaredEntryCount(buf), 300);
    await assert.rejects(openZipGuarded(buf, { maxEntries: 100, maxTotalBytes: 0 }), (e) => e.reason === 'too_many_entries');
    assert.strictEqual((await openZipGuarded(buf, { maxEntries: 300, maxTotalBytes: 0 })).entries.length, 300);
});

test('a part that inflates past what it declared is stopped at the first chunk over', async () => {
    const buf = await zipOf({ 'a.bin': Buffer.alloc(4 * MIB, 7) });
    const { zip } = await openZipGuarded(buf, { maxEntries: 10, maxTotalBytes: 0 });
    const entry = zip.file('a.bin');
    // Lie about the size the way a crafted central directory would.
    entry._data.uncompressedSize = 1000;
    await assert.rejects(readEntryCapped(entry, {}), (e) => e instanceof ZipLimitError && e.reason === 'broken');
});

test('not a zip at all is named as such', async () => {
    await assert.rejects(openZipGuarded(Buffer.from('plain text'), { maxEntries: 10, maxTotalBytes: 0 }), (e) => e.reason === 'not_a_zip');
});

test('scanPackage: a part that inflates past the part cap is refused, a small package passes', async () => {
    const { scanPackage, officePackageLimits } = require('./zipGuard');
    const bomb = await zipOf({ 'word/document.xml': Buffer.alloc(8 * MIB) });
    await assert.rejects(scanPackage(bomb, { maxEntries: 100, maxTotalBytes: 0, maxPartBytes: 4 * MIB }),
        (err) => err instanceof ZipLimitError && err.reason === 'part_too_large');
    await assert.rejects(scanPackage(bomb, { maxEntries: 100, maxTotalBytes: 4 * MIB, maxPartBytes: 0 }),
        (err) => err instanceof ZipLimitError && err.reason === 'total_too_large');
    await scanPackage(await zipOf({ 'a.xml': '<a/>', 'b.xml': '<b/>' }), officePackageLimits({}));
    await assert.rejects(scanPackage(Buffer.from('not a zip'), officePackageLimits({})),
        (err) => err instanceof ZipLimitError && err.reason === 'not_a_zip');
});

test('scanPackage: a part that understates its size is cut off at the declaration', async () => {
    const { scanPackage } = require('./zipGuard');
    const buf = await zipOf({ 'word/document.xml': Buffer.alloc(2 * MIB) });
    // Rewrite the declared uncompressed size (central directory and local header) to 1 KiB.
    const patched = Buffer.from(buf);
    for (let i = 0; i < patched.length - 4; i += 1) {
        const sig = patched.readUInt32LE(i);
        if (sig === 0x04034b50) patched.writeUInt32LE(1024, i + 22);
        if (sig === 0x02014b50) patched.writeUInt32LE(1024, i + 24);
    }
    await assert.rejects(scanPackage(patched, { maxEntries: 100, maxTotalBytes: 0, maxPartBytes: 0 }),
        (err) => err instanceof ZipLimitError);
});

test('officePackageLimits: environment caps, 0 = unlimited, garbage = default', () => {
    const { officePackageLimits } = require('./zipGuard');
    assert.deepStrictEqual(officePackageLimits({}), { maxEntries: 10_000, maxTotalBytes: 256 * MIB, maxPartBytes: 64 * MIB });
    const l = officePackageLimits({ OFFICE_PACKAGE_MAX_INFLATED_BYTES: '0', OFFICE_PACKAGE_MAX_PART_BYTES: 'x' });
    assert.strictEqual(l.maxTotalBytes, 0);
    assert.strictEqual(l.maxPartBytes, 64 * MIB);
});

/**
 * App Studio — archive.js (what kind of container is this, and what is in it).
 *
 * Run: cd server && node --test appStudio/archive.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const JSZip = require('jszip');

const { archiveFormat, looksLikeArchiveName, openArchive, zipIsEncrypted, _internal } = require('./archive');

async function zip(entries) {
    const z = new JSZip();
    for (const [name, content] of Object.entries(entries)) {
        if (content === null) z.folder(name);
        else z.file(name, content);
    }
    return z.generateAsync({ type: 'nodebuffer' });
}

/** A ustar tarball, by hand — no shelling out, so this runs anywhere. */
function tar(files) {
    const blocks = [];
    for (const [name, content] of Object.entries(files)) {
        const body = Buffer.from(content, 'utf8');
        const h = Buffer.alloc(512);
        h.write(name.slice(0, 100), 0, 'utf8');
        h.write('0000644\0', 100);
        h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
        h.write('00000000000\0', 136);
        h.write('        ', 148);
        h.write('0', 156);
        h.write('ustar\0', 257);
        h.write('00', 263);
        let sum = 0;
        for (const b of h) sum += b;
        h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
        blocks.push(h, body, Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length));
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

const SIG = {
    '7z': Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]),
    rar: Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0, 0]),
    xz: Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 0]),
};

test('the bytes decide what a container is, not the name a sender chose', async () => {
    assert.strictEqual(archiveFormat(await zip({ 'a.txt': 'x' }), 'order.7z'), 'zip',
        'a zip called .7z is a zip');
    assert.strictEqual(archiveFormat(SIG['7z'], 'order.zip'), '7z',
        'and a .7z called .zip is still a .7z — which is why "could not open the zip" was the wrong sentence');
    assert.strictEqual(archiveFormat(Buffer.from('%PDF-1.4 hello'), 'order.zip'), null,
        'a PDF is not an archive whatever it is called');
});

test('a tar is recognised by a marker INSIDE its first header, not a leading signature', () => {
    assert.strictEqual(archiveFormat(tar({ 'a.dxf': 'cut' }), 'order.tar'), 'tar');
    // A pre-POSIX tar has no marker at all, and its name is then the only thing
    // left to go on — the one place the filename is allowed to decide.
    assert.strictEqual(archiveFormat(Buffer.alloc(600), 'oud.tar'), 'tar');
    assert.strictEqual(archiveFormat(Buffer.alloc(600), 'oud.bin'), null);
});

test('looksLikeArchiveName is about the claim, not the bytes', () => {
    for (const n of ['a.zip', 'a.7z', 'a.rar', 'a.tar', 'a.tar.gz', 'a.tgz']) {
        assert.strictEqual(looksLikeArchiveName(n), true, n);
    }
    for (const n of ['a.dxf', 'a.pdf', 'a', '']) {
        assert.strictEqual(looksLikeArchiveName(n), false, JSON.stringify(n));
    }
});

test('a zip enumerates its entries, its folders, and nothing macOS left behind', async () => {
    const bytes = await zip({
        'RFQ/3010-005424-01/3010-005424-01.dxf': 'cut',
        'RFQ/3010-005424-01/3010-005424-01.pdf': 'drawing',
        'RFQ/leeg': null,
        '__MACOSX/._junk': 'resource fork',
    });
    const out = await openArchive(bytes, { name: 'RFQ.zip' });
    assert.strictEqual(out.format, 'zip');
    assert.deepStrictEqual(out.entries.map((e) => e.path).sort(), [
        'RFQ/3010-005424-01/3010-005424-01.dxf',
        'RFQ/3010-005424-01/3010-005424-01.pdf',
    ]);
    assert.ok(out.dirs.some((d) => d.replace(/\/$/, '') === 'RFQ/leeg'), 'the empty folder is still declared');
    assert.strictEqual((await out.entries[0].read()).toString(), 'cut');
});

test('a locked zip says it is locked, instead of failing like a broken one', async () => {
    const plain = await zip({ 'a.dxf': 'cut' });
    assert.strictEqual(zipIsEncrypted(plain), false);

    const locked = Buffer.from(plain);
    locked.writeUInt16LE(locked.readUInt16LE(6) | 0x01, 6);
    assert.strictEqual(zipIsEncrypted(locked), true);

    await assert.rejects(() => openArchive(locked, { name: 'beveiligd.zip' }), (e) => {
        assert.match(e.reason, /password/i);
        return true;
    });
});

test('tar and tar.gz enumerate the same way a zip does', async () => {
    const plain = tar({ 'RFQ/a.dxf': 'cut', 'RFQ/a.pdf': 'drawing' });
    const asTar = await openArchive(plain, { name: 'order.tar' });
    assert.deepStrictEqual(asTar.entries.map((e) => e.path), ['RFQ/a.dxf', 'RFQ/a.pdf']);
    assert.strictEqual((await asTar.entries[1].read()).toString(), 'drawing');

    const asGz = await openArchive(zlib.gzipSync(plain), { name: 'order.tar.gz' });
    assert.strictEqual(asGz.format, 'gzip');
    assert.deepStrictEqual(asGz.entries.map((e) => e.path), ['RFQ/a.dxf', 'RFQ/a.pdf']);
});

test("a lone gzipped FILE is one entry, named the way every unzipper names it", async () => {
    const out = await openArchive(zlib.gzipSync(Buffer.from('artikel;aantal')), { name: 'stuklijst.csv.gz' });
    assert.deepStrictEqual(out.entries.map((e) => e.path), ['stuklijst.csv']);
    assert.strictEqual((await out.entries[0].read()).toString(), 'artikel;aantal');
});

test('a tar reader has to understand ustar prefixes and GNU long names', () => {
    // The prefix field is where a long path's leading directories actually
    // live; a reader that ignores it files the part under a truncated folder.
    const h = Buffer.alloc(512);
    h.write('3010-005424-01.dxf', 0);
    h.write('0000000000\0', 124);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('RFQ-20260001/3010-005424-01', 345);
    const entries = _internal.tarEntries(Buffer.concat([h, Buffer.alloc(1024)]));
    assert.strictEqual(entries[0].path, 'RFQ-20260001/3010-005424-01/3010-005424-01.dxf');
});

test('the archives we do not open are NAMED, and told apart from each other', async () => {
    for (const [format, bytes] of Object.entries(SIG)) {
        await assert.rejects(() => openArchive(bytes, { name: `order.${format}` }), (e) => {
            assert.strictEqual(e.format, format, `${format} is identified as itself`);
            assert.match(e.reason, /cannot be opened here/);
            assert.match(e.reason, /zip/, 'and the sentence says what to ask for instead');
            return true;
        }, format);
    }
});

test('bytes that are no container at all are damaged, not mysteriously empty', async () => {
    await assert.rejects(() => openArchive(Buffer.from('this is not a zip'), { name: 'kapot.zip' }), (e) => {
        assert.match(e.reason, /damaged|not an archive/);
        return true;
    });
});

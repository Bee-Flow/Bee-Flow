/**
 * Upload guard — MIME allowlist, magic-byte sniffing, size cap, SVG
 * sanitization, and the pluggable AV scanner.
 *
 * The middleware runs the real multer memoryStorage parser, so tests feed a
 * genuine multipart/form-data body through a Readable that stands in for the
 * request stream (busboy only needs the stream + content-type header).
 *
 * Run: cd server && node --test middleware/uploadGuard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const { uploadGuard, scanBuffer, _sniffFamily, _magicMatchesDeclared, _resetAvHook, EICAR } = require('./uploadGuard');

// ── Fixtures ────────────────────────────────────────────────────────
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0]);
const CSV = Buffer.from('name,amount\nAlice,10\nBob,20\n');
const SVG_HOSTILE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>');

// CAD fixtures — the text-based ones are deliberately plain text on the wire.
const STEP = Buffer.from("ISO-10303-21;\nHEADER;\nFILE_NAME('BRK-1','',(''),(''),'','','');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n");
const DXF_ASCII = Buffer.from('  0\r\nSECTION\r\n  2\r\nHEADER\r\n  9\r\n$ACADVER\r\n  1\r\nAC1027\r\n  0\r\nENDSEC\r\n  0\r\nEOF\r\n');
const DXF_BINARY = Buffer.concat([Buffer.from('AutoCAD Binary DXF\r\n', 'latin1'), Buffer.from([0x1a, 0x00]), Buffer.alloc(16, 7)]);
const DWG = Buffer.concat([Buffer.from('AC1032'), Buffer.alloc(16, 0)]);
const IGES = Buffer.from('Acme flange export'.padEnd(72) + 'S0000001\n' + '1H,,1H;'.padEnd(72) + 'G0000001\n');
const MZ = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]); // an .exe header

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ── Multipart harness ───────────────────────────────────────────────
function multipartReq({ field = 'file', filename = 'f.bin', mime, buffer, fields = {} }) {
    const boundary = '----testb' + Math.random().toString(16).slice(2);
    const chunks = [];
    for (const [k, v] of Object.entries(fields)) {
        chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`));
    chunks.push(buffer);
    chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(chunks);
    const req = new Readable({ read() { this.push(body); this.push(null); } });
    req.method = 'POST';
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    return req;
}

function runGuard(mw, req) {
    return new Promise((resolve) => {
        const res = {
            statusCode: 200, body: undefined,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve({ res, nexted: false }); return this; },
        };
        mw(req, res, () => resolve({ res, nexted: true, req }));
    });
}

// ── Magic-byte helpers ──────────────────────────────────────────────

test('sniffFamily recognises the common signatures', () => {
    assert.strictEqual(_sniffFamily(PNG), 'png');
    assert.strictEqual(_sniffFamily(JPEG), 'jpeg');
    assert.strictEqual(_sniffFamily(PDF), 'pdf');
    assert.strictEqual(_sniffFamily(ZIP), 'zip');
    assert.strictEqual(_sniffFamily(CSV), 'text');
    assert.strictEqual(_sniffFamily(SVG_HOSTILE), 'svg');
    assert.strictEqual(_sniffFamily(Buffer.from([0, 1, 2, 3, 0])), 'binary');
});

test('sniffFamily finds the tar marker at offset 257, not offset 0', () => {
    // A ustar header: NUL-heavy name field, the magic at byte 257. This pins
    // the fix to startsWith() dropping its offset argument — with the bug, a
    // real tar sniffed 'binary' and the branch below could never fire.
    const tar = Buffer.alloc(512);
    tar.write('some/file.txt', 0, 'utf8');
    tar.write('ustar', 257, 'utf8');
    assert.strictEqual(_sniffFamily(tar), 'tar');
    // And the marker at the WRONG offset must not match.
    const notTar = Buffer.alloc(512);
    notTar.write('ustar', 0, 'utf8');
    assert.notStrictEqual(_sniffFamily(notTar), 'tar');
});

test('magicMatchesDeclared maps zip → docx and rejects a lie', () => {
    assert.ok(_magicMatchesDeclared(DOCX, ZIP));
    assert.ok(_magicMatchesDeclared('image/png', PNG));
    assert.ok(!_magicMatchesDeclared('image/png', PDF));   // declared png, is pdf
    assert.ok(!_magicMatchesDeclared('application/x-msdownload', PNG)); // unknown declared
});

test('sniffFamily recognises the CAD signatures ahead of the text check', () => {
    assert.strictEqual(_sniffFamily(STEP), 'step', 'STEP is plain text but must sniff as its own family');
    assert.strictEqual(_sniffFamily(DXF_ASCII), 'dxf');
    assert.strictEqual(_sniffFamily(DXF_BINARY), 'dxf-binary');
    assert.strictEqual(_sniffFamily(DWG), 'dwg');
    assert.strictEqual(_sniffFamily(IGES), 'iges');
    assert.strictEqual(_sniffFamily(MZ), 'binary');
});

// ── Middleware ──────────────────────────────────────────────────────

test('valid PNG passes and lands in req.file (memory)', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted, req } = await runGuard(mw, multipartReq({ filename: 'a.png', mime: 'image/png', buffer: PNG }));
    assert.strictEqual(nexted, true);
    assert.ok(Buffer.isBuffer(req.file.buffer));
    assert.strictEqual(req.file.mimetype, 'image/png');
    assert.strictEqual(req.file.size, PNG.length);
});

test('a declared MIME outside the allowlist answers 415', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted, res } = await runGuard(mw, multipartReq({ mime: 'application/x-msdownload', buffer: PNG }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 415);
});

test('magic-byte mismatch (png declared, pdf bytes) answers 415', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted, res } = await runGuard(mw, multipartReq({ mime: 'image/png', buffer: PDF }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 415);
    assert.match(res.body.error, /do not match/i);
});

test('an oversize file answers 413', async () => {
    const mw = uploadGuard({ maxBytes: 8 });
    const big = Buffer.concat([PNG, Buffer.alloc(64, 1)]);
    const { nexted, res } = await runGuard(mw, multipartReq({ mime: 'image/png', buffer: big }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 413);
});

test('a docx (zip container) declared as the OOXML type passes', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted } = await runGuard(mw, multipartReq({ filename: 'a.docx', mime: DOCX, buffer: ZIP }));
    assert.strictEqual(nexted, true);
});

test('a hostile SVG is sanitized in place (script stripped, marked sanitized)', async () => {
    const mw = uploadGuard({ maxBytes: 4096 });
    const { nexted, req } = await runGuard(mw, multipartReq({ filename: 'a.svg', mime: 'image/svg+xml', buffer: SVG_HOSTILE }));
    assert.strictEqual(nexted, true);
    assert.strictEqual(req.file.sanitized, true);
    const cleaned = req.file.buffer.toString('utf8');
    assert.ok(!/<script/i.test(cleaned), 'script element removed');
    assert.match(cleaned, /<svg/i);
    assert.strictEqual(req.file.size, req.file.buffer.length);
});

test('no file part answers 400', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const boundary = '----empty';
    const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="notfile"\r\n\r\nx\r\n--${boundary}--\r\n`);
    const req = new Readable({ read() { this.push(body); this.push(null); } });
    req.method = 'POST';
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': String(body.length) };
    const { nexted, res } = await runGuard(mw, req);
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 400);
});

// ── CAD uploads ─────────────────────────────────────────────────────

test('a genuine STEP file declared text/plain still passes (widening regression guard)', async () => {
    // STEP sniffs 'step' now instead of 'text' — the widened text/plain
    // families must keep the old behaviour working.
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted } = await runGuard(mw, multipartReq({ filename: 'part.step', mime: 'text/plain', buffer: STEP }));
    assert.strictEqual(nexted, true);
});

test('.stp declared application/octet-stream: the name proposes, the bytes confirm', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted, req } = await runGuard(mw, multipartReq({ filename: 'part.stp', mime: 'application/octet-stream', buffer: STEP }));
    assert.strictEqual(nexted, true);
    assert.strictEqual(req.file.mimetype, 'model/step', 'the mimetype is canonicalised for the ledger');
});

test('an executable renamed part.step is refused — the extension only proposes', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted, res } = await runGuard(mw, multipartReq({ filename: 'part.step', mime: 'application/octet-stream', buffer: MZ }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 415, 'MZ bytes sniff binary, not step');
});

test('a vendor alias (application/dxf) is canonicalised and passes', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted, req } = await runGuard(mw, multipartReq({ filename: 'plate.dxf', mime: 'application/dxf', buffer: DXF_ASCII }));
    assert.strictEqual(nexted, true);
    assert.strictEqual(req.file.mimetype, 'image/vnd.dxf');
});

test('plain text declared model/step is refused — magic must confirm', async () => {
    const mw = uploadGuard({ maxBytes: 1024 });
    const { nexted, res } = await runGuard(mw, multipartReq({ filename: 'part.step', mime: 'model/step', buffer: CSV }));
    assert.strictEqual(nexted, false);
    assert.strictEqual(res.statusCode, 415);
});

// ── scanBuffer ──────────────────────────────────────────────────────

test('scanBuffer: a benign buffer is clean; EICAR is dirty', async () => {
    _resetAvHook();
    assert.deepStrictEqual(await scanBuffer(CSV), { clean: true });
    const dirty = await scanBuffer(Buffer.from(EICAR));
    assert.strictEqual(dirty.clean, false);
    assert.strictEqual(dirty.signature, 'EICAR-Test-File');
});

test('scanBuffer honours a configured UPLOAD_AV_HOOK and fails closed on hook error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avhook-'));
    const rejectHook = path.join(dir, 'reject.js');
    fs.writeFileSync(rejectHook, 'module.exports = async () => ({ clean: false, signature: "Custom.Sig" });');
    const throwHook = path.join(dir, 'throw.js');
    fs.writeFileSync(throwHook, 'module.exports = async () => { throw new Error("scanner down"); };');

    process.env.UPLOAD_AV_HOOK = rejectHook;
    _resetAvHook();
    const r1 = await scanBuffer(CSV);
    assert.strictEqual(r1.clean, false);
    assert.strictEqual(r1.signature, 'Custom.Sig');

    process.env.UPLOAD_AV_HOOK = throwHook;
    _resetAvHook();
    const r2 = await scanBuffer(CSV);
    assert.strictEqual(r2.clean, false, 'a scanner error must fail closed');

    delete process.env.UPLOAD_AV_HOOK;
    _resetAvHook();
});

'use strict';

/**
 * Round-trip + tamper tests for the `.bfmod` verifier.
 *
 * The package builder is INLINED here (not imported from hub-module-sdk):
 * the SDK pack/sign helpers are ESM and this product test is CommonJS, so we
 * reproduce the exact integrity/JWS logic with an ephemeral RSA keypair. The
 * inlined logic must stay byte-for-byte in agreement with both
 * hub-module-sdk/scripts/{pack,sign}.mjs and modules/packageVerify.js — the
 * shared pins are: integrity.json = {algo:'sha256', files:{path:hex}} over
 * every file except signature.jws + integrity.json, and the JWS payload
 * { iss:'license.beeflow.nl/modules', module_id, version, integrity_sha256,
 *   iat, min_app_version, host_api_version } signed RS256 (RSA-SHA256, PKCS1).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const JSZip = require('jszip');

const { verifyPackage, validateManifest, sha256hex } = require('./packageVerify');

// One keypair for the whole file (2048-bit gen is the slow part).
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KID = crypto.createHash('sha256').update(publicKey).digest('hex').slice(0, 16);
const resolver = (kid) => (kid === KID ? publicKey : null);

const b64url = (input) => Buffer.from(input).toString('base64url');

function signJws(header, payload, key) {
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
    const sig = crypto.sign('RSA-SHA256', Buffer.from(signingInput), {
        key,
        padding: crypto.constants.RSA_PKCS1_PADDING,
    });
    return `${signingInput}.${b64url(sig)}`;
}

function defaultManifest() {
    return {
        manifestVersion: 1,
        id: 'example_module',
        name: 'Example Module',
        description: 'A minimal example.',
        icon: 'puzzle',
        category: 'Studio',
        version: '1.2.3',
        minAppVersion: '1.0.0',
        hostApiVersion: 1,
        capabilities: [{ id: 'example_capability', name: 'Example', kind: 'beta' }],
        server: { entry: 'server/entry.cjs', routes: ['/ping'], workers: [], stores: ['exampleStore'] },
        frontend: { entry: 'frontend/index.js', css: ['frontend/index.css'] },
        requirements: {},
    };
}

/**
 * Build a `.bfmod` buffer with staged mutation hooks so each tamper test can
 * intervene at exactly the right point.
 *   mutateFiles(files)         — payload files, BEFORE integrity is computed
 *   mutateIntegrity(intFiles)  — the integrity.files map, then RE-hashed+signed
 *   mutatePayload(payload)     — JWS payload, then re-signed
 *   signKey                    — private key to sign with (default: correct)
 *   mutateJws(jws) -> jws      — final signature string
 *   mutateZip(zipFiles)        — final { path: Buffer } added to the zip
 */
async function buildPackage(opts = {}) {
    const manifest = opts.manifest || defaultManifest();

    // Payload files (everything except integrity.json + signature.jws).
    const files = {
        'manifest.json': Buffer.from(JSON.stringify(manifest, null, 2)),
        'server/entry.cjs': Buffer.from('module.exports.createModule = () => ({});\n'),
        'frontend/index.js': Buffer.from('export default function App(){return null;}\n'),
        'frontend/index.css': Buffer.from('.x{color:#c60}\n'),
        'assets/logo.txt': Buffer.from('bee\n'),
    };
    if (opts.mutateFiles) opts.mutateFiles(files);

    // integrity.json covers every payload file.
    const integrityFiles = {};
    for (const [name, data] of Object.entries(files)) integrityFiles[name] = sha256hex(data);
    if (opts.mutateIntegrity) opts.mutateIntegrity(integrityFiles, files);
    const integrityBuf = Buffer.from(JSON.stringify({ algo: 'sha256', files: integrityFiles }));

    const payload = {
        iss: 'license.beeflow.nl/modules',
        module_id: manifest.id,
        version: manifest.version,
        integrity_sha256: sha256hex(integrityBuf),
        iat: Math.floor(Date.now() / 1000),
        min_app_version: manifest.minAppVersion || '1.0.0',
        host_api_version: manifest.hostApiVersion || 1,
    };
    if (opts.mutatePayload) opts.mutatePayload(payload);

    const header = { alg: 'RS256', typ: 'JWT', kid: opts.kid || KID };
    let jws = signJws(header, payload, opts.signKey || privateKey);
    if (opts.mutateJws) jws = opts.mutateJws(jws);

    const zipFiles = {
        ...files,
        'integrity.json': integrityBuf,
        'signature.jws': Buffer.from(jws),
    };
    if (opts.mutateZip) opts.mutateZip(zipFiles);

    const zip = new JSZip();
    for (const [name, data] of Object.entries(zipFiles)) zip.file(name, data);
    return zip.generateAsync({ type: 'nodebuffer' });
}

test('valid package round-trips to ok:true with the manifest + files', async () => {
    const buf = await buildPackage();
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.strictEqual(res.ok, true, `expected ok, got ${JSON.stringify(res)}`);
    assert.strictEqual(res.manifest.id, 'example_module');
    assert.strictEqual(res.manifest.version, '1.2.3');
    assert.ok(res.files instanceof Map);
    assert.ok(res.files.has('server/entry.cjs'));
    assert.ok(res.files.has('frontend/index.js'));
});

test('async publicKeyResolver is supported', async () => {
    const buf = await buildPackage();
    const res = await verifyPackage(buf, {
        publicKeyResolver: async (kid) => (kid === KID ? publicKey : null),
    });
    assert.strictEqual(res.ok, true);
});

test('tampering a covered file byte -> file_hash_mismatch', async () => {
    const buf = await buildPackage({
        // Rewrite the file in the zip AFTER integrity was computed, so its
        // declared hash is stale but the signature/integrity chain is intact.
        mutateZip: (zf) => { zf['server/entry.cjs'] = Buffer.from('module.exports = "evil";\n'); },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'file_hash_mismatch' });
});

test('file present in zip but absent from integrity.files -> unexpected_file', async () => {
    const buf = await buildPackage({
        // Drop a real file from the integrity manifest (re-signed), leaving it
        // orphaned in the zip.
        mutateIntegrity: (intFiles) => { delete intFiles['assets/logo.txt']; },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'unexpected_file' });
});

test('integrity.files lists a file not in the zip -> missing_file', async () => {
    const buf = await buildPackage({
        // Add a phantom entry (re-signed) with no backing file.
        mutateIntegrity: (intFiles) => { intFiles['server/ghost.cjs'] = 'a'.repeat(64); },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'missing_file' });
});

test('corrupted signature -> bad_signature', async () => {
    const buf = await buildPackage({
        mutateJws: (jws) => {
            const parts = jws.split('.');
            // Flip a char in the MIDDLE of the signature segment. (The LAST
            // base64url char's low bits are padding the decoder discards — an
            // A→B flip there decodes identically when the char is 'A', so the
            // signature legitimately verifies and the test flakes.)
            const sig = parts[2];
            const i = Math.floor(sig.length / 2);
            parts[2] = sig.slice(0, i) + (sig[i] === 'A' ? 'B' : 'A') + sig.slice(i + 1);
            return parts.join('.');
        },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'bad_signature' });
});

test('signature from an unrelated key -> bad_signature', async () => {
    const other = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    // Signed with a foreign key but resolver still returns OUR public key.
    const buf = await buildPackage({ signKey: other.privateKey });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'bad_signature' });
});

test('signature for a different module id -> signature_module_mismatch', async () => {
    const buf = await buildPackage({
        mutatePayload: (p) => { p.module_id = 'other_module'; },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'signature_module_mismatch' });
});

test('integrity.json altered after signing -> integrity_mismatch', async () => {
    const buf = await buildPackage({
        mutateZip: (zf) => {
            const parsed = JSON.parse(zf['integrity.json'].toString('utf8'));
            parsed.files['assets/logo.txt'] = 'f'.repeat(64); // now un-vouched-for
            zf['integrity.json'] = Buffer.from(JSON.stringify(parsed));
        },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'integrity_mismatch' });
});

test('path-traversal / backslash entry -> bad_path', async () => {
    // jszip normalises `..` out, so a backslash name is the surviving vector
    // (isBadPath rejects backslashes as well as `..`, leading `/`, drive letters).
    const buf = await buildPackage({
        mutateZip: (zf) => { zf['server\\evil.cjs'] = Buffer.from('x'); },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'bad_path' });
});

test('oversized file -> too_large', async () => {
    const buf = await buildPackage({
        // 50MB + 1 byte of zeros: compresses tiny, decompresses over the cap.
        mutateZip: (zf) => { zf['assets/huge.bin'] = Buffer.alloc(50 * 1024 * 1024 + 1); },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'too_large' });
});

test('missing manifest.json -> missing_manifest', async () => {
    const buf = await buildPackage({
        mutateZip: (zf) => { delete zf['manifest.json']; },
    });
    const res = await verifyPackage(buf, { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'missing_manifest' });
});

test('non-zip buffer -> bad_zip', async () => {
    const res = await verifyPackage(Buffer.from('not a zip at all'), { publicKeyResolver: resolver });
    assert.deepStrictEqual(res, { ok: false, error: 'bad_zip' });
});

test('missing publicKeyResolver -> no_resolver', async () => {
    const buf = await buildPackage();
    const res = await verifyPackage(buf, {});
    assert.deepStrictEqual(res, { ok: false, error: 'no_resolver' });
});

test('validateManifest rejects bad ids and versions', async () => {
    assert.strictEqual(validateManifest(defaultManifest()).ok, true);
    assert.deepStrictEqual(validateManifest({ ...defaultManifest(), id: 'Bad-Id' }), { ok: false, error: 'invalid_id' });
    assert.deepStrictEqual(validateManifest({ ...defaultManifest(), id: 'ab' }), { ok: false, error: 'invalid_id' });
    assert.deepStrictEqual(validateManifest({ ...defaultManifest(), version: 'v1' }), { ok: false, error: 'invalid_version' });
    assert.deepStrictEqual(validateManifest({ ...defaultManifest(), capabilities: 'nope' }), { ok: false, error: 'invalid_capabilities' });
    assert.deepStrictEqual(validateManifest({ ...defaultManifest(), server: {} }), { ok: false, error: 'invalid_server_entry' });
    const noFe = defaultManifest(); delete noFe.frontend;
    assert.strictEqual(validateManifest(noFe).ok, true);
});

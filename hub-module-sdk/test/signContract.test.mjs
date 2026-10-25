/**
 * sign/verify contract: what sign.mjs produces must verify with the server's
 * verifyPackage (server/modules/packageVerify.js), and any tampering must fail.
 * The keypair is generated per run; no key is ever committed.
 *
 * Run: node --test test/signContract.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { pack } from '../scripts/pack.mjs';
import { signBuffer, kidForPem, signJws, sha256hex } from '../scripts/sign.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

// The server verifier requires 'jszip', which the SDK job installs here and not
// under server/ (no server install in this job). Resolve that one name to the
// SDK's copy; every other require of the verifier is untouched.
const Module = require('node:module');
const sdkJszip = require.resolve('jszip');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
    return request === 'jszip' ? sdkJszip : origResolve.call(this, request, ...rest);
};
let packageVerify;
try {
    packageVerify = require('../../server/modules/packageVerify.js');
} finally {
    Module._resolveFilename = origResolve;
}
const { verifyPackage, PACKAGE_ISS } = packageVerify;

const MANIFEST = {
    manifestVersion: 2,
    id: 'contract_mod',
    name: 'Contract Mod',
    version: '2.0.1',
    minAppVersion: '1.2.0',
    hostApiVersion: 3,
    permissions: [],
    capabilities: [{ id: 'contract_mod_cap' }],
    server: { entry: 'server/entry.cjs' },
};

function keypair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return { privateKey, publicKey };
}

async function packedModule() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfmod-contract-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(MANIFEST));
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'entry.cjs'), 'module.exports.createModule = () => ({});\n');
    const out = path.join(dir, 'm.bfmod');
    await pack(dir, out);
    const buf = fs.readFileSync(out);
    fs.rmSync(dir, { recursive: true, force: true });
    return buf;
}

const resolverFor = (publicKey) => (kid) => (kid === kidForPem(publicKey) ? publicKey : null);

async function rewrite(buf, fn) {
    const zip = await JSZip.loadAsync(buf);
    await fn(zip);
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

test('a signed package verifies with the server verifier', async () => {
    const { privateKey, publicKey } = keypair();
    const { buf, kid, jws } = await signBuffer(await packedModule(), privateKey, publicKey);
    assert.equal(kid, kidForPem(publicKey));
    assert.equal(jws.split('.').length, 3);

    const res = await verifyPackage(buf, { publicKeyResolver: resolverFor(publicKey) });
    assert.equal(res.ok, true, res.error);
    assert.equal(res.signature.kid, kid);
    assert.equal(res.signature.payload.iss, PACKAGE_ISS);
    assert.equal(res.signature.payload.module_id, 'contract_mod');
    assert.equal(res.signature.payload.version, '2.0.1');
    assert.equal(res.signature.payload.min_app_version, '1.2.0');
    assert.equal(res.signature.payload.host_api_version, 3);
});

test('the public key is derived from the private key when omitted', async () => {
    const { privateKey, publicKey } = keypair();
    const { buf, kid } = await signBuffer(await packedModule(), privateKey);
    assert.equal(kid, kidForPem(publicKey));
    const res = await verifyPackage(buf, { publicKeyResolver: resolverFor(publicKey) });
    assert.equal(res.ok, true, res.error);
});

test('licenseClass free is pinned into the payload, paid leaves it out', async () => {
    const { privateKey, publicKey } = keypair();
    const free = await signBuffer(await packedModule(), privateKey, publicKey, { licenseClass: 'free' });
    const paid = await signBuffer(await packedModule(), privateKey, publicKey);
    const f = await verifyPackage(free.buf, { publicKeyResolver: resolverFor(publicKey) });
    const p = await verifyPackage(paid.buf, { publicKeyResolver: resolverFor(publicKey) });
    assert.equal(f.signature.payload.license_class, 'free');
    assert.equal(p.signature.payload.license_class, undefined);
});

test('a changed integrity.json is rejected', async () => {
    const { privateKey, publicKey } = keypair();
    const { buf } = await signBuffer(await packedModule(), privateKey, publicKey);
    const tampered = await rewrite(buf, async (zip) => {
        const integrity = JSON.parse(await zip.file('integrity.json').async('string'));
        integrity.files['server/entry.cjs'] = sha256hex(Buffer.from('other'));
        zip.file('integrity.json', JSON.stringify(integrity));
    });
    const res = await verifyPackage(tampered, { publicKeyResolver: resolverFor(publicKey) });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'integrity_mismatch');
});

test('a changed file is rejected', async () => {
    const { privateKey, publicKey } = keypair();
    const { buf } = await signBuffer(await packedModule(), privateKey, publicKey);
    const tampered = await rewrite(buf, (zip) => {
        zip.file('server/entry.cjs', 'module.exports.createModule = () => ({ evil: true });\n');
    });
    const res = await verifyPackage(tampered, { publicKeyResolver: resolverFor(publicKey) });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'file_hash_mismatch');
});

test('a wrong kid (unknown key) is rejected', async () => {
    const { privateKey, publicKey } = keypair();
    const { buf, jws } = await signBuffer(await packedModule(), privateKey, publicKey);
    const [h, p, s] = jws.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    header.kid = '0000000000000000';
    const forged = [Buffer.from(JSON.stringify(header)).toString('base64url'), p, s].join('.');
    const tampered = await rewrite(buf, (zip) => zip.file('signature.jws', forged));
    const res = await verifyPackage(tampered, { publicKeyResolver: resolverFor(publicKey) });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'bad_signature');
});

test('a signature by another key is rejected', async () => {
    const a = keypair();
    const b = keypair();
    const { buf } = await signBuffer(await packedModule(), a.privateKey, a.publicKey);
    const res = await verifyPackage(buf, { publicKeyResolver: () => b.publicKey });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'bad_signature');
});

test('a payload for another module id is rejected', async () => {
    const { privateKey, publicKey } = keypair();
    const packed = await packedModule();
    const zip = await JSZip.loadAsync(packed);
    const integrity = await zip.file('integrity.json').async('nodebuffer');
    const jws = signJws(
        { alg: 'RS256', typ: 'JWT', kid: kidForPem(publicKey) },
        { iss: PACKAGE_ISS, module_id: 'someone_else', version: '2.0.1', integrity_sha256: sha256hex(integrity) },
        privateKey,
    );
    zip.file('signature.jws', jws);
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const res = await verifyPackage(buf, { publicKeyResolver: resolverFor(publicKey) });
    assert.equal(res.ok, false);
    assert.equal(res.error, 'signature_module_mismatch');
});

test('signBuffer refuses an unpacked archive', async () => {
    const { privateKey } = keypair();
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify(MANIFEST));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    await assert.rejects(() => signBuffer(buf, privateKey), /integrity\.json missing/);
});

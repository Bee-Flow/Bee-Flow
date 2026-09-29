/**
 * pack/sign round-trip tests — pins the SDK side of the package contract:
 *   - pack() emits snake_case compat aliases (min_app_version,
 *     max_app_version, host_api_version) next to the authored camelCase, so a
 *     loader reading either spelling enforces the gate;
 *   - integrity.json covers every packaged file;
 *   - signBuffer() pins the compat claims (and optional license_class) into
 *     the signed payload — the product's authoritative source.
 *
 * Run: node --test test/pack.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

import { pack } from '../scripts/pack.mjs';
import { signBuffer } from '../scripts/sign.mjs';

const require = createRequire(import.meta.url);
const JSZip = require('jszip');

function makeModuleDir({ manifest }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfmod-pack-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'server', 'entry.cjs'), 'module.exports.createModule = () => ({ router: () => {} });\n');
    return dir;
}

const BASE_MANIFEST = {
    manifestVersion: 2,
    id: 'pack_test_mod',
    name: 'Pack Test',
    version: '1.2.3',
    minAppVersion: '1.1.0',
    hostApiVersion: 3,
    permissions: [],
    capabilities: [{ id: 'pack_test_mod_cap' }],
    server: { entry: 'server/entry.cjs' },
};

test('pack emits snake_case compat aliases and covering integrity', async () => {
    const dir = makeModuleDir({ manifest: BASE_MANIFEST });
    try {
        const out = path.join(dir, 'out.bfmod');
        await pack(dir, out);

        const zip = await JSZip.loadAsync(fs.readFileSync(out));
        const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
        assert.strictEqual(manifest.min_app_version, '1.1.0', 'alias emitted');
        assert.strictEqual(manifest.host_api_version, 3, 'alias emitted');
        assert.strictEqual(manifest.minAppVersion, '1.1.0', 'authored camelCase kept');

        const integrity = JSON.parse(await zip.file('integrity.json').async('string'));
        assert.strictEqual(integrity.algo, 'sha256');
        for (const name of ['manifest.json', 'server/entry.cjs']) {
            const buf = await zip.file(name).async('nodebuffer');
            assert.strictEqual(integrity.files[name], crypto.createHash('sha256').update(buf).digest('hex'), `${name} covered`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('signBuffer pins compat claims + optional license_class into the payload', async () => {
    const dir = makeModuleDir({ manifest: BASE_MANIFEST });
    try {
        const out = path.join(dir, 'out.bfmod');
        await pack(dir, out);
        const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

        const decodePayload = async (buf) => {
            const zip = await JSZip.loadAsync(buf);
            const jws = await zip.file('signature.jws').async('string');
            return JSON.parse(Buffer.from(jws.split('.')[1], 'base64url').toString('utf8'));
        };

        const paid = await signBuffer(fs.readFileSync(out), privatePem);
        const paidPayload = await decodePayload(paid.buf);
        assert.strictEqual(paidPayload.module_id, 'pack_test_mod');
        assert.strictEqual(paidPayload.min_app_version, '1.1.0');
        assert.strictEqual(paidPayload.host_api_version, 3);
        assert.strictEqual(paidPayload.license_class, undefined, 'absent means paid');

        const free = await signBuffer(fs.readFileSync(out), privatePem, undefined, { licenseClass: 'free' });
        const freePayload = await decodePayload(free.buf);
        assert.strictEqual(freePayload.license_class, 'free');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

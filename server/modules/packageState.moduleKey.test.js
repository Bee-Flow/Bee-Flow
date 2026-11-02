'use strict';
// The key family a module signature is checked against: with
// MODULES_PUBLIC_KEY pinned that key is the only root (the licence chain and
// the JWKS play no part); without it the licence chain stays the root.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const packageState = require('./packageState');
const licenseVerify = require('../license/verify');
// The barrel wires the licence verifier in; here a stand-in is wired that
// answers the chain with a marker, so the fallback is visible without a
// database or a bundled key.
packageState.wireDeps({ licenseVerify: () => ({ kidForPem: licenseVerify.kidForPem, resolvePublicKeyByKid: async (/** @type {string} */ kid) => `chain:${kid}` }) });
const { _defaultPackageKeyResolver, pinnedModulePublicKey } = packageState;
const { kidForPem } = licenseVerify;

const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();
const KID = kidForPem(PEM);

const saved = { key: process.env.MODULES_PUBLIC_KEY, file: process.env.MODULES_PUBLIC_KEY_FILE };
test.afterEach(() => {
    if (saved.key === undefined) delete process.env.MODULES_PUBLIC_KEY; else process.env.MODULES_PUBLIC_KEY = saved.key;
    if (saved.file === undefined) delete process.env.MODULES_PUBLIC_KEY_FILE; else process.env.MODULES_PUBLIC_KEY_FILE = saved.file;
});

test('a pinned inline key is the only root: its own kid resolves, any other kid resolves to nothing', async () => {
    process.env.MODULES_PUBLIC_KEY = PEM.replace(/\n/g, '\\n');
    delete process.env.MODULES_PUBLIC_KEY_FILE;
    assert.equal(pinnedModulePublicKey(), PEM);
    assert.equal(await _defaultPackageKeyResolver(KID), PEM);
    assert.equal(await _defaultPackageKeyResolver(undefined), PEM);
    assert.equal(await _defaultPackageKeyResolver('0123456789abcdef'), null);
});

test('a pinned key file works the same way, and an unreadable path pins nothing', async () => {
    delete process.env.MODULES_PUBLIC_KEY;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-modkey-'));
    const file = path.join(dir, 'modules.pem');
    fs.writeFileSync(file, PEM);
    process.env.MODULES_PUBLIC_KEY_FILE = file;
    assert.equal(await _defaultPackageKeyResolver(KID), PEM);
    process.env.MODULES_PUBLIC_KEY_FILE = path.join(dir, 'missing.pem');
    assert.equal(pinnedModulePublicKey(), null);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('without a pinned key the resolver falls back to the licence chain', async () => {
    delete process.env.MODULES_PUBLIC_KEY;
    delete process.env.MODULES_PUBLIC_KEY_FILE;
    assert.equal(pinnedModulePublicKey(), null);
    assert.equal(await _defaultPackageKeyResolver('0123456789abcdef'), 'chain:0123456789abcdef');
});

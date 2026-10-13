/**
 * BFSF-274 — unit tests for the TOTP/recovery-code helpers in auth/mfa.js.
 *
 * configStore is stubbed via require.cache (its real module pulls the DB
 * pool); otplib/bcryptjs/qrcode run for real, so the ±1-step verification
 * window and the bcrypt recovery-code round-trip are tested against the
 * actual crypto, not mocks.
 *
 * Run: cd server && node --test auth/mfa.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

// Stub configStore BEFORE requiring ./mfa — reversible envelope for tests.
const configStorePath = require.resolve('../stores/configStore');
require.cache[configStorePath] = {
    id: configStorePath,
    filename: configStorePath,
    loaded: true,
    exports: {
        encryptValue: (v) => `enc:${v}`,
        decryptValue: (s) => (typeof s === 'string' && s.startsWith('enc:') ? s.slice(4) : null),
    },
};

const mfa = require('./mfa');
const otplib = require('otplib');
// Secrets from v12 are 10 bytes; v13's default floor is 16.
const guardrails = otplib.createGuardrails({ MIN_SECRET_BYTES: 1 });
const generateSync = (o) => otplib.generateSync({ ...o, guardrails });

test('verifyTotp accepts the current code and ±1 step (30s drift), rejects ±3 steps', () => {
    const secret = mfa.generateSecret();

    // The functional API takes an explicit epoch (seconds), so no state leaks
    // into the configuration mfa.js uses.
    const at = (offsetMs) => generateSync({ secret, epoch: Math.floor((Date.now() + offsetMs) / 1000) });

    assert.strictEqual(mfa.verifyTotp(secret, at(0)), true, 'current step accepted');
    assert.strictEqual(mfa.verifyTotp(secret, at(-30_000)), true, 'previous step accepted (clock drift)');
    assert.strictEqual(mfa.verifyTotp(secret, at(30_000)), true, 'next step accepted (clock drift)');
    assert.strictEqual(mfa.verifyTotp(secret, at(-90_000)), false, '3 steps back rejected');
    assert.strictEqual(mfa.verifyTotp(secret, at(90_000)), false, '3 steps ahead rejected');
});

test('verifyTotp hard-rejects null secrets and malformed tokens', () => {
    const secret = mfa.generateSecret();
    assert.strictEqual(mfa.verifyTotp(null, '123456'), false, 'null secret (undecryptable) never verifies');
    assert.strictEqual(mfa.verifyTotp(secret, null), false);
    assert.strictEqual(mfa.verifyTotp(secret, 'abc123'), false, 'non-numeric rejected');
    assert.strictEqual(mfa.verifyTotp(secret, '12345'), false, '5 digits rejected');
    // Whitespace inside an otherwise-valid code is tolerated.
    const tok = generateSync({ secret });
    assert.strictEqual(mfa.verifyTotp(secret, ` ${tok.slice(0, 3)} ${tok.slice(3)} `), true);
});

test('recovery codes: full round-trip, single use, dash/whitespace tolerant', async () => {
    const { plain, stored } = await mfa.generateRecoveryCodes(4);
    assert.strictEqual(plain.length, 4);
    assert.strictEqual(mfa.remainingRecoveryCodes(JSON.stringify(stored)), 4);

    // Consume with the dash kept and surrounding whitespace.
    const updated = await mfa.consumeRecoveryCode(JSON.stringify(stored), ` ${plain[0]} `);
    assert.ok(updated, 'valid code consumes');
    assert.strictEqual(updated.filter(c => c.usedAt).length, 1, 'exactly one entry marked used');
    assert.strictEqual(mfa.remainingRecoveryCodes(JSON.stringify(updated)), 3);

    // Reuse of the same code is rejected.
    const reuse = await mfa.consumeRecoveryCode(JSON.stringify(updated), plain[0]);
    assert.strictEqual(reuse, null, 'consumed code cannot be reused');

    // A different code (without its dash) still works.
    const second = await mfa.consumeRecoveryCode(JSON.stringify(updated), plain[1].replace('-', ''));
    assert.ok(second, 'dash-less entry accepted');

    // Garbage never matches.
    assert.strictEqual(await mfa.consumeRecoveryCode(JSON.stringify(stored), 'nope-nope'), null);
    assert.strictEqual(await mfa.consumeRecoveryCode(JSON.stringify(stored), ''), null);
});

test('encrypt/decrypt secret round-trips through the configStore envelope', () => {
    const secret = mfa.generateSecret();
    const sealed = mfa.encryptSecret(secret);
    assert.notStrictEqual(sealed, secret);
    assert.strictEqual(mfa.decryptSecret(sealed), secret);
    assert.strictEqual(mfa.decryptSecret(null), null);
    // An envelope the store can't decrypt (key rotation) yields null — the
    // routes turn that into the mfa_secret_unreadable flow.
    assert.strictEqual(mfa.decryptSecret('garbage-envelope'), null);
});

// ── otplib 12 -> 13 compatibility ──────────────────────────────────────────
// Everything below was captured from the otplib 12.0.1 code path this module
// used before the upgrade (authenticator with window:1, SHA1, 6 digits, 30s)
// and is hard-coded, because v12 cannot be installed beside v13.

// RFC 6238 appendix B seed "12345678901234567890" (base32), SHA1. The RFC lists
// 8-digit codes (94287082, 07081804, 14050471, 89005924, 69279037, 65353130);
// the 6-digit codes are their last six digits, as v12 produced them.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_VECTORS = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
];

// Random 10-byte (the v12 default, 16 chars) and 20-byte secrets: [secret, epoch s, v12 token].
const V12_VECTORS = [
    ['FBKU77NMZ26X5S47', 1700000000, '423033'],
    ['36PM6TDZ4WWXO4A47SEMDFTDFM2TCSOY', 1701234567, '502089'],
    ['GWYPVULHLC2YCJHT', 1702469134, '229477'],
    ['XHQ6TMDIZFFPAEU5ED3XLI4V4TQKWKGN', 1703703701, '431381'],
    ['CPS4QCRMW5MUKFIT', 1704938268, '344180'],
    ['X22ECNYP7G3S3DSUFTWXBIF7RSVBY5AA', 1706172835, '988290'],
    ['H7MH36BMHVGYUNJB', 1707407402, '225645'],
    ['ZWHUZGU73XYZWARV7T2KNSVDGOCHCI7B', 1708641969, '603599'],
];

// Run verifyTotp with the clock pinned to an epoch in seconds.
function verifyAt(epochSeconds, secret, token) {
    const real = Date.now;
    Date.now = () => epochSeconds * 1000;
    try {
        return mfa.verifyTotp(secret, token);
    } finally {
        Date.now = real;
    }
}

test('otplib 13 generates the RFC 6238 codes v12 produced (SHA1, 6 digits, 30s)', () => {
    for (const [t, expected] of RFC_VECTORS) {
        assert.strictEqual(generateSync({ secret: RFC_SECRET, epoch: t }), expected, `t=${t}`);
        assert.strictEqual(verifyAt(t, RFC_SECRET, expected), true, `verifyTotp t=${t}`);
    }
    for (const [secret, t, expected] of V12_VECTORS) {
        assert.strictEqual(generateSync({ secret, epoch: t }), expected, `${secret} t=${t}`);
        assert.strictEqual(verifyAt(t, secret, expected), true, `verifyTotp ${secret}`);
    }
});

test('verifyTotp window is exactly the v12 window:1 at every instant (captured table)', () => {
    // v12 result for a token of step floor(base/30), verified at base+offset.
    const secret = 'BFZRGTI2LQHW2ECJ'; // a 10-byte secret, as enrolled by v12
    const base = 1791846411;
    const token = '097879';
    const offsets = [];
    for (let o = -100; o <= 100; o += 7) offsets.push(o);
    const expected = '00000001111111111111000000000';
    assert.strictEqual(offsets.length, expected.length);
    const got = offsets.map((o) => (verifyAt(base + o, secret, token) ? '1' : '0')).join('');
    assert.strictEqual(got, expected);

    // And on the RFC secret, around step boundaries: previous, current and next step only.
    const tok = generateSync({ secret: RFC_SECRET, epoch: 1111111109 });
    const step = (t) => Math.floor(t / 30);
    for (let t = 1111111109 - 100; t <= 1111111109 + 100; t++) {
        const want = Math.abs(step(t) - step(1111111109)) <= 1;
        assert.strictEqual(verifyAt(t, RFC_SECRET, tok), want, `epoch ${t}`);
    }
});

test('existing 10-byte secrets (enrolled under v12) still verify; new secrets keep the v12 shape', () => {
    // otplib 13 rejects < 16 bytes by default; mfa.js lowers that floor.
    assert.strictEqual(verifyAt(1791846411, 'BFZRGTI2LQHW2ECJ', '097879'), true);
    const fresh = mfa.generateSecret();
    assert.match(fresh, /^[A-Z2-7]{16}$/, '16 base32 characters, no padding, like v12');
    assert.notStrictEqual(fresh, mfa.generateSecret());
});

test('verifyTotp keeps v12 secret leniency and rejections', () => {
    const secret = 'BFZRGTI2LQHW2ECJ';
    const t = 1791846411;
    assert.strictEqual(verifyAt(t, secret.toLowerCase(), '097879'), true, 'lower-case accepted (v12)');
    assert.strictEqual(verifyAt(t, `${secret}====`, '097879'), true, 'padding accepted (v12)');
    assert.strictEqual(verifyAt(t, secret, '097878'), false, 'wrong code');
    for (const bad of ['!!!', 'abc', 'A', 'BFZRGTI2 LQHW2ECJ', 'GEZDGNBV1']) {
        assert.strictEqual(verifyAt(t, bad, '097879'), false, `secret ${JSON.stringify(bad)} never throws, never verifies`);
    }
});

test('otpauthUrl is byte-identical to otplib 12 keyuri (captured)', () => {
    const cases = [
        ['user@example.com', 'otpauth://totp/Bee%20Flow:user%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30&digits=6&algorithm=SHA1&issuer=Bee%20Flow'],
        ['a b+c@x.nl', 'otpauth://totp/Bee%20Flow:a%20b%2Bc%40x.nl?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30&digits=6&algorithm=SHA1&issuer=Bee%20Flow'],
        [undefined, 'otpauth://totp/Bee%20Flow:user?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30&digits=6&algorithm=SHA1&issuer=Bee%20Flow'],
        ['', 'otpauth://totp/Bee%20Flow:user?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30&digits=6&algorithm=SHA1&issuer=Bee%20Flow'],
        ["o'brien!(x)*~_-.@ex.com", "otpauth://totp/Bee%20Flow:o'brien!(x)*~_-.%40ex.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30&digits=6&algorithm=SHA1&issuer=Bee%20Flow"],
        ['Jos\u00e9 \u00dcnal@b\u00fccher.nl', 'otpauth://totp/Bee%20Flow:Jos%C3%A9%20%C3%9Cnal%40b%C3%BCcher.nl?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30&digits=6&algorithm=SHA1&issuer=Bee%20Flow'],
        ['a:b', 'otpauth://totp/Bee%20Flow:a%3Ab?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30&digits=6&algorithm=SHA1&issuer=Bee%20Flow'],
        ['a&b=c?d#e/f%g', 'otpauth://totp/Bee%20Flow:a%26b%3Dc%3Fd%23e%2Ff%25g?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&period=30&digits=6&algorithm=SHA1&issuer=Bee%20Flow'],
    ];
    for (const [label, expected] of cases) {
        assert.strictEqual(mfa.otpauthUrl(RFC_SECRET, label), expected, JSON.stringify(label));
    }
});

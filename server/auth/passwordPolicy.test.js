/**
 * The password policy exists because a pentest set a live account's password to
 * `password` through the UI and then to `12345678` through the API, and both
 * were accepted. These tests pin the specific strings from that report, the
 * canonicalisation that stops `P@ssw0rd`-shaped evasions, and — just as
 * importantly — that a genuinely good passphrase still gets through. A policy
 * that rejects everything is not a policy, it is an outage.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const {
    MIN_PASSWORD_LENGTH,
    MIN_ADMIN_PASSWORD_LENGTH,
    validatePassword,
    isCommonPassword,
    isRepeatedUnit,
    isSequential,
} = require('./passwordPolicy');

describe('the passwords the pentest actually used', () => {
    for (const pw of ['password', '12345678', 'Welcome123', 'P@ssw0rd', 'beeflow', 'admin123', 'Welkom123']) {
        test(`rejects ${JSON.stringify(pw)}`, () => {
            const r = validatePassword(pw, { username: 'someone' });
            assert.strictEqual(r.ok, false, `${pw} was accepted`);
        });
    }
});

describe('length', () => {
    test('MIN_PASSWORD_LENGTH is 8 — the frontend mirror and the ISO 27001 check both read it', () => {
        assert.strictEqual(MIN_PASSWORD_LENGTH, 8);
    });

    test('seven characters is short regardless of how odd it looks', () => {
        const r = validatePassword('x7Qz#pL', {});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.code, 'password_too_short');
    });

    test('administrative accounts get the longer minimum', () => {
        const pw = 'kraanvogel9';   // 11 chars — fine for a member, short for an admin
        assert.strictEqual(validatePassword(pw, {}).ok, true);
        assert.strictEqual(validatePassword(pw, { isAdmin: true }).ok, false);
        assert.strictEqual(validatePassword(pw, { role: 'admin' }).ok, false);
        assert.strictEqual(validatePassword(pw, { orgRole: 'org_admin' }).ok, false);
        assert.ok(MIN_ADMIN_PASSWORD_LENGTH > MIN_PASSWORD_LENGTH);
    });

    test('a member-level orgRole does not trigger the admin minimum', () => {
        assert.strictEqual(validatePassword('kraanvogel9', { orgRole: 'member' }).ok, true);
    });
});

describe('canonicalisation — the evasions a literal deny-list misses', () => {
    test('leet substitutions are reversed', () => {
        assert.ok(isCommonPassword('P@ssw0rd'));
        assert.ok(isCommonPassword('W3lk0m'));
        assert.ok(isCommonPassword('adm1n'));
    });

    test('appended years and counters are stripped to the base word', () => {
        assert.ok(isCommonPassword('sunshine2024'));
        assert.ok(isCommonPassword('welkom2025'));
        assert.ok(isCommonPassword('beeflow123'));
    });

    test('separators and punctuation are stripped', () => {
        assert.ok(isCommonPassword('bee-flow'));
        assert.ok(isCommonPassword('let.me.in'));
    });

    test('Dutch base words are covered — an English-only list would pass these', () => {
        assert.ok(isCommonPassword('welkom'));
        assert.ok(isCommonPassword('wachtwoord'));
        assert.ok(isCommonPassword('voetbal'));
        assert.ok(isCommonPassword('geheim'));
    });
});

describe('structural rejections', () => {
    test('a single repeated unit is not a password', () => {
        assert.ok(isRepeatedUnit('aaaaaaaa'));
        assert.ok(isRepeatedUnit('abababab'));
        assert.ok(isRepeatedUnit('123123123'));
        assert.ok(!isRepeatedUnit('kraanvogel'));
    });

    test('alphabet and keyboard runs are caught', () => {
        assert.ok(isSequential('abcdefgh'));
        assert.ok(isSequential('qwertyui'));
        assert.ok(isSequential('87654321'));
        assert.ok(!isSequential('kraanvogel9'));
    });

    test('a short run inside a longer passphrase is fine', () => {
        assert.ok(!isSequential('abcd-molenwiek-fietsbel'));
    });
});

describe('identity-derived passwords', () => {
    test('the username cannot be the password', () => {
        const r = validatePassword('tomsmit-tomsmit', { username: 'tomsmit' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.code, 'password_contains_identity');
    });

    test('the e-mail local part counts too', () => {
        const r = validatePassword('smittom99xyz', { email: 'smittom@example.nl' });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.code, 'password_contains_identity');
    });

    test('the e-mail domain label counts too — enumeration hands the attacker this half', () => {
        const r = validatePassword('werkenbijbeeflow', { email: 'iemand@beeflow.nl' });
        assert.strictEqual(r.ok, false);
    });

    test('a short username is not treated as a substring — "ab" would match everything', () => {
        assert.strictEqual(validatePassword('molenwiekfiets', { username: 'ab' }).ok, true);
    });
});

describe('good passwords still get through', () => {
    for (const pw of [
        'molenwiek-fietsbel-42',
        'Kr@anvogel-Zonsopgang',
        'correct horse battery staple',
        'z8Ntq!vRm2Ld',
        'drieKoffieVoorNegenUur',
    ]) {
        test(`accepts ${JSON.stringify(pw)}`, () => {
            const r = validatePassword(pw, { username: 'gebruiker', email: 'gebruiker@voorbeeld.nl' });
            assert.strictEqual(r.ok, true, `rejected with: ${r.error}`);
        });
    }
});

describe('input handling', () => {
    test('a missing password is a policy failure, not a crash', () => {
        for (const bad of [undefined, null, '', 123, {}, []]) {
            const r = validatePassword(bad, {});
            assert.strictEqual(r.ok, false);
        }
    });

    test('an absurdly long password is refused rather than carried into Argon2id', () => {
        const r = validatePassword('a1B!'.repeat(200), {});
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.code, 'password_too_long');
    });
});

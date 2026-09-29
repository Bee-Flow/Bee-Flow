/**
 * Tests for the Nextcloud SSRF target policy.
 *
 * The URL saved with a Nextcloud app password is user-controlled, and every
 * later call attaches that user's Basic credentials to it — so an unvalidated
 * value turns the server into a credential-bearing probe of its own network.
 * Validation used to be "does it start with http(s)".
 *
 * Run: node --test integrations/nextcloudTarget.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { assertAllowedNextcloudHost, isAllowedNextcloudHost, isMetadataHost } = require('./nextcloudTarget');

function withPrivateHostsAllowed(fn) {
    const prev = process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = '1';
    try { fn(); } finally {
        if (prev === undefined) delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
        else process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = prev;
    }
}

const PRIVATE = [
    'http://localhost:8080',
    'http://127.0.0.1',
    'http://10.1.2.3',
    'http://192.168.1.50',
    'http://172.16.0.9',
];

// Refused whatever the deployment allows: there is no legitimate Nextcloud
// here, and a blind SSRF to IMDS is the one that yields cloud credentials.
const METADATA = [
    'http://169.254.169.254',
    'http://169.254.170.2/v2/credentials',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://metadata',
];

test('public hosts are allowed, including subpath installs', () => {
    for (const url of [
        'https://cloud.example.com',
        'https://cloud.example.com/nextcloud',
        'http://cloud.example.com',
        'https://nc.example.co.uk:8443/cloud',
    ]) {
        assert.ok(isAllowedNextcloudHost(url), `${url} should be allowed`);
    }
});

test('private and loopback targets are refused by default', () => {
    delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    for (const url of PRIVATE) {
        assert.throws(() => assertAllowedNextcloudHost(url), /private or local network/, `${url} must be refused`);
    }
});

test('NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1 re-allows LAN self-host targets', () => {
    withPrivateHostsAllowed(() => {
        for (const url of PRIVATE) {
            assert.ok(isAllowedNextcloudHost(url), `${url} should be allowed for self-host`);
        }
    });
});

test('cloud metadata endpoints are refused in BOTH modes', () => {
    delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    for (const url of METADATA) {
        assert.throws(() => assertAllowedNextcloudHost(url), /not a valid Nextcloud host/, `${url} must be refused (strict)`);
    }
    withPrivateHostsAllowed(() => {
        for (const url of METADATA) {
            assert.strictEqual(isAllowedNextcloudHost(url), false, `${url} must stay refused with the flag on`);
        }
    });
});

test('isMetadataHost covers v4 link-local, IMDSv6 and the metadata names', () => {
    assert.ok(isMetadataHost('169.254.169.254'));
    assert.ok(isMetadataHost('169.254.0.1'));
    assert.ok(isMetadataHost('metadata.google.internal'));
    assert.ok(isMetadataHost('METADATA.GOOGLE.INTERNAL'), 'case-insensitive');
    assert.ok(isMetadataHost('[fd00:ec2::254]'), 'IMDSv6, brackets stripped');
    assert.ok(!isMetadataHost('cloud.example.com'));
    assert.ok(!isMetadataHost('169.253.1.1'), 'adjacent range is not link-local');
});

test('non-http schemes and embedded credentials are refused', () => {
    delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    assert.throws(() => assertAllowedNextcloudHost('file:///etc/passwd'), /http:\/\/ or https:\/\//);
    assert.throws(() => assertAllowedNextcloudHost('ftp://cloud.example.com'), /http:\/\/ or https:\/\//);
    assert.throws(() => assertAllowedNextcloudHost('gopher://cloud.example.com'), /http:\/\/ or https:\/\//);
    // Credentials in the URL would ride along on every request.
    assert.throws(() => assertAllowedNextcloudHost('https://user:pw@cloud.example.com'), /username or password/);
    assert.throws(() => assertAllowedNextcloudHost('not a url'), /valid Nextcloud URL/);
});

test('the refusal message tells a self-hoster which flag to set', () => {
    delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    assert.throws(() => assertAllowedNextcloudHost('http://192.168.1.50'), /NEXTCLOUD_ALLOW_PRIVATE_HOSTS=1/);
});

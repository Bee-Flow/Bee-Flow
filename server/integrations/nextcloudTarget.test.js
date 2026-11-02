// @typecheck strict
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

function withPrivateHostsAllowed(/** @type {() => unknown} */ fn) {
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

// ── Private-host mode: the fetch itself ─────────────────────────────

const { nextcloudFetch } = require('./nextcloudTarget');

/**
 * Private-host mode with a recording fetch answering from `routes`.
 * @param {Record<string, { status: number, location?: string }>} routes  url → answer
 * @param {(calls: string[]) => Promise<void>} body
 */
async function withPrivateMode(routes, body) {
    const prevEnv = process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    const prevFetch = globalThis.fetch;
    process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = '1';
    /** @type {string[]} */
    const calls = [];
    globalThis.fetch = /** @type {typeof fetch} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
        calls.push(`${init?.redirect}:${String(url)}`);
        const r = routes[String(url)] || { status: 200 };
        return new Response(r.status === 200 ? 'ok' : null, { status: r.status, headers: r.location ? { location: r.location } : {} });
    });
    try { await body(calls); } finally {
        globalThis.fetch = prevFetch;
        if (prevEnv === undefined) delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
        else process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = prevEnv;
    }
}

test('private-host mode: redirects are followed by hand, and never to a metadata address', async () => {
    await withPrivateMode({
        'http://lan.test/hop': { status: 302, location: 'http://lan.test/final' },
        'http://lan.test/bad': { status: 302, location: 'http://169.254.169.254/latest/meta-data/' },
        'http://lan.test/bad-name': { status: 302, location: 'http://metadata.google.internal/x' },
        'http://lan.test/bad-mapped': { status: 302, location: 'http://[::ffff:169.254.169.254]/x' },
    }, async (calls) => {
        assert.strictEqual(await (await nextcloudFetch('http://lan.test/hop')).text(), 'ok', 'a LAN hop is followed');
        await assert.rejects(nextcloudFetch('http://lan.test/bad'), /not a valid Nextcloud host/);
        await assert.rejects(nextcloudFetch('http://lan.test/bad-name'), /not a valid Nextcloud host/);
        await assert.rejects(nextcloudFetch('http://lan.test/bad-mapped'), /not a valid Nextcloud host/);
        const post = await nextcloudFetch('http://lan.test/bad', { method: 'POST', body: 'x' });
        assert.strictEqual(post.status, 302, 'a non-GET redirect is returned, not followed');
        assert.ok(calls.every((c) => c.startsWith('manual:')), 'fetch never follows a redirect itself');
        assert.ok(!calls.some((c) => /169\.254|metadata|ffff/.test(c)), 'no metadata request was made');
    });
});

// ── Private-host mode: connect-time screen ──────────────────────────

const http = require('node:http');
const { makePrivateModeDispatcher } = require('./nextcloudTarget');

/**
 * A dns.lookup stand-in that answers every name with `address`.
 * @param {string} address
 */
function fixedLookup(address) {
    return /** @type {any} */ ((/** @type {string} */ _h, /** @type {any} */ opts, /** @type {any} */ cb) => {
        const family = address.includes(':') ? 6 : 4;
        if (opts && opts.all) cb(null, [{ address, family }]);
        else cb(null, address, family);
    });
}

test('private-host mode: a name resolving to a link-local address is refused at connect time', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    try {
        const lan = makePrivateModeDispatcher({ lookup: fixedLookup('127.0.0.1') });
        const res = await fetch(`http://nc.test:${port}/`, /** @type {any} */ ({ dispatcher: lan }));
        assert.strictEqual(await res.text(), 'ok', 'a loopback/LAN answer is allowed in private-host mode');

        for (const address of ['169.254.169.254', 'fe80::1', 'fd00:ec2::254']) {
            const guarded = makePrivateModeDispatcher({ lookup: fixedLookup(address) });
            await assert.rejects(
                fetch(`http://nc.test:${port}/`, /** @type {any} */ ({ dispatcher: guarded })),
                (/** @type {any} */ err) => err?.cause?.code === 'ENEXTCLOUDLINKLOCAL',
                `${address} is refused`,
            );
        }
    } finally {
        server.close();
    }
});

test('private-host mode: nextcloudFetch hands a dispatcher to fetch', async () => {
    const prevEnv = process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
    const prevFetch = globalThis.fetch;
    process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = '1';
    /** @type {any[]} */
    const inits = [];
    globalThis.fetch = /** @type {typeof fetch} */ (async (/** @type {any} */ _url, /** @type {any} */ init) => {
        inits.push(init);
        return new Response('ok');
    });
    try {
        await nextcloudFetch('http://lan.test/x');
        assert.ok(inits[0]?.dispatcher, 'the connect-time screen is attached');
        assert.strictEqual(inits[0]?.redirect, 'manual');
    } finally {
        globalThis.fetch = prevFetch;
        if (prevEnv === undefined) delete process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS;
        else process.env.NEXTCLOUD_ALLOW_PRIVATE_HOSTS = prevEnv;
    }
});

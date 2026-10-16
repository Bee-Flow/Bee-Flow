const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalSignedPath, canonicalQuery, connectorWireUrl, signedConnectorHeaders } = require('./ncSigning');

test('the same query signs identically whether the hop sent %20, + or %26', () => {
    // After the AppAPI/HaRP hop `term=a%20b` arrives as `term=a+b`.
    assert.equal(canonicalSignedPath('/nc/ocs/x?term=a%20b'), canonicalSignedPath('/nc/ocs/x?term=a+b'));
    assert.equal(canonicalQuery('term=a%20b'), 'term=a%20b');
    assert.equal(canonicalQuery('term=a%26b'), 'term=a%26b');
    assert.equal(canonicalQuery('term=a%2Bb'), 'term=a%2Bb');
});

test('different parameter lists never share a canonical form', () => {
    assert.notEqual(canonicalQuery('a=1%262'), canonicalQuery('a=1&2='));
    assert.notEqual(canonicalQuery('a=b%3Dc'), canonicalQuery('a=b&c='));
    assert.notEqual(canonicalQuery('a=x+y'), canonicalQuery('a=x%2By'));
    assert.equal(canonicalQuery('a=1%0A2'), 'a=1%0A2', 'a newline cannot forge a message field');
});

test('plain queries and decoded paths keep their legacy shape', () => {
    assert.equal(canonicalSignedPath('/nc/remote.php/dav/files/alice/a%20b.txt'), '/nc/remote.php/dav/files/alice/a b.txt');
    assert.equal(canonicalSignedPath('/nc/ocs/x?path=/Docs/a:b,c@d&format=json'), '/nc/ocs/x?path=/Docs/a:b,c@d&format=json');
});

test('an invalid UTF-8 escape is refused, so %FF and %FE cannot collide', () => {
    assert.throws(() => canonicalQuery('a=%FF'), URIError);
    assert.throws(() => canonicalQuery('a=%FE'), URIError);
    assert.throws(() => canonicalSignedPath('/nc/x?a=%FF'), URIError);
    assert.equal(canonicalQuery('a=%EF%BF%BD'), 'a=\uFFFD');
});

test('the path/query boundary is unambiguous: an encoded ? in the path is escaped', () => {
    assert.notEqual(canonicalSignedPath('/nc/x/a%3Fb'), canonicalSignedPath('/nc/x/a?b'));
    assert.equal(canonicalSignedPath('/nc/x/a%3Fb%25%0A'), '/nc/x/a%3Fb%25%0A');
});

test('cross-repo vector (pinned in nextcloud-connector/test/ncProxy.test.js too)', () => {
    const { 'X-Beeflow-Sig': sig } = signedConnectorHeaders({
        tenantKey: 'k', method: 'get', path: '/nc/ocs/x?term=a%20b%26c%2Bd', ncUid: 'alice', ts: 1700000000,
    });
    assert.equal(sig, '1700000000.2965e7da7a070ac22f8859397b0220b3bec73431d1552795577c29e0de56f2c4');
});

test('plain requests sign the exact legacy message (old connectors keep working)', () => {
    const crypto = require('crypto');
    const legacy = (ts, m, p, uid, body) => crypto.createHmac('sha256', 'k').update(
        `${ts}\n${m}\n${decodeURIComponent(p)}\n${uid}\n${crypto.createHash('sha256').update(body).digest('hex')}`).digest('hex');
    for (const p of ['/nc/remote.php/dav/files/alice/a%20b.txt', '/nc/ocs/x?path=/Docs/a:b&format=json',
        '/nc/remote.php/dav/calendars/alice/p/9b2-uid%40nc.test.ics']) {
        const { 'X-Beeflow-Sig': sig } = signedConnectorHeaders({
            tenantKey: 'k', method: 'put', path: p, ncUid: 'alice', body: 'x', ts: 1700000000 });
        assert.equal(sig, `1700000000.${legacy(1700000000, 'PUT', p, 'alice', 'x')}`, p);
    }
    // Frozen literal, computed with the pre-canonical implementation (298a7cb97).
    const { 'X-Beeflow-Sig': frozen } = signedConnectorHeaders({
        tenantKey: 'k', method: 'get', path: '/nc/ocs/v2.php/cloud/user', ncUid: 'alice', ts: 1700000000 });
    assert.equal(frozen, '1700000000.2d7802a6f4bea509482159b389cd21d56d3f787b2d04732202b9fdf4eb8c2558');
});

test('requests the legacy form cannot carry sign the marked canonical message', () => {
    for (const p of ['/nc/ocs/x?term=a%20b', '/nc/ocs/x?term=a%2Bb', '/nc/x/a%3Fb.txt', '/nc/x/100%25.txt']) {
        assert.notEqual(canonicalSignedPath(p), decodeURIComponent(p), p);
    }
});

test('wire url escapes % in the path only, so one hop decode restores the real path', () => {
    const base = 'https://cb.test/nc';
    const name = encodeURIComponent('q?mark #1 100%.txt');
    const url = `${base}/remote.php/dav/files/alice/${name}?term=a%20b`;
    const wire = connectorWireUrl(url, base);
    assert.equal(wire, `${base}/remote.php/dav/files/alice/${name.replace(/%/g, '%25')}?term=a%20b`);
    // What the hop hands the connector: the path decoded once.
    const hopPath = decodeURIComponent(wire.slice(base.length).split('?')[0]);
    assert.equal(hopPath, `/remote.php/dav/files/alice/${name}`);
    assert.equal(connectorWireUrl('/nc/a%3Fb', base), '/nc/a%253Fb');
    assert.equal(connectorWireUrl('https://other.test/a%3F', base), 'https://other.test/a%3F');
});

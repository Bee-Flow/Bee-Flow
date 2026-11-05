/**
 * The client enum, and why it is closed.
 *
 * This column exists to answer one question — how much of the work happens on
 * a phone — and it can only answer it while it stays an enum you can GROUP BY.
 * The failure mode is not a crash: it is that some caller sends
 * `X-Beeflow-Client: android-v2` or `iOS`, the column grows a long tail of
 * near-duplicates, and every count quietly becomes wrong in a way nobody
 * notices for months.
 *
 * The second test is the one that matters for honesty rather than tidiness:
 * the denominator. Most rows in ai_usage_log come from the server acting on
 * its own, and counting them would report every client's share against how
 * busy the instance happens to be.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    normalizeClient,
    withRequestClient,
    currentClient,
    INTERACTIVE_SOURCES,
    CLIENTS,
} = require('./requestClient');

test('accepts exactly the known clients', () => {
    for (const name of ['web', 'android', 'desktop', 'api']) {
        assert.strictEqual(normalizeClient(name), name);
    }
});

test('narrows anything else to unknown rather than minting a category', () => {
    // Note 'WEB ' is deliberately NOT here — it is the same client as 'web'
    // and belongs in the case-insensitivity test below. Trimming and
    // lowercasing is intended: a header value is typed by a human somewhere.
    for (const value of ['android-v2', 'iOS', 'curl', '', 'web-app', undefined, null, 42, {}, []]) {
        assert.strictEqual(normalizeClient(value), 'unknown', `value: ${JSON.stringify(value)}`);
    }
});

test('is case- and whitespace-insensitive for the known names', () => {
    // A header is typed by a human somewhere. 'Android' and 'android' are the
    // same client and must not become two rows in a GROUP BY.
    assert.strictEqual(normalizeClient('Android'), 'android');
    assert.strictEqual(normalizeClient('  web  '), 'web');
});

test('is unknown outside a request, which is the honest answer', async () => {
    // The automation runner, cron and swarm workers all log usage with no
    // request in flight. Attributing those to a client would be a lie.
    assert.strictEqual(currentClient(), 'unknown');
});

test('carries the client through the async work of a request', async () => {
    const req = { headers: { 'x-beeflow-client': 'android' } };
    await new Promise((resolve) => {
        withRequestClient(req, {}, async () => {
            assert.strictEqual(currentClient(), 'android');
            // The point of AsyncLocalStorage over a plain variable: it has to
            // survive an await, because logUsage is called deep inside one.
            await new Promise((r) => setImmediate(r));
            assert.strictEqual(currentClient(), 'android');
            resolve();
        });
    });
    // And it must not leak back out.
    assert.strictEqual(currentClient(), 'unknown');
});

test('the interactive denominator excludes machine-initiated work', () => {
    // If any of these ever appear in INTERACTIVE_SOURCES, every client share
    // silently starts being divided by how busy the instance is.
    for (const machine of ['automation', 'scheduled_task', 'swarm', 'title', 'cron']) {
        assert.ok(!INTERACTIVE_SOURCES.includes(machine), `${machine} is not a person typing`);
    }
    assert.ok(INTERACTIVE_SOURCES.includes('direct_chat'));
    assert.ok(INTERACTIVE_SOURCES.length > 0);
});

test('unknown is never itself a member of the enum', () => {
    // Otherwise "we could not tell" and "a client called unknown" become the
    // same row.
    assert.ok(!CLIENTS.has('unknown'));
});

test('the desktop client is its own value, not unknown', () => {
    // The desktop app sends `X-Beeflow-Client: desktop` on every request
    // (desktop/src/main/security/sessionHeaders.ts); before it was in the enum
    // every desktop turn landed in `unknown`, mixed with machine-initiated rows.
    assert.strictEqual(normalizeClient('desktop'), 'desktop');
    assert.strictEqual(normalizeClient('Desktop'), 'desktop');
});

test('the interactive denominator is the vocabulary\'s interactive sources', () => {
    const { SOURCES, INTERACTIVE_SOURCES: fromVocabulary } = require('../shared/usageAreas');
    assert.deepStrictEqual([...INTERACTIVE_SOURCES], [...fromVocabulary]);
    for (const source of INTERACTIVE_SOURCES) {
        assert.ok(SOURCES[source], `${source} is a declared source`);
    }
    // Sources no writer emits are gone from the denominator.
    for (const dead of ['notebook', 'webpage_chat']) {
        assert.ok(!INTERACTIVE_SOURCES.includes(dead), `${dead} is not written by anyone`);
    }
});

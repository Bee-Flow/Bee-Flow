/**
 * Token numbering must continue across turns, not restart.
 *
 * `tokenizeText` takes an `existingTokenMap` precisely so turn 2 extends turn
 * 1's numbering instead of colliding with it. The interactive DLP path passes
 * it (dlp/dlpRunner.js:349, whose comment spells out the consequence); the
 * legacy guardrails path called `validateInputForPii` with no way to supply
 * one, so every turn restarted the per-category counters at 1.
 *
 * The damage is not cosmetic. `_mergeIntoTokenMap` merges each turn's map into
 * one conversation-scoped map by key, so turn 2's `[email_1]` OVERWRITES turn
 * 1's entry. The un-tokeniser then rewrites turn 1's placeholder — which may
 * still be sitting in persisted history, a notebook, or an outbound tool
 * argument — with a different person's address.
 *
 * Run: node --test server/core/piiDetection.tokencontinuity.test.js
 */

const assert = require('assert');
const { test, before, after } = require('node:test');
const http = require('http');

process.env.NODE_ENV = 'test';

function stub(id, exports) {
    const resolved = require.resolve(id);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
    return resolved;
}
stub('../aiAgent', {
    getAIConfig: async () => ({ piiDetectionEnabled: true, piiDetectionAction: 'tokenize' }),
});
stub('../../stores/configStore', {
    getConfig: async () => null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
});

const ALICE = 'alice@voorbeeld.nl';
const BOB = 'bob@voorbeeld.nl';

let server;

before(async () => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            const { text } = JSON.parse(body);
            const entities = [];
            const re = /[a-z]+@voorbeeld\.nl/g;
            let m;
            while ((m = re.exec(text)) !== null) {
                entities.push({
                    text: m[0], category: 'Email', label: 'Email Address',
                    confidence: 0.95, offset: m.index, length: m[0].length,
                });
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ hasPii: entities.length > 0, entities }));
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    process.env.PII_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
    delete process.env.PII_SERVICE_API_KEY;
});

after(() => new Promise(resolve => server.close(resolve)));

const { validateInputForPii, tokenizeText } = require('./piiDetection');

const shield = { enabled: true, piiDetectionAction: 'tokenize' };
const turn = (text) => [{ role: 'user', content: text }];

test('turn 2 does not reuse turn 1 token numbers for a different value', async () => {
    const first = await validateInputForPii(turn(`Mail naar ${ALICE} graag`), true, shield);
    assert.ok(first?.tokenMap);
    const aliceToken = Object.keys(first.tokenMap)[0];
    assert.strictEqual(first.tokenMap[aliceToken], ALICE);

    // The conversation map as the runner would hold it after turn 1.
    const conversationMap = new Map(Object.entries(first.tokenMap));

    const second = await validateInputForPii(
        turn(`En ook naar ${BOB} sturen`), true, shield, null, conversationMap,
    );
    assert.ok(second?.tokenMap);
    const bobToken = Object.keys(second.tokenMap)[0];

    assert.notStrictEqual(bobToken, aliceToken,
        `turn 2 minted ${bobToken} for ${BOB} while turn 1 already used it for ${ALICE} — ` +
        'merging these maps silently rebinds turn 1s placeholder to the wrong person');

    // And the merge must be lossless.
    const merged = new Map([...conversationMap, ...Object.entries(second.tokenMap)]);
    assert.strictEqual(merged.get(aliceToken), ALICE);
    assert.strictEqual(merged.get(bobToken), BOB);
    assert.strictEqual(merged.size, 2, 'a mapping was lost when the two turns were merged');
});

test('the same value in a later turn reuses its existing token', async () => {
    const first = await validateInputForPii(turn(`Eerst ${ALICE} hier`), true, shield);
    const token = Object.keys(first.tokenMap)[0];
    const conversationMap = new Map(Object.entries(first.tokenMap));

    const second = await validateInputForPii(
        turn(`Nogmaals ${ALICE} daar`), true, shield, null, conversationMap,
    );
    assert.ok(second.tokenizedText.includes(token),
        'a repeated value should keep its original placeholder across turns');
});

test('omitting the map preserves the old single-turn behaviour', async () => {
    // Not a regression guard for the bug — a guard that the new parameter is
    // genuinely optional, since most callers still pass nothing.
    const result = await validateInputForPii(turn(`Alleen ${ALICE} nu`), true, shield);
    assert.ok(result?.tokenMap);
    assert.strictEqual(Object.keys(result.tokenMap).length, 1);
});

test('a Map and a plain object seed the counters identically', () => {
    // The silent trap: `typeof aMap === 'object'` is true but
    // `Object.entries(aMap)` is [], so passing the inner Map from dlpRunner's
    // own store used to seed NOTHING — numbering restarted at 1 and the caller
    // got exactly the collision this parameter exists to prevent, with no
    // error anywhere. dlpRunner's public accessor returns an object, but its
    // internal store is a Map, so both shapes are one refactor apart.
    const seed = { '[email_1]': ALICE };
    const entity = [{ text: BOB, category: 'Email', offset: 2, length: BOB.length }];

    const viaObject = tokenizeText(`x ${BOB} y`, entity, seed);
    const viaMap = tokenizeText(`x ${BOB} y`, entity, new Map(Object.entries(seed)));

    assert.deepStrictEqual(Object.keys(viaMap.tokenMap), Object.keys(viaObject.tokenMap),
        'a Map seed produced different numbering than the equivalent object');
    assert.ok(!('[email_1]' in viaMap.tokenMap),
        'a Map seed was ignored, so turn 2 re-minted [email_1] for a different value');
});

test('tokenizeText itself continues numbering (the primitive this relies on)', () => {
    const a = tokenizeText(`x ${ALICE} y`, [
        { text: ALICE, category: 'Email', offset: 2, length: ALICE.length },
    ]);
    const b = tokenizeText(`x ${BOB} y`, [
        { text: BOB, category: 'Email', offset: 2, length: BOB.length },
    ], new Map(Object.entries(a.tokenMap)));

    assert.notDeepStrictEqual(Object.keys(a.tokenMap), Object.keys(b.tokenMap));
});

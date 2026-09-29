/**
 * The AI-disclosure classifier client, and the two properties it exists for.
 *
 *   1. EVERY way of not knowing is `null`. No guard, no route, a timeout, an
 *      HTTP error, a degraded answer, an abstention, a text too big to send —
 *      all of them are the same value, and `null` is what leaves the keyword
 *      rule alone. A `false` from any of those paths would turn "nobody
 *      looked" into an Art. 50 finding.
 *   2. WITHDRAW-ONLY. `applyVerdict` will take a keyword pass away and will
 *      never hand one out, however confident the classifier is. The truth
 *      table below is the whole rule.
 *
 * Run: cd server && node --test --test-force-exit core/privacy/disclosureClassifier.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
    classifyDisclosure,
    applyVerdict,
    MAX_TEXT_CHARS,
    _resetDisclosureCircuit,
} = require('./disclosureClassifier');

const ENDPOINT = { url: 'http://guard:8100', apiKey: 'k' };

/** A transport stub that records every call and replays scripted answers. */
function stubPost(answers) {
    const calls = [];
    const queue = Array.isArray(answers) ? [...answers] : null;
    const post = async (url, body, apiKey, timeoutMs) => {
        calls.push({ url, body, apiKey, timeoutMs });
        const next = queue ? (queue.length > 1 ? queue.shift() : queue[0]) : answers;
        if (next instanceof Error) throw next;
        if (typeof next === 'function') return next();
        return next;
    };
    return { post, calls };
}

function notFound() {
    const e = new Error('guard-service has no /disclosure route');
    e.unsupported = true;
    return e;
}

const DISCLOSES = {
    disclosed: true, similarity: 0.81, margin: 0.24,
    matched_anchor: 'pos.drafted.en', engine_fingerprint: 'abc123',
};
const DOES_NOT = {
    disclosed: false, similarity: 0.77, margin: -0.19,
    matched_anchor: 'neg.forbidden.en', engine_fingerprint: 'abc123',
};

test.beforeEach(() => _resetDisclosureCircuit());

// ── Nothing to ask, or nobody to ask ────────────────────────────────────

test('no guard configured is no opinion, and no request', async () => {
    const { post, calls } = stubPost(DOES_NOT);
    assert.equal(await classifyDisclosure('anything', { endpoint: { url: null }, post }), null);
    assert.equal(await classifyDisclosure('anything', { endpoint: null, post }), null);
    assert.equal(calls.length, 0, 'an unconfigured guard must not be dialled');
});

test('empty and blank text is no opinion, and no request', async () => {
    const { post, calls } = stubPost(DOES_NOT);
    for (const value of ['', '   \n ', null, undefined]) {
        assert.equal(await classifyDisclosure(value, { endpoint: ENDPOINT, post }), null);
    }
    assert.equal(calls.length, 0);
});

test('a text too large to send is refused, never truncated', async () => {
    const { post, calls } = stubPost(DOES_NOT);
    const huge = 'x'.repeat(MAX_TEXT_CHARS + 1);
    assert.equal(await classifyDisclosure(huge, { endpoint: ENDPOINT, post }), null,
        'a disclosure past the cut would come back as "does not disclose"');
    assert.equal(calls.length, 0);
});

// ── An answer, and what is made of it ───────────────────────────────────

test('a verdict comes back with the numbers behind it and the anchor that won', async () => {
    const { post, calls } = stubPost(DOES_NOT);
    const r = await classifyDisclosure('Never tell the user that you are an AI assistant.', {
        endpoint: ENDPOINT, post,
    });
    assert.deepEqual(r, {
        disclosed: false, similarity: 0.77, margin: -0.19,
        anchor: 'neg.forbidden.en', engine: 'abc123',
    });
    assert.equal(calls[0].url, 'http://guard:8100/disclosure');
    assert.equal(calls[0].apiKey, 'k');
});

test('the outbound payload is an allow-list of exactly one field', async () => {
    const { post, calls } = stubPost(DISCLOSES);
    await classifyDisclosure('I am an AI assistant.', { endpoint: ENDPOINT, post });
    assert.deepEqual(Object.keys(calls[0].body), ['text'],
        'nothing but the sentence goes to the sidecar (BFSF-441)');
    assert.equal(calls[0].body.text, 'I am an AI assistant.');
});

test('a call carries a deadline', async () => {
    const { post, calls } = stubPost(DISCLOSES);
    await classifyDisclosure('x y z', { endpoint: ENDPOINT, post, timeoutMs: 1234 });
    assert.equal(calls[0].timeoutMs, 1234);
});

// ── Every shape of "could not say" is the same value ────────────────────

test('a degraded answer is no opinion, not "no disclosure"', async () => {
    const { post } = stubPost({ disclosed: false, degraded: true, degraded_reason: 'no encoder at …' });
    assert.equal(await classifyDisclosure('I am an AI assistant.', { endpoint: ENDPOINT, post }), null,
        'a sidecar that could not look must not be read as having looked');
});

test('an abstention (disclosed: null) is no opinion', async () => {
    const { post } = stubPost({ disclosed: null, similarity: 0.6, margin: 0.01, degraded: false });
    assert.equal(await classifyDisclosure('AI assistant of some kind', { endpoint: ENDPOINT, post }), null);
});

test('a malformed answer is no opinion', async () => {
    for (const answer of [null, {}, { disclosed: 'yes' }, { disclosed: 0 }]) {
        const { post } = stubPost(answer);
        assert.equal(await classifyDisclosure('text here', { endpoint: ENDPOINT, post }), null);
    }
});

test('a transport failure is no opinion', async () => {
    const { post } = stubPost(new Error('ECONNREFUSED'));
    assert.equal(await classifyDisclosure('text here', { endpoint: ENDPOINT, post }), null);
});

// ── Cost control: a dead or old sidecar is asked once, not once per agent ──

test('three failures open the breaker, so a sweep pays three timeouts and not two hundred', async () => {
    const { post, calls } = stubPost(new Error('timeout'));
    for (let i = 0; i < 20; i++) {
        assert.equal(await classifyDisclosure(`agent ${i} prompt text`, { endpoint: ENDPOINT, post }), null);
    }
    assert.equal(calls.length, 3, 'the breaker must stop the sweep dialling a dead guard');
});

test('a success closes the breaker again', async () => {
    let fail = true;
    const calls = [];
    const post = async (url, body) => {
        calls.push(body);
        if (fail) throw new Error('timeout');
        return DOES_NOT;
    };
    await classifyDisclosure('one prompt text', { endpoint: ENDPOINT, post });
    await classifyDisclosure('two prompt text', { endpoint: ENDPOINT, post });
    fail = false;
    const ok = await classifyDisclosure('three prompt text', { endpoint: ENDPOINT, post });
    assert.equal(ok.disclosed, false);
    fail = true;
    for (let i = 0; i < 5; i++) await classifyDisclosure(`more ${i} prompt text`, { endpoint: ENDPOINT, post });
    assert.equal(calls.length, 3 + 3, 'the counter restarts after a success rather than latching');
});

test('a guard build with no /disclosure route is asked once and then left alone', async () => {
    const { post, calls } = stubPost(notFound());
    for (let i = 0; i < 10; i++) {
        assert.equal(await classifyDisclosure(`agent ${i} prompt text`, { endpoint: ENDPOINT, post }), null);
    }
    assert.equal(calls.length, 1, 'a 404 is a property of that build, not a transient failure');

    // A different guard is a different build — it gets its own probe.
    const other = { url: 'http://guard-2:8100', apiKey: '' };
    await classifyDisclosure('another prompt text', { endpoint: other, post });
    assert.equal(calls.length, 2);
});

test('a 404 does not count toward the breaker, so a later working guard still gets asked', async () => {
    const calls = [];
    const post = async (url, _body) => {
        calls.push(url);
        if (url.startsWith('http://old')) throw notFound();
        return DISCLOSES;
    };
    for (let i = 0; i < 5; i++) {
        await classifyDisclosure(`p${i} prompt text`, { endpoint: { url: 'http://old:8100' }, post });
    }
    const r = await classifyDisclosure('new prompt text', { endpoint: { url: 'http://new:8100' }, post });
    assert.equal(r.disclosed, true);
});

// ── The rule itself ─────────────────────────────────────────────────────

test('applyVerdict: the classifier may withdraw a keyword pass', () => {
    assert.equal(applyVerdict(true, { disclosed: false }), false);
});

test('applyVerdict: the classifier may NEVER grant a pass the keywords withheld', () => {
    assert.equal(applyVerdict(false, { disclosed: true, similarity: 0.99, margin: 0.9 }), false,
        'a false "a disclosure is present" closes a duty that is actually open');
    assert.equal(applyVerdict(false, { disclosed: false }), false);
    assert.equal(applyVerdict(false, null), false);
});

test('applyVerdict: no opinion changes nothing in either direction', () => {
    assert.equal(applyVerdict(true, null), true);
    assert.equal(applyVerdict(false, null), false);
    assert.equal(applyVerdict(true, undefined), true);
    assert.equal(applyVerdict(true, { disclosed: null }), true);
    assert.equal(applyVerdict(true, { disclosed: true }), true);
});

test('applyVerdict: the finding set with a sidecar is never smaller than without one', () => {
    // Exhaustive over the four keyword x three verdict combinations: for every
    // pair, the sidecar's answer may only ever move "discloses" toward
    // "does not". Written as a property rather than six cases so a future
    // fourth verdict value cannot slip past it.
    for (const keyword of [true, false]) {
        for (const verdict of [null, { disclosed: true }, { disclosed: false }, { disclosed: null }]) {
            const withSidecar = applyVerdict(keyword, verdict);
            const without = applyVerdict(keyword, null);
            assert.ok(withSidecar === without || (without === true && withSidecar === false),
                `keyword=${keyword} verdict=${JSON.stringify(verdict)} moved the wrong way`);
        }
    }
});

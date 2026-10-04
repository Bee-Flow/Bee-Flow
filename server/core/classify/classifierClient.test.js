/**
 * The wire to classify-service: what is sent, batching, retries, the breaker,
 * the score cache, and the rule that every failure throws with an errorClass.
 * Transport and endpoint are injected, so nothing here opens a socket.
 *
 * Run: node --test core/classify/classifierClient.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { classify, probe, TopicClassifierError, BATCH_SIZE, _resetClassifierState } = require('./classifierClient');

const endpoint = { url: 'http://classify:8300', apiKey: 'k' };

/** A fake service: scores each label by whether the text contains it. */
function service({ status = 200, engine = 'gliclass@abc', delayFirst = null } = {}) {
    const calls = [];
    let n = 0;
    const request = async (url, opts) => {
        calls.push({ url, ...opts });
        n += 1;
        if (delayFirst && n <= delayFirst.times) return { status: delayFirst.status, json: delayFirst.json };
        if (status !== 200) return { status, json: { detail: 'nope' } };
        const { texts, labels } = opts.body;
        return {
            status: 200,
            json: {
                results: texts.map((t) => ({ scores: Object.fromEntries(labels.map((l) => [l, t.includes(l) ? 0.9 : 0.1])), truncated: t.length > 20 })),
                labels, model: 'knowledgator/gliclass-multilang-mini', revision: 'abc', engine, default_threshold: 0.45, ms: 5,
            },
        };
    };
    return { request, calls };
}

test.beforeEach(() => _resetClassifierState());

test('sends only texts and labels, and aligns the scores with the texts', async () => {
    const { request, calls } = service();
    const res = await classify(['a bill', 'a moan about a bill here'], ['bill', 'moan'], { endpoint, request });
    assert.deepEqual(Object.keys(calls[0].body).sort(), ['labels', 'texts']);
    assert.equal(calls[0].url, 'http://classify:8300/classify');
    assert.equal(calls[0].apiKey, 'k');
    assert.deepEqual(res.scores, [{ bill: 0.9, moan: 0.1 }, { bill: 0.9, moan: 0.9 }]);
    assert.equal(res.defaultThreshold, 0.45);
    assert.equal(res.truncated, 1);
    assert.equal(res.model, 'knowledgator/gliclass-multilang-mini');
});

test('splits large inputs into batches', async () => {
    const { request, calls } = service();
    const texts = Array.from({ length: BATCH_SIZE * 2 + 3 }, (_, i) => `text ${i}`);
    const res = await classify(texts, ['text'], { endpoint, request });
    assert.equal(calls.length, 3);
    assert.equal(res.scores.length, texts.length);
    assert.ok(calls.every((c) => c.body.texts.length <= BATCH_SIZE));
});

test('answers repeat texts from the cache once the engine is known', async () => {
    const { request, calls } = service();
    await classify(['one', 'two'], ['one'], { endpoint, request });
    const res = await classify(['two', 'three'], ['one'], { endpoint, request });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body.texts, ['three']);
    assert.deepEqual(res.scores, [{ one: 0.1 }, { one: 0.1 }]);
});

test('the cache is per topic list: other topics are asked again', async () => {
    const { request, calls } = service();
    await classify(['one'], ['one'], { endpoint, request });
    await classify(['one'], ['one', 'two'], { endpoint, request });
    assert.equal(calls.length, 2);
});

test('no endpoint configured throws topic_classifier_not_configured', async () => {
    await assert.rejects(
        classify(['x'], ['y'], { endpoint: { url: null, apiKey: '' }, request: service().request }),
        (e) => e instanceof TopicClassifierError && e.errorClass === 'topic_classifier_not_configured' && e.topicFatal === true,
    );
});

test('an error status throws topic_classifier_unavailable', async () => {
    const { request } = service({ status: 500 });
    await assert.rejects(classify(['x'], ['y'], { endpoint, request }), (e) => e.errorClass === 'topic_classifier_unavailable' && e.detail === 'status 500');
});

test('a response missing a topic score is rejected, not half-used', async () => {
    const request = async () => ({ status: 200, json: { results: [{ scores: { y: 0.5 } }] } });
    await assert.rejects(classify(['x'], ['y', 'z'], { endpoint, request }), (e) => e.detail === 'bad response');
});

test('busy and loading answers are retried', async () => {
    const { request, calls } = service({ delayFirst: { times: 2, status: 429, json: { detail: 'busy' } } });
    const res = await classify(['x'], ['x'], { endpoint, request });
    assert.equal(calls.length, 3);
    assert.deepEqual(res.scores, [{ x: 0.9 }]);
});

test('a network error throws, and three in a row open the breaker', async () => {
    const request = async () => { throw new TypeError('fetch failed'); };
    for (let i = 0; i < 3; i++) {
        await assert.rejects(classify([`x${i}`], ['y'], { endpoint, request }), (e) => e.detail === 'network');
    }
    let asked = false;
    await assert.rejects(
        classify(['z'], ['y'], { endpoint, request: async () => { asked = true; return {}; } }),
        (e) => e.detail === 'breaker open',
    );
    assert.equal(asked, false);
});

test('a cancelled run surfaces the cancel, not a classifier failure', async () => {
    const controller = new AbortController();
    const request = async (_url, { signal }) => {
        controller.abort(new Error('Run cancelled'));
        signal.throwIfAborted();
        return {};
    };
    await assert.rejects(classify(['x'], ['y'], { endpoint, request, signal: controller.signal }), /Run cancelled/);
});

test('empty input needs no service at all', async () => {
    const res = await classify([], ['y'], { endpoint: { url: null, apiKey: '' } });
    assert.deepEqual(res.scores, []);
});

test('probe: available, with the service default threshold', async () => {
    const request = async (url, opts) => {
        assert.equal(url, 'http://classify:8300/health');
        assert.equal(opts.method, 'GET');
        return { status: 200, json: { status: 'ok', default_threshold: 0.45, max_labels: 16, model: 'm' } };
    };
    assert.deepEqual(await probe({ endpoint, request, fresh: true }), { available: true, reason: null, defaultThreshold: 0.45, maxLabels: 16, model: 'm' });
});

test('probe: the reasons a builder shows', async () => {
    assert.equal((await probe({ endpoint: { url: null, apiKey: '' }, fresh: true })).reason, 'not_configured');
    assert.equal((await probe({ endpoint, request: async () => { throw new Error('x'); }, fresh: true })).reason, 'unreachable');
    assert.equal((await probe({ endpoint, request: async () => ({ status: 503, json: { status: 'loading' } }), fresh: true })).reason, 'loading');
    assert.equal((await probe({ endpoint, request: async () => ({ status: 503, json: { load_error: 'boom' } }), fresh: true })).reason, 'error');
});

test('probe answers from its cache until told to look again', async () => {
    let n = 0;
    const request = async () => { n += 1; return { status: 200, json: {} }; };
    await probe({ endpoint, request, fresh: true });
    await probe({ endpoint, request });
    assert.equal(n, 1);
});

test('topicClassifierFor: no probe for an automation without isAbout', async () => {
    const { topicClassifierFor } = require('./classifierClient');
    let probed = false;
    const probeFn = async () => { probed = true; return { available: true, reason: null }; };
    assert.equal(await topicClassifierFor({ steps: [{ type: 'condition', expr: 'x > 1' }] }, { probeFn }), null);
    assert.equal(probed, false);
});

test('topicClassifierFor: true, false, or unknown', async () => {
    const { topicClassifierFor } = require('./classifierClient');
    const def = { steps: [{ type: 'filter', expr: 'isAbout(item.body, "spam")' }] };
    assert.equal(await topicClassifierFor(def, { probeFn: async () => ({ available: true, reason: null }) }), true);
    assert.equal(await topicClassifierFor(def, { probeFn: async () => ({ available: false, reason: 'not_configured' }) }), false);
    assert.equal(await topicClassifierFor(def, { probeFn: async () => ({ available: false, reason: 'unreachable' }) }), null);
    assert.equal(await topicClassifierFor(def, { probeFn: async () => ({ available: false, reason: 'loading' }) }), null);
});

/**
 * The KB source API, the web-page kind: a `webpage` source is the webpages module's kind
 * (core/kb/sources/moduleKinds.js), so creating one is that module's behaviour. Over the
 * harness of sources.test.js (sources.testkit.js).
 *
 * Run: cd server && node --test routes/knowledgeBases/sources.webpages.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { fx, resetFx, dispatch } = require('./sources.testkit');

test('POST kind=webpage fetches through the guard and stores the crawl for K3', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'webpage', config: { url: 'https://example.com/docs', crawl: { maxPages: 9999 } } },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.source.kind, 'webpage');
    assert.strictEqual(res.body.source.config.url, 'https://example.com/docs');
    assert.deepStrictEqual(res.body.source.config.crawl, { maxPages: 500 }, 'maxPages is clamped');
    assert.strictEqual(res.body.crawlPending, true);

    const ingest = fx.ingested.at(-1);
    assert.strictEqual(ingest.sourceType, 'web');
    assert.strictEqual(ingest.opts.externalId, 'https://example.com/docs');
});

test('POST kind=webpage refuses a URL the guard rejects, and creates nothing', async () => {
    resetFx();
    fx.blockedHosts.add('127.0.0.1');
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'webpage', config: { url: 'http://127.0.0.1:3101/admin' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'url_rejected');
    assert.strictEqual(fx.sources.length, 0, 'no half-created source is left behind');
    assert.strictEqual(fx.ingested.length, 0, 'and nothing internal was ingested');
});

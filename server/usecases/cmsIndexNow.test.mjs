/**
 * IndexNow after a CMS publish (usecases/cmsIndexNow.mts): off without a key,
 * only the live site, only what changed, capped, and never in the way of the
 * publish itself.
 *
 * Run: cd server && node --test usecases/cmsIndexNow.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert';
import {
    indexNowKey, keyFilePath, maxUrls, sitemapLastmods, changedUrls, submitUrls, publishWithIndexNow,
    INDEXNOW_ENDPOINT, PROTOCOL_MAX_URLS, DEFAULT_MAX_URLS,
} from './cmsIndexNow.mts';

const KEY = 'indexnow-test-key';
const ORIGIN = 'https://site.test';

/** @param {Array<[string, string?]>} entries */
const sitemap = (entries) => `<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n${entries.map(([loc, lastmod]) => `  <url>\n    <loc>${loc}</loc>\n${lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : ''}    <xhtml:link rel="alternate" hreflang="nl" href="${loc}/nl"/>\n  </url>`).join('\n')}\n</urlset>`;

/** @param {{ before: string, after: string, live?: string|null, env?: Record<string, string> }} o */
function harness({ before, after, live = 'pj_live', env = { INDEXNOW_KEY: KEY } }) {
    const calls = { submits: /** @type {any[]} */ ([]), reads: 0 };
    let published = false;
    /** @type {(v?: unknown) => void} */
    let done = () => {};
    const sent = new Promise((resolve) => { done = resolve; });
    const deps = {
        env,
        origin: () => ORIGIN,
        getLiveSiteId: async () => live,
        sitemapXml: async () => { calls.reads++; return published ? after : before; },
        submit: async (/** @type {any} */ args) => { calls.submits.push(args); done(); return 202; },
    };
    const publish = async () => { published = true; return { publishedAt: 'now' }; };
    return { deps, publish, calls, sent };
}

test('the key: unset or malformed is off', () => {
    assert.strictEqual(indexNowKey({}), null);
    assert.strictEqual(indexNowKey({ INDEXNOW_KEY: 'short' }), null);
    assert.strictEqual(indexNowKey({ INDEXNOW_KEY: 'has/slash-0000' }), null);
    assert.strictEqual(indexNowKey({ INDEXNOW_KEY: ` ${KEY} ` }), KEY);
    assert.strictEqual(keyFilePath({ INDEXNOW_KEY: KEY }), `/${KEY}.txt`);
    assert.strictEqual(keyFilePath({}), null);
});

test('the cap: a generous default, 0 means the protocol limit', () => {
    const old = process.env.INDEXNOW_MAX_URLS;
    try {
        delete process.env.INDEXNOW_MAX_URLS;
        assert.strictEqual(maxUrls(), DEFAULT_MAX_URLS);
        process.env.INDEXNOW_MAX_URLS = '0';
        assert.strictEqual(maxUrls(), PROTOCOL_MAX_URLS);
        process.env.INDEXNOW_MAX_URLS = '5';
        assert.strictEqual(maxUrls(), 5);
    } finally {
        if (old === undefined) delete process.env.INDEXNOW_MAX_URLS; else process.env.INDEXNOW_MAX_URLS = old;
    }
});

test('the diff: new addresses and a changed lastmod count, the rest does not', () => {
    const before = sitemap([[`${ORIGIN}/`, '2026-11-01'], [`${ORIGIN}/pricing`, '2026-11-01'], [`${ORIGIN}/gone`, '2026-11-01']]);
    const after = sitemap([[`${ORIGIN}/`, '2026-11-01'], [`${ORIGIN}/pricing`, '2026-11-27'], [`${ORIGIN}/new?a=1&amp;b=2`]]);
    assert.deepStrictEqual([...sitemapLastmods(after).keys()], [`${ORIGIN}/`, `${ORIGIN}/pricing`, `${ORIGIN}/new?a=1&b=2`]);
    assert.deepStrictEqual(changedUrls(before, after, 100), [`${ORIGIN}/pricing`, `${ORIGIN}/new?a=1&b=2`]);
    assert.deepStrictEqual(changedUrls(before, after, 1), [`${ORIGIN}/pricing`]);
    assert.deepStrictEqual(changedUrls('', after, 100).length, 3, 'a first publish announces every address');
});

test('the POST: host, key, key location and the addresses, nothing else', async () => {
    /** @type {any[]} */
    const seen = [];
    const status = await submitUrls({ origin: ORIGIN, key: KEY, urls: [`${ORIGIN}/a`] }, async (url, init) => { seen.push([url, init]); return { status: 200 }; });
    assert.strictEqual(status, 200);
    assert.strictEqual(seen[0][0], INDEXNOW_ENDPOINT);
    assert.strictEqual(seen[0][1].method, 'POST');
    assert.deepStrictEqual(JSON.parse(seen[0][1].body), { host: 'site.test', key: KEY, keyLocation: `${ORIGIN}/${KEY}.txt`, urlList: [`${ORIGIN}/a`] });
});

test('a publish of the live site announces what it changed, after the publish', async () => {
    const h = harness({ before: sitemap([[`${ORIGIN}/`, '2026-11-01']]), after: sitemap([[`${ORIGIN}/`, '2026-11-01'], [`${ORIGIN}/new`, '2026-11-27']]) });
    const result = await publishWithIndexNow('pj_live', h.publish, h.deps);
    assert.deepStrictEqual(result, { publishedAt: 'now' });
    await h.sent;
    assert.deepStrictEqual(h.calls.submits, [{ origin: ORIGIN, key: KEY, urls: [`${ORIGIN}/new`] }]);
});

test('nothing is read or sent without a key, for another site, or without an origin', async () => {
    for (const [siteId, env, origin] of [['pj_live', {}, ORIGIN], ['pj_other', { INDEXNOW_KEY: KEY }, ORIGIN], ['pj_live', { INDEXNOW_KEY: KEY }, '']]) {
        const h = harness({ before: '', after: sitemap([[`${ORIGIN}/new`]]), env });
        h.deps.origin = () => origin;
        await publishWithIndexNow(String(siteId), h.publish, h.deps);
        await new Promise((r) => setImmediate(r));
        assert.strictEqual(h.calls.reads, 0, String(siteId));
        assert.strictEqual(h.calls.submits.length, 0, String(siteId));
    }
});

test('IndexNow never fails or blocks a publish; a failed publish sends nothing', async () => {
    const broken = harness({ before: '', after: '' });
    broken.deps.sitemapXml = async () => { throw new Error('db down'); };
    assert.deepStrictEqual(await publishWithIndexNow('pj_live', broken.publish, broken.deps), { publishedAt: 'now' });

    const failing = harness({ before: '', after: sitemap([[`${ORIGIN}/new`]]) });
    failing.deps.submit = async () => { throw new Error('network'); };
    assert.deepStrictEqual(await publishWithIndexNow('pj_live', failing.publish, failing.deps), { publishedAt: 'now' });

    const refused = harness({ before: '', after: sitemap([[`${ORIGIN}/new`]]) });
    await assert.rejects(publishWithIndexNow('pj_live', async () => { throw new Error('publish failed'); }, refused.deps), /publish failed/);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(refused.calls.submits.length, 0);
});

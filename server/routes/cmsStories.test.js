/**
 * GET /api/cms/stories — the public read behind the Customer stories grid.
 * Anonymous, published content only, query values clamped, never an error
 * page (a refusal would blank a block on a public page).
 *
 * Run: node --test routes/cmsStories.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

const h = require('../testUtils/routeHarness');

const configState = { map: new Map() };
function likeToRegex(pattern) {
    // LIKE with ESCAPE '\': a backslash makes the next character literal; % is any run, _ any one character.
    let src = '';
    const chars = [...String(pattern)];
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (c === '\\' && i + 1 < chars.length) src += chars[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        else if (c === '%') src += '.*';
        else if (c === '_') src += '.';
        else src += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${src}$`);
}
const keysLike = (p) => [...configState.map.keys()].filter((k) => likeToRegex(p).test(k)).map((key) => ({ key }));
const { api } = h.routeUnderTest(test, '/api/cms/stories', () => require('./cmsStories').createPublicRouter(), {
    answer: (sql, params = []) => {
    if (/^\s*SELECT value FROM config WHERE key = \$1/i.test(sql)) {
        return { rows: configState.map.has(params[0]) ? [{ value: configState.map.get(params[0]) }] : [] };
    }
    if (/INSERT INTO config/i.test(sql)) { configState.map.set(params[0], params[1]); return { rows: [], rowCount: 1 }; }
    if (/^\s*DELETE FROM config WHERE key = \$1/i.test(sql)) {
        const had = configState.map.delete(params[0]);
        return { rows: [], rowCount: had ? 1 : 0 };
    }
    // publishSite: the site doc, its pages and its locale overrides in one statement.
    if (/SELECT key, value FROM config WHERE key = \$1 OR key LIKE \$2/i.test(sql)) {
        const patterns = params.slice(1).map(likeToRegex);
        return {
            rows: [...configState.map.keys()]
                .filter((k) => k === params[0] || patterns.some((re) => re.test(k)))
                .map((key) => ({ key, value: configState.map.get(key) })),
        };
    }
    if (/SELECT key FROM config WHERE key = \$1 OR key LIKE \$2/i.test(sql)) {
        return { rows: [...(configState.map.has(params[0]) ? [{ key: params[0] }] : []), ...keysLike(params[1])] };
    }
    if (/SELECT key FROM config WHERE key LIKE \$1/i.test(sql)) return { rows: keysLike(params[0]) };
    return undefined;
    },
});

const get = (qs = '') => api.call('GET', `/api/cms/stories${qs}`);

test('without a live site the answer is an empty list, not an error', async () => {
    const res = await get();
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { stories: [] });
    assert.match(res.headers.get('cache-control') || '', /public/);
});

test('it answers the published stories of the live site and clamps nonsense queries', async () => {
    const cmsStore = require('../stores/cmsStore');
    const { setLiveSiteId } = require('./cmsShared');
    const { id: siteId } = await cmsStore.createProject({ name: 'Live' });
    const created = await cmsStore.createPage(siteId, { title: 'Story one' });
    const page = await cmsStore.getPage(siteId, created.id);
    await cmsStore.setPage(siteId, {
        ...page,
        blocks: [{ id: 'blk_story', type: 'story-header', enabled: true, style: {}, content: { customer: 'Acme Test Co', sector: 'Finance', title: 'Acme story' } }],
    });
    await cmsStore.publishSite(siteId);
    await setLiveSiteId(siteId);

    const res = await get('?limit=banana&locale=%3Cscript%3E&sector=' + 'x'.repeat(500));
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.stories, [], 'an unknown sector filters everything out');

    const ok = await get('?limit=1&sector=finance');
    assert.strictEqual(ok.body.stories.length, 1);
    assert.strictEqual(ok.body.stories[0].customer, 'Acme Test Co');
    assert.strictEqual(ok.body.stories[0].href, '/story-one');
    assert.ok(!('content' in ok.body.stories[0]), 'cards are an allow-list, not the block');
});

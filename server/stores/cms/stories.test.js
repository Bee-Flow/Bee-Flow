/**
 * Customer stories (issue #239): story pages are ordinary CMS pages that carry
 * a story-header block; the grid reads their cards from the PUBLISHED snapshot.
 *
 *   - only published, enabled story headers become cards, in page order;
 *   - a draft story never reaches a visitor, a later edit needs a publish;
 *   - the card is an allow-list (no stray block field), logos are URL-gated;
 *   - sector filter, limit, translations (text only, link prefix only when
 *     the page is translated);
 *   - the grid block is filled for the server-rendered HTML;
 *   - the built-in "Customer story" template seeds a valid story page.
 *
 * Run: node --test stores/cms/stories.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';

// The store runs REAL against an in-memory config table, served through the
// database pool seam of testUtils/routeHarness (same arrangement as
// stores/cmsStore.blog.test.js; no module-system mocking).
const { recordDb } = require('../../testUtils/routeHarness');

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
recordDb((sql, params = []) => {
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
});

const cmsStore = require('../cmsStore');
const { getPublishedStories, fillCustomerStories, sectorSlug, storyCard } = require('./stories');
const { renderBlocks } = require('../../core/seo/renderBlocks');

/** A story-header block with synthetic content. */
const header = (content = {}, extra = {}) => ({
    type: 'story-header',
    content: {
        customer: 'Acme Test Co', sector: 'Public Sector', title: 'How Acme cut review time',
        lead: 'A short summary.', logo: { src: 'cms/acme.png', alt: '' }, quote: 'It just works.', quoteBy: 'Pat Example, CTO',
        metrics: [{ stat: '60%', label: 'less review time' }, { stat: '3 weeks', label: 'to go live' }],
        ...content,
    },
    ...extra,
});

/** Create a page with the given blocks (saved through the real page store). */
async function addPage(siteId, title, blocks) {
    const created = await cmsStore.createPage(siteId, { title });
    const page = await cmsStore.getPage(siteId, created.id);
    await cmsStore.setPage(siteId, { ...page, blocks: blocks.map((b, i) => ({ id: `blk_${created.id}_${i}`, enabled: true, style: {}, ...b })) });
    return created;
}

async function newSite() {
    const { id } = await cmsStore.createProject({ name: 'Stories site' });
    return id;
}

test('only published pages with an enabled story-header become cards, in page order', async () => {
    const siteId = await newSite();
    await addPage(siteId, 'Plain page', [{ type: 'faq' }]);
    await addPage(siteId, 'First story', [header()]);
    await addPage(siteId, 'Disabled header', [header({}, { enabled: false })]);
    await addPage(siteId, 'Second story', [header({ customer: 'Globex Test', sector: 'Finance', title: 'Globex story' })]);
    assert.deepStrictEqual((await getPublishedStories(siteId)).stories, [], 'nothing before the first publish');
    await cmsStore.publishSite(siteId);
    const { stories } = await getPublishedStories(siteId);
    assert.deepStrictEqual(stories.map((s) => s.customer), ['Acme Test Co', 'Globex Test']);
    assert.strictEqual(stories[0].href, '/first-story');
    assert.strictEqual(stories[0].sectorId, 'public-sector');
});

test('a draft story is invisible until published, and an edit needs a publish', async () => {
    const siteId = await newSite();
    const page = await addPage(siteId, 'Draft story', [header()]);
    await cmsStore.publishSite(siteId);
    assert.strictEqual((await getPublishedStories(siteId)).stories.length, 1);
    const doc = await cmsStore.getPage(siteId, page.id);
    await cmsStore.setPage(siteId, { ...doc, blocks: [header({ customer: 'Renamed Co' })] });
    assert.strictEqual((await getPublishedStories(siteId)).stories[0].customer, 'Acme Test Co', 'the draft edit is not public');
    await addPage(siteId, 'Never published', [header({ customer: 'Secret Co' })]);
    assert.ok(!(await getPublishedStories(siteId)).stories.some((s) => s.customer === 'Secret Co'));
});

test('the card is an allow-list; logos must be a CMS asset or https; text is cleaned', () => {
    const card = storyCard(
        { id: 'pg_1', slug: 'acme', title: 'Page title' },
        { type: 'story-header', content: {
            customer: 'Acme', title: '', logo: { src: 'javascript:alert(1)', srcDark: 'https://cdn.example.test/logo.svg', alt: 'x' },
            internalNote: 'must not leak', metrics: [{ stat: '1', label: 'a', secret: 'no' }, { stat: '', label: '' }, 5, ...Array(6).fill({ stat: '2', label: 'b' })],
        } },
        '/acme',
    );
    assert.ok(card);
    assert.strictEqual(card.title, 'Page title', 'falls back to the page title');
    assert.strictEqual(card.logo.src, '');
    assert.strictEqual(card.logo.srcDark, 'https://cdn.example.test/logo.svg');
    assert.deepStrictEqual(Object.keys(card.metrics[0]).sort(), ['label', 'stat']);
    assert.strictEqual(card.metrics.length, 4, 'at most four metrics');
    assert.ok(!JSON.stringify(card).includes('must not leak'));
    assert.strictEqual(storyCard({ id: 'p', slug: 's' }, { type: 'story-header', content: {} }, '/s'), null);
});

test('sector filter, limit and the URL form of a sector', async () => {
    const siteId = await newSite();
    await addPage(siteId, 'Story alpha', [header({ sector: 'Finance & Banking' })]);
    await addPage(siteId, 'Story beta', [header({ sector: 'Public sector' })]);
    await addPage(siteId, 'Story gamma', [header({ sector: 'finance banking' })]);
    await cmsStore.publishSite(siteId);
    assert.strictEqual(sectorSlug('Finance & Banking'), 'finance-banking');
    assert.strictEqual((await getPublishedStories(siteId, { sector: 'Finance-Banking' })).stories.length, 2);
    assert.strictEqual((await getPublishedStories(siteId, { limit: 1 })).stories.length, 1);
    assert.strictEqual((await getPublishedStories(siteId, { sector: 'nope' })).stories.length, 0);
});

test('a translation changes the text, never the structure; the locale prefix needs a translated page', async () => {
    const siteId = await newSite();
    const page = await addPage(siteId, 'Translated', [header()]);
    await addPage(siteId, 'Untranslated', [header({ customer: 'Other Co' })]);
    await cmsStore.publishSite(siteId);
    const before = await getPublishedStories(siteId, { locale: 'nl' });
    assert.strictEqual(before.stories[0].href, '/translated', 'no translation yet: no /nl prefix (it would redirect)');
    await cmsStore.setPageLocaleOverride(siteId, page.id, 'nl', { blocks: { [`blk_${page.id}_0`]: { content: { title: 'Hoe Acme sneller werd', metrics: [{ stat: '60%', label: 'minder reviewtijd' }] } } } });
    await cmsStore.publishSite(siteId);
    const nl = await getPublishedStories(siteId, { locale: 'nl' });
    const [translated, other] = nl.stories;
    assert.strictEqual(translated.title, 'Hoe Acme sneller werd');
    assert.strictEqual(translated.metrics[0].label, 'minder reviewtijd');
    assert.strictEqual(translated.metrics[1].stat, '3 weeks', 'untranslated entries keep the source');
    assert.strictEqual(translated.href, '/nl/translated');
    assert.strictEqual(other.href, '/untranslated');
});

test('fillCustomerStories feeds the server-rendered HTML: cards, sectors and real links, escaped', async () => {
    const siteId = await newSite();
    await addPage(siteId, 'Story one', [header({ customer: 'Acme <b>Co</b>' })]);
    await cmsStore.publishSite(siteId);
    const page = { blocks: [
        { type: 'customer-stories', enabled: true, content: { title: 'Our customers', limit: 6, sectorId: '' } },
        { type: 'customer-stories', enabled: false, content: { title: 'Hidden grid' } },
    ] };
    await fillCustomerStories(siteId, page, 'en');
    assert.strictEqual(page.blocks[0].content.items.length, 1);
    assert.ok(!page.blocks[1].content.items, 'a disabled grid is left alone');
    const html = renderBlocks(page.blocks);
    assert.match(html, /Our customers/);
    assert.match(html, /Acme &lt;b&gt;Co&lt;\/b&gt;/);
    assert.match(html, /How Acme cut review time/);
    assert.match(html, /<p>Public Sector<\/p>/);
    assert.match(html, /<p>60%<\/p>\n<p>less review time<\/p>/);
    assert.match(html, /<a href="\/story-one">How Acme cut review time<\/a>/);
    assert.ok(!html.includes('<b>Co</b>'));
});

test('the story header renders its text for crawlers (customer, sector, metrics, quote)', () => {
    const html = renderBlocks([{ type: 'story-header', content: header().content }]);
    for (const needle of ['How Acme cut review time', 'Acme Test Co', 'Public Sector', '60%', 'less review time', 'It just works.', 'Pat Example, CTO']) {
        assert.ok(html.includes(needle), needle);
    }
    assert.match(html, /<h1>How Acme cut review time<\/h1>/);
});

test('the built-in template is listed first, applies with fresh ids and is not stored or deletable', async () => {
    const siteId = await newSite();
    const templates = await cmsStore.getTemplates();
    const story = templates.find((t) => t.id === 'tpl_builtin_customer_story');
    assert.ok(story && story.builtin);
    assert.strictEqual(templates[0].id, story.id);
    const created = await cmsStore.createPage(siteId, { title: 'Acme story', templateId: story.id });
    const doc = await cmsStore.getPage(siteId, created.id);
    assert.deepStrictEqual(doc.blocks.map((b) => b.type), ['story-header', 'media-text', 'media-text', 'cta-banner']);
    assert.ok(doc.blocks.every((b) => /^blk_/.test(b.id)));
    await cmsStore.saveTemplate({ name: 'Mine', blocks: [] });
    await cmsStore.deleteTemplate(story.id);
    const after = await cmsStore.getTemplates();
    assert.deepStrictEqual(after.map((t) => t.name), ['Customer story', 'Mine']);
    assert.ok(![...configState.map.values()].some((v) => JSON.stringify(v).includes('tpl_builtin_customer_story')), 'the built-in is never written to the config table');
    await cmsStore.publishSite(siteId);
    assert.strictEqual((await getPublishedStories(siteId)).stories.length, 1, 'a page from the template is a story');
});

test('the sector key stays the default-language one when only the label is translated', async () => {
    const siteId = await newSite();
    const page = await addPage(siteId, 'Bank story', [header({ sector: 'Finance' })]);
    await cmsStore.setPageLocaleOverride(siteId, page.id, 'nl', { blocks: { [`blk_${page.id}_0`]: { content: { sector: 'Financiële sector' } } } });
    await cmsStore.publishSite(siteId);
    const nl = await getPublishedStories(siteId, { locale: 'nl' });
    assert.strictEqual(nl.stories[0].sector, 'Financiële sector', 'the visible label is Dutch');
    assert.strictEqual(nl.stories[0].sectorId, 'finance', 'the key is not');
    assert.strictEqual((await getPublishedStories(siteId, { locale: 'nl', sector: 'finance' })).stories.length, 1, '?sector= works in Dutch');
    assert.strictEqual((await getPublishedStories(siteId, { locale: 'nl', sector: 'financiele-sector' })).stories.length, 0);

    const grid = { blocks: [{ type: 'customer-stories', enabled: true, content: { sectorId: 'finance' } }] };
    await fillCustomerStories(siteId, grid, 'nl');
    assert.strictEqual(grid.blocks[0].content.items.length, 1, 'a grid pinned to a sector still finds the Dutch story');
});

test('an empty override shell is not a translation: no /nl link', async () => {
    const siteId = await newSite();
    const page = await addPage(siteId, 'Shell story', [header()]);
    await cmsStore.setPageLocaleOverride(siteId, page.id, 'nl', { blocks: {} });
    await cmsStore.publishSite(siteId);
    assert.strictEqual((await getPublishedStories(siteId, { locale: 'nl' })).stories[0].href, '/shell-story');
});

test('a noindex story gets no card', async () => {
    const siteId = await newSite();
    const page = await addPage(siteId, 'Hidden story', [header()]);
    await addPage(siteId, 'Open story', [header({ customer: 'Open Co' })]);
    const doc = await cmsStore.getPage(siteId, page.id);
    await cmsStore.setPage(siteId, { ...doc, seo: { ...(doc.seo || {}), noIndex: true } });
    await cmsStore.publishSite(siteId);
    assert.deepStrictEqual((await getPublishedStories(siteId)).stories.map((s) => s.customer), ['Open Co']);
});

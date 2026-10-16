/**
 * CMS writes must not lose a concurrent edit, and must say so when they would.
 *
 * - A PageDoc and a SiteDoc carry a revision (`rev`); a save based on an older
 *   one is refused with 409 instead of replacing the newer one.
 * - Tool-style read-modify-write of a page (mutatePage) and of the site
 *   (mutateProject / updateSiteChrome) apply the change to the CURRENT stored
 *   document, so two parallel edits both land.
 * - Chrome writes never carry the page list: a page created meanwhile stays.
 * - The projects-index touch after a site write cannot drop a site created at
 *   the same moment.
 *
 * The real config store runs over an in-memory config table (the database pool
 * seam of testUtils/routeHarness, no module mocking). "Another replica" writes
 * straight to the table, which this replica's 60s cache never hears about.
 *
 * Run: node --test stores/cms/concurrency.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.CONFIG_INVALIDATION_LISTENER = '0';

const { recordDb } = require('../../testUtils/routeHarness');

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
const table = new Map();
const likeToRegex = (pattern) => {
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
};

recordDb((sql, params = []) => {
    if (/^\s*SELECT value FROM config WHERE key = \$1/i.test(sql)) {
        return { rows: table.has(params[0]) ? [{ value: JSON.stringify(table.get(params[0])) }] : [] };
    }
    if (/INSERT INTO config/i.test(sql)) { table.set(params[0], JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
    if (/^\s*DELETE FROM config WHERE key = \$1/i.test(sql)) {
        return { rows: [], rowCount: table.delete(params[0]) ? 1 : 0 };
    }
    if (/SELECT key FROM config WHERE key LIKE \$1/i.test(sql)) {
        const re = likeToRegex(params[0]);
        return { rows: [...table.keys()].filter((k) => re.test(k)).map((key) => ({ key })) };
    }
    return undefined;
});

const configStore = require('../configStore');
const projects = require('./projects');
const pages = require('./pages');
const { removePage } = require('./pageRemoval');
const { projectKey, pageKey, KEY_PROJECTS_INDEX } = require('./shared');

test.beforeEach(() => { table.clear(); });

const block = (id, text) => ({ id, type: 'faq', enabled: true, content: { text }, style: {} });

async function siteWithPage() {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const pageId = table.get(projectKey(siteId)).pages[0].id;
    await pages.setPage(siteId, { id: pageId, slug: 'home', title: 'Home', blocks: [block('blk_a', 'one'), block('blk_b', 'two')] });
    return { siteId, pageId };
}

test('setPage: a save based on an older revision is a 409 and changes nothing', async () => {
    const { siteId, pageId } = await siteWithPage();
    const opened = await pages.getPage(siteId, pageId, { fresh: true });
    const { page: first } = await pages.setPage(siteId, { ...opened, title: 'First' }, { expectedRev: opened.rev });
    assert.strictEqual(first.rev, opened.rev + 1);

    await assert.rejects(
        pages.setPage(siteId, { ...opened, title: 'Stale' }, { expectedRev: opened.rev }),
        (e) => e.status === 409 && e.code === 'cms_conflict' && /changed elsewhere/.test(e.message),
    );
    assert.strictEqual(table.get(pageKey(siteId, pageId)).title, 'First');
});

test('mutatePage: an edit saved elsewhere meanwhile is kept, and ours is applied on top of it', async () => {
    const { siteId, pageId } = await siteWithPage();
    let runs = 0;
    const { page } = await pages.mutatePage(siteId, pageId, (doc) => {
        runs += 1;
        if (runs === 1) {
            // Another replica saves a block edit after we read, before we write.
            const other = clone(table.get(pageKey(siteId, pageId)));
            other.blocks[0].content.text = 'edited elsewhere';
            other.rev += 1;
            table.set(pageKey(siteId, pageId), other);
        }
        doc.blocks[1].content.text = 'edited here';
        return doc;
    });
    assert.strictEqual(runs, 2, 'applied again to the newer version');
    assert.deepStrictEqual(page.blocks.map((b) => b.content.text), ['edited elsewhere', 'edited here']);
    assert.deepStrictEqual(table.get(pageKey(siteId, pageId)).blocks.map((b) => b.content.text), ['edited elsewhere', 'edited here']);
});

test('updateSiteChrome: a stale editor copy cannot bring back the old page list', async () => {
    const { siteId } = await siteWithPage();
    const staleCopy = clone(await projects.getProject(siteId, { fresh: true }));
    const { id: newId } = await projects.createPage(siteId, { slug: 'contact', title: 'Contact' });

    const saved = await projects.updateSiteChrome(siteId, { ...staleCopy, name: 'Renamed', homepageId: null }, { expectedRev: staleCopy.rev });

    assert.strictEqual(saved.name, 'Renamed');
    assert.deepStrictEqual(table.get(projectKey(siteId)).pages.map((p) => p.slug), ['home', 'contact']);
    assert.ok(table.get(projectKey(siteId)).pages.some((p) => p.id === newId));
    assert.ok(table.get(projectKey(siteId)).homepageId, 'the homepage stays');
});

test('updateSiteChrome: chrome saved elsewhere since the editor opened is a 409', async () => {
    const { siteId } = await siteWithPage();
    const opened = await projects.getProject(siteId, { fresh: true });
    await projects.updateSiteChrome(siteId, { name: 'Other admin' }, { expectedRev: opened.rev });

    await assert.rejects(
        projects.updateSiteChrome(siteId, { name: 'Mine' }, { expectedRev: opened.rev }),
        (e) => e.status === 409 && e.code === 'cms_conflict',
    );
    assert.strictEqual(table.get(projectKey(siteId)).name, 'Other admin');
});

test('creating a page does not make an open chrome editor stale', async () => {
    const { siteId } = await siteWithPage();
    const opened = await projects.getProject(siteId, { fresh: true });
    await projects.createPage(siteId, { slug: 'contact', title: 'Contact' });
    await projects.updateSiteChrome(siteId, { name: 'Renamed' }, { expectedRev: opened.rev });
    assert.strictEqual(table.get(projectKey(siteId)).name, 'Renamed');
});

test('a site write does not drop a site another replica added to the projects index', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Old' });
    await projects.listProjects(); // warm this replica's cached copy of the index
    const index = clone(table.get(KEY_PROJECTS_INDEX));
    index.projects.push({ id: 'pj_0123456789abcdef', name: 'Created elsewhere', versionGroupId: 'pj_0123456789abcdef', versionName: 'v1' });
    table.set(KEY_PROJECTS_INDEX, index);

    await projects.renameProject(siteId, 'New');

    const ids = table.get(KEY_PROJECTS_INDEX).projects.map((p) => p.id);
    assert.ok(ids.includes('pj_0123456789abcdef'), 'the site created elsewhere is still listed');
    assert.strictEqual(table.get(KEY_PROJECTS_INDEX).projects.find((p) => p.id === siteId).name, 'New');
});

test('the config store seam is the real one (guards the harness)', () => {
    assert.strictEqual(typeof configStore.mutateConfig, 'function');
});

test('a versioned write never recreates a page that was deleted meanwhile', async () => {
    const { siteId, pageId } = await siteWithPage();
    await assert.rejects(
        pages.mutatePage(siteId, pageId, (doc) => {
            table.delete(pageKey(siteId, pageId)); // removePage lands between our read and our write
            return doc;
        }),
        (e) => e.status === 404 && e.code === 'cms_gone',
    );
    assert.ok(!table.has(pageKey(siteId, pageId)), 'no orphan row was written');

    await assert.rejects(
        pages.setPage(siteId, { id: pageId, slug: 'home', title: 'x', blocks: [] }, { expectedRev: 1 }),
        (e) => e.status === 404,
    );
    assert.ok(!table.has(pageKey(siteId, pageId)));
});

test('a stale-revision PUT against a block reorder changes neither the page nor its translations', async () => {
    const { siteId, pageId } = await siteWithPage();
    const items = [{ q: 'first' }, { q: 'second' }];
    const faq = { id: 'blk_list', type: 'faq', enabled: true, content: { items }, style: {} };
    await pages.setPage(siteId, { id: pageId, slug: 'home', title: 'Home', blocks: [faq] });
    const nlKey = `${pageKey(siteId, pageId)}_locale_nl`;
    table.set(nlKey, { version: 1, blocks: { blk_list: { content: { items: [{ q: 'eerste' }, { q: 'tweede' }] } } } });
    const opened = await pages.getPage(siteId, pageId, { fresh: true });

    // Somebody reorders the list: the translations follow their items, inside the same write.
    const reordered = { ...opened, blocks: [{ ...faq, content: { items: [items[1], items[0]] } }] };
    await pages.setPage(siteId, reordered, { expectedRev: opened.rev });
    const pageAfterReorder = clone(table.get(pageKey(siteId, pageId)));
    const overrideAfterReorder = clone(table.get(nlKey));
    assert.deepStrictEqual(overrideAfterReorder.blocks.blk_list.content.items, [{ q: 'tweede' }, { q: 'eerste' }]);

    // The editor opened before the reorder now saves its own copy.
    await assert.rejects(
        pages.setPage(siteId, { ...opened, title: 'Edited in the old tab' }, { expectedRev: opened.rev }),
        (e) => e.status === 409 && e.code === 'cms_conflict',
    );

    assert.deepStrictEqual(table.get(pageKey(siteId, pageId)), pageAfterReorder);
    assert.deepStrictEqual(table.get(nlKey), overrideAfterReorder);
});

test('renaming a site and deleting a page that the chrome links to move the chrome revision', async () => {
    const { siteId } = await siteWithPage();
    const { id: otherId } = await projects.createPage(siteId, { slug: 'contact', title: 'Contact' });
    const opened = await projects.getProject(siteId, { fresh: true });

    await projects.renameProject(siteId, 'Renamed');
    assert.strictEqual(table.get(projectKey(siteId)).rev, opened.rev + 1);

    await projects.updateSiteChrome(siteId, { header: { ...opened.header, nav: [{ id: 'nav_1', label: 'Contact', link: { kind: 'page', pageId: otherId } }] } });
    const before = table.get(projectKey(siteId)).rev;
    await removePage(siteId, otherId);
    assert.strictEqual(table.get(projectKey(siteId)).rev, before + 1, 'links were stripped from the chrome');
    assert.deepStrictEqual(table.get(projectKey(siteId)).header.nav, []);

    const { id: plainId } = await projects.createPage(siteId, { slug: 'plain', title: 'Plain' });
    const unchanged = table.get(projectKey(siteId)).rev;
    await removePage(siteId, plainId);
    assert.strictEqual(table.get(projectKey(siteId)).rev, unchanged, 'a delete that leaves the chrome alone does not move it');
});

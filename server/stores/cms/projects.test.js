/**
 * The SiteDoc page-list operations must not lose a concurrent edit.
 *
 * The page index lives inside the SiteDoc blob. Every page create / rename /
 * reorder / delete used to read that blob through the per-replica 60s config
 * cache and write the whole thing back last-write-wins, so an editor on a pod
 * with a stale cache (or two editors racing) silently wiped the other's page.
 * They now go through configStore.mutateConfig (advisory lock + fresh read).
 *
 * The REAL config store runs here, over an in-memory config table served
 * through the database pool seam of core/http/routeHarness (no module-system
 * mocking), so getConfig serves this replica's real 60s cache (the SAME object
 * on every hit) and mutateConfig takes its real advisory lock + fresh read.
 * "Another replica" writes straight to the table, which that cache never hears
 * about. The cms logic itself runs for real.
 *
 * Run: node --test stores/cms/projects.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.CONFIG_INVALIDATION_LISTENER = '0'; // no LISTEN socket in tests

const { recordDb } = require('../../core/http/routeHarness');

function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

// `table` is the database every replica shares (parsed values); this
// replica's cache is configStore's own.
const table = new Map();
/** @type {null | (() => void)} */
let afterFreshRead = null;
// Inside mutateConfig's transaction (between its advisory lock and COMMIT /
// ROLLBACK) a read is the locked one; outside it, a read for a key is
// getConfig's cache miss or getConfigFresh.
let inLockedTxn = false;
let unlockedReads = 0;

recordDb((sql, params = []) => {
    if (/pg_advisory_xact_lock/i.test(sql)) { inLockedTxn = true; return undefined; }
    if (/^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) { inLockedTxn = false; return undefined; }
    if (/^\s*SELECT value FROM config WHERE key = \$1/i.test(sql)) {
        const key = params[0];
        const rows = table.has(key) ? [{ value: JSON.stringify(table.get(key)) }] : [];
        if (!inLockedTxn) {
            unlockedReads += 1;
            // The fresh planning read has its answer; now someone else writes.
            if (afterFreshRead) { const hook = afterFreshRead; afterFreshRead = null; hook(); }
        }
        return { rows };
    }
    if (/INSERT INTO config/i.test(sql)) { table.set(params[0], JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
    if (/^\s*DELETE FROM config WHERE key = \$1/i.test(sql)) {
        const had = table.delete(params[0]);
        return { rows: [], rowCount: had ? 1 : 0 };
    }
    return undefined;
});

const configStore = require('../configStore');
const projects = require('./projects');
const { projectKey, pageKey } = require('./shared');

// Site ids are fresh per test and every write busts the key it wrote, so this
// replica's cache carries nothing stale from one test into the next.
test.beforeEach(() => { table.clear(); afterFreshRead = null; inLockedTxn = false; });

// Another replica appends a page entry: a direct table write this replica's
// cache never hears about (the stale window the cache documents).
function otherReplicaAddsPage(siteId, entry) {
    const key = projectKey(siteId);
    const row = clone(table.get(key));
    row.pages.push({ isHomepage: false, hideHeader: false, hideFooter: false, noAnalytics: false, isNotFound: false, ...entry });
    table.set(key, row);
}

const slugs = (siteId) => table.get(projectKey(siteId)).pages.map(p => p.slug);

test('createPage on a replica with a stale cache keeps the page another replica just added', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    await projects.getProject(siteId); // warm this replica's cache
    otherReplicaAddsPage(siteId, { id: 'pg_aaaaaaaaaaaaaaaa', slug: 'about', title: 'About' });

    await projects.createPage(siteId, { slug: 'contact', title: 'Contact' });

    assert.deepStrictEqual(slugs(siteId), ['home', 'about', 'contact']);
});

test('updatePageMeta, setHomepage, reorderPages and removePage do not resurrect a stale page list', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const { id: newsId } = await projects.createPage(siteId, { slug: 'news', title: 'News' });
    const homeId = table.get(projectKey(siteId)).homepageId;

    await projects.getProject(siteId);
    otherReplicaAddsPage(siteId, { id: 'pg_bbbbbbbbbbbbbbbb', slug: 'pricing', title: 'Pricing' });
    await projects.updatePageMeta(siteId, newsId, { title: 'Latest' });
    assert.deepStrictEqual(slugs(siteId), ['home', 'news', 'pricing']);

    await projects.getProject(siteId);
    otherReplicaAddsPage(siteId, { id: 'pg_cccccccccccccccc', slug: 'jobs', title: 'Jobs' });
    await projects.setHomepage(siteId, newsId);
    assert.deepStrictEqual(slugs(siteId), ['home', 'news', 'pricing', 'jobs']);

    await projects.getProject(siteId);
    otherReplicaAddsPage(siteId, { id: 'pg_dddddddddddddddd', slug: 'team', title: 'Team' });
    await projects.reorderPages(siteId, [newsId, homeId]);
    assert.deepStrictEqual(slugs(siteId), ['news', 'home', 'pricing', 'jobs', 'team']);

    await projects.getProject(siteId);
    otherReplicaAddsPage(siteId, { id: 'pg_eeeeeeeeeeeeeeee', slug: 'faq', title: 'FAQ' });
    await projects.removePage(siteId, homeId);
    assert.deepStrictEqual(slugs(siteId), ['news', 'pricing', 'jobs', 'team', 'faq']);

    const site = table.get(projectKey(siteId));
    assert.strictEqual(site.homepageId, newsId);
    assert.strictEqual(site.pages.find(p => p.id === newsId).title, 'Latest');
});

test('renameProject keeps a page another replica just added', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Old' });
    await projects.getProject(siteId);
    otherReplicaAddsPage(siteId, { id: 'pg_ffffffffffffffff', slug: 'about', title: 'About' });

    const saved = await projects.renameProject(siteId, 'New');

    assert.strictEqual(saved.name, 'New');
    assert.deepStrictEqual(slugs(siteId), ['home', 'about']);
    assert.strictEqual((await projects.listProjects()).find(p => p.id === siteId).name, 'New');
});

test('createPage re-picks the slug under the lock and the PageDoc follows it', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    // Between the planning read and the locked write, someone takes "about".
    afterFreshRead = () => otherReplicaAddsPage(siteId, { id: 'pg_1111111111111111', slug: 'about', title: 'About' });

    const { id, slug } = await projects.createPage(siteId, { slug: 'about', title: 'About us' });

    assert.strictEqual(slug, 'about-2');
    assert.deepStrictEqual(slugs(siteId), ['home', 'about', 'about-2']);
    assert.strictEqual(table.get(pageKey(siteId, id)).slug, 'about-2');
});

test('a rejected page operation writes nothing and keeps the error message', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const before = clone(table.get(projectKey(siteId)));

    await assert.rejects(projects.updatePageMeta(siteId, 'pg_missing', { title: 'x' }), /Page not found/);
    await assert.rejects(projects.setHomepage(siteId, 'pg_missing'), /Page not found/);
    await assert.rejects(projects.reorderPages('pj_0000000000000000', []), /Project not found/);

    assert.deepStrictEqual(table.get(projectKey(siteId)), before);
});

test('getProject never mutates the shared cached object', async () => {
    const siteId = 'pj_abcdef0123456789';
    const key = projectKey(siteId);
    // A v1 site: the lazy migration seeds nav, ctas and versioning fields.
    table.set(key, {
        version: 1, id: siteId, name: 'Legacy',
        pages: [{ id: 'pg_2222222222222222', slug: 'home', title: 'Home', isHomepage: true },
            { id: 'pg_3333333333333333', slug: 'about', title: 'About' }],
        header: { nav: [] },
    });
    const pristine = clone(table.get(key));

    const site = await projects.getProject(siteId);
    assert.strictEqual(site.versionGroupId, siteId);
    assert.ok(Array.isArray(site.header.ctas) && site.header.ctas.length === 2);
    // A caller that edits the result and then fails to save it.
    site.name = 'unsaved edit';
    site.pages.length = 0;

    // What this replica's cache now serves (a hit: no read reaches the table).
    const readsBefore = unlockedReads;
    assert.deepStrictEqual(await configStore.getConfig(key), pristine);
    assert.strictEqual(unlockedReads, readsBefore, 'getConfig answered from the cache');
    assert.strictEqual((await projects.getProject(siteId)).name, 'Legacy');
    assert.strictEqual((await projects.getProject(siteId)).pages.length, 2);
});

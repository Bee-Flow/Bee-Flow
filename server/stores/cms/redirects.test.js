/**
 * The redirect list of a site: stored apart from the SiteDoc, an automatic 301
 * when a page's slug changes, never a loop, carried into the published snapshot
 * and into an export / import.
 *
 * The real config store runs over an in-memory config table (testUtils/routeHarness).
 *
 * Run: node --test stores/cms/redirects.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.CONFIG_INVALIDATION_LISTENER = '0';

const { recordDb } = require('../../testUtils/routeHarness');

const table = new Map();
recordDb((sql, params = []) => {
    if (/pg_advisory_xact_lock|^\s*(COMMIT|ROLLBACK)\b/i.test(sql)) return undefined;
    if (/^\s*SELECT value FROM config WHERE key = \$1/i.test(sql)) {
        const key = params[0];
        return { rows: table.has(key) ? [{ value: JSON.stringify(table.get(key)) }] : [] };
    }
    if (/INSERT INTO config/i.test(sql)) { table.set(params[0], JSON.parse(params[1])); return { rows: [], rowCount: 1 }; }
    if (/^\s*DELETE FROM config WHERE key = \$1/i.test(sql)) return { rows: [], rowCount: table.delete(params[0]) ? 1 : 0 };
    if (/SELECT key, value FROM config WHERE key = \$1 OR key LIKE/i.test(sql)) {
        const unescape = (v) => String(v).replace(/%$/, '').replace(/\\(.)/g, '$1');
        const [base, ...prefixes] = params.map(unescape);
        return { rows: [...table.entries()].filter(([k]) => k === base || prefixes.some((p) => k.startsWith(p))).map(([key, v]) => ({ key, value: JSON.stringify(v) })) };
    }
    if (/FROM config WHERE key LIKE/i.test(sql)) {
        const prefix = String(params[0]).replace(/%$/, '');
        return { rows: [...table.keys()].filter((k) => k.startsWith(prefix.replace(/\\/g, ''))).map((key) => ({ key })) };
    }
    return undefined;
});

const projects = require('./projects');
const redirects = require('./redirects');
const { redirectsKey } = require('./shared');

test.beforeEach(() => { table.clear(); });

const froms = async (siteId) => (await redirects.getRedirects(siteId, { fresh: true })).redirects.map((r) => [r.from, r.to, r.auto]);

test('renaming a page leaves an automatic 301 from the old address', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const { id: pageId } = await projects.createPage(siteId, { slug: 'old-page', title: 'Old' });
    await projects.updatePageMeta(siteId, pageId, { slug: 'new-page' });
    assert.deepStrictEqual(await froms(siteId), [['/old-page', '/new-page', true]]);
});

test('renaming twice keeps one hop: the first old address follows to the latest', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const { id: pageId } = await projects.createPage(siteId, { slug: 'one', title: 'P' });
    await projects.updatePageMeta(siteId, pageId, { slug: 'two' });
    await projects.updatePageMeta(siteId, pageId, { slug: 'three' });
    assert.deepStrictEqual((await froms(siteId)).sort(), [['/one', '/three', true], ['/two', '/three', true]]);
});

test('renaming back drops the redirect that would shadow the page', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const { id: pageId } = await projects.createPage(siteId, { slug: 'one', title: 'P' });
    await projects.updatePageMeta(siteId, pageId, { slug: 'two' });
    await projects.updatePageMeta(siteId, pageId, { slug: 'one' });
    assert.deepStrictEqual(await froms(siteId), [['/two', '/one', true]]);
});

test('the homepage keeps its URL "/" whatever its slug, so renaming it leaves nothing', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const home = (await projects.getProject(siteId)).pages[0];
    await projects.updatePageMeta(siteId, home.id, { slug: 'start' });
    assert.deepStrictEqual(await froms(siteId), []);
});

test('a new page takes over an address a redirect used to own', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    await redirects.setRedirect(siteId, { from: '/pricing', to: '/plans' });
    await projects.createPage(siteId, { slug: 'pricing', title: 'Pricing' });
    assert.deepStrictEqual(await froms(siteId), []);
});

test('a manual redirect is refused when it would loop, and the list is untouched', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    await redirects.setRedirect(siteId, { from: '/aa', to: '/bb' });
    await assert.rejects(() => redirects.setRedirect(siteId, { from: '/bb', to: '/aa' }), { code: 'loop' });
    assert.deepStrictEqual(await froms(siteId), [['/aa', '/bb', false]]);
});

test('external targets need the allow-list; removing a host drops its redirects', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const input = { from: '/partner', to: 'https://partner.example/x', external: true };
    await assert.rejects(() => redirects.setRedirect(siteId, input), { code: 'to_host_not_allowed' });
    await redirects.setAllowedHosts(siteId, ['Partner.Example']);
    await redirects.setRedirect(siteId, input);
    assert.strictEqual((await redirects.getRedirects(siteId, { fresh: true })).redirects.length, 1);
    await redirects.setAllowedHosts(siteId, []);
    assert.strictEqual((await redirects.getRedirects(siteId, { fresh: true })).redirects.length, 0);
});

test('removeRedirect reports whether anything was removed', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    const { entry } = await redirects.setRedirect(siteId, { from: '/aa', to: '/bb' });
    assert.strictEqual(await redirects.removeRedirect(siteId, entry.id), true);
    assert.strictEqual(await redirects.removeRedirect(siteId, entry.id), false);
});

test('editing the SiteDoc never touches the redirect list (own key)', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    await redirects.setRedirect(siteId, { from: '/aa', to: '/bb' });
    const site = await projects.getProject(siteId, { fresh: true });
    await projects.setProject(siteId, { ...site, name: 'Renamed' });
    assert.strictEqual((await redirects.getRedirects(siteId, { fresh: true })).redirects.length, 1);
    assert.ok(table.has(redirectsKey(siteId)));
});

test('duplicating a site copies its redirects', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    await redirects.setRedirect(siteId, { from: '/aa', to: '/bb' });
    const copy = await projects.duplicateProject(siteId);
    assert.deepStrictEqual(await froms(copy.id), [['/aa', '/bb', false]]);
});

test('a publish snapshots the redirects for the public renderer', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    await redirects.setRedirect(siteId, { from: '/aa', to: '/bb', status: 302 });
    await require('./publishing').publishSite(siteId);
    const snap = await require('./publishing').getPublishedSnapshot(siteId, { fresh: true });
    assert.deepStrictEqual(snap.redirects.map((r) => [r.from, r.to, r.status]), [['/aa', '/bb', 302]]);
});

test('an export carries the redirects; an import restores them, drops loops, and never restores the allowed hosts', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    await redirects.setAllowedHosts(siteId, ['partner.example']);
    await redirects.setRedirect(siteId, { from: '/aa', to: '/bb' });
    await redirects.setRedirect(siteId, { from: '/pp', to: 'https://partner.example/x', external: true });
    const bundle = await require('./exportImport').exportSite(siteId);
    assert.deepStrictEqual(bundle.site.redirects.map((r) => [r.from, r.to]), [['/aa', '/bb'], ['/pp', 'https://partner.example/x']]);
    assert.strictEqual(bundle.site.redirectHosts, undefined);
    // A hand-edited bundle that tries to bring its own allow-list and a loop.
    bundle.site.redirectHosts = ['evil.example'];
    bundle.site.redirects.push({ from: '/bb', to: '/aa', status: 301 }, { from: '/cc', to: 'https://evil.example/', status: 301, external: true });
    const imported = await require('./exportImport').importSite(bundle);
    assert.deepStrictEqual(await froms(imported.siteId), [['/aa', '/bb', false]]);
    assert.deepStrictEqual((await redirects.getRedirects(imported.siteId, { fresh: true })).allowedHosts, []);
    assert.ok(imported.warnings.some((w) => /2 redirect\(s\) to other websites/.test(w) && /partner\.example/.test(w)));
});

test('a redirect from a language-prefixed address is refused by the store (published locales included)', async () => {
    const { id: siteId } = await projects.createProject({ name: 'Site' });
    await assert.rejects(() => redirects.setRedirect(siteId, { from: '/nl/aa', to: '/bb' }), { code: 'from_locale_prefix' });
});

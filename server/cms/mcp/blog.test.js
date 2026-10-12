/**
 * CMS MCP blog tools: input checks, exact-match body edits, the write budget,
 * audit (ids and slugs only), translation rules, and — through the real
 * dispatcher — that the tools are listed, classified read-only vs write for
 * the token scope, and refused to a non-admin. Every collaborator is a fake.
 *
 * Run: node --test cms/mcp/blog.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createBlogHandlers, BLOG_TOOLS, postWarnings, WRITE_MAX_PER_WINDOW } = require('./blog');
const { createCmsMcp } = require('./dispatch');
const { TOOL_SCHEMAS } = require('../../cmsBuilder/schemas');
const { classifyRpc, parseToolCall, PROTOCOL_VERSION, INVALID_REQUEST } = require('../../routes/mcpServer');

const SITE = 'pj_aaaa1111';

function fakeStore() {
    const posts = new Map();
    const overrides = new Map();
    const project = { id: SITE, name: 'Main', pages: [], blog: { title: { en: 'Blog' }, description: {}, postsPerPage: 10 } };
    let n = 0;
    const store = {
        project,
        posts,
        overrides,
        getProject: async () => structuredClone(project),
        setProject: async (_id, next) => { Object.assign(project, next); return structuredClone(project); },
        getDefaultLocale: async () => 'en',
        isValidLocale: (c) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(c),
        sanitizeBlogSettings: (b) => ({ title: b?.title || {}, description: b?.description || {}, postsPerPage: b?.postsPerPage || 10 }),
        listPosts: async () => [...posts.values()].map(p => structuredClone(p)),
        getPost: async (_s, id) => (posts.has(id) ? structuredClone(posts.get(id)) : null),
        findPostBySlug: async (_s, slug) => structuredClone([...posts.values()].find(p => p.slug === slug) || null),
        createPost: async (_s, input) => {
            const id = `po_${(++n).toString(16).padStart(4, '0')}`;
            const doc = { id, slug: (input.slug || input.title).toLowerCase().replace(/[^a-z0-9]+/g, '-'), title: input.title, excerpt: input.excerpt || '', body: input.body || '', coverImage: input.coverImage || '', coverAlt: '', authorName: '', tags: input.tags || [], status: input.status || 'draft', publishedAt: input.publishedAt || null, seo: { metaTitle: '', metaDescription: '', ogImage: '', noIndex: false } };
            posts.set(id, doc);
            return structuredClone(doc);
        },
        updatePost: async (_s, id, patch) => {
            const doc = { ...posts.get(id), ...patch };
            posts.set(id, doc);
            return structuredClone(doc);
        },
        deletePost: async (_s, id) => posts.delete(id),
        collectPostLocaleOverrides: async () => {
            const out = {};
            for (const [k, v] of overrides) { const [id, loc] = k.split('|'); out[id] = { ...(out[id] || {}), [loc]: v }; }
            return out;
        },
        setPostLocaleOverride: async (_s, id, loc, ov) => { overrides.set(`${id}|${loc}`, { version: 1, ...ov }); return { version: 1, ...ov }; },
        deletePostLocaleOverride: async (_s, id, loc) => { overrides.delete(`${id}|${loc}`); },
    };
    return store;
}

function harness() {
    const store = fakeStore();
    const audit = [];
    let t = Date.now();
    const { handlers, _budget } = createBlogHandlers({
        cmsStore: store,
        resolveSite: async (args) => (args.siteId && args.siteId !== SITE ? { error: 'Site not found' } : { siteId: SITE, project: await store.getProject() }),
        audit: async (...a) => { audit.push(a); },
        now: () => t,
    });
    const ctx = { userId: 'u1', orgId: 'org1', token: { name: 'claude', scopes: {} } };
    return { store, audit, handlers, ctx, budget: _budget, tick: (ms) => { t += ms; } };
}

test('every blog tool has a description an agent can act on and a schema', () => {
    const names = BLOG_TOOLS.map(t => t.name);
    for (const want of ['cms_list_posts', 'cms_get_post', 'cms_create_post', 'cms_update_post', 'cms_delete_post', 'cms_set_post_translation', 'cms_update_blog_settings']) {
        assert.ok(names.includes(want), want);
    }
    for (const tool of BLOG_TOOLS) {
        assert.ok(tool.description.length > 60, tool.name);
        assert.equal(tool.parameters.type, 'object');
        assert.equal(typeof tool.readOnly, 'boolean');
        assert.ok(!tool.publish, 'publishing stays with cms_publish');
    }
    assert.ok(BLOG_TOOLS.find(t => t.name === 'cms_list_posts').readOnly);
    assert.ok(!BLOG_TOOLS.find(t => t.name === 'cms_create_post').readOnly);
});

test('create: title required, unknown fields named, unsafe cover refused, audited without text', async () => {
    const { handlers, ctx, audit } = harness();
    assert.match((await handlers.cms_create_post({}, ctx)).result.error, /title is required/);
    assert.match((await handlers.cms_create_post({ title: 'x', authorEmail: 'a@b.c' }, ctx)).result.error, /Unknown field: authorEmail/);
    assert.match((await handlers.cms_create_post({ title: 'x', coverImage: 'javascript:alert(1)' }, ctx)).result.error, /not an asset url/);
    assert.match((await handlers.cms_create_post({ title: 'x', tags: Array(11).fill('t') }, ctx)).result.error, /at most 10/);
    const out = await handlers.cms_create_post({ title: 'Hello world', body: '<b>hi</b> [x](javascript:alert(1))' }, ctx);
    assert.equal(out.result.created.slug, 'hello-world');
    assert.ok(out.result.warnings.some(w => /HTML tags/.test(w)));
    assert.ok(out.result.warnings.some(w => /not allowed/.test(w)));
    assert.equal(audit.length, 1);
    assert.equal(audit[0][0], 'cms.post.create.mcp');
    assert.deepEqual(Object.keys(audit[0][5]).sort(), ['siteId', 'slug', 'tokenName']);
    assert.ok(!JSON.stringify(audit).includes('<b>hi</b>'), 'no post text in the audit log');
});

test('update: bodyEdits must match exactly once, are applied in order, and fail atomically', async () => {
    const { handlers, ctx, store } = harness();
    const { result } = await handlers.cms_create_post({ title: 'Doc', body: 'Alpha beta.\n\nGamma beta.' }, ctx);
    const id = result.created.id;
    const ambiguous = await handlers.cms_update_post({ postId: id, bodyEdits: [{ find: 'beta', replace: 'B' }] }, ctx);
    assert.match(ambiguous.result.error, /more than once/);
    const missing = await handlers.cms_update_post({ postId: id, bodyEdits: [{ find: 'Alpha', replace: 'A' }, { find: 'Delta', replace: 'D' }] }, ctx);
    assert.match(missing.result.error, /bodyEdits\[1\]\.find was not found/);
    assert.equal(store.posts.get(id).body, 'Alpha beta.\n\nGamma beta.', 'a failed batch changes nothing');
    const ok = await handlers.cms_update_post({ postId: id, bodyEdits: [{ find: 'Alpha beta', replace: 'Alpha one' }, { find: 'Gamma beta', replace: 'Gamma two' }], appendBody: '## End' }, ctx);
    assert.deepEqual(ok.result.changed, ['body']);
    assert.equal(store.posts.get(id).body, 'Alpha one.\n\nGamma two.\n\n## End');
    assert.match((await handlers.cms_update_post({ postId: id, body: 'x', bodyEdits: [{ find: 'a', replace: 'b' }] }, ctx)).result.error, /not both/);
    assert.match((await handlers.cms_update_post({ postId: id, bodyEdits: Array(21).fill({ find: 'a', replace: 'b' }) }, ctx)).result.error, /At most 20/);
    assert.match((await handlers.cms_update_post({ postId: id }, ctx)).result.error, /Nothing to change/);
    const notFound = await handlers.cms_update_post({ postId: 'po_ffff', title: 'x' }, ctx);
    assert.match(notFound.result._fixHint, /po_0001 \(doc\)/);
});

test('the write budget stops a runaway client, per user, and refills', async () => {
    const { handlers, ctx, budget, tick } = harness();
    budget.set('u1', { count: WRITE_MAX_PER_WINDOW, resetAt: Date.now() + 60_000 });
    assert.match((await handlers.cms_create_post({ title: 'x' }, ctx)).result.error, /budget spent/);
    assert.ok((await handlers.cms_create_post({ title: 'x' }, { ...ctx, userId: 'u2' })).result.created, 'another user is not affected');
    tick(10 * 60 * 1000);
    assert.ok((await handlers.cms_create_post({ title: 'y' }, ctx)).result.created);
    // Reads do not spend the budget.
    budget.set('u1', { count: WRITE_MAX_PER_WINDOW, resetAt: Infinity });
    assert.ok((await handlers.cms_list_posts({}, ctx)).result.posts);
});

test('translations: never the default language, text fields only, remove works', async () => {
    const { handlers, ctx, store } = harness();
    const id = (await handlers.cms_create_post({ title: 'Hi' }, ctx)).result.created.id;
    assert.match((await handlers.cms_set_post_translation({ postId: id, locale: 'en', override: { title: 'x' } }, ctx)).result.error, /default language/);
    assert.match((await handlers.cms_set_post_translation({ postId: id, locale: 'nl', override: { slug: 'x' } }, ctx)).result.error, /no field slug/);
    assert.match((await handlers.cms_set_post_translation({ postId: id, locale: 'x<y', override: {} }, ctx)).result.error, /language code/);
    const saved = await handlers.cms_set_post_translation({ postId: id, locale: 'nl', override: { title: 'Hoi' } }, ctx);
    assert.equal(saved.result.path, '/nl/blog/hi');
    const read = await handlers.cms_get_post({ postId: id, locale: 'nl' }, ctx);
    assert.equal(read.result.translations.nl.title, 'Hoi');
    await handlers.cms_set_post_translation({ postId: id, locale: 'nl', remove: true }, ctx);
    assert.equal(store.overrides.size, 0);
});

test('list filters and caps; delete is audited; blog settings merge per language', async () => {
    const { handlers, ctx, audit, store } = harness();
    for (let i = 0; i < 3; i++) await handlers.cms_create_post({ title: `P${i}`, tags: i ? ['news'] : [], status: i === 2 ? 'published' : 'draft', publishedAt: i === 2 ? '2020-01-01T00:00:00Z' : undefined }, ctx);
    const all = await handlers.cms_list_posts({ limit: 1000 }, ctx);
    assert.equal(all.result.total, 3);
    assert.equal((await handlers.cms_list_posts({ tag: 'news' }, ctx)).result.total, 2);
    const published = await handlers.cms_list_posts({ status: 'published' }, ctx);
    assert.equal(published.result.posts[0].visibleAfterPublish, true);
    const del = await handlers.cms_delete_post({ postId: all.result.posts[0].id }, ctx);
    assert.ok(del.result.deleted);
    assert.equal(audit.at(-1)[0], 'cms.post.delete.mcp');
    const set = await handlers.cms_update_blog_settings({ title: { nl: 'Nieuws', en: '' }, postsPerPage: 5 }, ctx);
    assert.deepEqual(set.result.blogSettings.title, { nl: 'Nieuws' });
    assert.equal(store.project.blog.postsPerPage, 5);
    assert.match((await handlers.cms_update_blog_settings({ postsPerPage: 500 }, ctx)).result.error, /1 to 50/);
    assert.match((await handlers.cms_update_blog_settings({ theme: 'x' }, ctx)).result.error, /Unknown field/);
});

test('postWarnings tells an agent what is missing', () => {
    const w = postWarnings({ title: 'T'.repeat(70), body: '', coverImage: 'cms/x.png', coverAlt: '', excerpt: '', seo: {} });
    assert.ok(w.some(x => /excerpt/.test(x)) && w.some(x => /coverAlt/.test(x)) && w.some(x => /empty/.test(x)) && w.some(x => /60 characters/.test(x)));
});

test('through the dispatcher: listed, scoped read vs write, refused to a non-admin, screenshot takes postSlug', async () => {
    const store = fakeStore();
    const shots = [];
    const scopeAllowsTool = (scopes, server, name, { readOnly = false, publish = false } = {}) => {
        const spec = scopes && scopes[server];
        if (!spec) return false;
        if (spec.level === 'read' && !readOnly) return false;
        return !(publish && spec.publish !== true);
    };
    const mcp = createCmsMcp({
        cmsStore: { ...store, listProjects: async () => [{ id: SITE, name: 'Main' }], getAdminPayload: async () => ({ site: store.project, pages: [] }) },
        cmsParts: { collectLocaleOverrides: async () => ({}), deepMerge: (a, b) => ({ ...a, ...b }), sanitizeAnalytics: (a) => a },
        builder: { TOOL_SCHEMAS, MUTATING_TOOLS: new Set(), applyToolCall: async () => ({}) },
        validateDraft: () => ({ errors: [], warnings: [] }),
        defaults: { SITE_DEFAULTS: {} },
        access: {
            scopeAllowsTool,
            filterToolsByScope: (scopes, server, tools, { isReadOnly, isPublish }) => tools.filter(t => scopeAllowsTool(scopes, server, t.name, { readOnly: isReadOnly(t), publish: isPublish(t) })),
        },
        live: { getLiveSiteId: async () => SITE, setLiveSiteId: async () => SITE, ensurePublishedSnapshot: async () => {}, SITE_ID_RE: /^pj_[a-f0-9]{4,}$/ },
        tickets: {},
        screenshots: { render: async (args) => { shots.push(args); return { ok: true, image: { data: 'QQ==', mimeType: 'image/png' }, text: 'shot', rendering: 'hydrated', path: '/blog/x', pageHeight: 900 }; } },
        storage: { isAvailable: () => false, listKeys: async () => [] },
        audit: async () => {},
        isAdmin: async (user) => user.role === 'admin',
        rpc: { classifyRpc, parseToolCall, PROTOCOL_VERSION, INVALID_REQUEST },
    });
    const admin = { id: 'u1', role: 'admin' };
    const readCtx = { user: admin, userId: 'u1', token: { name: 't', scopes: { cms: { level: 'read' } } } };
    const writeCtx = { ...readCtx, token: { name: 't', scopes: { cms: { level: 'write' } } } };

    const readTools = (await mcp.listTools(readCtx)).map(t => t.name);
    assert.ok(readTools.includes('cms_list_posts') && readTools.includes('cms_get_post'));
    assert.ok(!readTools.includes('cms_create_post'), 'a read-only token is not shown write tools');
    assert.ok((await mcp.listTools(writeCtx)).some(t => t.name === 'cms_update_post' && t.annotations.readOnlyHint === false));
    assert.equal((await mcp.listTools(writeCtx)).find(t => t.name === 'cms_delete_post').annotations.destructiveHint, true);

    const refused = await mcp.callTool('cms_create_post', { title: 'x' }, readCtx);
    assert.equal(refused.isError, true);
    const nonAdmin = await mcp.callTool('cms_list_posts', {}, { ...writeCtx, user: { id: 'u2', role: 'user' }, userId: 'u2' });
    assert.match(nonAdmin.result.error, /administrator/);
    const created = await mcp.callTool('cms_create_post', { title: 'Hello' }, writeCtx);
    assert.equal(created.isError, false);

    await mcp.callTool('cms_screenshot', { postSlug: 'hello' }, writeCtx);
    assert.equal(shots[0].postSlug, 'hello');
    assert.match(mcp.INSTRUCTIONS, /cms_create_post/);
});

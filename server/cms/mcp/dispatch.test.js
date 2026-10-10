/**
 * CMS MCP dispatch: scope filtering, the publish gate, the admin gate, the
 * builder pass-through, site settings, uploads' request side, screenshots'
 * budget. Every collaborator is a fake; no database, browser or gate.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCmsMcp, SHOT_MAX_PER_WINDOW } = require('./dispatch');
const { createUploadTickets } = require('./uploadTickets');
const { TOOL_SCHEMAS } = require('../../cmsBuilder/schemas');
const { SITE_DEFAULTS } = require('../../i18n/defaults/cmsDefaults');
const { classifyRpc, parseToolCall, PROTOCOL_VERSION, INVALID_REQUEST } = require('../../routes/mcpServer');

const SITE = 'pj_aaaa1111';
const OTHER = 'pj_bbbb2222';
const READ_ONLY_BUILDER = new Set(['cms_list_site', 'cms_get_page']);
const MUTATING_TOOLS = new Set(TOOL_SCHEMAS.map((t) => t.function.name).filter((n) => !READ_ONLY_BUILDER.has(n)));

// The access contract (auth/mcpAccess), stubbed with its documented semantics so
// these tests do not depend on that module's timing. The real one is run below.
const stubAccess = {
    scopeAllowsTool(scopes, server, name, { readOnly = false, publish = false } = {}) {
        const spec = scopes && scopes[server];
        if (!spec) return false;
        if (spec.level === 'read' && !readOnly) return false;
        if (publish && spec.publish !== true) return false;
        if (Array.isArray(spec.tools) && !spec.tools.includes(name)) return false;
        return true;
    },
    filterToolsByScope(scopes, server, tools, { isReadOnly, isPublish }) {
        return tools.filter((t) => stubAccess.scopeAllowsTool(scopes, server, t.name, { readOnly: isReadOnly(t), publish: isPublish(t) }));
    },
};

function makeHarness(over = {}) {
    const calls = { audit: [], publish: [], setProject: [], applied: [], removed: [], issued: [], live: [] };
    const projects = {
        [SITE]: {
            id: SITE, name: 'Main', pages: [{ id: 'pg_1', slug: 'home', isHomepage: true }, { id: 'pg_2', slug: 'pricing' }],
            header: structuredClone(SITE_DEFAULTS.header), footer: structuredClone(SITE_DEFAULTS.footer),
            cookieBanner: structuredClone(SITE_DEFAULTS.cookieBanner), announcement: structuredClone(SITE_DEFAULTS.announcement),
            analytics: { gaMeasurementId: '' },
        },
        [OTHER]: { id: OTHER, name: 'Draft v2', pages: [], header: {}, footer: {}, cookieBanner: {}, announcement: {}, analytics: {} },
    };
    let liveSiteId = SITE;
    const kv = new Map();
    const tickets = createUploadTickets({
        store: {
            get: async (k) => (kv.has(k) ? structuredClone(kv.get(k)) : null),
            set: async (k, v) => { kv.set(k, structuredClone(v)); },
            mutate: async (k, fn) => { const next = fn(kv.has(k) ? structuredClone(kv.get(k)) : null); kv.set(k, next); return next; },
            remove: async (k) => { kv.delete(k); },
            listKeys: async () => [...kv.keys()],
        },
    });
    const cmsStore = {
        getProject: async (id) => (projects[id] ? structuredClone(projects[id]) : null),
        listProjects: async () => Object.values(projects).map((p) => ({ id: p.id, name: p.name })),
        getAdminPayload: async (id) => ({ site: structuredClone(projects[id]), pages: [], defaultLocale: 'en', localeOverrides: { siteByLocale: {}, pagesByLocale: {} } }),
        getDefaultLocale: async () => 'en',
        isValidLocale: (c) => /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(c),
        setProject: async (id, site) => { calls.setProject.push([id, site]); projects[id] = site; return site; },
        publishSite: async (id) => { calls.publish.push(id); return { publishedAt: '2026-10-10T10:00:00.000Z' }; },
        removePage: async (id, pageId) => { calls.removed.push([id, pageId]); },
        duplicateProject: async (id) => ({ id: 'pj_cccc3333', copiedFrom: id }),
        getTemplates: async () => [{ id: 'tpl_1', name: 'Landing', blocks: [{}, {}] }],
        setSiteLocaleOverride: async (...a) => { calls.live.push(['site-override', ...a]); },
        setPageLocaleOverride: async (...a) => { calls.live.push(['page-override', ...a]); },
        deleteSiteLocaleOverride: async () => {},
        deletePageLocaleOverride: async () => {},
    };
    const deps = {
        cmsStore,
        cmsParts: {
            collectLocaleOverrides: async () => ({ siteByLocale: { nl: { header: {} } }, pagesByLocale: { pg_1: { nl: { blocks: {} }, de: { blocks: {} } } } }),
            deepMerge: (base, patch) => {
                const out = { ...base };
                for (const [k, v] of Object.entries(patch)) {
                    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...(base[k] || {}), ...v } : v;
                }
                return out;
            },
            sanitizeAnalytics: (a) => ({ gaMeasurementId: /^G-[A-Z0-9]{4,20}$/.test(String(a.gaMeasurementId).toUpperCase()) ? String(a.gaMeasurementId).toUpperCase() : '' }),
        },
        builder: {
            TOOL_SCHEMAS,
            MUTATING_TOOLS,
            applyToolCall: async (draftWrap, name, args) => { calls.applied.push({ draftWrap, name, args }); return { ok: true, pageId: 'pg_9' }; },
        },
        validateDraft: () => ({ errors: [], warnings: [{ code: 'empty_page' }] }),
        defaults: { SITE_DEFAULTS },
        access: stubAccess,
        live: {
            getLiveSiteId: async () => liveSiteId,
            setLiveSiteId: async (id) => { liveSiteId = id; return id; },
            ensurePublishedSnapshot: async (id) => { calls.live.push(['snapshot', id]); },
            SITE_ID_RE: /^pj_[a-f0-9]{4,}$/,
        },
        tickets,
        screenshots: { render: async () => ({ ok: true, image: { data: 'QUJD', mimeType: 'image/png' }, text: 'a screenshot', rendering: 'hydrated', path: '/', pageHeight: 2000 }) },
        storage: { isAvailable: () => true, listKeys: async () => ['cms/100-a.png', 'cms/200-b.jpg', 'cms/300-c.txt'] },
        audit: async (...a) => { calls.audit.push(a); },
        isAdmin: async (user) => user.role === 'admin',
        rpc: { classifyRpc, parseToolCall, PROTOCOL_VERSION, INVALID_REQUEST },
        ...over,
    };
    return { mcp: createCmsMcp(deps), calls, projects, kv, setLive: (id) => { liveSiteId = id; } };
}

const ctxOf = (scopes, over = {}) => ({
    user: { id: 'u1', role: 'admin' }, userId: 'u1', orgId: 'org1', token: { name: 'laptop', scopes },
    baseUrl: 'https://app.example.test', ...over,
});
const FULL = { cms: { level: 'write', publish: true } };
const NO_PUBLISH = { cms: { level: 'write', publish: false } };
const READ = { cms: { level: 'read' } };

const rpcCall = (mcp, ctx, name, args = {}) =>
    mcp.handleRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, ctx);
const textOf = (res) => res.result.content[0].text;

// ── tools/list ───────────────────────────────────────────────────────

test('tools/list: a write+publish token sees every tool, builder and MCP-only', async () => {
    const { mcp } = makeHarness();
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOf(FULL));
    const names = res.result.tools.map((t) => t.name);
    for (const n of ['cms_list_site', 'cms_add_blocks', 'cms_update_design', 'cms_list_sites', 'cms_get_site_settings', 'cms_update_site_settings',
        'cms_get_locale_overrides', 'cms_set_locale_override', 'cms_duplicate_site', 'cms_list_templates', 'cms_list_assets',
        'cms_request_upload', 'cms_upload_status', 'cms_screenshot', 'cms_publish', 'cms_set_live_site']) {
        assert.ok(names.includes(n), `${n} is advertised`);
    }
});

test('tools/list: without cms.publish the publish-class tools are hidden', async () => {
    const { mcp } = makeHarness();
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOf(NO_PUBLISH));
    const names = res.result.tools.map((t) => t.name);
    assert.ok(names.includes('cms_update_block'));
    assert.ok(!names.includes('cms_publish'));
    assert.ok(!names.includes('cms_set_live_site'));
});

test('tools/list: a read token sees only the read-only tools, and the annotations agree', async () => {
    const { mcp } = makeHarness();
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOf(READ));
    const tools = res.result.tools;
    assert.ok(tools.length > 0);
    for (const t of tools) assert.equal(t.annotations.readOnlyHint, true, `${t.name} is read-only`);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('cms_screenshot') && names.includes('cms_list_site'));
    assert.ok(!names.includes('cms_add_blocks') && !names.includes('cms_request_upload'));
});

test('tools/list: a per-server tool allow-list narrows further', async () => {
    const { mcp } = makeHarness();
    const scopes = { cms: { level: 'write', tools: ['cms_list_site', 'cms_screenshot'] } };
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOf(scopes));
    assert.deepEqual(res.result.tools.map((t) => t.name).sort(), ['cms_list_site', 'cms_screenshot']);
});

test('tools/list: a token without the cms server sees nothing', async () => {
    const { mcp } = makeHarness();
    const res = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOf({ studio: { level: 'write' } }));
    assert.deepEqual(res.result.tools, []);
});

test('every builder tool is advertised with an optional siteId; the shared schemas are untouched', async () => {
    const { mcp } = makeHarness();
    const before = JSON.stringify(TOOL_SCHEMAS);
    const list = mcp.buildToolList();
    const page = list.find((t) => t.name === 'cms_get_page');
    assert.ok(page.inputSchema.properties.siteId);
    assert.ok(!(page.inputSchema.required || []).includes('siteId'));
    assert.equal(JSON.stringify(TOOL_SCHEMAS), before, 'TOOL_SCHEMAS is copied, never mutated');
    assert.equal(list.find((t) => t.name === 'cms_list_sites').inputSchema.properties.siteId, undefined);
});

test('annotations: destructive tools say so, publish tools are not read-only', () => {
    const { mcp } = makeHarness();
    const byName = Object.fromEntries(mcp.buildToolList().map((t) => [t.name, t.annotations]));
    assert.equal(byName.cms_remove_block.destructiveHint, true);
    assert.equal(byName.cms_delete_page.destructiveHint, true);
    assert.equal(byName.cms_publish.readOnlyHint, false);
    assert.equal(byName.cms_list_site.destructiveHint, false);
});

// ── admin gate ───────────────────────────────────────────────────────

test('a user who is not a CMS admin gets no tools and every call is refused', async () => {
    const { mcp, calls } = makeHarness();
    const ctx = ctxOf(FULL, { user: { id: 'u2', role: 'user' }, userId: 'u2' });
    assert.deepEqual((await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctx)).result.tools, []);
    const res = await rpcCall(mcp, ctx, 'cms_publish', {});
    assert.equal(res.result.isError, true);
    assert.match(textOf(res), /administrator/);
    assert.equal(calls.publish.length, 0);
});

// ── publish gate ─────────────────────────────────────────────────────

test('cms_publish without cms.publish is refused and publishes nothing', async () => {
    const { mcp, calls } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(NO_PUBLISH), 'cms_publish', { siteId: SITE });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res), /cms\.publish/);
    assert.equal(calls.publish.length, 0);
    assert.equal(calls.audit.length, 0);
});

test('cms_set_live_site without cms.publish is refused', async () => {
    const { mcp, calls } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(NO_PUBLISH), 'cms_set_live_site', { siteId: OTHER });
    assert.equal(res.result.isError, true);
    assert.equal(calls.audit.length, 0);
});

test('a call to a tool the token was never shown is still refused (scope re-checked on call)', async () => {
    const { mcp } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(READ), 'cms_add_blocks', { pageId: 'pg_1', blocks: [] });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res), /not available to this token/);
});

test('cms_publish with the scope publishes and audits with the token name', async () => {
    const { mcp, calls } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(FULL), 'cms_publish', { siteId: SITE });
    assert.equal(res.result.isError, false);
    assert.deepEqual(calls.publish, [SITE]);
    assert.deepEqual(calls.audit, [['cms.publish.mcp', 'cms_site', SITE, 'u1', null, { tokenName: 'laptop' }, 'org1']]);
    const body = JSON.parse(textOf(res));
    assert.equal(body.live, true);
    assert.deepEqual(body.validation.warnings, [{ code: 'empty_page' }]);
});

test('cms_publish says so when the site is not the live one', async () => {
    const { mcp } = makeHarness();
    const body = JSON.parse(textOf(await rpcCall(mcp, ctxOf(FULL), 'cms_publish', { siteId: OTHER })));
    assert.equal(body.live, false);
    assert.match(body.note, /not the live site/);
});

test('cms_set_live_site goes live, snapshots, and audits as cms.live.mcp', async () => {
    const { mcp, calls } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(FULL), 'cms_set_live_site', { siteId: OTHER });
    assert.equal(JSON.parse(textOf(res)).liveSiteId, OTHER);
    assert.ok(calls.live.some((c) => c[0] === 'snapshot' && c[1] === OTHER));
    assert.deepEqual(calls.audit[0].slice(0, 6), ['cms.live.mcp', 'cms_site', OTHER, 'u1', null, { tokenName: 'laptop', live: true }]);
});

test('cms_set_live_site live:false only clears the live site when it is the live one', async () => {
    const { mcp } = makeHarness();
    const miss = JSON.parse(textOf(await rpcCall(mcp, ctxOf(FULL), 'cms_set_live_site', { siteId: OTHER, live: false })));
    assert.equal(miss.liveSiteId, SITE);
    const hit = JSON.parse(textOf(await rpcCall(mcp, ctxOf(FULL), 'cms_set_live_site', { siteId: SITE, live: false })));
    assert.equal(hit.liveSiteId, null);
});

// ── unknown / protocol ───────────────────────────────────────────────

test('an unknown tool is an error result, not a crash', async () => {
    const { mcp } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(FULL), 'cms_drop_database');
    assert.equal(res.result.isError, true);
    assert.match(textOf(res), /Unknown tool/);
});

test('protocol: initialize, ping, notification, unknown method, missing tool name, invalid message', async () => {
    const { mcp } = makeHarness();
    const ctx = ctxOf(FULL);
    const init = await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, ctx);
    assert.equal(init.result.serverInfo.name, 'bee-flow-cms');
    assert.match(init.result.instructions, /cms_request_upload/);
    assert.deepEqual((await mcp.handleRpc({ jsonrpc: '2.0', id: 2, method: 'ping' }, ctx)).result, {});
    assert.equal(await mcp.handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null);
    assert.equal((await mcp.handleRpc({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, ctx)).error.code, -32601);
    assert.equal((await mcp.handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} }, ctx)).error.code, -32602);
    assert.equal((await mcp.handleRpc('nonsense', ctx)).error.code, -32600);
});

// ── builder pass-through ─────────────────────────────────────────────

test('a builder tool runs against the live site by default, without siteId in its args', async () => {
    const { mcp, calls } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(FULL), 'cms_create_page', { title: 'About' });
    const [call] = calls.applied;
    assert.equal(call.name, 'cms_create_page');
    assert.deepEqual(call.args, { title: 'About' });
    assert.equal(call.draftWrap.siteId, SITE);
    assert.equal(call.draftWrap.userId, 'u1');
    assert.equal(call.draftWrap.builderSessionId, `mcp_${SITE}`);
    const body = JSON.parse(textOf(res));
    assert.equal(body.siteId, SITE);
    assert.equal(body.pageId, 'pg_9');
    assert.deepEqual(body.validation.warnings, [{ code: 'empty_page' }]);
});

test('a builder tool honours an explicit siteId', async () => {
    const { mcp, calls } = makeHarness();
    await rpcCall(mcp, ctxOf(FULL), 'cms_get_page', { siteId: OTHER, pageId: 'pg_1' });
    assert.equal(calls.applied[0].draftWrap.siteId, OTHER);
});

test('no live site and no siteId: a clear error, nothing applied', async () => {
    const { mcp, calls, setLive } = makeHarness();
    setLive(null);
    const res = await rpcCall(mcp, ctxOf(FULL), 'cms_list_site');
    assert.equal(res.result.isError, true);
    assert.match(textOf(res), /No site is live/);
    assert.equal(calls.applied.length, 0);
});

test('a malformed or unknown siteId is rejected before anything runs', async () => {
    const { mcp, calls } = makeHarness();
    assert.equal((await rpcCall(mcp, ctxOf(FULL), 'cms_list_site', { siteId: 'x; drop' })).result.isError, true);
    assert.equal((await rpcCall(mcp, ctxOf(FULL), 'cms_list_site', { siteId: 'pj_dead0000' })).result.isError, true);
    assert.equal(calls.applied.length, 0);
});

test('a rejected builder call keeps its _fixHint and is flagged as an error', async () => {
    const { mcp } = makeHarness({
        builder: { TOOL_SCHEMAS, MUTATING_TOOLS, applyToolCall: async () => ({ error: 'bad', _fixHint: 'do better' }) },
    });
    const res = await rpcCall(mcp, ctxOf(FULL), 'cms_update_block', {});
    assert.equal(res.result.isError, true);
    assert.equal(JSON.parse(textOf(res))._fixHint, 'do better');
});

// ── site settings ────────────────────────────────────────────────────

test('cms_get_site_settings returns the requested sections only', async () => {
    const { mcp } = makeHarness();
    const body = JSON.parse(textOf(await rpcCall(mcp, ctxOf(READ), 'cms_get_site_settings', { sections: ['footer'] })));
    assert.ok(body.footer);
    assert.equal(body.header, undefined);
    assert.equal(body.defaultLocale, 'en');
});

test('cms_update_site_settings merges a footer patch, validates and saves through setProject', async () => {
    const { mcp, calls } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(FULL), 'cms_update_site_settings', {
        footer: { copyright: '© Acme', blurb: 'We build' }, analytics: { gaMeasurementId: 'g-abc123xyz' }, name: ' Renamed ',
    });
    assert.equal(res.result.isError, false);
    const [[id, saved]] = calls.setProject;
    assert.equal(id, SITE);
    assert.equal(saved.footer.copyright, '© Acme');
    assert.equal(saved.footer.brandText, SITE_DEFAULTS.footer.brandText, 'untouched keys survive the merge');
    assert.equal(saved.analytics.gaMeasurementId, 'G-ABC123XYZ');
    assert.equal(saved.name, 'Renamed');
});

test('cms_update_site_settings rejects unknown sections, unknown keys, header.nav, bad types and bad GA ids', async () => {
    const { mcp, calls } = makeHarness();
    const ctx = ctxOf(FULL);
    const cases = [
        [{ seo: {} }, /Unknown field/],
        [{ footer: { colour: 'red' } }, /no setting called colour/],
        [{ header: { nav: [] } }, /cms_update_header_nav/],
        [{ footer: 'text' }, /must be an object/],
        [{ cookieBanner: { enabled: 'yes' } }, /true or false/],
        [{ analytics: { gaMeasurementId: 'UA-1' } }, /not a Google Analytics 4 id/],
        [{ name: '' }, /name must be text/],
        [{}, /Nothing to change/],
    ];
    for (const [args, pattern] of cases) {
        const res = await rpcCall(mcp, ctx, 'cms_update_site_settings', args);
        assert.equal(res.result.isError, true, JSON.stringify(args));
        assert.match(textOf(res), pattern);
    }
    assert.equal(calls.setProject.length, 0, 'nothing was written');
});

// ── translations ─────────────────────────────────────────────────────

test('locale overrides can be read filtered by locale and page', async () => {
    const { mcp } = makeHarness();
    const body = JSON.parse(textOf(await rpcCall(mcp, ctxOf(READ), 'cms_get_locale_overrides', { locale: 'nl', pageId: 'pg_1' })));
    assert.deepEqual(Object.keys(body.site), ['nl']);
    assert.deepEqual(Object.keys(body.pages.pg_1), ['nl']);
});

test('cms_set_locale_override writes site and page overrides, validates locale and page', async () => {
    const { mcp, calls } = makeHarness();
    const ctx = ctxOf(FULL);
    assert.equal(JSON.parse(textOf(await rpcCall(mcp, ctx, 'cms_set_locale_override', { locale: 'NL', override: { pageTitles: {} } }))).saved, true);
    await rpcCall(mcp, ctx, 'cms_set_locale_override', { locale: 'nl', pageId: 'pg_1', override: { blocks: {} } });
    assert.equal(calls.live[0][0], 'site-override');
    assert.equal(calls.live[0][2], 'nl');
    assert.equal(calls.live[1][0], 'page-override');
    assert.equal((await rpcCall(mcp, ctx, 'cms_set_locale_override', { locale: 'not a locale', override: {} })).result.isError, true);
    assert.equal((await rpcCall(mcp, ctx, 'cms_set_locale_override', { locale: 'nl', pageId: 'pg_zzz', override: {} })).result.isError, true);
    assert.equal((await rpcCall(mcp, ctx, 'cms_set_locale_override', { locale: 'nl', override: 'x' })).result.isError, true);
});

// ── sites, pages, templates, assets ──────────────────────────────────

test('list sites flags the live one; duplicate; templates; delete page', async () => {
    const { mcp, calls } = makeHarness();
    const ctx = ctxOf(FULL);
    const sites = JSON.parse(textOf(await rpcCall(mcp, ctx, 'cms_list_sites')));
    assert.equal(sites.sites.find((s) => s.id === SITE).live, true);
    assert.equal(sites.sites.find((s) => s.id === OTHER).live, false);
    assert.equal(JSON.parse(textOf(await rpcCall(mcp, ctx, 'cms_duplicate_site'))).id, 'pj_cccc3333');
    assert.equal(JSON.parse(textOf(await rpcCall(mcp, ctx, 'cms_list_templates'))).templates[0].blockCount, 2);
    await rpcCall(mcp, ctx, 'cms_delete_page', { pageId: 'pg_2' });
    assert.deepEqual(calls.removed, [[SITE, 'pg_2']]);
    assert.equal((await rpcCall(mcp, ctx, 'cms_delete_page', { pageId: 'pg_nope' })).result.isError, true);
});

test('cms_list_assets lists only asset extensions, newest first, with urls', async () => {
    const { mcp } = makeHarness();
    const body = JSON.parse(textOf(await rpcCall(mcp, ctxOf(READ), 'cms_list_assets', {})));
    assert.deepEqual(body.assets.map((a) => a.key), ['cms/200-b.jpg', 'cms/100-a.png']);
    assert.equal(body.assets[0].url, '/api/cms/asset/cms/200-b.jpg');
    assert.equal(body.assets[0].absoluteUrl, 'https://app.example.test/api/cms/asset/cms/200-b.jpg');
});

test('cms_list_assets degrades to unavailable without storage listing', async () => {
    const { mcp } = makeHarness({ storage: { isAvailable: () => true, listKeys: async () => { throw new Error('local fs'); } } });
    const body = JSON.parse(textOf(await rpcCall(mcp, ctxOf(READ), 'cms_list_assets', {})));
    assert.equal(body.unavailable, true);
});

// ── upload request side ──────────────────────────────────────────────

test('cms_request_upload issues a ticket, a URL on the public base and a ready curl line', async () => {
    const { mcp, kv } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(FULL), 'cms_request_upload', { filename: 'Hero Photo.jpg', contentType: 'image/jpeg', size: 1_000_000 });
    assert.equal(res.result.isError, false);
    const body = JSON.parse(textOf(res));
    // The URL carries the public ticket id only; the secret is a header.
    assert.match(body.uploadUrl, /^https:\/\/app\.example\.test\/mcp\/cms\/upload\/[a-f0-9]{24}$/);
    const secret = body.uploadHeaders['X-Upload-Ticket'];
    assert.match(secret, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!body.uploadUrl.includes(secret), 'the secret is not in the URL');
    assert.equal(body.curl, `curl -fS -T '<path/to/Hero_Photo.jpg>' -H 'Content-Type: image/jpeg' -H 'X-Upload-Ticket: ${secret}' '${body.uploadUrl}'`);
    assert.ok(Date.parse(body.expiresAt) > Date.now());
    const [record] = [...kv.values()];
    assert.equal(record.userId, 'u1');
    assert.equal(record.orgId, 'org1');
    assert.equal(record.siteId, SITE);
    assert.equal(record.maxSize, 1_000_000);
    assert.equal(record.tokenId, null, 'the ticket remembers which token issued it (null here: no id in the test ctx)');
    assert.equal(record.legacy, false);
    assert.equal(record.used, false);
    assert.ok(!JSON.stringify(record).includes(secret), 'the secret itself is never stored');
});

test('cms_request_upload binds the ticket to the issuing named token', async () => {
    const { mcp, kv } = makeHarness();
    await rpcCall(mcp, ctxOf(FULL, { token: { id: 'tok-1', name: 'laptop', scopes: FULL, legacy: false } }), 'cms_request_upload', { filename: 'a.png', contentType: 'image/png', size: 5 });
    const [named] = [...kv.values()];
    assert.deepEqual([named.tokenId, named.legacy], ['tok-1', false]);
});

test('cms_request_upload gives a legacy token no upload URL and says how to get one', async () => {
    const { mcp, kv } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(FULL, { token: { id: null, name: 'legacy', scopes: FULL, legacy: true } }), 'cms_request_upload', { filename: 'a.png', contentType: 'image/png', size: 5 });
    assert.equal(res.result.isError, true);
    assert.match(textOf(res), /named MCP token/);
    assert.match(textOf(res), /Settings/);
    assert.equal(kv.size, 0, 'no ticket was written');
});

test('cms_request_upload stops at 20 open tickets per user, and another user is unaffected', async () => {
    const { mcp, kv } = makeHarness();
    const ctx = ctxOf(FULL);
    for (let i = 0; i < 20; i++) {
        const ok = await rpcCall(mcp, ctx, 'cms_request_upload', { filename: `a${i}.png`, contentType: 'image/png', size: 5 });
        assert.equal(ok.result.isError, false, `request ${i + 1}`);
    }
    const over = await rpcCall(mcp, ctx, 'cms_request_upload', { filename: 'one-more.png', contentType: 'image/png', size: 5 });
    assert.equal(over.result.isError, true);
    assert.match(textOf(over), /20 unused upload URLs/);
    assert.equal(kv.size, 20);
    const other = await rpcCall(mcp, ctxOf(FULL, { user: { id: 'u9', role: 'admin' }, userId: 'u9' }), 'cms_request_upload', { filename: 'a.png', contentType: 'image/png', size: 5 });
    assert.equal(other.result.isError, false);
});

test('cms_request_upload refuses a type that is not allowed and sizes over the limit', async () => {
    const { mcp, kv } = makeHarness();
    const ctx = ctxOf(FULL);
    const bad = await rpcCall(mcp, ctx, 'cms_request_upload', { filename: 'a.exe', contentType: 'application/x-msdownload', size: 10 });
    assert.equal(bad.result.isError, true);
    assert.match(textOf(bad), /not accepted/);
    const bigImage = await rpcCall(mcp, ctx, 'cms_request_upload', { filename: 'a.png', contentType: 'image/png', size: 26 * 1024 * 1024 });
    assert.equal(bigImage.result.isError, true);
    assert.match(textOf(bigImage), /at most 25 MB/);
    const bigClip = await rpcCall(mcp, ctx, 'cms_request_upload', { filename: 'a.mp4', contentType: 'video/mp4', size: 501 * 1024 * 1024 });
    assert.equal(bigClip.result.isError, true);
    const okClip = await rpcCall(mcp, ctx, 'cms_request_upload', { filename: 'a.mp4', contentType: 'video/mp4', size: 400 * 1024 * 1024 });
    assert.equal(okClip.result.isError, false);
    const zero = await rpcCall(mcp, ctx, 'cms_request_upload', { filename: 'a.png', contentType: 'image/png', size: 0 });
    assert.equal(zero.result.isError, true);
    assert.equal(kv.size, 1, 'only the valid request left a ticket');
});

test('cms_request_upload without a configured public URL hands out a relative one and says so', async () => {
    const { mcp } = makeHarness();
    const body = JSON.parse(textOf(await rpcCall(mcp, ctxOf(FULL, { baseUrl: '' }), 'cms_request_upload', { filename: 'a.png', contentType: 'image/png', size: 5 })));
    assert.match(body.uploadUrl, /^\/mcp\/cms\/upload\//);
    assert.match(body.note, /public address/);
});

test('cms_request_upload needs the write level: a read token is refused', async () => {
    const { mcp } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(READ), 'cms_request_upload', { filename: 'a.png', contentType: 'image/png', size: 5 });
    assert.equal(res.result.isError, true);
});

test('cms_upload_status is private to the user the ticket belongs to', async () => {
    const { mcp } = makeHarness();
    const issued = JSON.parse(textOf(await rpcCall(mcp, ctxOf(FULL), 'cms_request_upload', { filename: 'a.png', contentType: 'image/png', size: 5 })));
    const mine = JSON.parse(textOf(await rpcCall(mcp, ctxOf(FULL), 'cms_upload_status', { ticketId: issued.ticketId })));
    assert.equal(mine.state, 'pending');
    const theirs = await rpcCall(mcp, ctxOf(FULL, { user: { id: 'u9', role: 'admin' }, userId: 'u9' }), 'cms_upload_status', { ticketId: issued.ticketId });
    assert.equal(theirs.result.isError, true);
});

// ── screenshots ──────────────────────────────────────────────────────

test('cms_screenshot returns a text block and an image block', async () => {
    const { mcp } = makeHarness();
    const res = await rpcCall(mcp, ctxOf(READ), 'cms_screenshot', { state: 'draft' });
    assert.equal(res.result.isError, false);
    assert.equal(res.result.content[0].text, 'a screenshot');
    assert.deepEqual(res.result.content[1], { type: 'image', data: 'QUJD', mimeType: 'image/png' });
});

test('cms_screenshot unavailable is a plain sentence, not an error', async () => {
    const { mcp } = makeHarness({ screenshots: { render: async () => ({ ok: false, unavailable: true, reason: 'no browser is available on this server.' }) } });
    const res = await rpcCall(mcp, ctxOf(READ), 'cms_screenshot', {});
    assert.equal(res.result.isError, false);
    assert.equal(res.result.content.length, 1);
    assert.equal(textOf(res), 'Screenshot unavailable: no browser is available on this server.');
});

test('cms_screenshot has a budget per user: 24, then a polite refusal, other users unaffected', async () => {
    const { mcp } = makeHarness();
    const ctx = ctxOf(READ);
    for (let i = 0; i < SHOT_MAX_PER_WINDOW; i += 1) {
        assert.equal((await rpcCall(mcp, ctx, 'cms_screenshot', {})).result.content.length, 2);
    }
    const over = await rpcCall(mcp, ctx, 'cms_screenshot', {});
    assert.equal(over.result.content.length, 1);
    assert.match(textOf(over), /budget spent/);
    const other = await rpcCall(mcp, ctxOf(READ, { user: { id: 'u2', role: 'admin' }, userId: 'u2' }), 'cms_screenshot', {});
    assert.equal(other.result.content.length, 2);
});

test('the screenshot budget refills after the window', async () => {
    let t = 1_000_000;
    const { mcp } = makeHarness({ now: () => t });
    const ctx = ctxOf(READ);
    for (let i = 0; i < SHOT_MAX_PER_WINDOW; i += 1) await rpcCall(mcp, ctx, 'cms_screenshot', {});
    assert.match(textOf(await rpcCall(mcp, ctx, 'cms_screenshot', {})), /budget spent/);
    t += 10 * 60 * 1000 + 1;
    assert.equal((await rpcCall(mcp, ctx, 'cms_screenshot', {})).result.content.length, 2);
});

// ── against the real access module, when it is there ─────────────────

test('scope semantics hold against the real auth/mcpAccess/scopes module', async (t) => {
    let real;
    try { real = require('../../auth/mcpAccess/scopes'); } catch (_) { return t.skip('auth/mcpAccess/scopes is not present'); }
    const { mcp } = makeHarness({ access: { scopeAllowsTool: real.scopeAllowsTool, filterToolsByScope: real.filterToolsByScope } });
    const names = async (scopes) => (await mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, ctxOf(scopes))).result.tools.map((x) => x.name);
    assert.ok((await names(FULL)).includes('cms_publish'));
    assert.ok(!(await names(NO_PUBLISH)).includes('cms_publish'));
    assert.ok((await names(NO_PUBLISH)).includes('cms_screenshot'));
    assert.ok(!(await names(READ)).includes('cms_update_block'));
    assert.equal(textOf(await rpcCall(mcp, ctxOf(NO_PUBLISH), 'cms_publish', {})).includes('cms.publish'), true);
});

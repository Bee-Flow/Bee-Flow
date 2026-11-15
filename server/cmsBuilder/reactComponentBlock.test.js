/**
 * The React component block (`react-component`) on the server: the compile on
 * every save (stores/cms/reactBlock.mts via setPage), what a translation may
 * change, the validation warnings, the reader's view of `compiled`, and the
 * cms_update_react_component tool as an MCP caller sees it (siteContext's
 * runBuilderTool: the builder's apply function plus `validation`).
 *
 * The REAL cmsStore runs over an in-memory config table (cmsStore.testkit).
 *
 * Run: node --test cmsBuilder/reactComponentBlock.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../stores/cmsStore.testkit');

const { configState } = installCmsStoreMocks();

const cmsStore = require('../stores/cmsStore');
const builder = require('./builderTools');
const { validateSiteDraft } = require('./validate');
const { renderDraftState } = require('./builderPrompt');
const { createSiteContext } = require('../cms/mcp/siteContext');
const { createLocaleHandlers } = require('../cms/mcp/siteHandlers');
const { extractPageEntries } = require('../core/cms/cmsTranslate');
const { pageLocaleKey } = require('../stores/cms/shared');
const { BLOCK_DEFAULTS, BLOCK_TYPES } = require('../i18n/defaults/cmsDefaults');

const OK_SOURCE = 'export default function Hello({ title }: { title: string }) {\n  return <h2>{title}</h2>;\n}\n';
const BROKEN_SOURCE = 'export default function Hello() {\n  return <h2>{oops</h2>;\n}\n';

/** A site with one react-component block on its first page, edited the way an MCP caller does. */
async function reactSite(content) {
    const created = await cmsStore.createProject({ name: 'React site' });
    const siteId = created.id;
    const site = await cmsStore.getProject(siteId);
    const page = site.pages[0];
    const kit = createSiteContext({
        cmsStore, builder, validateDraft: validateSiteDraft,
        live: { getLiveSiteId: async () => siteId, SITE_ID_RE: /^[A-Za-z0-9_-]+$/ },
    });
    const call = async (name, args) => (await kit.runBuilderTool(name, { siteId, ...args }, { userId: 'u1', orgId: 'orgA' })).result;
    const added = await call('cms_add_blocks', { pageId: page.id, blocks: [{ type: 'react-component', content }] });
    assert.ok(Array.isArray(added.blockIds) && added.blockIds.length === 1, JSON.stringify(added));
    const stored = async () => (await cmsStore.getPage(siteId, page.id)).blocks.find((b) => b.id === added.blockIds[0]);
    const { setLocaleOverride } = createLocaleHandlers({ deps: {}, cmsStore, resolveSite: kit.resolveSite });
    return { siteId, pageId: page.id, slug: page.slug, blockId: added.blockIds[0], call, stored, setLocaleOverride };
}

// ── Catalogue and store ─────────────────────────────────────────────

test('react-component is in the catalogue; its sample uses state, typed props and theme variables', () => {
    assert.deepStrictEqual(BLOCK_TYPES.find((t) => t.type === 'react-component'),
        { type: 'react-component', label: 'React component', icon: 'Atom', category: 'Content' });
    const d = BLOCK_DEFAULTS['react-component'];
    assert.match(d.source, /useState/);
    assert.match(d.source, /export default function/);
    assert.match(d.source, /var\(--bf-primary\)/);
    assert.deepStrictEqual(Object.keys(d.props).sort(), d.fields.map((f) => f.name).sort());
    assert.strictEqual(d.width, 'container');
    assert.strictEqual(d.minHeight, 240);
    assert.strictEqual(d.compiled, '');
    assert.strictEqual(d.compileError, '');
});

test('the type aliases react, reactcomponent and react_component land on react-component', () => {
    for (const alias of ['react', 'reactcomponent', 'ReactComponent', 'react_component']) {
        assert.strictEqual(cmsStore.sanitizeBlocks([{ type: alias, content: {} }]).blocks[0]?.type, 'react-component', alias);
    }
});

test('a new block with the sample code is compiled by the server and validates clean', async () => {
    const { stored, call, pageId } = await reactSite(undefined);
    const block = await stored();
    assert.match(block.content.compiled, /module\.exports/);
    assert.strictEqual(block.content.compileError, '');
    const page = await call('cms_get_page', { pageId });
    assert.ok(!page.validation, JSON.stringify(page.validation));
});

test('setPage discards a compiled / compileError the client sent and recompiles the source', async () => {
    const { siteId, pageId, blockId, stored } = await reactSite({ source: OK_SOURCE });
    const page = await cmsStore.getPage(siteId, pageId);
    const evil = page.blocks.map((b) => (b.id === blockId ? { ...b, content: { ...b.content, compiled: 'alert(1)', compileError: 'fake' } } : b));
    await cmsStore.setPage(siteId, { ...page, blocks: evil });
    let block = await stored();
    assert.doesNotMatch(block.content.compiled, /alert\(1\)/);
    assert.match(block.content.compiled, /module\.exports/);
    assert.strictEqual(block.content.compileError, '');

    const broken = page.blocks.map((b) => (b.id === blockId ? { ...b, content: { ...b.content, source: BROKEN_SOURCE, compiled: 'alert(1)' } } : b));
    await cmsStore.setPage(siteId, { ...page, blocks: broken });
    block = await stored();
    assert.strictEqual(block.content.compiled, '');
    assert.match(block.content.compileError, /^component\.tsx:2:\d+: /);
});

test('the content shape is rebuilt from an allow-list: fields, props, width and minHeight are cleaned', async () => {
    const { siteId, pageId, blockId, stored } = await reactSite({ source: OK_SOURCE });
    const page = await cmsStore.getPage(siteId, pageId);
    const content = {
        source: OK_SOURCE, css: 7, evil: '<script>',
        fields: [
            { name: 'title', label: 'Title', type: 'text' },
            { name: 'title', label: 'Again', type: 'number' },
            { name: 'bad-name', type: 'text' },
            { name: 'size', type: 'gigantic' },
            { name: 'tone', type: 'select', options: ['calm', 3, 'loud'] },
        ],
        props: { title: 'Hi', 'not ok': 1, size: Number.NaN, extra: { kind: 'external', url: 'https://example.org' } },
        width: 'huge', minHeight: 99999,
    };
    await cmsStore.setPage(siteId, { ...page, blocks: page.blocks.map((b) => (b.id === blockId ? { ...b, content } : b)) });
    const c = (await stored()).content;
    assert.strictEqual(c.evil, undefined);
    assert.strictEqual(c.css, '');
    assert.deepStrictEqual(c.fields, [
        { name: 'title', label: 'Title', type: 'text' },
        { name: 'size', label: 'size', type: 'text' },
        { name: 'tone', label: 'tone', type: 'select', options: ['calm', 'loud'] },
    ]);
    assert.deepStrictEqual(c.props, { title: 'Hi', extra: { kind: 'external', url: 'https://example.org' } });
    assert.strictEqual(c.width, 'container');
    assert.strictEqual(c.minHeight, 4000);
});

// ── Translations ────────────────────────────────────────────────────

test('a locale override of a react-component block keeps props only, on write and on read', async () => {
    const { siteId, pageId, blockId, slug } = await reactSite({
        source: OK_SOURCE, fields: [{ name: 'title', label: 'Title', type: 'text' }], props: { title: 'Hello' },
    });
    const saved = await cmsStore.setPageLocaleOverride(siteId, pageId, 'nl', {
        blocks: { [blockId]: { content: { props: { title: 'Hallo' }, source: 'export default () => null', compiled: 'alert(1)', fields: [] } } },
    });
    assert.deepStrictEqual(saved.blocks[blockId], { content: { props: { title: 'Hallo' } } });
    assert.deepStrictEqual(configState.map.get(pageLocaleKey(siteId, pageId, 'nl')).blocks[blockId], { content: { props: { title: 'Hallo' } } });

    // An override stored before the rule (or by an import) must not shadow the code either.
    const key = pageLocaleKey(siteId, pageId, 'nl');
    const stale = configState.map.get(key);
    stale.blocks[blockId] = { content: { props: { title: 'Hallo' }, compiled: 'alert(1)', source: 'x', compileError: 'no' } };
    configState.map.set(key, stale);
    const eff = await cmsStore.getEffective(siteId, slug, 'nl');
    const block = eff.page.blocks.find((b) => b.id === blockId);
    assert.strictEqual(block.content.props.title, 'Hallo');
    assert.match(block.content.compiled, /module\.exports/);
    assert.strictEqual(block.content.source, OK_SOURCE);
    assert.strictEqual(block.content.compileError, '');
});

test('cms_set_locale_override says which keys of a react-component translation were not stored', async () => {
    const { siteId, pageId, blockId, setLocaleOverride } = await reactSite({ source: OK_SOURCE });
    const out = await setLocaleOverride({ siteId, pageId, locale: 'nl', override: { blocks: { [blockId]: { content: { props: { title: 'Hallo' }, source: 'x' } } } } });
    assert.strictEqual(out.result.saved, true);
    assert.match(out.result.reactWarning, new RegExp(`props only; not stored: ${blockId}\\.source`));
    const clean = await setLocaleOverride({ siteId, pageId, locale: 'nl', override: { blocks: { [blockId]: { content: { props: { title: 'Hallo' } } } } } });
    assert.strictEqual(clean.result.reactWarning, undefined);
});

test('an AI translation result is held to props for a react-component block too', async () => {
    const { siteId, pageId, blockId } = await reactSite({ source: OK_SOURCE });
    const snapshot = await cmsStore.getPage(siteId, pageId);
    const saved = await cmsStore.saveTranslatedPageOverride(siteId, pageId, 'nl', {
        blocks: { [blockId]: { content: { props: { title: 'Hallo' }, compiled: 'alert(1)' } } },
    }, snapshot);
    assert.deepStrictEqual(saved.blocks[blockId], { content: { props: { title: 'Hallo' } } });
});

test('the translator gets the text and textarea props only, never code, fields or other props', () => {
    const entries = extractPageEntries({
        blocks: [{
            id: 'b1', type: 'react-component',
            content: {
                source: 'export default () => <p>Hello there</p>', css: '.x { content: "Hi" }', compiled: 'module.exports = 1', compileError: 'Some error text',
                fields: [{ name: 'title', label: 'Title', type: 'text' }, { name: 'body', label: 'Body', type: 'textarea' }, { name: 'tone', label: 'Tone', type: 'select', options: ['calm'] }, { name: 'n', label: 'N', type: 'number' }],
                props: { title: 'Welcome', body: 'Longer text', tone: 'calm', n: 3, undeclared: 'Not me' },
            },
        }],
    });
    assert.deepStrictEqual(entries.map((e) => [e.targetPath.join('.'), e.source]), [
        ['blocks.b1.content.props.title', 'Welcome'],
        ['blocks.b1.content.props.body', 'Longer text'],
    ]);
});

// ── cms_update_react_component ──────────────────────────────────────

test('source: a whole new file compiles; the result reports the outcome', async () => {
    const { pageId, blockId, call, stored } = await reactSite({ source: OK_SOURCE });
    const next = 'export default function Two() {\n  return <p>two</p>;\n}\n';
    const r = await call('cms_update_react_component', { pageId, blockId, source: next });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.compiled, true);
    assert.strictEqual(r.compileError, '');
    assert.deepStrictEqual(r.diagnostics, []);
    assert.strictEqual(r.sourceBytes, Buffer.byteLength(next));
    assert.strictEqual((await stored()).content.source, next);
});

test('sourceEdits: applied in order; a find that is missing or not unique changes nothing', async () => {
    const { pageId, blockId, call, stored } = await reactSite({ source: OK_SOURCE });
    const ok = await call('cms_update_react_component', {
        pageId, blockId, sourceEdits: [{ find: 'Hello(', replace: 'Greeting(' }, { find: '<h2>{title}</h2>', replace: '<h3>{title}!</h3>' }],
    });
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    const after = (await stored()).content.source;
    assert.match(after, /function Greeting\(/);
    assert.match(after, /<h3>\{title\}!<\/h3>/);

    const missing = await call('cms_update_react_component', { pageId, blockId, sourceEdits: [{ find: 'Greeting(', replace: 'X(' }, { find: 'nowhere', replace: 'y' }] });
    assert.match(missing.error, /sourceEdits\[1\]\.find was not found in the source \(nothing was changed\)/);
    assert.ok(missing._fixHint);
    const twice = await call('cms_update_react_component', { pageId, blockId, sourceEdits: [{ find: 'title', replace: 'name' }] });
    assert.match(twice.error, /sourceEdits\[0\]\.find occurs more than once/);
    assert.strictEqual((await stored()).content.source, after, 'nothing was saved');

    const both = await call('cms_update_react_component', { pageId, blockId, source: 'x', sourceEdits: [{ find: 'a', replace: 'b' }] });
    assert.match(both.error, /either source .* or sourceEdits/);
    const tooMany = await call('cms_update_react_component', { pageId, blockId, sourceEdits: Array.from({ length: 21 }, () => ({ find: 'a', replace: 'b' })) });
    assert.match(tooMany.error, /At most 20 sourceEdits/);
});

test('props merge key by key (null removes one); fields replace; width and minHeight are checked', async () => {
    const { pageId, blockId, call, stored } = await reactSite({
        source: OK_SOURCE,
        fields: [{ name: 'title', label: 'Title', type: 'text' }, { name: 'n', label: 'N', type: 'number' }, { name: 'gone', label: 'Gone', type: 'text' }],
        props: { title: 'Hi', n: 1, gone: 'bye' },
    });
    const r = await call('cms_update_react_component', { pageId, blockId, props: { title: 'Hello', gone: null }, width: 'full', minHeight: 300 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const c = (await stored()).content;
    assert.deepStrictEqual(c.props, { title: 'Hello', n: 1 });
    assert.strictEqual(c.width, 'full');
    assert.strictEqual(c.minHeight, 300);

    await call('cms_update_react_component', { pageId, blockId, fields: [{ name: 'title', label: 'Heading', type: 'textarea' }] });
    assert.deepStrictEqual((await stored()).content.fields, [{ name: 'title', label: 'Heading', type: 'textarea' }]);

    const badField = await call('cms_update_react_component', { pageId, blockId, fields: [{ name: 'a-b', type: 'text' }] });
    assert.match(badField.error, /fields\[0\]\.name is not a valid prop name/);
    assert.match(badField._fixHint, /COMPLETE list/);
    const dup = await call('cms_update_react_component', { pageId, blockId, fields: [{ name: 'a', type: 'text' }, { name: 'a', type: 'text' }] });
    assert.match(dup.error, /used twice/);
    const select = await call('cms_update_react_component', { pageId, blockId, fields: [{ name: 'a', type: 'select' }] });
    assert.match(select.error, /select field without options/);
    assert.match((await call('cms_update_react_component', { pageId, blockId, width: 'huge' })).error, /width must be one of container, full/);
    assert.match((await call('cms_update_react_component', { pageId, blockId, minHeight: 5000 })).error, /minHeight/);
    assert.match((await call('cms_update_react_component', { pageId, blockId })).error, /Nothing to change/);
});

test('a compile error comes back with diagnostics and as a react_compile_error warning with its position', async () => {
    const { pageId, blockId, call } = await reactSite({ source: OK_SOURCE });
    const r = await call('cms_update_react_component', { pageId, blockId, source: BROKEN_SOURCE });
    assert.strictEqual(r.error, undefined, 'a compile error is an outcome, not a failed call');
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.compiled, false);
    assert.match(r.compileError, /^component\.tsx:2:\d+: /);
    assert.strictEqual(r.diagnostics[0].line, 2);
    const warning = r.validation.warnings.find((w) => w.code === 'react_compile_error');
    assert.ok(warning, JSON.stringify(r.validation));
    assert.match(warning.message, /component\.tsx:2:\d+/);
    assert.match(warning.path, /\.blocks\[\d+\]\.content\.source$/);
    assert.match(warning.hint, /cms_update_react_component/);
});

test('the tool refuses a block of another type and an unknown block', async () => {
    const { pageId, call } = await reactSite({ source: OK_SOURCE });
    const added = await call('cms_add_blocks', { pageId, blocks: [{ type: 'faq' }] });
    const wrong = await call('cms_update_react_component', { pageId, blockId: added.blockIds[0], source: OK_SOURCE });
    assert.match(wrong.error, /is a faq block, not a react-component block/);
    const unknown = await call('cms_update_react_component', { pageId, blockId: 'blk_nope', source: OK_SOURCE });
    assert.match(unknown.error, /Unknown blockId/);
});

test('a block added with its own source starts without the sample fields and props', async () => {
    const { stored } = await reactSite({ source: OK_SOURCE, fields: [{ name: 'title', label: 'Title', type: 'text' }], props: { title: 'Mine' } });
    const c = (await stored()).content;
    assert.deepStrictEqual(c.fields, [{ name: 'title', label: 'Title', type: 'text' }]);
    assert.deepStrictEqual(c.props, { title: 'Mine' });
});

// ── Readers ─────────────────────────────────────────────────────────

test('cms_get_page and the builder site state show the code but replace compiled with a size note', async () => {
    const { siteId, pageId, blockId, call } = await reactSite({ source: OK_SOURCE });
    const got = await call('cms_get_page', { pageId });
    const block = got.page.blocks.find((b) => b.id === blockId);
    assert.strictEqual(block.content.source, OK_SOURCE);
    assert.match(block.content.compiled, /^<compiled: \d+ bytes>$/);

    const site = await cmsStore.getProject(siteId);
    const state = renderDraftState({ site, pages: new Map([[pageId, await cmsStore.getPage(siteId, pageId)]]), locales: [] }, { activePageId: pageId });
    assert.match(state, /react-component \(react: 0 fields, compiles\)/);
    assert.match(state, /<compiled: \d+ bytes>/);
    assert.doesNotMatch(state, /module\.exports/);
});

test('prop values that do not fit their field, and props without a field, are warnings', () => {
    const draft = {
        site: { pages: [{ id: 'p1', slug: 'home', title: 'Home' }] },
        pages: new Map([['p1', { blocks: [{ id: 'b1', type: 'react-component', content: {
            source: OK_SOURCE, compiled: 'x', compileError: '',
            fields: [{ name: 'n', type: 'number' }, { name: 'c', type: 'color' }, { name: 's', type: 'select', options: ['a'] }, { name: 't', type: 'text' }],
            props: { n: '3', c: 'red', s: 'b', t: 'fine', stray: 1 },
        } }] }]]),
    };
    const warnings = validateSiteDraft(draft).warnings;
    const byPath = Object.fromEntries(warnings.map((w) => [w.path.split('.').pop(), w.code]));
    assert.deepStrictEqual(byPath, { n: 'react_prop_type', c: 'react_prop_type', s: 'react_prop_type', stray: 'react_prop_undeclared' });
});

/**
 * The `feature-matrix` block (issue #529): catalogue entry, seeded defaults,
 * the validator's warnings, MCP acceptance through cms_add_blocks /
 * cms_update_block against the real store, translations that stay on their
 * item, and the server-rendered (pre-hydration) <table>.
 *
 * Run: node --test cmsBuilder/featureMatrixBlock.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installCmsStoreMocks } = require('../stores/cmsStore.testkit');

installCmsStoreMocks();

const cmsStore = require('../stores/cmsStore');
const { BLOCK_DEFAULTS, BLOCK_TYPE_IDS, MATRIX_COLUMNS_MIN, MATRIX_COLUMNS_MAX } = require('../i18n/defaults/cmsDefaults');
const { applyToolCall } = require('./builderTools');
const { validateSiteDraft } = require('./validate');
const { renderBlocks } = require('../core/seo/renderBlocks');
const { isDeniedKey } = require('../core/cms/cmsTranslate');

const col = (id, label, extra = {}) => ({ id, label, highlight: false, ...extra });
const cell = (id, kind, text = '') => ({ id, kind, text });

function matrix(over = {}) {
    return {
        title: 'Plans',
        columns: [col('col-free', 'Free'), col('col-pro', 'Pro', { highlight: true }), col('col-ent', 'Enterprise')],
        groups: [
            {
                id: 'grp-a', title: 'Core',
                rows: [
                    { id: 'row-a1', label: 'Agents', cells: [cell('col-free', 'included'), cell('col-pro', 'included'), cell('col-ent', 'included')] },
                    { id: 'row-a2', label: 'Seats', cells: [cell('col-free', 'text', 'Up to 3'), cell('col-pro', 'text', 'Unlimited'), cell('col-ent', 'text', 'Unlimited')] },
                ],
            },
            {
                id: 'grp-b', title: 'Security',
                rows: [{ id: 'row-b1', label: 'SSO', cells: [cell('col-free', 'excluded'), cell('col-pro', 'excluded'), cell('col-ent', 'included')] }],
            },
        ],
        ...over,
    };
}

/** @param {Record<string, unknown>} content */
const warnings = (content) => validateSiteDraft(/** @type {any} */ ({
    site: { pages: [{ id: 'p1', slug: 'home', title: 'Home' }] },
    pages: new Map([['p1', { blocks: [{ id: 'b1', type: 'feature-matrix', content }] }]]),
})).warnings;
const codes = (content) => warnings(content).map((w) => w.code);

async function makeDraft() {
    const created = await cmsStore.createProject({ name: 'Matrix site' });
    const site = await cmsStore.getProject(created.id);
    const pages = new Map();
    for (const entry of site.pages) pages.set(entry.id, await cmsStore.getPage(created.id, entry.id));
    return {
        siteId: created.id, userId: 'u1', orgId: 'orgA', builderSessionId: 'cms_test', site, pages,
        defaultLocale: 'en', locales: [], createdPageIds: [], touchedPageIds: new Set(),
    };
}

test('feature-matrix is in the catalogue and seeds a valid two-column matrix', () => {
    assert.ok(BLOCK_TYPE_IDS.includes('feature-matrix'));
    const d = BLOCK_DEFAULTS['feature-matrix'];
    assert.ok(d.columns.length >= MATRIX_COLUMNS_MIN && d.columns.length <= MATRIX_COLUMNS_MAX);
    assert.deepStrictEqual(codes(d), []);
    assert.ok(BLOCK_DEFAULTS['compare-table'].rows, 'compare-table keeps its data shape');
});

test('the structural keys are on the translation denylist, the visible text is not', () => {
    for (const k of ['id', 'kind']) assert.ok(isDeniedKey(k), k);
    for (const k of ['label', 'title', 'text']) assert.ok(!isDeniedKey(k), k);
});

test('a well-formed matrix validates clean', () => {
    assert.deepStrictEqual(codes(matrix()), []);
});

test('column count outside 2-6, empty labels and many highlights are warnings, never errors', () => {
    assert.ok(codes(matrix({ columns: [col('col-free', 'Free')] })).includes('matrix_columns_count'));
    const seven = Array.from({ length: MATRIX_COLUMNS_MAX + 1 }, (_, i) => col(`col-${i}`, `P${i}`));
    assert.ok(codes(matrix({ columns: seven })).includes('matrix_columns_count'));
    assert.ok(codes(matrix({ columns: [col('a', 'A'), col('b', ' ')] })).includes('matrix_empty_label'));
    assert.ok(codes(matrix({ columns: [col('a', 'A', { highlight: true }), col('b', 'B', { highlight: true })] })).includes('matrix_many_highlights'));
});

test('missing and repeated ids are reported on columns, groups and rows', () => {
    const c = codes(matrix({ columns: [col('x', 'A'), col('x', 'B')] }));
    assert.ok(c.includes('matrix_duplicate_id'));
    assert.ok(codes(matrix({ columns: [col('', 'A'), col('b', 'B')] })).includes('matrix_missing_id'));
    const groups = matrix().groups;
    groups[1].id = 'grp-a';
    assert.ok(codes(matrix({ groups })).includes('matrix_duplicate_id'));
    const rows = matrix().groups;
    rows[0].rows[1].id = 'row-a1';
    assert.ok(codes(matrix({ groups: rows })).includes('matrix_duplicate_id'));
});

test('a cell for a column that does not exist, or with an unknown kind, is reported', () => {
    const g = matrix().groups;
    g[0].rows[0].cells.push(cell('col-gone', 'included'));
    const w = warnings(matrix({ groups: g })).filter((x) => x.code === 'matrix_unknown_column');
    assert.strictEqual(w.length, 1);
    assert.match(String(w[0].hint), /col-free/);
    const g2 = matrix().groups;
    g2[0].rows[0].cells[0].kind = 'maybe';
    assert.ok(codes(matrix({ groups: g2 })).includes('matrix_cell_kind'));
});

test('cms_add_blocks accepts the block, replaces arrays wholesale and validates clean', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const r = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'feature-matrix', content: matrix() }] });
    assert.ok(!r.error, JSON.stringify(r));
    assert.deepStrictEqual(r.dropped, []);
    const block = draft.pages.get(home).blocks[0];
    assert.strictEqual(block.type, 'feature-matrix');
    assert.strictEqual(block.content.columns.length, 3, 'default two columns replaced');
    assert.strictEqual(block.content.groups.length, 2);
    assert.strictEqual(block.content.footnote, '', 'unspecified defaults seeded');
    assert.deepStrictEqual(validateSiteDraft(draft).warnings.filter((w) => String(w.code).startsWith('matrix_')), []);

    const seeded = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'feature-matrix' }] });
    assert.ok(!seeded.error);
    assert.deepStrictEqual(draft.pages.get(home).blocks[1].content, BLOCK_DEFAULTS['feature-matrix']);
});

test('a translation stays on its row and cell when the rows are reordered', async () => {
    const draft = await makeDraft();
    const home = draft.site.pages[0].id;
    const added = await applyToolCall(draft, 'cms_add_blocks', { pageId: home, blocks: [{ type: 'feature-matrix', content: matrix() }] });
    const blockId = added.blockIds[0];
    await cmsStore.setPageLocaleOverride(draft.siteId, home, 'nl', {
        blocks: {
            [blockId]: {
                content: {
                    columns: [{ label: 'Gratis' }],
                    groups: [{ title: 'Kern', rows: [{ label: 'Agenten' }, { label: 'Plekken', cells: [{ text: 'Tot 3' }] }] }],
                },
            },
        },
    });

    const groups = matrix().groups;
    groups[0].rows.reverse();
    const r = await applyToolCall(draft, 'cms_update_block', { pageId: home, blockId, contentPatch: { groups } });
    assert.ok(!r.error, JSON.stringify(r));

    const nl = await cmsStore.getPageLocaleOverride(draft.siteId, home, 'nl');
    const rows = nl.blocks[blockId].content.groups[0].rows;
    const seats = rows.findIndex((x) => x && x.label === 'Plekken');
    const agents = rows.findIndex((x) => x && x.label === 'Agenten');
    assert.strictEqual(seats, 0, 'Seats is now first and keeps its translation');
    assert.strictEqual(agents, 1);
    assert.strictEqual(rows[seats].cells[0].text, 'Tot 3');
    assert.strictEqual(nl.blocks[blockId].content.columns[0].label, 'Gratis');
});

test('the server-rendered HTML is one table: column heads, group rows, escaped cells by column id', () => {
    const content = matrix();
    content.groups[0].rows[1].label = '<b>Seats</b>';
    // The cells of a row may come in any order: they are matched by column id.
    content.groups[0].rows[0].cells.reverse();
    const html = renderBlocks([{ type: 'feature-matrix', content: { ...content, footnote: 'Features differ per licence.' } }]);
    assert.match(html, /<table>/);
    assert.match(html, /<th>Free<\/th><th>Pro<\/th><th>Enterprise<\/th>/);
    assert.match(html, /<th colspan="4">Core<\/th>/);
    assert.match(html, /<th colspan="4">Security<\/th>/);
    assert.match(html, /<th>Agents<\/th><td>Included<\/td><td>Included<\/td><td>Included<\/td>/);
    assert.match(html, /<th>SSO<\/th><td>Not included<\/td><td>Not included<\/td><td>Included<\/td>/);
    assert.match(html, /&lt;b&gt;Seats&lt;\/b&gt;<\/th><td>Up to 3<\/td><td>Unlimited<\/td>/);
    assert.ok(!html.includes('<b>Seats</b>'));
    assert.match(html, /Features differ per licence/);
    assert.ok(!html.includes('col-free') && !html.includes('grp-a'), 'ids are structural, not prose');
});

test('a matrix with no filled rows emits no table', () => {
    const html = renderBlocks([{ type: 'feature-matrix', content: { title: 'T', columns: [col('a', 'A'), col('b', 'B')], groups: [{ id: 'g', title: 'G', rows: [{ id: 'r', label: ' ', cells: [] }] }] } }]);
    assert.ok(!html.includes('<table>'));
});

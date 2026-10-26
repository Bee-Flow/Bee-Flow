// @typecheck strict
/**
 * Edit results report validation for the page that was edited, plus one summary
 * line for the other empty pages, instead of an empty_page warning per page.
 *
 * Run: node --test cms/mcp/siteContext.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createSiteContext, scopeValidation } = require('./siteContext');

/** @param {string} id */
const emptyPage = (id) => ({ code: 'empty_page', path: `pages.${id}`, message: `Page ${id} has no blocks yet.`, hint: 'x' });

test('scopeValidation: other empty pages collapse into one summary warning', () => {
    const v = { errors: /** @type {any[]} */ ([]), warnings: [emptyPage('pg_1'), emptyPage('pg_2'), emptyPage('pg_3'), { code: 'unknown_icon', path: 'pages.pg_2.blocks[0].content.icon', message: 'm' }] };
    const out = scopeValidation(v, new Set(['pg_1']));
    const codes = out.warnings.map((w) => w.code);
    assert.deepStrictEqual(codes.filter((c) => c === 'empty_page'), ['empty_page'], 'the edited page keeps its own warning');
    assert.ok(out.warnings.some((w) => w.code === 'other_empty_pages' && w.message.includes('2')), JSON.stringify(out.warnings));
    assert.ok(codes.includes('unknown_icon'), 'non-empty-page warnings are untouched');
});

test('scopeValidation: a single other empty page is kept as is; none → unchanged', () => {
    const one = { errors: /** @type {any[]} */ ([]), warnings: [emptyPage('pg_2')] };
    assert.deepStrictEqual(scopeValidation(one, new Set(['pg_1'])).warnings.map((w) => w.code), ['empty_page']);
    const none = { errors: [{ code: 'e' }], warnings: /** @type {any[]} */ ([]) };
    assert.deepStrictEqual(scopeValidation(none, new Set()), none);
});

test('runBuilderTool: the validation in an edit result is scoped to the touched page', async () => {
    const draft = { touchedPageIds: new Set(['pg_1']), pages: new Map() };
    const ctx = createSiteContext({
        cmsStore: { getProject: async () => ({}), getAdminPayload: async () => ({ site: {}, pages: /** @type {any[]} */ ([]) }) },
        live: { getLiveSiteId: async () => 'pj_aaaa1111', SITE_ID_RE: /^pj_[a-z0-9]+$/ },
        builder: { MUTATING_TOOLS: new Set(['cms_add_blocks']), applyToolCall: async (/** @type {object} */ d) => { Object.assign(d, draft); return { pageId: 'pg_1' }; } },
        validateDraft: () => ({ errors: /** @type {any[]} */ ([]), warnings: [emptyPage('pg_1'), emptyPage('pg_2'), emptyPage('pg_3'), emptyPage('pg_4')] }),
    });
    const { result } = await ctx.runBuilderTool('cms_add_blocks', {}, { userId: 'u' });
    assert.strictEqual(result.validation.warnings.length, 2, JSON.stringify(result.validation));
});

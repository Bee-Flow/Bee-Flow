// @typecheck
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runLinkCheck, asValidationWarnings } = require('./linkReport');

const store = () => ({
    getAdminPayload: async () => ({
        site: { pages: [{ id: 'pg_1', slug: 'home' }], footer: { links: [{ link: { kind: 'external', url: 'https://example.org/dead?k=1' } }, { link: { kind: 'external', url: 'https://example.org/fine' } }, { link: { kind: 'page', pageId: 'pg_x' } }] } },
        pages: [], localeOverrides: {},
    }),
    getRedirects: async () => ({ redirects: [] }),
    listPosts: async () => [],
});

test('internal only by default: the probe is never called', async () => {
    let called = false;
    const report = await runLinkCheck('pj_aaaa', {}, { cmsStore: store(), probe: async () => { called = true; return { results: new Map(), skipped: 0 }; } });
    assert.equal(called, false);
    assert.equal(report.external.requested, false);
    assert.deepEqual(report.summary, { errors: 1, warnings: 0 });
});

test('external on request: 404 is an error, query string is not reported', async () => {
    const probe = async () => ({ results: new Map([['https://example.org/dead?k=1', { status: 404 }], ['https://example.org/fine', { status: 200 }]]), skipped: 0 });
    const report = await runLinkCheck('pj_aaaa', { external: true }, { cmsStore: store(), probe });
    assert.equal(report.external.checked, 2);
    const gone = report.problems.find((p) => p.code === 'external_gone');
    assert.equal(gone?.url, 'https://example.org/dead');
    assert.ok(!JSON.stringify(report).includes('k=1'));
    assert.equal(asValidationWarnings(report)[0].code, 'broken_link');
});

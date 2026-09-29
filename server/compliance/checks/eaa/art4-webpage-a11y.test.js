/**
 * EAA-Art4-webpage-a11y — per-source static lint of published pages.
 * Run: cd server && node --test --test-force-exit compliance/checks/eaa/art4-webpage-a11y.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const ORG = 'org-a';
const fx = {
    settings: {},
    webpages: [],
    slots: {},          // `${owner}/${id}/${version}` → html
    queries: [],
    dbError: null,
    mode: 'self-hosted',
    cmsProjects: [],
    cmsSnapshot: null,
    cmsEffective: null,
    shell: null,
};

const restore = installResolveStub({
    '../../../db': {
        getAll: async (sql, params) => {
            fx.queries.push({ sql, params });
            if (fx.dbError) { const e = new Error('boom'); e.code = fx.dbError; throw e; }
            assert.match(sql, /organization_id = \$1/, 'every query is org-scoped');
            return fx.webpages.slice(0, params[1]);
        },
    },
    '../../../stores/complianceStore': { getSettings: async (orgId) => ({ organization_id: orgId, ...fx.settings }) },
    '../../../stores/webpage/storage': {
        readSlot: async (owner, id, slot, version) => {
            assert.equal(slot, 'html');
            return fx.slots[`${owner}/${id}/${version || 'live'}`] ?? '';
        },
    },
    '../../../license': { deploymentMode: () => fx.mode },
    '../../../stores/cmsStore': {
        listProjects: async () => fx.cmsProjects,
        getPublishedSnapshot: async () => fx.cmsSnapshot,
        getDefaultLocale: async () => 'nl',
        getEffectivePublished: async () => fx.cmsEffective,
    },
    '../../../core/seo/shell': { getShell: async () => fx.shell },
});
const check = require('./art4-webpage-a11y');
test.after(() => restore());

test.beforeEach(() => {
    fx.settings = {};
    fx.webpages = [];
    fx.slots = {};
    fx.queries = [];
    fx.dbError = null;
    fx.mode = 'self-hosted';
    fx.cmsProjects = [];
    fx.cmsSnapshot = null;
    fx.cmsEffective = null;
    fx.shell = null;
});

const GOOD = '<!DOCTYPE html><html lang="en"><head><title>Hello</title></head><body><h1>Hi</h1><p>Text</p><a href="/x">Read the terms</a></body></html>';
const BAD = '<!DOCTYPE html><html><head></head><body><img src="a.png"><button></button><a href="/x"></a></body></html>';
const WARNY = '<!DOCTYPE html><html lang="en"><head><title>T</title></head><body><h1>A</h1><h3>skip</h3><a href="/x">click here</a></body></html>';

function page(id, extra = {}) {
    return { id, name: `Page ${id}`, user_id: 'owner-1', published_version_id: `v-${id}`, settings: {}, updated_at: '2026-09-01', ...extra };
}

test('contract shape', () => {
    assert.equal(check.id, 'EAA-Art4-webpage-a11y');
    assert.equal(check.regulation, 'EAA');
    assert.equal(check.scope, 'per-source');
    assert.equal(check.verification, 'automated');
    assert.equal(typeof check.listSubjects, 'function');
    assert.ok(!check.remediationLink.includes('?'));
    for (const k of ['titleKey', 'descriptionKey', 'remediationKey']) assert.match(check[k], /^compliance\.check_eaa_webpage_a11y_(title|desc|fix)$/);
});

test('relevance gate — no subjects and not_applicable', async () => {
    fx.settings = { framework_relevance: { eaa: 'not_relevant' } };
    fx.webpages = [page('w1')];
    assert.deepEqual(await check.listSubjects(ORG), []);
    const r = await check.evaluate(ORG, { id: 'webpage:w1' });
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('listSubjects: published webpages of the org, capped at 200, with CMS pages on self-host', async () => {
    fx.webpages = [page('w1'), page('w2', { settings: JSON.stringify({ framework: 'react-mui' }) })];
    fx.cmsProjects = [{ id: 'site1', name: 'Site' }];
    fx.cmsSnapshot = { site: { pages: [{ id: 'p1', title: 'Home', slug: 'home', isHomepage: true }, { id: 'p2', title: 'Pricing', slug: 'pricing' }] } };
    const subjects = await check.listSubjects(ORG);
    assert.equal(subjects.length, 4);
    assert.deepEqual(subjects.map(s => s.id), ['webpage:w1', 'webpage:w2', 'cms:site1:p1', 'cms:site1:p2']);
    assert.equal(subjects[1].framework, 'react-mui');
    assert.equal(subjects[2].slug, '');
    assert.equal(subjects[3].slug, 'pricing');
    assert.equal(fx.queries[0].params[0], ORG);
    assert.equal(fx.queries[0].params[1], check.SUBJECT_CAP + 1);
    assert.ok(subjects.every(s => s.label && s.name));
});

test('listSubjects: on cloud the CMS is platform-owned and excluded', async () => {
    fx.mode = 'cloud';
    fx.webpages = [page('w1')];
    fx.cmsProjects = [{ id: 'site1' }];
    fx.cmsSnapshot = { site: { pages: [{ id: 'p1', title: 'Home' }] } };
    const subjects = await check.listSubjects(ORG);
    assert.deepEqual(subjects.map(s => s.id), ['webpage:w1']);
});

test('listSubjects: the cap marks every subject when more pages exist', async () => {
    fx.webpages = Array.from({ length: 201 }, (_, i) => page(`w${i}`));
    const subjects = await check.listSubjects(ORG);
    assert.equal(subjects.length, 200);
    assert.equal(subjects[0].capped, true);
    assert.equal(subjects[0].total_published, 201);
});

test('listSubjects: missing webpages table → no subjects, no throw', async () => {
    fx.dbError = '42P01';
    assert.deepEqual(await check.listSubjects(ORG), []);
});

test('good page → pass with html_sha256 and rules_checked', async () => {
    const subj = { id: 'webpage:w1', label: 'Page w1', kind: 'webpage', webpage_id: 'w1', owner_id: 'owner-1', published_version_id: 'v-w1' };
    fx.slots['owner-1/w1/v-w1'] = GOOD;
    const r = await check.evaluate(ORG, subj);
    assert.equal(r.status, 'pass');
    assert.match(r.evidence.html_sha256, /^[a-f0-9]{64}$/);
    assert.ok(r.evidence.rules_checked.includes('html-lang'));
    assert.equal(r.evidence.published_version_id, 'v-w1');
    assert.deepEqual(r.evidence.errors, []);
});

test('error-class findings → fail with per-rule counts and ≤10 samples', async () => {
    const subj = { id: 'webpage:w1', label: 'Page w1', kind: 'webpage', webpage_id: 'w1', owner_id: 'owner-1', published_version_id: 'v-w1' };
    fx.slots['owner-1/w1/v-w1'] = BAD;
    const r = await check.evaluate(ORG, subj);
    assert.equal(r.status, 'fail');
    const rules = r.evidence.errors.map(e => e.rule);
    for (const want of ['html-lang', 'img-alt', 'button-name', 'link-name', 'page-title']) assert.ok(rules.includes(want), `expected ${want} in ${rules}`);
    for (const e of r.evidence.errors) assert.ok(e.samples.length <= 10);
    assert.match(r.details, /error-class/);
});

test('warnings only → warn', async () => {
    const subj = { id: 'webpage:w1', label: 'Page w1', kind: 'webpage', webpage_id: 'w1', owner_id: 'owner-1', published_version_id: 'v-w1' };
    fx.slots['owner-1/w1/v-w1'] = WARNY;
    const r = await check.evaluate(ORG, subj);
    assert.equal(r.status, 'warn');
    assert.deepEqual(r.evidence.errors, []);
    assert.ok(r.evidence.warnings.length >= 1);
});

test('a body-only slot is wrapped like the viewer wraps it — and so fails html-lang', async () => {
    const subj = { id: 'webpage:w1', label: 'Page w1', kind: 'webpage', webpage_id: 'w1', owner_id: 'owner-1', published_version_id: null };
    fx.slots['owner-1/w1/live'] = '<h1>Fragment</h1><p>Body only</p>';
    const r = await check.evaluate(ORG, subj);
    assert.equal(r.status, 'fail');
    assert.ok(r.evidence.errors.some(e => e.rule === 'html-lang'));
});

test('empty html slot: react-mui → not_applicable (client rendered); other → warn', async () => {
    const rm = { id: 'webpage:w2', label: 'App', kind: 'webpage', webpage_id: 'w2', owner_id: 'owner-1', published_version_id: 'v', framework: 'react-mui' };
    let r = await check.evaluate(ORG, rm);
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.reason, 'client_rendered');
    const vanilla = { ...rm, framework: 'vanilla', id: 'webpage:w3', webpage_id: 'w3' };
    r = await check.evaluate(ORG, vanilla);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.reason, 'empty_html');
});

test('CMS page: rendered through renderBlocks + the public shell (fallback shell when agent-hub is unreachable)', async () => {
    const subj = { id: 'cms:site1:p1', label: 'Home', kind: 'cms', site_id: 'site1', page_id: 'p1', slug: '' };
    fx.cmsEffective = {
        found: true,
        page: { id: 'p1', title: 'Welkom', slug: '', isHomepage: true, blocks: [{ type: 'hero', enabled: true, content: { title: 'Welkom', text: 'Hallo wereld' } }] },
        header: { logoText: 'Acme' }, design: {},
    };
    const r = await check.evaluate(ORG, subj);
    assert.ok(['pass', 'warn'].includes(r.status), `got ${r.status}: ${r.details}`);
    assert.equal(r.evidence.lang, 'nl');
    assert.equal(r.evidence.kind, 'cms');
    assert.deepEqual(r.evidence.errors, []);
    assert.match(r.evidence.html_sha256, /^[a-f0-9]{64}$/);
});

test('CMS page missing from the snapshot → warn, never throw', async () => {
    fx.cmsEffective = { found: false, page: null };
    const r = await check.evaluate(ORG, { id: 'cms:site1:p9', label: 'Gone', kind: 'cms', site_id: 'site1', page_id: 'p9', slug: 'gone' });
    assert.equal(r.status, 'warn');
    assert.match(r.details, /could not be rendered/);
});

test('storage failure → warn with a bounded error, no throw', async () => {
    const subj = { id: 'webpage:w1', label: 'Page w1', kind: 'webpage', webpage_id: 'w1', owner_id: 'owner-1', published_version_id: 'v-w1' };
    const storage = require('../../../stores/webpage/storage');
    const orig = storage.readSlot;
    storage.readSlot = async () => { throw new Error('RustFS down'); };
    try {
        const r = await check.evaluate(ORG, subj);
        assert.equal(r.status, 'warn');
        assert.equal(r.evidence.reason, 'read_failed');
    } finally { storage.readSlot = orig; }
});

test('evidence carries no e-mail addresses even when the page does', async () => {
    const subj = { id: 'webpage:w1', label: 'Page w1', kind: 'webpage', webpage_id: 'w1', owner_id: 'owner-1', published_version_id: 'v-w1' };
    fx.slots['owner-1/w1/v-w1'] = '<!DOCTYPE html><html><head></head><body><a href="mailto:jane.doe@example.org"></a><img src="x.png" title="mail jane.doe@example.org"></body></html>';
    const r = await check.evaluate(ORG, subj);
    assert.equal(r.status, 'fail');
    assert.ok(!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(JSON.stringify(r.evidence)), 'no e-mail in evidence');
    assert.ok(!/@/.test(r.details));
});

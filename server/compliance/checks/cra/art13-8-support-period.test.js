// @typecheck
/**
 * CRA Art. 13(8) support period: relevance/role gates (with the products
 * hint), missing declaration → fail, passed / near end-of-support → warn,
 * declared → pass, DATE-typed column tolerated, missing tables tolerated in
 * the hint, and evidence free of the update-channel address. The products
 * hint runs on a real Postgres.
 *
 * Run: cd server && node --test compliance/checks/cra/art13-8-support-period.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const { usePglitePool } = require('../../../testUtils/pglitePool');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { hideTable } = require('../../../testUtils/pgliteFaults');
const { insertRow } = require('../../../testUtils/pgliteSeed');

const D = 86400e3;
/** @type {{ settings: Record<string, unknown> }} */
const state = { settings: {} };

// The products hint reads the boot ladder's schema on PGlite
// (testUtils/pgliteTemplate.js) behind db.js's pool. The settings are stubbed:
// the declarations under test include values the settings store would refuse
// to save (a date of "someday"), which is exactly what the check must survive.
const { pg, close } = usePglitePool(ladderPglite());
const restore = installResolveStub({
    '../../../stores/complianceStore': { async getSettings() { return state.settings; } },
});
const check = require('./art13-8-support-period');
test.after(async () => { restore(); await close(); });

/** Products placed on the market by `org`: gallery releases, public app pages, published webpages. */
async function products(org, { releases = 0, publicPages = 0, webpages = 0, unpublishedWebpages = 0 } = {}) {
    const project = await insertRow(pg, 'projects', { id: `p_${org}_${Math.random().toString(36).slice(2)}`, name: 'P', owner_id: 'u', organization_id: org });
    for (let i = 0; i < releases; i++) {
        await insertRow(pg, 'project_releases', { id: `r_${project.id}_${i}`, project_id: project.id, version: i + 1, manifest: {}, published_by: 'u', channel: 'gallery' });
    }
    await insertRow(pg, 'project_releases', { id: `r_${project.id}_pipe`, project_id: project.id, version: 99, manifest: {}, published_by: 'u', channel: 'pipeline' });
    const app = await insertRow(pg, 'studio_apps', { id: `a_${project.id}`, user_id: 'u', organization_id: org });
    for (let i = 0; i < publicPages; i++) await insertRow(pg, 'studio_app_public_pages', { id: `pp_${app.id}_${i}`, app_id: app.id });
    for (let i = 0; i < webpages + unpublishedWebpages; i++) {
        await insertRow(pg, 'webpages', { id: `w_${project.id}_${i}`, user_id: 'u', organization_id: org, is_published: i < webpages });
    }
}

const iso = (daysFromNow) => new Date(Date.now() + daysFromNow * D).toISOString().slice(0, 10);
const GOOD = {
    framework_relevance: { cra: 'relevant' },
    cra_role: 'manufacturer',
    support_policy_url: 'https://www.example.com/support-policy',
    support_end_date: iso(3 * 365),
    security_update_channel: 'mailto:updates@example.com',
};

test.beforeEach(async () => {
    state.settings = { ...GOOD };
    await pg.exec('DELETE FROM studio_app_public_pages; DELETE FROM studio_apps; DELETE FROM webpages; DELETE FROM project_releases; DELETE FROM projects');
});

function noPersonalData(r) {
    const blob = JSON.stringify(r.evidence) + (r.details || '');
    assert.ok(!/@/.test(blob), `evidence/details must not carry an address: ${blob}`);
}

test('module shape: id with the paragraph, attestation, medium, PLD tag, settings deep-link', () => {
    assert.equal(check.id, 'CRA-Art13(8)-support-period');
    assert.equal(check.regulation, 'CRA');
    assert.equal(check.article, 'Art. 13(8)');
    assert.equal(check.severity, 'medium');
    assert.equal(check.scope, 'global');
    assert.equal(check.verification, 'attestation');
    assert.deepEqual(check.frameworks, [{ regulation: 'PLD', ref: 'Art. 11(2)(c)' }]);
    assert.equal(check.remediationLink, 'admin/compliance/settings');
    assert.equal(check.titleKey, 'compliance.check_cra_support_period_title');
});

test('relevance gate: CRA not relevant → not_applicable before any query', async () => {
    state.settings = { ...GOOD, framework_relevance: { cra: 'not_relevant' } };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
});

test('role gate: distributor / user_only / undeclared → not_applicable; the hint names detected products, org-scoped', async () => {
    state.settings = { ...GOOD, cra_role: 'distributor' };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.cra_role, 'distributor');
    assert.equal(r.evidence.products_hint.any, false);
    assert.match(r.details, /no products placed on the market were detected/);

    // Another organisation's products, and an unpublished page, are not org1's.
    await products('org2', { releases: 5, publicPages: 5, webpages: 5 });
    await products('org1', { unpublishedWebpages: 1 });
    assert.equal((await check.evaluate('org1')).evidence.products_hint.any, false);

    state.settings = { ...GOOD, cra_role: null };
    await products('org1', { releases: 3, webpages: 2 });
    const r2 = await check.evaluate('org1');
    assert.equal(r2.status, 'not_applicable');
    assert.equal(r2.evidence.products_hint.any, true);
    assert.equal(r2.evidence.products_hint.solution_releases, 3);
    assert.match(r2.details, /no CRA role has been declared/);
    assert.match(r2.details, /3 solution release\(s\), 2 published webpage\(s\)/);
    assert.match(r2.details, /declare the manufacturer role/);
});

test('hint tolerates missing product tables (42P01) — that number is simply unknown', async () => {
    state.settings = { ...GOOD, cra_role: 'user_only' };
    await products('org1', { releases: 2, publicPages: 2, webpages: 1 });
    const restores = [await hideTable(pg, 'project_releases'), await hideTable(pg, 'studio_app_public_pages')];
    let r;
    try { r = await check.evaluate('org1'); } finally { for (const undo of restores.reverse()) await undo(); }
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.evidence.products_hint.solution_releases, null);
    assert.equal(r.evidence.products_hint.public_app_pages, null);
    assert.equal(r.evidence.products_hint.published_webpages, 1);
    assert.equal(r.evidence.products_hint.any, true);
});

test('manufacturer without URL or date → fail, each gap named; nothing queried', async () => {
    state.settings = { framework_relevance: {}, cra_role: 'manufacturer' };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.support_policy_url_set, false);
    assert.equal(r.evidence.support_end_date, null);
    assert.match(r.details, /no support policy URL and no end-of-support date/);

    state.settings = { ...GOOD, support_policy_url: 'not a url', support_end_date: 'someday' };
    const r2 = await check.evaluate('org1');
    assert.equal(r2.status, 'fail');
    assert.match(r2.details, /not a valid http\(s\) address/);
    assert.match(r2.details, /not a valid date/);
});

test('end-of-support already passed → warn', async () => {
    state.settings = { ...GOOD, support_end_date: iso(-40) };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.ok(r.evidence.days_remaining < 0);
    assert.match(r.details, /has passed/);
});

test('end-of-support inside 12 months → warn (partial)', async () => {
    state.settings = { ...GOOD, support_end_date: iso(200) };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'warn');
    assert.ok(r.evidence.days_remaining >= 199 && r.evidence.days_remaining <= 200);
    assert.match(r.details, /12-month renewal horizon/);
    noPersonalData(r);
});

test('declared with > 12 months left → pass; the update channel is recorded as a boolean only', async () => {
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.support_policy_url, 'https://www.example.com/support-policy');
    assert.equal(r.evidence.security_update_channel_set, true);
    assert.ok(r.evidence.days_remaining > 1000);
    assert.equal('security_update_channel' in r.evidence, false);
    noPersonalData(r);
});

test('a DATE column arrives as a Date object and is normalised to YYYY-MM-DD', async () => {
    state.settings = { ...GOOD, support_end_date: new Date(Date.now() + 800 * D) };
    const r = await check.evaluate('org1');
    assert.equal(r.status, 'pass');
    assert.match(r.evidence.support_end_date, /^\d{4}-\d{2}-\d{2}$/);
});

test('_daysUntil counts to the end of the given day', () => {
    const { _daysUntil } = check._test;
    const now = Date.parse('2026-09-14T12:00:00Z');
    assert.equal(_daysUntil('2026-09-14', now), 0);
    assert.equal(_daysUntil('2026-09-15', now), 1);
    assert.equal(_daysUntil('2026-09-13', now), -1);
    assert.equal(_daysUntil(null, now), null);
});

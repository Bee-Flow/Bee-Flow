/**
 * PLD Art. 9 release record: subject listing (relevance gate, empty org →
 * [], org-scoped queries, missing tables tolerated), the platform subject
 * (dev build → warn, log table missing → warn 'not provisioned yet', SQL
 * upsert → pass with the previous build, store present → pass via the
 * store), the org subjects (no release → fail, modified after the grace
 * window → warn, released → pass), and evidence free of personal data.
 *
 * The listing and the release log run on a real Postgres: the boot ladder's
 * schema on PGlite (testUtils/pgliteTemplate.js) behind db.js's pool,
 * recorded by testUtils/routeHarness.js. The settings, the SBOM locator and
 * the build stamp are stubbed: they are this check's inputs.
 *
 * Run: cd server && node --test compliance/checks/pld/art9-release-record.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { installResolveStub } = require('../../../testUtils/stubRequire');
const { ladderPglite } = require('../../../testUtils/pgliteTemplate');
const { insertRow } = require('../../../testUtils/pgliteSeed');
const { hideTable, failReads } = require('../../../testUtils/pgliteFaults');
const { pinPgliteNow } = require('../../../testUtils/pgliteClock');
const { recordDb } = require('../../../testUtils/routeHarness');

const D = 86400e3;
const STORE_REQUEST = '../../../stores/platformReleaseStore';
const CHECK_PATH = require.resolve('./art9-release-record');

const pg = ladderPglite();
const rec = recordDb(undefined, { pg });

const state = {
    settings: /** @type {Record<string, any>} */ ({}),
    sbom: /** @type {{ format: string | null, path: string | null, sha256: string | null }} */ ({ format: null, path: null, sha256: null }),
    store: /** @type {any} */ (null), // null → the store module is "absent"; object → stubbed exports
};

const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeLocator = { async locate() { return state.sbom; }, candidates: () => [] };

let restoreStub = null;
let restoreResolve = null;

/**
 * Load the check fresh with a given build stamp. APP_BUILD_SHA is destructured
 * at module load, so each build variant needs its own require.
 * The platformReleaseStore request is routed to `state.store` when set, and
 * made to throw MODULE_NOT_FOUND when null: the check must work either way.
 */
function loadCheck({ sha = 'abc1234def5678900000000000000000deadbeef', version = '9.9.9' } = {}) {
    unload();
    restoreStub = installResolveStub({
        '../../../stores/complianceStore': fakeComplianceStore,
        '../../lib/sbomLocator': fakeLocator,
        '../../../utils/buildInfo': { APP_BUILD_SHA: sha },
        '../../../version': { APP_VERSION: version },
    });
    const stubbedResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, ...rest) {
        if (request === STORE_REQUEST) {
            if (state.store) {
                const id = 'stub:platformReleaseStore';
                require.cache[id] = /** @type {any} */ ({ id, filename: id, loaded: true, exports: state.store, children: [], paths: [] });
                return id;
            }
            throw Object.assign(new Error(`Cannot find module '${request}'`), { code: 'MODULE_NOT_FOUND' });
        }
        return stubbedResolve.call(this, request, ...rest);
    };
    restoreResolve = () => { Module._resolveFilename = stubbedResolve; delete require.cache['stub:platformReleaseStore']; };
    return require(CHECK_PATH);
}

function unload() {
    delete require.cache[CHECK_PATH];
    if (restoreResolve) { restoreResolve(); restoreResolve = null; }
    if (restoreStub) { restoreStub(); restoreStub = null; }
}

const NOW = new Date('2026-09-14T09:00:00.000Z');
/** @type {{ set: (at: Date | string) => Promise<void> }} */
let clock;
test.before(async () => { clock = await pinPgliteNow(pg, NOW); });
test.after(async () => { unload(); await pg.close(); });

const daysAgo = (n) => new Date(Date.now() - n * D);

let seq = 0;
/** A solution of org1 with `releases` gallery releases, the newest `lastReleaseDaysAgo` back. */
async function solution(id, { releases = 1, lastReleaseDaysAgo = 30, updatedDaysAgo = 40, version = 2, name = `Solution ${id}`, org = 'org1' } = {}) {
    await insertRow(pg, 'projects', { id, name, owner_id: 'u1', organization_id: org, updated_at: daysAgo(updatedDaysAgo) });
    for (let i = 0; i < releases; i++) {
        await insertRow(pg, 'project_releases', {
            id: `rel-${++seq}`, project_id: id, channel: 'gallery', version: version - i, manifest: {}, published_by: 'u1',
            published_at: daysAgo(lastReleaseDaysAgo + i),
        });
    }
}
/** A webpage of org1; `releases` published snapshots, the newest `lastReleaseDaysAgo` back. */
async function webpage(id, { releases = 1, lastReleaseDaysAgo = 10, updatedDaysAgo = 12, name = `Page ${id}`, published = true, org = 'org1' } = {}) {
    await insertRow(pg, 'webpages', { id, user_id: 'u1', name, organization_id: org, is_published: published, updated_at: daysAgo(updatedDaysAgo) });
    for (let i = 0; i < releases; i++) {
        await insertRow(pg, 'webpage_versions', { id: `v-${id}-${i}`, webpage_id: id, source: 'published', created_at: daysAgo(lastReleaseDaysAgo + i) });
    }
}
const releaseLog = async () => (await pg.query('SELECT * FROM platform_release_log ORDER BY first_seen_at')).rows;

test.beforeEach(async () => {
    state.settings = { framework_relevance: {} };
    state.sbom = { format: null, path: null, sha256: null };
    state.store = null;
    await pg.exec('TRUNCATE projects, project_releases, webpages, webpage_versions, platform_release_log CASCADE');
    await clock.set(NOW);
    rec.reset();
});

function noPersonalData(r) {
    const blob = JSON.stringify(r.evidence) + (r.details || '');
    assert.ok(!/@/.test(blob), `evidence/details must not carry an address: ${blob}`);
}

function solutionRow(id, { releases = 1, lastReleaseDaysAgo = 30, updatedDaysAgo = 40, version = '1.2.0', name = `Solution ${id}` } = {}) {
    return {
        id, name,
        updated_at: daysAgo(updatedDaysAgo),
        release_count: releases,
        last_release_at: releases ? daysAgo(lastReleaseDaysAgo) : null,
        last_version: releases ? version : null,
    };
}
function webpageRow(id, { releases = 1, lastReleaseDaysAgo = 10, updatedDaysAgo = 12, name = `Page ${id}` } = {}) {
    return {
        id, name,
        updated_at: daysAgo(updatedDaysAgo),
        published_version_id: releases ? `v-${id}` : null,
        release_count: releases,
        last_release_at: releases ? daysAgo(lastReleaseDaysAgo) : null,
    };
}

test('module shape: PLD home, per-source automated, CRA + ISO tags, i18n keys, Studio deep-link without "?"', () => {
    const check = loadCheck();
    assert.equal(check.id, 'PLD-Art9-release-record');
    assert.match(check.id, /^(NIS2|CRA|DATA_ACT|PLD|EAA|DORA|MACHINERY)-(Art[\w().-]+|AnnexI-[\w.]+)-[\w()-]+$/);
    assert.equal(check.regulation, 'PLD');
    assert.equal(check.article, 'Art. 9');
    assert.equal(check.severity, 'high');
    assert.equal(check.scope, 'per-source');
    assert.equal(check.verification, 'automated');
    assert.equal(typeof check.listSubjects, 'function');
    assert.deepEqual(check.frameworks, [
        { regulation: 'CRA', ref: 'Art. 13' },
        { regulation: 'ISO27001', ref: 'A.8.32' },
    ]);
    assert.equal(check.titleKey, 'compliance.check_pld_release_record_title');
    assert.equal(check.descriptionKey, 'compliance.check_pld_release_record_desc');
    assert.equal(check.remediationKey, 'compliance.check_pld_release_record_fix');
    assert.equal(check.remediationLink, 'studio/solutions');
    assert.ok(!check.remediationLink.includes('?'));
});

test('listSubjects: PLD not relevant → [] without touching the database', async () => {
    const check = loadCheck();
    state.settings = { framework_relevance: { pld: 'not_relevant' } };
    await solution('p1');
    rec.reset();
    assert.deepEqual(await check.listSubjects('org1'), []);
    assert.equal(rec.queries.length, 0);
});

test('listSubjects: an org that places nothing on the market → [] (runner emits not_applicable)', async () => {
    const check = loadCheck();
    await solution('p-other', { org: 'org2' });
    await webpage('w-other', { org: 'org2' });
    assert.deepEqual(await check.listSubjects('org1'), [], 'another organisation\'s products are not this one\'s');
});

test('listSubjects: relevance "relevant" keeps the platform subject even with no org products', async () => {
    const check = loadCheck();
    state.settings = { framework_relevance: { pld: 'relevant' } };
    const subjects = await check.listSubjects('org1');
    assert.equal(subjects.length, 1);
    assert.equal(subjects[0].id, 'platform');
    assert.equal(subjects[0].kind, 'platform');
    assert.equal(subjects[0].org_subjects, 0);
});

test('listSubjects: platform first, then solutions with gallery releases and published webpages; ids prefixed by kind', async () => {
    const check = loadCheck();
    await solution('p1', { updatedDaysAgo: 40 });
    await solution('p2', { releases: 3, updatedDaysAgo: 50, version: 5 });
    await solution('p-none', { releases: 0 });
    await insertRow(pg, 'projects', { id: 'p-pipeline', name: 'Pipeline only', owner_id: 'u1', organization_id: 'org1' });
    await insertRow(pg, 'project_releases', { id: 'rel-pipeline', project_id: 'p-pipeline', channel: 'pipeline', version: 1, manifest: {}, published_by: 'u1' });
    await webpage('w1');
    await webpage('w-draft', { published: false });
    // A pinned legacy snapshot is a release record too.
    await webpage('w-legacy', { releases: 0, updatedDaysAgo: 20 });
    await insertRow(pg, 'webpage_versions', { id: 'v-pinned', webpage_id: 'w-legacy', source: 'autosave', created_at: daysAgo(21) });
    await pg.query(`UPDATE webpages SET published_version_id = 'v-pinned' WHERE id = 'w-legacy'`);

    const subjects = await check.listSubjects('org1');
    assert.deepEqual(subjects.map((s) => s.id), ['platform', 'solution:p1', 'solution:p2', 'webpage:w1', 'webpage:w-legacy'],
        'only gallery releases make a solution a product; a draft page is not on the market');
    assert.equal(subjects[0].org_subjects, 4);
    assert.deepEqual(subjects[0].not_provisioned, []);
    const p2 = subjects.find((s) => s.id === 'solution:p2');
    assert.equal(p2.release_count, 3);
    assert.equal(p2.last_version, 5, 'the newest release\'s version');
    assert.equal(p2.entity_id, 'p2');
    assert.equal(p2.label, 'Solution p2');
    assert.equal(p2.name, 'Solution p2');
    assert.match(p2.last_release_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(subjects.find((s) => s.id === 'webpage:w-legacy').release_count, 1);
});

test('listSubjects: a missing table blanks only that source and is reported on the platform subject', async () => {
    const check = loadCheck();
    await solution('p1');
    await webpage('w1');
    const restore = await hideTable(pg, 'project_releases');
    try {
        const subjects = await check.listSubjects('org1');
        assert.deepEqual(subjects.map((s) => s.id), ['platform', 'webpage:w1']);
        assert.deepEqual(subjects[0].not_provisioned, ['project_releases']);
    } finally { await restore(); }
});

test('listSubjects: a non-schema database error still propagates', async () => {
    const check = loadCheck();
    const restore = await failReads(pg, 'webpages', '08006', 'connection refused');
    try {
        await assert.rejects(() => check.listSubjects('org1'), /connection refused/);
    } finally { await restore(); }
});

test('evaluate: relevance gate → not_applicable with evidence.relevance for any subject', async () => {
    const check = loadCheck();
    state.settings = { framework_relevance: { pld: 'not_relevant' } };
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.equal(rec.queries.length, 0);
    assert.deepEqual(await releaseLog(), []);
});

test('evaluate: no subject → not_applicable', async () => {
    const check = loadCheck();
    const r = await check.evaluate('org1', null);
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { subjects: 0 });
});

test('org subject: a solution without a release → fail, names the Studio location', async () => {
    const check = loadCheck();
    const [subject] = [solutionRow('p1', { releases: 0 })].map(r => check._test._orgSubject('solution', r));
    const r = await check.evaluate('org1', subject);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.kind, 'solution');
    assert.equal(r.evidence.entity_id, 'p1');
    assert.equal(r.evidence.release_count, 0);
    assert.equal(r.evidence.last_release_at, null);
    assert.match(r.details, /no recorded release/);
    assert.match(r.details, /Studio → Solutions/);
    assert.equal(rec.queries.length, 0, 'org subjects evaluate without a query');
    noPersonalData(r);
});

test('org subject: a published webpage without a frozen snapshot → fail', async () => {
    const check = loadCheck();
    const subject = check._test._orgSubject('webpage', webpageRow('w1', { releases: 0 }));
    const r = await check.evaluate('org1', subject);
    assert.equal(r.status, 'fail');
    assert.equal(r.evidence.kind, 'webpage');
    assert.match(r.details, /no frozen published snapshot/);
    assert.match(r.details, /Studio → Webpages/);
});

test('org subject: modified more than 7 days after the last release → warn (substantial modification)', async () => {
    const check = loadCheck();
    const subject = check._test._orgSubject('solution', solutionRow('p1', { lastReleaseDaysAgo: 60, updatedDaysAgo: 5, version: 2 }));
    const r = await check.evaluate('org1', subject);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.modified_after_release, true);
    assert.equal(r.evidence.grace_days, 7);
    assert.equal(r.evidence.last_version, 2);
    assert.equal(r.evidence.days_since_release, 60);
    assert.match(r.details, /modified 55 day\(s\) after its last release \(v2\)/);
    assert.match(r.details, /Art\. 8\(2\)/);
    noPersonalData(r);
});

test('org subject: modified inside the grace window → still pass', async () => {
    const check = loadCheck();
    const subject = check._test._orgSubject('solution', solutionRow('p1', { lastReleaseDaysAgo: 10, updatedDaysAgo: 6 }));
    const r = await check.evaluate('org1', subject);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.modified_after_release, false);
});

test('org subject: released and untouched since → pass with the release on record', async () => {
    const check = loadCheck();
    const subject = check._test._orgSubject('webpage', webpageRow('w1', { releases: 4, lastReleaseDaysAgo: 3, updatedDaysAgo: 3 }));
    const r = await check.evaluate('org1', subject);
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.release_count, 4);
    assert.match(r.details, /4 release\(s\)/);
    assert.match(r.evidence.last_release_at, /^\d{4}-\d{2}-\d{2}T/);
    noPersonalData(r);
});

test('platform: a "dev" build cannot be tied to a version → warn, nothing written', async () => {
    const check = loadCheck({ sha: 'dev' });
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform', org_subjects: 2 });
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.build_sha, 'dev');
    assert.equal(r.evidence.app_version, '9.9.9');
    assert.equal(r.evidence.org_subjects, 2);
    assert.match(r.details, /APP_BUILD_SHA/);
    assert.equal(rec.queries.length, 0);
    assert.deepEqual(await releaseLog(), []);
});

test('platform: release log table missing → warn "not provisioned yet"', async () => {
    const check = loadCheck();
    const restore = await hideTable(pg, 'platform_release_log');
    try {
        const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
        assert.equal(r.status, 'warn');
        assert.equal(r.evidence.release_log_provisioned, false);
        assert.match(r.details, /not provisioned yet/);
    } finally { await restore(); }
});

test('platform: first sighting is stamped via SQL and passes; a later build names its predecessor', async () => {
    const check = loadCheck({ sha: 'abc1234def5678900000000000000000deadbeef' });
    state.sbom = { format: 'cyclonedx', path: '/app/sbom/cyclonedx.json', sha256: 'f'.repeat(64) };
    const first = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(first.status, 'pass');
    assert.equal(first.evidence.release_log_via, 'sql');
    assert.equal(first.evidence.release_log_provisioned, true);
    assert.equal(first.evidence.build_sha, 'abc1234def5678900000000000000000deadbeef');
    assert.equal(first.evidence.first_seen_at, NOW.toISOString());
    assert.equal(first.evidence.previous_build_sha, null);
    assert.equal(first.evidence.builds_logged, 1);
    assert.equal(first.evidence.sbom_hash, 'f'.repeat(64));
    assert.match(first.details, /SBOM hash attached/);
    assert.deepEqual((await releaseLog()).map((r) => [r.build_sha, r.app_version, r.sbom_hash]),
        [['abc1234def5678900000000000000000deadbeef', '9.9.9', 'f'.repeat(64)]]);
    noPersonalData(first);

    // The same build seen again later keeps its first sighting.
    await clock.set(new Date(NOW.getTime() + D));
    const again = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(again.evidence.first_seen_at, NOW.toISOString());
    assert.equal(again.evidence.builds_logged, 1);

    // A newer build arrives on the same log.
    const next = loadCheck({ sha: '0123456789abcdef0123456789abcdef01234567', version: '9.10.0' });
    state.sbom = { format: null, path: null, sha256: null };
    const r = await next.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.previous_build_sha, 'abc1234def5678900000000000000000deadbeef');
    assert.equal(r.evidence.previous_first_seen_at, NOW.toISOString());
    assert.equal(r.evidence.builds_logged, 2);
    assert.match(r.details, /superseding abc1234def56/);
    // Seen again without an SBOM: the hash on record is kept.
    await loadCheck({ sha: 'abc1234def5678900000000000000000deadbeef' }).evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal((await releaseLog())[0].sbom_hash, 'f'.repeat(64));
});

test('platform: a licences-only artefact contributes no sbom_hash', async () => {
    const check = loadCheck();
    state.sbom = { format: 'licenses-md', path: '/repo/THIRD-PARTY-LICENSES.md', sha256: 'a'.repeat(64) };
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.sbom_hash, null);
    assert.equal(r.evidence.sbom_path, null);
    assert.equal((await releaseLog())[0].sbom_hash, null);
});

test('platform: a locator failure never breaks the release record', async () => {
    const check = loadCheck();
    const orig = fakeLocator.locate;
    fakeLocator.locate = async () => { throw new Error('disk on fire'); };
    try {
        const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
        assert.equal(r.status, 'pass');
        assert.equal(r.evidence.sbom_hash, null);
    } finally {
        fakeLocator.locate = orig;
    }
});

test('platform: when stores/platformReleaseStore is there, its helpers are preferred over the SQL fallback', async () => {
    const calls = [];
    state.store = {
        async recordBuild(args) { calls.push(['recordBuild', args]); return { ...args, first_seen_at: '2026-09-10T08:00:00.000Z' }; },
        async getPreviousBuild(sha) { calls.push(['getPreviousBuild', sha]); return { build_sha: 'feedfacefeedfacefeedfacefeedfacefeedface', app_version: '9.8.0', first_seen_at: '2026-08-30T08:00:00.000Z' }; },
        async countBuilds() { calls.push(['countBuilds']); return 7; },
    };
    const check = loadCheck({ sha: 'abc1234def5678900000000000000000deadbeef' });
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.release_log_via, 'store');
    assert.equal(r.evidence.first_seen_at, '2026-09-10T08:00:00.000Z');
    assert.equal(r.evidence.previous_build_sha, 'feedfacefeedfacefeedfacefeedfacefeedface');
    assert.equal(r.evidence.builds_logged, 7);
    assert.deepEqual(calls.map((c) => c[0]), ['recordBuild', 'getPreviousBuild', 'countBuilds']);
    assert.deepEqual(calls[0][1], { build_sha: 'abc1234def5678900000000000000000deadbeef', app_version: '9.9.9', sbom_hash: null });
    assert.equal(rec.queries.length, 0, 'no direct SQL once the store exists');
});

test('platform: a store module without recordBuild falls back to SQL', async () => {
    state.store = { somethingElse() {} };
    const check = loadCheck();
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.release_log_via, 'sql');
    assert.equal((await releaseLog()).length, 1);
});

test('_test helpers: _orgSubject falls back to the id as label when the name is blank', () => {
    const check = loadCheck();
    const s = check._test._orgSubject('solution', { id: 'p9', name: '   ', release_count: '2', last_release_at: null, updated_at: null });
    assert.equal(s.label, 'p9');
    assert.equal(s.release_count, 2);
    assert.equal(s.last_release_at, null);
    assert.equal(check._test.GRACE_DAYS, 7);
    assert.equal(check._test.PLATFORM_SUBJECT_ID, 'platform');
});

/**
 * PLD Art. 9 release record: subject listing (relevance gate, empty org →
 * [], org-scoped queries, missing tables tolerated), the platform subject
 * (dev build → warn, log table missing → warn 'not provisioned yet', SQL
 * upsert → pass with the previous build, store present → pass via the
 * store), the org subjects (no release → fail, modified after the grace
 * window → warn, released → pass), and evidence free of personal data.
 *
 * Run: cd server && node --test --test-force-exit compliance/checks/pld/art9-release-record.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const { installResolveStub } = require('../../../testUtils/stubRequire');

const D = 86400e3;
const STORE_REQUEST = '../../../stores/platformReleaseStore';
const CHECK_PATH = require.resolve('./art9-release-record');

const state = {
    settings: {},
    solutions: [],
    webpages: [],
    failTables: new Set(),      // 'project_releases' | 'webpages' | 'platform_release_log'
    releaseLog: new Map(),      // build_sha → { build_sha, app_version, first_seen_at, sbom_hash }
    sbom: { format: null, path: null, sha256: null },
    queries: [],
    store: null,                // null → the store module is "absent"; object → stubbed exports
};

function notProvisioned(t) {
    return Object.assign(new Error(`relation "${t}" does not exist`), { code: '42P01' });
}

const fakeDb = {
    async getAll(sql, params) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        state.queries.push({ sql: s, params });
        if (s.includes('JOIN project_releases')) {
            if (state.failTables.has('project_releases')) throw notProvisioned('project_releases');
            return state.solutions;
        }
        if (s.includes('FROM webpages w')) {
            if (state.failTables.has('webpages')) throw notProvisioned('webpages');
            return state.webpages;
        }
        return [];
    },
    async getOne(sql, params) {
        const s = String(sql).replace(/\s+/g, ' ').trim();
        state.queries.push({ sql: s, params });
        if (s.includes('platform_release_log')) {
            if (state.failTables.has('platform_release_log')) throw notProvisioned('platform_release_log');
            if (s.startsWith('INSERT INTO platform_release_log')) {
                const [sha, version, sbomHash] = params;
                const existing = state.releaseLog.get(sha);
                const row = existing
                    ? { ...existing, app_version: version ?? existing.app_version, sbom_hash: sbomHash ?? existing.sbom_hash }
                    : { build_sha: sha, app_version: version, first_seen_at: new Date('2026-09-14T09:00:00Z'), sbom_hash: sbomHash };
                state.releaseLog.set(sha, row);
                return row;
            }
            const others = [...state.releaseLog.values()].filter(r => r.build_sha !== params[0])
                .sort((a, b) => b.first_seen_at - a.first_seen_at);
            const p = others[0] || null;
            return {
                total: state.releaseLog.size,
                previous_build_sha: p?.build_sha || null,
                previous_app_version: p?.app_version || null,
                previous_first_seen_at: p?.first_seen_at || null,
            };
        }
        return null;
    },
    async run() { return { rowCount: 0 }; },
    async exec() {},
};
const fakeComplianceStore = { async getSettings() { return state.settings; } };
const fakeLocator = { async locate() { return state.sbom; }, candidates: () => [] };

let restoreStub = null;
let restoreResolve = null;

/**
 * Load the check fresh with a given build stamp. APP_BUILD_SHA is destructured
 * at module load, so each build variant needs its own require.
 * The platformReleaseStore request is routed to `state.store` when set, and
 * made to throw MODULE_NOT_FOUND when null — the store is being written in
 * parallel and the check must work either way.
 */
function loadCheck({ sha = 'abc1234def5678900000000000000000deadbeef', version = '9.9.9' } = {}) {
    unload();
    restoreStub = installResolveStub({
        '../../../db': fakeDb,
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
                require.cache[id] = { id, filename: id, loaded: true, exports: state.store, children: [], paths: [] };
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

test.after(() => unload());

const daysAgo = (n) => new Date(Date.now() - n * D);

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

test.beforeEach(() => {
    state.settings = { framework_relevance: {} };
    state.solutions = [];
    state.webpages = [];
    state.failTables = new Set();
    state.releaseLog = new Map();
    state.sbom = { format: null, path: null, sha256: null };
    state.queries = [];
    state.store = null;
});

function noPersonalData(r) {
    const blob = JSON.stringify(r.evidence) + (r.details || '');
    assert.ok(!/@/.test(blob), `evidence/details must not carry an address: ${blob}`);
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
    state.solutions = [solutionRow('p1')];
    assert.deepEqual(await check.listSubjects('org1'), []);
    assert.equal(state.queries.length, 0);
});

test('listSubjects: an org that places nothing on the market → [] (runner emits not_applicable)', async () => {
    const check = loadCheck();
    const subjects = await check.listSubjects('org1');
    assert.deepEqual(subjects, []);
    assert.equal(state.queries.length, 2);
    for (const q of state.queries) assert.deepEqual(q.params, ['org1'], 'every listing query is org-scoped');
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

test('listSubjects: platform first, then solutions with releases and published webpages; ids prefixed by kind', async () => {
    const check = loadCheck();
    state.solutions = [solutionRow('p1'), solutionRow('p2', { releases: 3 })];
    state.webpages = [webpageRow('w1')];
    const subjects = await check.listSubjects('org1');
    assert.deepEqual(subjects.map(s => s.id), ['platform', 'solution:p1', 'solution:p2', 'webpage:w1']);
    assert.equal(subjects[0].org_subjects, 3);
    assert.deepEqual(subjects[0].not_provisioned, []);
    const p2 = subjects.find(s => s.id === 'solution:p2');
    assert.equal(p2.release_count, 3);
    assert.equal(p2.entity_id, 'p2');
    assert.equal(p2.label, 'Solution p2');
    assert.equal(p2.name, 'Solution p2');
    assert.match(p2.last_release_at, /^\d{4}-\d{2}-\d{2}T/);
    const solutionsSql = state.queries.find(q => q.sql.includes('JOIN project_releases')).sql;
    assert.ok(/p\.organization_id = \$1/.test(solutionsSql), 'solutions listing is org-scoped');
    const pagesSql = state.queries.find(q => q.sql.includes('FROM webpages w')).sql;
    assert.ok(/w\.organization_id = \$1 AND w\.is_published = TRUE/.test(pagesSql), 'webpage listing is org-scoped and published-only');
    assert.match(pagesSql, /v\.source = 'published' OR v\.id = w\.published_version_id/, 'a pinned legacy snapshot is a release record');
});

test('listSubjects: a missing table blanks only that source and is reported on the platform subject', async () => {
    const check = loadCheck();
    state.failTables = new Set(['project_releases']);
    state.webpages = [webpageRow('w1')];
    const subjects = await check.listSubjects('org1');
    assert.deepEqual(subjects.map(s => s.id), ['platform', 'webpage:w1']);
    assert.deepEqual(subjects[0].not_provisioned, ['project_releases']);
});

test('listSubjects: a non-schema database error still propagates', async () => {
    const check = loadCheck();
    const origGetAll = fakeDb.getAll;
    fakeDb.getAll = async () => { throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }); };
    try {
        await assert.rejects(() => check.listSubjects('org1'), /connection refused/);
    } finally {
        fakeDb.getAll = origGetAll;
    }
});

test('evaluate: relevance gate → not_applicable with evidence.relevance for any subject', async () => {
    const check = loadCheck();
    state.settings = { framework_relevance: { pld: 'not_relevant' } };
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'not_applicable');
    assert.deepEqual(r.evidence, { relevance: 'not_relevant' });
    assert.equal(state.queries.length, 0);
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
    assert.equal(state.queries.length, 0, 'org subjects evaluate without a query');
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
    const subject = check._test._orgSubject('solution', solutionRow('p1', { lastReleaseDaysAgo: 60, updatedDaysAgo: 5, version: '2.0.0' }));
    const r = await check.evaluate('org1', subject);
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.modified_after_release, true);
    assert.equal(r.evidence.grace_days, 7);
    assert.equal(r.evidence.last_version, '2.0.0');
    assert.equal(r.evidence.days_since_release, 60);
    assert.match(r.details, /modified 55 day\(s\) after its last release \(v2\.0\.0\)/);
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
    assert.equal(state.queries.length, 0);
    assert.equal(state.releaseLog.size, 0);
});

test('platform: release log table missing → warn "not provisioned yet"', async () => {
    const check = loadCheck();
    state.failTables = new Set(['platform_release_log']);
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'warn');
    assert.equal(r.evidence.release_log_provisioned, false);
    assert.match(r.details, /not provisioned yet/);
});

test('platform: first sighting is stamped via SQL and passes; a later build names its predecessor', async () => {
    const check = loadCheck({ sha: 'abc1234def5678900000000000000000deadbeef' });
    state.sbom = { format: 'cyclonedx', path: '/app/sbom/cyclonedx.json', sha256: 'f'.repeat(64) };
    const first = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(first.status, 'pass');
    assert.equal(first.evidence.release_log_via, 'sql');
    assert.equal(first.evidence.release_log_provisioned, true);
    assert.equal(first.evidence.build_sha, 'abc1234def5678900000000000000000deadbeef');
    assert.equal(first.evidence.first_seen_at, '2026-09-14T09:00:00.000Z');
    assert.equal(first.evidence.previous_build_sha, null);
    assert.equal(first.evidence.builds_logged, 1);
    assert.equal(first.evidence.sbom_hash, 'f'.repeat(64));
    assert.match(first.details, /SBOM hash attached/);
    const insert = state.queries.find(q => q.sql.startsWith('INSERT INTO platform_release_log'));
    assert.deepEqual(insert.params, ['abc1234def5678900000000000000000deadbeef', '9.9.9', 'f'.repeat(64)]);
    noPersonalData(first);

    // A newer build arrives on the same log.
    state.releaseLog.get('abc1234def5678900000000000000000deadbeef').first_seen_at = new Date('2026-09-01T09:00:00Z');
    const next = loadCheck({ sha: '0123456789abcdef0123456789abcdef01234567', version: '9.10.0' });
    const r = await next.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.previous_build_sha, 'abc1234def5678900000000000000000deadbeef');
    assert.equal(r.evidence.previous_first_seen_at, '2026-09-01T09:00:00.000Z');
    assert.equal(r.evidence.builds_logged, 2);
    assert.match(r.details, /superseding abc1234def56/);
});

test('platform: a licences-only artefact contributes no sbom_hash', async () => {
    const check = loadCheck();
    state.sbom = { format: 'licenses-md', path: '/repo/THIRD-PARTY-LICENSES.md', sha256: 'a'.repeat(64) };
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.sbom_hash, null);
    assert.equal(r.evidence.sbom_path, null);
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

test('platform: when stores/platformReleaseStore ships, its helpers are preferred over the SQL fallback', async () => {
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
    assert.deepEqual(calls.map(c => c[0]), ['recordBuild', 'getPreviousBuild', 'countBuilds']);
    assert.deepEqual(calls[0][1], { build_sha: 'abc1234def5678900000000000000000deadbeef', app_version: '9.9.9', sbom_hash: null });
    assert.equal(state.queries.filter(q => q.sql.includes('platform_release_log')).length, 0, 'no direct SQL once the store exists');
});

test('platform: a store module without recordBuild falls back to SQL', async () => {
    state.store = { somethingElse() {} };
    const check = loadCheck();
    const r = await check.evaluate('org1', { id: 'platform', kind: 'platform' });
    assert.equal(r.status, 'pass');
    assert.equal(r.evidence.release_log_via, 'sql');
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

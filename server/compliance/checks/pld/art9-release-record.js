/**
 * PLD Art. 9 (disclosure of evidence) / Art. 2(1) placing on the market /
 * Art. 8(2) substantial modification — every product has a recorded release.
 *
 * Under Directive (EU) 2024/2853 strict liability attaches to the VERSION of a
 * product that was placed on the market and to the DATE that happened; a
 * substantial modification later on starts a new liability window. In a
 * dispute the manufacturer must be able to disclose that record. Two layers
 * carry products with digital elements here:
 *
 *   PLATFORM (subject `platform`) — the running Bee Flow build. APP_BUILD_SHA
 *   (utils/buildInfo.js) is the version, APP_VERSION the human label; the first
 *   time a build is seen it is stamped into `platform_release_log`
 *   (build_sha PK, app_version, first_seen_at, sbom_hash) — via
 *   stores/platformReleaseStore when it ships a helper, via a direct upsert
 *   otherwise. That first_seen_at IS the release date of this deployment.
 *   A build without a sha ('dev') cannot be tied to a version → warn.
 *
 *   ORGANISATION (subjects `solution:<projectId>`, `webpage:<id>`) — Studio
 *   solutions that have at least one `project_releases` row, and webpages
 *   with `is_published = TRUE`. A subject passes when a release / published
 *   snapshot exists; when the entity was modified more than 7 days after its
 *   last release it warns ("assess whether this is a substantial
 *   modification"); a published webpage without a frozen snapshot fails.
 *
 * `listSubjects` returns [] for organisations that place nothing on the
 * market (unless `framework_relevance.pld === 'relevant'` says otherwise), so
 * the runner records not_applicable for them. Evaluate is cheap: org subjects
 * carry everything they need from the listing (zero queries); the platform
 * subject costs one upsert and one lookup.
 *
 * Also counts for CRA Art. 13 (manufacturer obligations) and ISO 27001 A.8.32
 * (change management).
 */

const db = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');
const sbomLocator = require('../../lib/sbomLocator');
const { APP_BUILD_SHA } = require('../../../utils/buildInfo');
const { APP_VERSION } = require('../../../version');

const GRACE_DAYS = 7;
const DAY_MS = 86400e3;
const SUBJECT_LIMIT = 200;
const PLATFORM_SUBJECT_ID = 'platform';

function _isNotProvisioned(e) {
    return e && (e.code === '42703' || e.code === '42P01');
}

function _ts(value) {
    if (!value) return null;
    const t = value instanceof Date ? value.getTime() : Date.parse(value);
    return Number.isFinite(t) ? t : null;
}

function _iso(value) {
    const t = _ts(value);
    return t === null ? null : new Date(t).toISOString();
}

/** stores/platformReleaseStore is being added in parallel — tolerate its absence. */
function _releaseStore() {
    try {
        return require('../../../stores/platformReleaseStore');
    } catch (e) {
        if (e && e.code === 'MODULE_NOT_FOUND' && /platformReleaseStore/.test(String(e.message))) return null;
        throw e;
    }
}

/**
 * Stamp the running build into platform_release_log and fetch the previous
 * build for the evidence row. Returns `{ provisioned, record, previous, total }`.
 * The table is platform-wide by design (build_sha PK) — it has no
 * organisation column to scope on.
 */
async function _recordBuild({ build_sha, app_version, sbom_hash }) {
    const store = _releaseStore();
    if (store && typeof store.recordBuild === 'function') {
        const record = await store.recordBuild({ build_sha, app_version, sbom_hash });
        let previous = null;
        let total = null;
        if (typeof store.getPreviousBuild === 'function') previous = await store.getPreviousBuild(build_sha);
        if (typeof store.countBuilds === 'function') total = await store.countBuilds();
        return { provisioned: true, record: record || null, previous: previous || null, total, via: 'store' };
    }
    try {
        const record = await db.getOne(`
            INSERT INTO platform_release_log (build_sha, app_version, first_seen_at, sbom_hash)
            VALUES ($1, $2, NOW(), $3)
            ON CONFLICT (build_sha) DO UPDATE SET
                app_version = COALESCE(EXCLUDED.app_version, platform_release_log.app_version),
                sbom_hash   = COALESCE(EXCLUDED.sbom_hash, platform_release_log.sbom_hash)
            RETURNING build_sha, app_version, first_seen_at, sbom_hash
        `, [build_sha, app_version || null, sbom_hash || null]);
        const prev = await db.getOne(`
            SELECT (SELECT COUNT(*)::int FROM platform_release_log) AS total,
                   p.build_sha AS previous_build_sha,
                   p.app_version AS previous_app_version,
                   p.first_seen_at AS previous_first_seen_at
            FROM (SELECT 1) AS one
            LEFT JOIN LATERAL (
                SELECT build_sha, app_version, first_seen_at
                FROM platform_release_log
                WHERE build_sha <> $1
                ORDER BY first_seen_at DESC
                LIMIT 1
            ) p ON TRUE
        `, [build_sha]);
        const previous = prev?.previous_build_sha
            ? { build_sha: prev.previous_build_sha, app_version: prev.previous_app_version || null, first_seen_at: _iso(prev.previous_first_seen_at) }
            : null;
        return { provisioned: true, record: record || null, previous, total: prev?.total ?? null, via: 'sql' };
    } catch (e) {
        if (_isNotProvisioned(e)) return { provisioned: false, record: null, previous: null, total: null, via: 'sql' };
        throw e;
    }
}

async function _solutionSubjects(orgId) {
    try {
        const rows = await db.getAll(`
            SELECT p.id, p.name, p.updated_at,
                   COUNT(r.id)::int AS release_count,
                   MAX(r.published_at) AS last_release_at,
                   (ARRAY_AGG(r.version ORDER BY r.published_at DESC, r.id DESC))[1] AS last_version
            FROM projects p
            JOIN project_releases r ON r.project_id = p.id AND r.channel = 'gallery'
            WHERE p.organization_id = $1
            GROUP BY p.id, p.name, p.updated_at
            ORDER BY p.updated_at DESC
            LIMIT ${SUBJECT_LIMIT}
        `, [orgId]);
        return { rows: rows || [], provisioned: true };
    } catch (e) {
        if (_isNotProvisioned(e)) return { rows: [], provisioned: false };
        throw e;
    }
}

async function _webpageSubjects(orgId) {
    try {
        const rows = await db.getAll(`
            SELECT w.id, w.name, w.updated_at, w.published_version_id,
                   (SELECT COUNT(*)::int FROM webpage_versions v
                     WHERE v.webpage_id = w.id AND v.source = 'published') AS release_count,
                   (SELECT MAX(v.created_at) FROM webpage_versions v
                     WHERE v.webpage_id = w.id AND v.source = 'published') AS last_release_at
            FROM webpages w
            WHERE w.organization_id = $1 AND w.is_published = TRUE
            ORDER BY w.updated_at DESC
            LIMIT ${SUBJECT_LIMIT}
        `, [orgId]);
        return { rows: rows || [], provisioned: true };
    } catch (e) {
        if (_isNotProvisioned(e)) return { rows: [], provisioned: false };
        throw e;
    }
}

function _orgSubject(kind, row) {
    const label = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : row.id;
    return {
        id: `${kind}:${row.id}`,
        label,
        name: label,
        kind,
        entity_id: row.id,
        release_count: Number(row.release_count) || 0,
        last_release_at: _iso(row.last_release_at),
        last_version: row.last_version ?? null,
        updated_at: _iso(row.updated_at),
        published_version_id: row.published_version_id ?? null,
    };
}

function _platformSubject(extra = {}) {
    return { id: PLATFORM_SUBJECT_ID, label: 'Bee Flow platform build', name: 'Bee Flow platform build', kind: 'platform', ...extra };
}

async function _evaluatePlatform(evidenceBase) {
    const buildSha = typeof APP_BUILD_SHA === 'string' && APP_BUILD_SHA.trim() ? APP_BUILD_SHA.trim() : 'dev';
    let sbomHash = null;
    let sbomPath = null;
    try {
        const located = await sbomLocator.locate({ hash: true });
        if (located.format === 'cyclonedx' || located.format === 'spdx') { sbomHash = located.sha256 || null; sbomPath = located.path; }
    } catch { /* the SBOM has its own check — never fail the release record over it */ }

    const evidence = {
        ...evidenceBase,
        build_sha: buildSha,
        app_version: APP_VERSION,
        sbom_hash: sbomHash,
        sbom_path: sbomPath,
        release_log_provisioned: null,
        first_seen_at: null,
        previous_build_sha: null,
        previous_first_seen_at: null,
        builds_logged: null,
    };

    if (buildSha === 'dev') {
        return {
            status: 'warn',
            evidence,
            details: `This process carries no build identifier (APP_BUILD_SHA is unset, so it runs as "dev"). The version placed on the market cannot be tied to a commit — set APP_BUILD_SHA in the deployment (CI passes the git sha as a build-arg) so each release is stamped.`,
        };
    }

    const log = await _recordBuild({ build_sha: buildSha, app_version: APP_VERSION, sbom_hash: sbomHash });
    evidence.release_log_provisioned = log.provisioned;
    evidence.release_log_via = log.via;
    if (!log.provisioned) {
        return {
            status: 'warn',
            evidence,
            details: `not provisioned yet — build ${buildSha.slice(0, 12)} (v${APP_VERSION}) is running but the platform release log (platform_release_log) does not exist, so its release date is not being recorded. Restart the server after the update or run the pending migrations.`,
        };
    }
    evidence.first_seen_at = _iso(log.record?.first_seen_at);
    evidence.previous_build_sha = log.previous?.build_sha || null;
    evidence.previous_first_seen_at = log.previous?.first_seen_at ? _iso(log.previous.first_seen_at) : null;
    evidence.builds_logged = log.total;
    return {
        status: 'pass',
        evidence,
        details: `Platform release recorded: build ${buildSha.slice(0, 12)} (v${APP_VERSION}) first seen ${evidence.first_seen_at ? evidence.first_seen_at.slice(0, 10) : 'now'}${evidence.previous_build_sha ? `, superseding ${evidence.previous_build_sha.slice(0, 12)}` : ''}${sbomHash ? '; SBOM hash attached' : ''}.`,
    };
}

function _evaluateOrgSubject(subject, evidenceBase, now) {
    const kind = subject.kind === 'webpage' ? 'webpage' : 'solution';
    const lastRelease = _ts(subject.last_release_at);
    const updated = _ts(subject.updated_at);
    const releaseCount = Number(subject.release_count) || 0;
    const daysSinceRelease = lastRelease === null ? null : Math.floor((now - lastRelease) / DAY_MS);
    const modifiedAfter = lastRelease !== null && updated !== null && updated > lastRelease + GRACE_DAYS * DAY_MS;
    const evidence = {
        ...evidenceBase,
        kind,
        entity_id: subject.entity_id ?? String(subject.id).replace(/^[a-z]+:/, ''),
        label: subject.label || subject.name || null,
        release_count: releaseCount,
        last_release_at: _iso(subject.last_release_at),
        last_version: subject.last_version ?? null,
        updated_at: _iso(subject.updated_at),
        days_since_release: daysSinceRelease,
        modified_after_release: modifiedAfter,
        grace_days: GRACE_DAYS,
    };
    const noun = kind === 'webpage' ? 'webpage' : 'solution';
    const where = kind === 'webpage' ? 'Studio → Webpages' : 'Studio → Solutions';

    if (releaseCount === 0 || lastRelease === null) {
        return {
            status: 'fail',
            evidence,
            details: kind === 'webpage'
                ? `The published webpage "${evidence.label}" has no frozen published snapshot, so there is no record of which version the audience receives or since when. Publish it again from ${where} to pin a version.`
                : `The solution "${evidence.label}" has no recorded release. Publish a release from ${where} so the version placed on the market and its date are on record.`,
        };
    }
    if (modifiedAfter) {
        const daysAfter = Math.floor((updated - lastRelease) / DAY_MS);
        return {
            status: 'warn',
            evidence,
            details: `The ${noun} "${evidence.label}" was modified ${daysAfter} day(s) after its last release${evidence.last_version ? ` (v${evidence.last_version})` : ''} of ${evidence.last_release_at.slice(0, 10)}. Assess whether this is a substantial modification (Art. 8(2)) — if so, publish a new release from ${where}.`,
        };
    }
    return {
        status: 'pass',
        evidence,
        details: `Release on record for the ${noun} "${evidence.label}": ${releaseCount} release(s), latest${evidence.last_version ? ` v${evidence.last_version}` : ''} on ${evidence.last_release_at.slice(0, 10)}; no modification outside the ${GRACE_DAYS}-day grace window since.`,
    };
}

module.exports = {
    id: 'PLD-Art9-release-record',
    regulation: 'PLD',
    article: 'Art. 9',
    frameworks: [
        { regulation: 'CRA', ref: 'Art. 13' },
        { regulation: 'ISO27001', ref: 'A.8.32' },
    ],
    severity: 'high',
    scope: 'per-source',
    verification: 'automated',
    titleKey: 'compliance.check_pld_release_record_title',
    descriptionKey: 'compliance.check_pld_release_record_desc',
    remediationKey: 'compliance.check_pld_release_record_fix',
    remediationLink: 'studio/solutions',

    async listSubjects(orgId) {
        const settings = await complianceStore.getSettings(orgId) || {};
        const relevance = settings.framework_relevance?.pld;
        if (relevance === 'not_relevant') return [];

        const [solutions, webpages] = await Promise.all([_solutionSubjects(orgId), _webpageSubjects(orgId)]);
        const subjects = [
            ...solutions.rows.map(r => _orgSubject('solution', r)),
            ...webpages.rows.map(r => _orgSubject('webpage', r)),
        ];
        const notProvisioned = [
            ...(solutions.provisioned ? [] : ['project_releases']),
            ...(webpages.provisioned ? [] : ['webpages']),
        ];
        if (subjects.length === 0 && relevance !== 'relevant') return [];
        return [_platformSubject({ org_subjects: subjects.length, not_provisioned: notProvisioned }), ...subjects];
    },

    async evaluate(orgId, subject) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (settings.framework_relevance?.pld === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'Product liability was marked not relevant for this organisation.',
            };
        }
        if (!subject?.id) {
            return { status: 'not_applicable', evidence: { subjects: 0 }, details: 'No product placed on the market to assess.' };
        }
        const evidenceBase = { subject_id: String(subject.id) };
        if (subject.kind === 'platform' || subject.id === PLATFORM_SUBJECT_ID) {
            return _evaluatePlatform({ ...evidenceBase, kind: 'platform', org_subjects: subject.org_subjects ?? null, not_provisioned: subject.not_provisioned || [] });
        }
        return _evaluateOrgSubject(subject, evidenceBase, Date.now());
    },
};

module.exports._test = { _recordBuild, _orgSubject, _evaluateOrgSubject, GRACE_DAYS, PLATFORM_SUBJECT_ID };

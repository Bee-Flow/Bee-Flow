/**
 * EAA Art. 4 / Art. 13(2) — the product's own public surfaces are
 * accessibility-tested.
 *
 * Hosted forms (/f/<token>), public Studio-app pages (/p/<token>), the
 * data-subject request form (/privacy/requests) and the shared-webpage viewer
 * (/share/<token>) render in the browser, and the production image ships no
 * browser. So the axe run happens in CI (.github/workflows/a11y-conformance.yml)
 * and its report ships with the build as compliance/a11y/conformance.json.
 * This check reads that artefact through a11y/conformance.js and verdicts:
 *
 *   artefact absent / unusable                → fail   (nothing proves anything)
 *   build_sha ≠ APP_BUILD_SHA or older > 60 d  → warn   ("stale": tested a different build)
 *   any surface skipped                        → warn   (an untested surface is never a pass)
 *   serious + critical > 0                     → fail
 *   moderate + minor > 0                       → warn
 *   otherwise                                  → pass
 *
 * HYBRID: the admin's declared conformance level and date
 * (`accessibility_conformance_level` / `_at`) ride along in the evidence — a
 * declaration is what an auditor asks for next; it never moves the verdict.
 *
 * Evidence is about the product build, never about a person: sha, dates,
 * per-surface counts, violated rule ids and CSS targets from the product's
 * own markup.
 */

const complianceStore = require('../../../stores/complianceStore');
const conformance = require('../../a11y/conformance');

const STALE_DAYS = 60;
const MAX_RULES_IN_EVIDENCE = 25;

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.eaa === 'not_relevant';
}

function _buildSha() {
    try { return require('../../../utils/buildInfo').APP_BUILD_SHA || 'dev'; } catch { return process.env.APP_BUILD_SHA || 'dev'; }
}

function _iso(v) {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function _shaMatches(a, b) {
    if (!a || !b) return false;
    const x = String(a).toLowerCase();
    const y = String(b).toLowerCase();
    if (x === 'dev' || y === 'dev') return x === y;
    return x.startsWith(y) || y.startsWith(x);
}

function _attestation(settings) {
    const level = typeof settings.accessibility_conformance_level === 'string' && settings.accessibility_conformance_level.trim()
        ? settings.accessibility_conformance_level.trim().slice(0, 40) : null;
    return { declared_level: level, declared_at: _iso(settings.accessibility_conformance_at) };
}

module.exports = {
    id: 'EAA-Art4-product-surfaces-conformance',
    regulation: 'EAA',
    article: 'Art. 4',
    frameworks: [],
    severity: 'high',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.check_eaa_product_surfaces_title',
    descriptionKey: 'compliance.check_eaa_product_surfaces_desc',
    remediationKey: 'compliance.check_eaa_product_surfaces_fix',
    remediationLink: null,
    STALE_DAYS,

    async evaluate(orgId, _subject, opts = {}) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The EAA was marked not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        const buildSha = _buildSha();
        const loaded = conformance.loadConformance({ path: opts.path, now: opts.now });
        const evidence = {
            build_sha: buildSha,
            artefact_found: loaded.found,
            artefact_path: loaded.path,
            artefact_problems: loaded.problems,
            artefact_build_sha: loaded.artefact?.build_sha || null,
            generated_at: loaded.artefact?.generated_at || null,
            age_days: loaded.age_days === null ? null : Math.round(loaded.age_days),
            stale_after_days: STALE_DAYS,
            axe_version: loaded.artefact?.axe_version || null,
            surfaces: [],
            totals: null,
            attestation: _attestation(settings),
        };

        if (!loaded.found || !loaded.artefact) {
            const why = !loaded.found
                ? 'No accessibility conformance artefact ships with this build'
                : `The conformance artefact is unusable (${loaded.problems.join('; ')})`;
            return {
                status: 'fail',
                evidence,
                details: `${why} — the product's public forms, apps, DSR form and webpage viewer have not been tested with axe for this build. Run the a11y-conformance CI job and ship its report with the image.`,
            };
        }

        const art = loaded.artefact;
        evidence.surfaces = art.surfaces.map(s => ({
            id: s.id,
            status: s.status,
            url_path: s.url_path || null,
            skip_reason: s.status === 'skipped' ? (s.skip_reason || null) : undefined,
            violations: s.status === 'tested' ? s.violations : undefined,
            rules: s.status === 'tested'
                ? (s.rules || []).slice(0, MAX_RULES_IN_EVIDENCE).map(r => ({ id: r.id, impact: r.impact, nodes: r.nodes, targets: Array.isArray(r.targets) ? r.targets.slice(0, 10) : undefined }))
                : undefined,
        }));
        const totals = conformance.totals(art);
        evidence.totals = totals;
        const skipped = art.surfaces.filter(s => s.status !== 'tested').map(s => s.id);
        const tested = art.surfaces.filter(s => s.status === 'tested').map(s => s.id);
        evidence.tested_surfaces = tested;
        evidence.skipped_surfaces = skipped;

        const shaMatch = _shaMatches(art.build_sha, buildSha);
        const tooOld = loaded.age_days !== null && loaded.age_days > STALE_DAYS;
        evidence.build_sha_matches = shaMatch;
        evidence.stale = !shaMatch || tooOld;

        const blocking = totals.critical + totals.serious;
        const minor = totals.moderate + totals.minor;

        if (blocking > 0) {
            return {
                status: 'fail',
                evidence,
                details: `${blocking} serious/critical axe violation(s) across ${tested.length} tested surface(s) (critical ${totals.critical}, serious ${totals.serious})${evidence.stale ? ' — and the report is stale' : ''}. Resolve them in the product and re-run the a11y-conformance job.`,
            };
        }
        if (evidence.stale) {
            const why = !shaMatch
                ? `it was produced for build ${String(art.build_sha).slice(0, 12)}, the server runs ${String(buildSha).slice(0, 12)}`
                : `it is ${Math.round(loaded.age_days)} days old (limit ${STALE_DAYS})`;
            return {
                status: 'warn',
                evidence,
                details: `The conformance report is stale: ${why}. Re-run the a11y-conformance job for this build.`,
            };
        }
        if (skipped.length) {
            return {
                status: 'warn',
                evidence,
                details: `${skipped.length} surface(s) were not tested (${skipped.join(', ')}) — an untested surface is never a pass. Seed the missing fixture(s) in the a11y-conformance job.`,
            };
        }
        if (minor > 0) {
            return {
                status: 'warn',
                evidence,
                details: `No serious or critical violations, but ${minor} moderate/minor axe finding(s) remain across ${tested.length} surface(s) (moderate ${totals.moderate}, minor ${totals.minor}).`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `All ${tested.length} public surfaces (${tested.join(', ')}) pass axe for build ${String(buildSha).slice(0, 12)} with no violations${evidence.attestation.declared_level ? `; declared conformance ${evidence.attestation.declared_level}` : ''}.`,
        };
    },
};

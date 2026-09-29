/**
 * CRA Annex I Part II(1) / Art. 13 — a software bill of materials ships with
 * the running build.
 *
 * When a vulnerability is disclosed the manufacturer must be able to say,
 * component by component, whether the product is affected. Annex I Part II(1)
 * therefore requires a machine-readable SBOM covering at least the top-level
 * dependencies; the PLD (Art. 7(2)(f) cybersecurity, Art. 9 disclosure of
 * evidence) leans on the same artefact when liability for a defective product
 * is assessed.
 *
 * The check does not read package.json — that describes what was *asked for*.
 * It looks for the artefact CI produced for THIS build (lib/sbomLocator.js:
 * SBOM_PATH → /app/sbom/cyclonedx.json → <repo>/sbom/cyclonedx.json →
 * THIRD-PARTY-LICENSES.md) and grades it:
 *   • pass  — CycloneDX/SPDX with components, and either the `beeflow:build_sha`
 *             property equals APP_BUILD_SHA or the document was generated at
 *             most 30 days before this process started;
 *   • warn  — only the human-readable licence list, an SBOM for ANOTHER build,
 *             a stale one, or one without components;
 *   • fail  — nothing at all.
 *
 * Global, automated. The remediation is an operator task (CI + image), so
 * there is no admin deep-link; the details name the env var to set.
 * Also counts for PLD Art. 7(2)(f)/Art. 9 and ISO 27001 A.5.9 (asset inventory).
 */

const complianceStore = require('../../../stores/complianceStore');
const sbomLocator = require('../../lib/sbomLocator');
const { APP_BUILD_SHA } = require('../../../utils/buildInfo');
const { APP_VERSION } = require('../../../version');

const FRESH_DAYS = 30;
const MIN_SHA_PREFIX = 7;
const MACHINE_READABLE = new Set(['cyclonedx', 'spdx']);

/**
 * Two build stamps agree when one is a ≥7-char prefix of the other — CI writes
 * the full 40-char sha into the SBOM while an operator may pin a short one in
 * APP_BUILD_SHA (or the other way round). 'dev' is never a match.
 */
function _shaMatches(sbomSha, appSha) {
    const a = typeof sbomSha === 'string' ? sbomSha.trim().toLowerCase() : '';
    const b = typeof appSha === 'string' ? appSha.trim().toLowerCase() : '';
    if (!a || !b || a === 'dev' || b === 'dev') return false;
    if (a.length < MIN_SHA_PREFIX || b.length < MIN_SHA_PREFIX) return a === b;
    return a.startsWith(b) || b.startsWith(a);
}

function _processStartedAt(now = Date.now()) {
    const uptimeMs = typeof process.uptime === 'function' ? process.uptime() * 1000 : 0;
    return now - (Number.isFinite(uptimeMs) ? uptimeMs : 0);
}

/** Days between the SBOM's generation and the moment this build started running. */
function _ageDays(generatedAt, referenceMs) {
    const t = generatedAt ? Date.parse(generatedAt) : NaN;
    if (!Number.isFinite(t)) return null;
    return Math.max(0, Math.round((referenceMs - t) / 86400e3));
}

module.exports = {
    id: 'CRA-AnnexI-II1-sbom',
    regulation: 'CRA',
    article: 'Annex I Part II(1)',
    frameworks: [
        { regulation: 'PLD', ref: 'Art. 7(2)(f), Art. 9' },
        { regulation: 'ISO27001', ref: 'A.5.9' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'automated',
    titleKey: 'compliance.check_cra_sbom_title',
    descriptionKey: 'compliance.check_cra_sbom_desc',
    remediationKey: 'compliance.check_cra_sbom_fix',
    remediationLink: null,

    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId) || {};
        if (settings.framework_relevance?.cra === 'not_relevant') {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The CRA was marked not relevant for this organisation.',
            };
        }

        const located = await sbomLocator.locate({ hash: true });
        const appSha = typeof APP_BUILD_SHA === 'string' && APP_BUILD_SHA.trim() ? APP_BUILD_SHA.trim() : 'dev';
        const startedAt = _processStartedAt();

        const tried = (located.tried || []).map(t => ({ path: t.path, reason: t.reason }));
        const evidence = {
            found: !!located.format,
            path: located.path,
            format: located.format,
            machine_readable: MACHINE_READABLE.has(located.format),
            component_count: located.parsed?.component_count ?? 0,
            generated_at: located.parsed?.generated_at ?? null,
            spec_version: located.parsed?.spec_version ?? null,
            tool: located.parsed?.tool ?? null,
            sbom_build_sha: located.parsed?.build_sha ?? null,
            sbom_version: located.parsed?.version ?? null,
            sbom_sha256: located.sha256 || null,
            app_build_sha: appSha,
            app_version: APP_VERSION,
            matches_build: false,
            age_days: null,
            fresh: false,
            fresh_window_days: FRESH_DAYS,
            search_order: sbomLocator.candidates(),
            tried,
        };

        if (!located.format) {
            return {
                status: 'fail',
                evidence,
                details: `No software bill of materials found for this build. Searched ${evidence.search_order.length} location(s): ${evidence.search_order.join(', ')}. Generate one in CI (npm sbom --sbom-format=cyclonedx), copy it into the image as /app/sbom/cyclonedx.json or point SBOM_PATH at it.`,
            };
        }

        if (!evidence.machine_readable) {
            return {
                status: 'warn',
                evidence,
                details: `Only the human-readable licence list (${located.path}, ${evidence.component_count} entries${evidence.generated_at ? `, generated ${evidence.generated_at.slice(0, 10)}` : ''}) is available. Annex I Part II(1) asks for a machine-readable SBOM (CycloneDX or SPDX) so components can be matched against disclosed vulnerabilities automatically.`,
            };
        }

        evidence.matches_build = _shaMatches(evidence.sbom_build_sha, appSha);
        evidence.age_days = _ageDays(evidence.generated_at, startedAt);
        evidence.fresh = evidence.age_days !== null && evidence.age_days <= FRESH_DAYS;

        if (evidence.component_count === 0) {
            return {
                status: 'warn',
                evidence,
                details: `The SBOM at ${located.path} (${located.format}) lists no components — the generator ran without an installed dependency tree or on the wrong workspace. Regenerate it from the server workspace lockfile.`,
            };
        }

        const shaKnownMismatch = !!evidence.sbom_build_sha && appSha !== 'dev' && !evidence.matches_build;
        if (evidence.matches_build) {
            return {
                status: 'pass',
                evidence,
                details: `${located.format === 'cyclonedx' ? 'CycloneDX' : 'SPDX'} SBOM found at ${located.path}: ${evidence.component_count} components, stamped for build ${appSha.slice(0, 12)} — the artefact describes the running build.`,
            };
        }
        if (shaKnownMismatch) {
            return {
                status: 'warn',
                evidence,
                details: `The SBOM at ${located.path} was generated for build ${String(evidence.sbom_build_sha).slice(0, 12)} but this process runs build ${appSha.slice(0, 12)}. Rebuild the image so the SBOM and the binary come from the same commit.`,
            };
        }
        if (evidence.fresh) {
            const stamp = appSha === 'dev'
                ? 'this process carries no build sha (APP_BUILD_SHA=dev), so freshness is the only available proof'
                : 'the artefact carries no beeflow:build_sha property, so freshness is the only available proof';
            return {
                status: 'pass',
                evidence,
                details: `${located.format === 'cyclonedx' ? 'CycloneDX' : 'SPDX'} SBOM found at ${located.path}: ${evidence.component_count} components, generated ${evidence.age_days} day(s) before this build started — ${stamp}.`,
            };
        }
        return {
            status: 'warn',
            evidence,
            details: evidence.age_days === null
                ? `The SBOM at ${located.path} carries neither a generation timestamp nor a build sha, so it cannot be tied to the running build. Regenerate it in CI with the beeflow:build_sha property.`
                : `The SBOM at ${located.path} is ${evidence.age_days} days old (limit ${FRESH_DAYS}) and carries no matching build sha — it may describe an earlier release. Regenerate it in the build that produces the image.`,
        };
    },
};

module.exports._test = { _shaMatches, _ageDays, FRESH_DAYS };

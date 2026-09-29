/**
 * ComplianceCheckRegistry — holds every compliance check module.
 *
 * A check module exports:
 *   {
 *     id: 'GDPR-Art32-encryption-at-rest',
 *     regulation: 'GDPR' | 'AIA' | 'ISO27001' | 'NIS2' | 'CRA' | …,   // its HOME framework
 *                               // (any code in frameworks.regulationCodes() except CUSTOM —
 *                               // org-defined frameworks are DB rows, never modules)
 *     article: '32',            // GDPR/AIA article, or ISO control/clause ref
 *                               // ('A.8.24', '9.2') for ISO27001 checks; the newer
 *                               // frameworks write 'Art. 21(2)(j)'
 *     // ISO27001 checks additionally declare which Annex A controls the check
 *     // satisfies (one check can evidence several controls — the SoA joins on
 *     // this): controls: ['A.5.15', 'A.5.18', 'A.8.3']
 *     // Any check may count for OTHER frameworks too — a GDPR Art. 33 check is
 *     // also ISO A.5.24 evidence, a NIS2 MFA check also DORA Art. 9:
 *     //   frameworks: [{ regulation: 'ISO27001', ref: 'A.5.24' }, …]
 *     // register() merges home + controls + frameworks into ONE deduped
 *     // `frameworks[]` (each entry gains framework_id + in_force_since) and
 *     // sets `in_force_since` for the home article.
 *     severity: 'critical' | 'high' | 'medium' | 'low',
 *     scope: 'global' | 'per-source',
 *     // How the result is established — surfaced in the UI so a passing
 *     // check never overstates what the tool actually verified:
 *     //   'automated'   — evaluated from live system state/telemetry
 *     //   'attestation' — reflects what an admin declared/confirmed
 *     //   'hybrid'      — automated signal + an admin attestation on top
 *     verification: 'automated' | 'attestation' | 'hybrid',
 *     titleKey, descriptionKey, remediationKey,  // i18n keys
 *     remediationLink,                            // optional admin deep-link
 *
 *     async evaluate(orgId, subject)
 *       -> { status: 'pass'|'warn'|'fail'|'not_applicable',
 *            evidence: { ... },
 *            details: '...' }
 *
 *     // Per-source checks only:
 *     async listSubjects(orgId)
 *       -> [{ id, label, ...extras }, ...]
 *
 *     // Optional auto-fix (one-click remediation from the UI):
 *     autoFixId: 'aia_art50_inject_disclosure',
 *     async autoFix(orgId, { subjectId, actorId, ... })
 *       -> { changed, summary, ...details }   // captured in evidence chain
 *   }
 *
 * A check RUNS when its home regulation's framework is active for the org
 * (runner.js asks frameworkPolicy) and COUNTS toward every framework in its
 * `frameworks[]` that is active (score.forRegulation reads this list).
 */

const frameworks = require('./frameworks');
const log = require('../telemetry/log');

const _checks = new Map();

const ISO = 'ISO27001';
const ISO_CONTROL_REF = /^A\.\d+\.\d+$/;

function _isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

/**
 * Merge the three places a check can name a framework into one list:
 * home `{regulation, article}`, ISO `controls[]`, explicit `frameworks[]`.
 * Order is kept (home first) and duplicates on (regulation, ref) dropped.
 * Throws on an unknown regulation or an empty ref — a typo in a framework tag
 * would otherwise make the check silently count for nothing.
 */
function _normaliseFrameworks(check) {
    const known = new Set(frameworks.regulationCodes());
    const raw = [{ regulation: check.regulation, ref: check.article }];
    for (const ref of Array.isArray(check.controls) ? check.controls : []) raw.push({ regulation: ISO, ref });
    if (check.frameworks !== undefined && !Array.isArray(check.frameworks)) {
        throw new Error(`Check ${check.id}: frameworks must be an array of { regulation, ref }`);
    }
    for (const f of check.frameworks || []) raw.push({ regulation: f?.regulation, ref: f?.ref });

    const seen = new Set();
    const out = [];
    for (const { regulation, ref } of raw) {
        if (!known.has(regulation) || regulation === frameworks.CUSTOM_REGULATION) {
            throw new Error(`Check ${check.id}: unknown regulation "${regulation}" in frameworks[] (known: ${[...known].filter(k => k !== frameworks.CUSTOM_REGULATION).join(', ')})`);
        }
        if (!_isNonEmptyString(ref)) {
            throw new Error(`Check ${check.id}: frameworks[] entry for ${regulation} needs a non-empty ref`);
        }
        // Separator is a literal "|": it cannot occur in a regulation code
        // (closed set - registry.test.js asserts that stays true) nor in an
        // article/control ref, so the key stays injective. Do NOT "tidy" it
        // back into \u0000 - a literal NUL byte here made the whole file
        // BINARY to git: no line diffs, no blame, whole-file merge conflicts.
        const key = `${regulation}|${ref.trim()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(Object.freeze({
            regulation,
            ref: ref.trim(),
            framework_id: frameworks.frameworkIdOf(regulation),
            in_force_since: frameworks.inForceSince(regulation, ref),
        }));
    }
    return out;
}

function register(check) {
    if (!check || !check.id) throw new Error('Check must have an id');
    if (typeof check.evaluate !== 'function') throw new Error(`Check ${check.id} missing evaluate()`);
    if (check.scope === 'per-source' && typeof check.listSubjects !== 'function') {
        throw new Error(`Per-source check ${check.id} must export listSubjects(orgId)`);
    }
    if (!_isNonEmptyString(check.regulation)) {
        throw new Error(`Check ${check.id} must declare its home regulation`);
    }
    if (!_isNonEmptyString(check.article)) {
        throw new Error(`Check ${check.id} must declare its home article/control ref`);
    }
    if (!['automated', 'attestation', 'hybrid'].includes(check.verification)) {
        // Warn (not throw) so ad-hoc/test registrations keep working; the
        // registry test asserts every shipped check declares it.
        log.warn(`[ComplianceRegistry] Check "${check.id}" missing verification label — defaulting to 'automated'`);
        check.verification = 'automated';
    }

    // Throws on an unknown regulation / empty ref (home included).
    check.frameworks = _normaliseFrameworks(check);
    check.in_force_since = frameworks.inForceSince(check.regulation, check.article);

    // A non-ISO check that counts for an Annex A control must be visible to
    // the SoA join, which reads `controls[]` — derive it from the ISO tags so
    // the A.5.24 row can show the GDPR Art. 33 check ("also counts for ISO").
    if (check.regulation !== ISO) {
        const isoRefs = check.frameworks
            .filter(f => f.regulation === ISO && ISO_CONTROL_REF.test(f.ref))
            .map(f => f.ref);
        if (isoRefs.length) {
            const existing = Array.isArray(check.controls) ? check.controls : [];
            check.controls = [...new Set([...existing, ...isoRefs])];
        }
    }

    if (_checks.has(check.id)) {
        log.warn(`[ComplianceRegistry] Duplicate check id "${check.id}" — overwriting`);
    }
    _checks.set(check.id, check);
}

function get(id) { return _checks.get(id); }
function getAll() { return Array.from(_checks.values()); }

/** Checks whose HOME framework is `regulation` — the ones the runner executes for it. */
function getByRegulation(regulation) {
    return getAll().filter(c => c.regulation === regulation);
}
const getPrimary = getByRegulation;

/** Checks that COUNT for `regulation`: home ∪ tagged via frameworks[]. */
function getByFramework(regulation) {
    return getAll().filter(c => c.frameworks.some(f => f.regulation === regulation));
}

// Test-only: drop an ad-hoc registration so a contract test can register a
// throwaway check without leaving it behind for the assertions that follow.
function _unregister(id) { return _checks.delete(id); }

module.exports = { register, get, getAll, getByRegulation, getPrimary, getByFramework, _unregister };

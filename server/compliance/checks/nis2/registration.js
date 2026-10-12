/**
 * NIS2 Art. 3(4) / Cyberbeveiligingswet registratieplicht — essential and
 * important entities register with the national authority.
 *
 * Pure attestation: the fact lives in a filing outside the platform. Settings:
 *   nis2_entity_class            'essential' | 'important' | 'not_in_scope' | 'supplier_only' | null
 *   nis2_registration_reference  the authority's reference
 *   nis2_registered_at           when the registration was filed
 *
 *   not_in_scope | supplier_only          → not_applicable (self-classification recorded)
 *   essential | important + reference+date → pass
 *   essential | important, no reference    → fail
 *   class not set                          → warn ("classify")
 *
 * The article cited is the Directive's, Art. 3(4): Member States must require
 * essential and important entities to submit the registration data. The Dutch
 * implementing act, the Cyberbeveiligingswet (Stb. 2026, 187, BWBR0052872),
 * is in force since 15 Aug 2026; its matching article has not been verified.
 * Do not cite a Cbw article number until it has been read on
 * wetten.overheid.nl.
 */

const complianceStore = require('../../../stores/complianceStore');

const IN_SCOPE = new Set(['essential', 'important']);
const OUT_OF_SCOPE = new Set(['not_in_scope', 'supplier_only']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

function _iso(v) {
    if (!v) return null;
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

module.exports = {
    id: 'NIS2-Art3-registration',
    regulation: 'NIS2',
    article: 'Art. 3(4)',
    frameworks: [],
    severity: 'high',
    scope: 'global',
    verification: 'attestation',
    titleKey: 'compliance.check_nis2_registration_title',
    descriptionKey: 'compliance.check_nis2_registration_desc',
    remediationKey: 'compliance.check_nis2_registration_fix',
    remediationLink: 'admin/compliance/settings',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'NIS2 is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        const entityClass = typeof settings.nis2_entity_class === 'string' && settings.nis2_entity_class.trim()
            ? settings.nis2_entity_class.trim() : null;
        const reference = typeof settings.nis2_registration_reference === 'string' && settings.nis2_registration_reference.trim()
            ? settings.nis2_registration_reference.trim().slice(0, 120) : null;
        const registeredAt = _iso(settings.nis2_registered_at);

        const evidence = {
            entity_class: entityClass,
            registration_reference: reference,
            registered_at: registeredAt,
            attested_at: _iso(settings.updated_at),
        };

        if (entityClass && OUT_OF_SCOPE.has(entityClass)) {
            return {
                status: 'not_applicable',
                evidence,
                details: entityClass === 'supplier_only'
                    ? 'Self-classified as a supplier to NIS2 entities only — no registration duty of its own; customers will ask for the supplier questionnaire pack instead.'
                    : 'Self-classified as outside NIS2 scope — no registration duty.',
            };
        }
        if (entityClass && IN_SCOPE.has(entityClass)) {
            if (reference && registeredAt) {
                return {
                    status: 'pass',
                    evidence,
                    details: `Registered with the national authority as an ${entityClass} entity on ${registeredAt.slice(0, 10)} (reference recorded).`,
                };
            }
            return {
                status: 'fail',
                evidence,
                details: `Classified as an ${entityClass} entity but no registration ${!reference ? 'reference' : 'date'} is recorded — file the registration and record its reference and date under Compliance → Settings.`,
            };
        }
        return {
            status: 'warn',
            evidence,
            details: entityClass
                ? `Unknown NIS2 classification "${entityClass}" — choose essential, important, supplier_only or not_in_scope under Compliance → Settings.`
                : 'The organisation has not been classified under NIS2 yet — decide whether it is an essential or important entity, a supplier only, or out of scope.',
        };
    },
};

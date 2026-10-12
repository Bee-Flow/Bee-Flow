/**
 * NIS2 Art. 20(1)(2) — management bodies approve the cybersecurity measures,
 * oversee their implementation and follow training.
 *
 * AUTOMATED part:
 *   - the `information-security-policy` must be published            → else fail
 *   - every organisation admin acknowledged its CURRENT version       → pass
 *     some did                                                        → warn
 *     none did                                                        → fail
 *   - evidence only: the newest management review with attendees, as the
 *     "oversight" signal (never changes the status).
 * ATTESTATION part (hybrid):
 *   - `nis2_board_training_at` (compliance settings) at most 365 days old.
 *     Missing or stale downgrades a pass to warn — Art. 20(2) makes the
 *     training itself an obligation, not a nice-to-have.
 *
 * Evidence names opaque user ids only, never names or e-mail addresses.
 * ISO 27001: clause 5.1 (leadership), A.5.1 (policies).
 */

const { getAll, getOne } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');

const POLICY_SLUG = 'information-security-policy';
const ORG_ADMIN_ROLES = ['org_admin', 'admin'];
const TRAINING_MAX_DAYS = 365;
const DAY = 86400 * 1000;
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.nis2 === 'not_relevant';
}

module.exports = {
    id: 'NIS2-Art20-board-approval',
    regulation: 'NIS2',
    article: 'Art. 20',
    frameworks: [
        { regulation: 'ISO27001', ref: 'cl. 5.1' },
        { regulation: 'ISO27001', ref: 'A.5.1' },
    ],
    severity: 'high',
    scope: 'global',
    verification: 'hybrid',
    titleKey: 'compliance.check_nis2_board_approval_title',
    descriptionKey: 'compliance.check_nis2_board_approval_desc',
    remediationKey: 'compliance.check_nis2_board_approval_fix',
    remediationLink: 'admin/compliance/policies',
    async evaluate(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'NIS2 is marked as not relevant for this organisation (Compliance → Frameworks).',
            };
        }

        let doc;
        try {
            doc = await getOne(`
                SELECT status, current_version
                FROM isms_documents
                WHERE organization_id = $1 AND slug = $2
            `, [orgId, POLICY_SLUG]);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return {
                    status: 'warn',
                    evidence: { provisioned: false, missing: e.code },
                    details: 'The ISMS policy register is not provisioned yet — open Compliance → Policies once to seed it.',
                };
            }
            throw e;
        }
        const published = !!doc && doc.status === 'published' && Number(doc.current_version) > 0;
        const version = published ? Number(doc.current_version) : null;

        // Board training attestation (settings) — evaluated up front so the
        // fail branches can still report it.
        const trainingAt = settings.nis2_board_training_at ? new Date(settings.nis2_board_training_at) : null;
        const trainingAgeDays = trainingAt && Number.isFinite(trainingAt.getTime())
            ? Math.floor((Date.now() - trainingAt.getTime()) / DAY) : null;
        const trainingCurrent = trainingAgeDays !== null && trainingAgeDays >= 0 && trainingAgeDays <= TRAINING_MAX_DAYS;

        // Evidence only: the most recent management review that recorded attendees.
        let lastReview = null;
        try {
            const r = await getOne(`
                SELECT held_at, jsonb_array_length(COALESCE(attendees, '[]'::jsonb)) AS attendees_count
                FROM iso_management_reviews
                WHERE organization_id = $1
                  AND held_at <= NOW()
                  AND jsonb_array_length(COALESCE(attendees, '[]'::jsonb)) > 0
                ORDER BY held_at DESC
                LIMIT 1
            `, [orgId]);
            if (r) lastReview = { held_at: r.held_at, attendees_count: Number(r.attendees_count) || 0 };
        } catch { /* register absent — the signal is optional */ }

        const evidence = {
            policy_slug: POLICY_SLUG,
            policy_published: published,
            policy_version: version,
            admins_total: 0,
            acknowledged: 0,
            unacknowledged_count: 0,
            unacknowledged: [],
            board_training_at: trainingAt && Number.isFinite(trainingAt.getTime()) ? trainingAt.toISOString() : null,
            board_training_age_days: trainingAgeDays,
            board_training_current: trainingCurrent,
            training_max_days: TRAINING_MAX_DAYS,
            last_management_review: lastReview,
        };

        if (!published) {
            return {
                status: 'fail',
                evidence,
                details: 'The information-security policy is not published — management has nothing to approve or be held accountable for.',
            };
        }

        let admins;
        try {
            admins = await getAll(`
                SELECT u.id, (a.user_id IS NOT NULL) AS acknowledged
                FROM users u
                LEFT JOIN isms_acknowledgements a
                  ON a.organization_id = $1 AND a.slug = $2 AND a.version = $3 AND a.user_id = u.id
                WHERE u."organizationId" = $1
                  AND (u.role = 'admin' OR u."orgRole" = ANY($4))
                  AND COALESCE(u.status, 'active') <> 'suspended'
            `, [orgId, POLICY_SLUG, version, ORG_ADMIN_ROLES]);
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return {
                    status: 'warn',
                    evidence: { ...evidence, provisioned: false, missing: e.code },
                    details: 'The acknowledgement ledger is not provisioned yet — cannot verify management approval.',
                };
            }
            throw e;
        }

        const acked = admins.filter(a => a.acknowledged === true);
        const unacked = admins.filter(a => a.acknowledged !== true);
        evidence.admins_total = admins.length;
        evidence.acknowledged = acked.length;
        evidence.unacknowledged_count = unacked.length;
        evidence.unacknowledged = unacked.slice(0, 10).map(a => a.id);

        const trainingNote = trainingCurrent
            ? ''
            : (trainingAt
                ? ` Management training was last recorded ${trainingAgeDays} days ago — refresh it under Compliance → Settings.`
                : ' No management cybersecurity training is recorded yet (Art. 20(2)) — stamp it under Compliance → Settings.');

        if (admins.length === 0) {
            return {
                status: 'warn',
                evidence,
                details: `The policy is published (v${version}) but no organisation admin accounts were found to approve it.${trainingNote}`,
            };
        }
        if (unacked.length === admins.length) {
            return {
                status: 'fail',
                evidence,
                details: `None of the ${admins.length} admin(s) has acknowledged the current information-security policy (v${version}).${trainingNote}`,
            };
        }
        if (unacked.length > 0) {
            return {
                status: 'warn',
                evidence,
                details: `${acked.length} of ${admins.length} admin(s) acknowledged policy v${version}; ${unacked.length} still have to.${trainingNote}`,
            };
        }
        if (!trainingCurrent) {
            return {
                status: 'warn',
                evidence,
                details: `All ${admins.length} admin(s) acknowledged policy v${version}.${trainingNote}`,
            };
        }
        return {
            status: 'pass',
            evidence,
            details: `All ${admins.length} admin(s) acknowledged the current information-security policy (v${version}) and management training was recorded ${trainingAgeDays} day(s) ago.`,
        };
    },
};

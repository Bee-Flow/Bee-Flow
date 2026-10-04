/**
 * EU AI Act — record one attestation: assess, append the register row, write
 * the evidence row and emit the event.
 *
 * Shared by the hub's register (routes/compliance/aiAct.js, admin_compliance)
 * and by the automation's own settings page (routes/automation/aiAct.js, the
 * automation's owner and editors), so an attestation made from either place is
 * the same row, the same evidence and the same event.
 *
 * The evidence row is built from an explicit allow-list: target kind/id,
 * outcome, actor id, attested_at. No prompts, no answers, no titles, no names
 * (BFSF-441). The register row itself holds the answers; the chain only proves
 * that an attestation happened.
 *
 * Dependencies resolve lazily so a test can hand in its own (and so requiring
 * this file never opens a database connection).
 */

'use strict';

const log = require('../../telemetry/log');

const EVIDENCE_CHECK_ID = 'AIA-Art53-model-inventory';

/**
 * `validMonths`, when given, sets the expiry for every outcome (the register's
 * own rule leaves a "not applicable" verdict without one). `source` and
 * `evidence` (the automation's own check, automation/aiActAuto.js) go into the
 * register row only, never into the evidence chain.
 *
 * @param {{ orgId: string, kind: 'automation'|'agent', id: string, signals: object, answers: object, actorId: string|null, validMonths?: number, source?: string|null, evidence?: object|null }} input
 * @param {{ store?: object, complianceStore?: object, events?: object, assess?: object, now?: () => Date }} [deps]
 * @returns {Promise<{ row: object|null, result: object }>}
 */
async function attest({ orgId, kind, id, signals, answers, actorId, validMonths, source = null, evidence = null }, deps = {}) {
    const store = deps.store || require('../../stores/aiActAssessmentStore');
    const complianceStore = deps.complianceStore || require('../../stores/complianceStore');
    const events = deps.events || require('../events');
    const assess = deps.assess || require('./assess');
    const attestedAt = deps.now ? deps.now() : new Date();
    const live = signals || {};
    const result = assess.assess(live, answers || {}, { attestedAt });

    const row = await store.record(orgId, kind, id, {
        signals: live,
        answers: result.answers,
        outcome: result.outcome,
        attestedBy: actorId || null,
        expiresAt: Number.isInteger(validMonths) && validMonths > 0
            ? assess.expiresAt(attestedAt, validMonths)
            : result.expires_at,
        source,
        evidence,
    });

    const payload = {
        target_kind: kind,
        target_id: id,
        outcome: result.outcome,
        actor: actorId || null,
        attested_at: (row?.attested_at ? new Date(row.attested_at) : attestedAt).toISOString(),
    };
    try {
        await complianceStore.addEvidence({
            organization_id: orgId,
            check_id: EVIDENCE_CHECK_ID,
            subject_type: 'ai_act_assessment',
            subject_id: `${kind}:${id}`,
            payload,
        });
    } catch (e) {
        log.warn('[compliance/aiAct] evidence row failed:', e.message);
    }
    try {
        const name = (events.EVENTS && events.EVENTS.AI_ACT_ATTESTED) || 'ai_act_attested';
        events.emit(name, { orgId, targetKind: kind, targetId: id, outcome: result.outcome, actorId: actorId || null });
    } catch (e) {
        log.warn('[compliance/aiAct] event emit failed:', e.message);
    }
    return { row, result };
}

module.exports = { attest, EVIDENCE_CHECK_ID };

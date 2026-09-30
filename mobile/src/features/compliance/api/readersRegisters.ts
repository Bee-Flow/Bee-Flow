/**
 * Contract readers for the registers' rows. Each spec is the allow-list of
 * what the phone reads from one table; the stores' columns are named in the
 * comments so a rename on the server side is found here.
 *
 * Verified against server/routes/compliance/{incidents,isoProcess,isoSoa,
 * isoDocs,isoConnectors,customFrameworks,machinery,dpia}.js, routes/dsr.js
 * and the stores behind them (incidentStore, riskStore, isoAuditStore,
 * isoObligationStore, soaStore, ismsDocStore, customFrameworkStore, dsrStore).
 */

import { field, pick, shapeListOf, shapeOf } from '@/core/api/contract';

/** A SERIAL or UUID id as the string a route segment carries. */
export const idText = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

/** compliance_incidents (breaches, NIS2 incidents, CRA vulnerabilities). */
export const readIncidents = shapeListOf({
    id: idText,
    kind: field.str('breach'),
    title: field.str(''),
    description: field.strOrNull,
    severity: field.str('medium'),
    status: field.str('open'),
    high_risk: field.bool(false),
    occurred_at: field.strOrNull,
    detected_at: field.strOrNull,
    deadline_at: field.strOrNull,
    recipients_notified_at: field.strOrNull,
    authority_notified_at: field.strOrNull,
    authority_reference: field.strOrNull,
    subjects_notified_at: field.strOrNull,
    early_warning_sent_at: field.strOrNull,
    final_report_sent_at: field.strOrNull,
    customer_notified_at: field.strOrNull,
    customer_notice_due_at: field.strOrNull,
    reported_via: field.strOrNull,
    cve_ids: field.strArray,
    exploited_in_wild: boolOrNull,
    updated_at: field.strOrNull,
});

/** routes/dsr.js listRow: the masked row (never the address) plus the clock. */
export const readDsrRequests = shapeListOf({
    id: idText,
    request_type: field.str('access'),
    status: field.str('pending'),
    subject_email_masked: field.strOrNull,
    channel: field.strOrNull,
    identity_status: field.strOrNull,
    notes: field.strOrNull,
    result_summary: field.strOrNull,
    created_at: field.strOrNull,
    due_at: field.strOrNull,
    days_left: field.numOrNull,
    state: field.strOrNull,
    extended_until: field.strOrNull,
    extended_at: field.strOrNull,
    fulfilled_at: field.strOrNull,
});

/** GET /api/dsr/requests/:id/timeline — `{ id, timeline }`. */
export const readDsrTimeline = (raw: unknown) =>
    shapeListOf({ kind: field.str('note'), at: field.strOrNull, text: field.strOrNull })(pick(raw, 'timeline'));

/** iso_risks + iso_risk_treatments (GET /iso/risks → `{ risks, treatments, stats }`). */
export const readRiskBundle = shapeOf({
    risks: field.list(shapeOf({
        id: idText,
        title: field.str(''),
        description: field.strOrNull,
        category: field.strOrNull,
        likelihood: field.numOrNull,
        impact: field.numOrNull,
        score: field.numOrNull,
        status: field.str('open'),
        owner_user_id: field.strOrNull,
        review_due_at: field.strOrNull,
        accepted_at: field.strOrNull,
        source: field.strOrNull,
    })),
    treatments: field.list(shapeOf({
        id: idText,
        risk_id: idText,
        option: field.str('mitigate'),
        description: field.strOrNull,
        due_at: field.strOrNull,
        done_at: field.strOrNull,
    })),
});

/** GET /iso/soa → `{ controls: [{ ref, theme, titleKey, entry }], stats }`, flattened per control. */
export function readSoaControls(raw: unknown) {
    const controls = field.list(shapeOf({
        ref: field.str(''),
        theme: idText,
        titleKey: field.strOrNull,
        entry: field.recordOrNull,
    }))(pick(raw, 'controls'));
    return controls.map((c) => ({
        ref: c.ref,
        theme: c.theme,
        titleKey: c.titleKey,
        seeded: c.entry !== null,
        applicable: boolOrNull(pick(c.entry, 'applicable')) ?? true,
        justification: field.strOrNull(pick(c.entry, 'justification')),
        how_met: field.strOrNull(pick(c.entry, 'how_met')),
        source: field.strOrNull(pick(c.entry, 'source')),
        status: field.str('todo')(pick(c.entry, 'status')),
        owner_user_id: field.strOrNull(pick(c.entry, 'owner_user_id')),
        evidence_ref: field.strOrNull(pick(c.entry, 'evidence_ref')),
        updated_at: field.strOrNull(pick(c.entry, 'updated_at')),
    }));
}

const docSpec = {
    slug: field.str(''),
    title: field.str(''),
    status: field.str('draft'),
    current_version: field.numOrNull,
    owner_user_id: field.strOrNull,
    review_due_at: field.strOrNull,
    edited: field.bool(false),
    updated_at: field.strOrNull,
};

/** GET /iso/docs → `{ documents, missing_seeds }`. */
export const readPolicyBundle = shapeOf({
    documents: field.list(shapeOf(docSpec)),
    missing_seeds: field.list(shapeOf({ slug: field.str(''), title: field.str('') })),
});

/** GET /iso/docs/:slug — the document with its draft text. */
export const readPolicyDoc = shapeOf({ ...docSpec, draft_body: field.strOrNull });

/** GET /iso/audit → the audit and management-review bundle. */
export const readAuditBundle = shapeOf({
    audits: field.list(shapeOf({
        id: idText,
        title: field.str(''),
        scope_note: field.strOrNull,
        auditor_user_id: field.strOrNull,
        status: field.str('planned'),
        planned_at: field.strOrNull,
        started_at: field.strOrNull,
        closed_at: field.strOrNull,
    })),
    findings: field.list(shapeOf({
        id: idText,
        audit_id: idText,
        severity: field.str('observation'),
        description: field.str(''),
        control_ref: field.strOrNull,
        clause: field.strOrNull,
    })),
    reviews: field.list(shapeOf({ id: idText, held_at: field.strOrNull, decisions: field.strOrNull, minutes_evidence_ref: field.strOrNull })),
    ncs: field.list(shapeOf({
        id: idText,
        title: field.str(''),
        description: field.strOrNull,
        source: field.strOrNull,
        severity: field.str('minor'),
        status: field.str('open'),
        corrective_action: field.strOrNull,
        due_at: field.strOrNull,
        effectiveness_review_due_at: field.strOrNull,
        owner_user_id: field.strOrNull,
        closed_at: field.strOrNull,
    })),
    objectives: field.list(shapeOf({
        id: idText,
        title: field.str(''),
        measure: field.strOrNull,
        target: field.strOrNull,
        status: field.str('active'),
        review_due_at: field.strOrNull,
        owner_user_id: field.strOrNull,
    })),
    mr_inputs: field.recordOrNull,
});

/** GET /iso/training → `{ personnel, obligations }`. The e-mail is not read. */
export const readTrainingBundle = shapeOf({
    personnel: field.list(shapeOf({
        user_id: field.str(''),
        displayName: field.str(''),
        policy_acks: field.numOrNull,
        policy_total: field.numOrNull,
        learning_done: field.numOrNull,
        attested_at: field.strOrNull,
        attested_note: field.strOrNull,
    })),
    obligations: field.list(shapeOf({
        id: idText,
        kind: field.str('custom'),
        subject: field.strOrNull,
        title: field.str(''),
        owner_user_id: field.strOrNull,
        due_at: field.strOrNull,
        recur_months: field.numOrNull,
        completed_at: field.strOrNull,
    })),
});

/** GET /iso/connectors — the catalogue with each connector's saved config. */
export function readConnectors(raw: unknown) {
    return shapeListOf({ id: field.str(''), titleKey: field.strOrNull, descKey: field.strOrNull, config: field.recordOrNull, snapshots: field.numOrNull })(raw).map((c) => ({
        id: c.id,
        titleKey: c.titleKey,
        descKey: c.descKey,
        snapshots: c.snapshots,
        enabled: boolOrNull(pick(c.config, 'enabled')) ?? false,
        connection_id: field.strOrNull(pick(c.config, 'connection_id')),
        last_sweep_at: field.strOrNull(pick(c.config, 'last_sweep_at')),
        last_status: field.strOrNull(pick(c.config, 'last_status')),
        last_error: field.strOrNull(pick(c.config, 'last_error')),
    }));
}

const customFrameworkSpec = {
    id: idText,
    code: field.str(''),
    name: field.str(''),
    reference: field.strOrNull,
    description: field.strOrNull,
    attestation_valid_months: field.numOrNull,
    status: field.str('draft'),
};

/** compliance_custom_frameworks (GET /custom/frameworks). */
export const readCustomFrameworks = shapeListOf(customFrameworkSpec);

/** GET /custom/frameworks/:id — the framework with its checks register. */
export const readCustomFramework = shapeOf({
    ...customFrameworkSpec,
    checks: field.list(shapeOf({
        id: idText,
        ref: field.str(''),
        title: field.str(''),
        description: field.strOrNull,
        severity: field.str('medium'),
        evidence_required: field.bool(false),
    })),
});

/** GET /custom/checks/:id/attestations and /machinery/subjects/:id/attestations. */
export const readAttestations = shapeListOf({
    id: idText,
    outcome: field.strOrNull,
    classification: field.strOrNull,
    statement: field.strOrNull,
    attested_at: field.strOrNull,
    expires_at: field.strOrNull,
});

const readAssessment = (v: unknown) =>
    v !== null && typeof v === 'object'
        ? { classification: field.strOrNull(pick(v, 'classification')), attested_at: field.strOrNull(pick(v, 'attested_at')), current: field.bool(false)(pick(v, 'current')) }
        : null;

const readSubject = shapeListOf({
    subject_id: field.strOrNull,
    label: field.strOrNull,
    source: field.strOrNull,
    confidence: field.strOrNull,
    assessment: readAssessment,
});

/** GET /machinery/detections — detected matches plus the manually added subjects. */
export function readMachinery(raw: unknown) {
    return [...readSubject(pick(raw, 'matches')), ...readSubject(pick(raw, 'manual_subjects'))]
        .filter((s) => s.subject_id)
        .map((s) => ({
            subject_id: s.subject_id ?? '',
            label: s.label ?? s.subject_id ?? '',
            source: s.source,
            confidence: s.confidence,
            classification: s.assessment?.classification ?? null,
            attested_at: s.assessment?.attested_at ?? null,
            current: s.assessment?.current ?? false,
        }));
}

/** GET /dpia — the latest assessment per agent. */
export const readDpiaList = shapeListOf({
    agent_id: idText,
    mode: field.strOrNull,
    risk_level: field.strOrNull,
    approved_at: field.strOrNull,
    expires_at: field.strOrNull,
});

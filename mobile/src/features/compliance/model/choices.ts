/**
 * The option tables the registers share — each the server's own vocabulary
 * (the zod enums in server/routes/compliance/*.js), labelled with the web's
 * keys. `choicesLockstep.test.ts` holds the values to those enums.
 */

import type { Choice } from './types';

export const INCIDENT_SEVERITIES: readonly Choice[] = [
    { value: 'low', label: { i18nKey: 'compliance.inc_sev_low', en: 'Low' }, tone: 'neutral' },
    { value: 'medium', label: { i18nKey: 'compliance.inc_sev_medium', en: 'Medium' }, tone: 'warning' },
    { value: 'high', label: { i18nKey: 'compliance.inc_sev_high', en: 'High' }, tone: 'error' },
    { value: 'critical', label: { i18nKey: 'compliance.inc_sev_critical', en: 'Critical' }, tone: 'error' },
];

export const INCIDENT_STATUSES: readonly Choice[] = [
    { value: 'open', label: { i18nKey: 'compliance.inc_status_open', en: 'Open' }, tone: 'error' },
    { value: 'assessing', label: { i18nKey: 'compliance.inc_status_assessing', en: 'Assessing' }, tone: 'warning' },
    { value: 'early_warning_sent', label: { i18nKey: 'compliance.inc_status_early_warning_sent', en: 'Early warning sent' }, tone: 'warning' },
    { value: 'authority_notified', label: { i18nKey: 'compliance.inc_status_authority', en: 'Authority notified' }, tone: 'neutral' },
    { value: 'reported', label: { i18nKey: 'compliance.inc_status_reported', en: 'Reported' }, tone: 'neutral' },
    { value: 'subjects_notified', label: { i18nKey: 'compliance.inc_status_subjects', en: 'Subjects notified' }, tone: 'neutral' },
    { value: 'closed', label: { i18nKey: 'compliance.inc_status_closed', en: 'Closed' }, tone: 'success' },
];

export const DSR_TYPES: readonly Choice[] = [
    { value: 'access', label: { i18nKey: 'compliance.dsr_type_access', en: 'Access request' } },
    { value: 'rectification', label: { i18nKey: 'compliance.dsr_type_rectification', en: 'Rectification request' } },
    { value: 'deletion', label: { i18nKey: 'compliance.dsr_type_deletion', en: 'Deletion request' } },
    { value: 'restriction', label: { i18nKey: 'compliance.dsr_type_restriction', en: 'Restriction request' } },
    { value: 'portability', label: { i18nKey: 'compliance.dsr_type_portability', en: 'Portability request' } },
    { value: 'objection', label: { i18nKey: 'compliance.dsr_type_objection', en: 'Objection' } },
];

export const DSR_STATES: readonly Choice[] = [
    { value: 'pending', label: { i18nKey: 'compliance.dsr_state_pending', en: 'Open' }, tone: 'warning' },
    { value: 'in_progress', label: { i18nKey: 'compliance.dsr_state_in_progress', en: 'In progress' }, tone: 'info' },
    { value: 'fulfilled', label: { i18nKey: 'compliance.dsr_state_fulfilled', en: 'Completed' }, tone: 'success' },
    { value: 'rejected', label: { i18nKey: 'compliance.dsr_state_rejected', en: 'Rejected' }, tone: 'neutral' },
];

/** The channels a DPO records by hand, in the server's spelling (dsrStore VALID_CHANNELS). */
export const DSR_CAPTURE_CHANNELS: readonly Choice[] = [
    { value: 'email_dpo', label: { i18nKey: 'compliance.dsr_channel_email_dpo', en: 'E-mail to the DPO' } },
    { value: 'phone', label: { i18nKey: 'compliance.dsr_channel_phone', en: 'Phone' } },
    { value: 'letter', label: { i18nKey: 'compliance.dsr_channel_letter', en: 'Letter' } },
    { value: 'other', label: { i18nKey: 'compliance.dsr_channel_other', en: 'Other' } },
];

export const DSR_CHANNELS: readonly Choice[] = [
    { value: 'public_form', label: { i18nKey: 'compliance.dsr_channel_public_form', en: 'Public form' } },
    ...DSR_CAPTURE_CHANNELS,
];

export const DSR_IDENTITY: readonly Choice[] = [
    { value: 'unverified', label: { i18nKey: 'compliance.dsr_identity_unverified', en: 'Identity not verified' }, tone: 'warning' },
    { value: 'verified_email_link', label: { i18nKey: 'compliance.dsr_identity_verified_email_link', en: 'Verified via e-mail link' }, tone: 'success' },
    { value: 'verified_manual', label: { i18nKey: 'compliance.dsr_identity_verified_manual', en: 'Verified manually' }, tone: 'success' },
];

export const RISK_STATUSES: readonly Choice[] = [
    { value: 'open', label: { i18nKey: 'compliance.risk_status_open', en: 'Open' }, tone: 'warning' },
    { value: 'treating', label: { i18nKey: 'compliance.risk_status_treating', en: 'Treating' }, tone: 'info' },
    { value: 'accepted', label: { i18nKey: 'compliance.risk_status_accepted', en: 'Accepted' }, tone: 'neutral' },
    { value: 'closed', label: { i18nKey: 'compliance.risk_status_closed', en: 'Closed' }, tone: 'success' },
];

export const RISK_CATEGORIES: readonly Choice[] = [
    { value: 'confidentiality', label: { i18nKey: 'compliance.risk_cat_confidentiality', en: 'Confidentiality' } },
    { value: 'integrity', label: { i18nKey: 'compliance.risk_cat_integrity', en: 'Integrity' } },
    { value: 'availability', label: { i18nKey: 'compliance.risk_cat_availability', en: 'Availability' } },
    { value: 'compliance', label: { i18nKey: 'compliance.risk_cat_compliance', en: 'Compliance' } },
];

/** A 1–5 likelihood or impact; the digits need no translation. */
export const SCALE: readonly Choice[] = ['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: v }));

export const TREATMENT_OPTIONS: readonly Choice[] = [
    { value: 'mitigate', label: { i18nKey: 'compliance.risk_opt_mitigate', en: 'Mitigate' } },
    { value: 'transfer', label: { i18nKey: 'compliance.risk_opt_transfer', en: 'Transfer' } },
    { value: 'avoid', label: { i18nKey: 'compliance.risk_opt_avoid', en: 'Avoid' } },
    { value: 'accept', label: { i18nKey: 'compliance.risk_opt_accept', en: 'Accept' } },
];

export const AUDIT_STATUSES: readonly Choice[] = [
    { value: 'planned', label: { i18nKey: 'compliance.audit_status_planned', en: 'Planned' }, tone: 'info' },
    { value: 'in_progress', label: { i18nKey: 'compliance.audit_status_in_progress', en: 'In progress' }, tone: 'warning' },
    { value: 'closed', label: { i18nKey: 'compliance.audit_status_closed', en: 'Closed' }, tone: 'success' },
];

export const FINDING_SEVERITIES: readonly Choice[] = [
    { value: 'observation', label: { i18nKey: 'compliance.audit_sev_observation', en: 'Observation' } },
    { value: 'minor', label: { i18nKey: 'compliance.audit_sev_minor', en: 'Minor' } },
    { value: 'major', label: { i18nKey: 'compliance.audit_sev_major', en: 'Major' } },
];

export const NC_SOURCES: readonly Choice[] = [
    { value: 'internal_audit', label: { i18nKey: 'compliance.nc_source_internal_audit', en: 'Internal audit' } },
    { value: 'management_review', label: { i18nKey: 'compliance.nc_source_management_review', en: 'Management review' } },
    { value: 'incident', label: { i18nKey: 'compliance.nc_source_incident', en: 'Incident' } },
    { value: 'check', label: { i18nKey: 'compliance.nc_source_check', en: 'Automated check' } },
    { value: 'manual', label: { i18nKey: 'compliance.nc_source_manual', en: 'Manual' } },
];

export const NC_SEVERITIES: readonly Choice[] = [
    { value: 'minor', label: { i18nKey: 'compliance.nc_sev_minor', en: 'Minor' }, tone: 'warning' },
    { value: 'major', label: { i18nKey: 'compliance.nc_sev_major', en: 'Major' }, tone: 'error' },
];

export const NC_STATUSES: readonly Choice[] = [
    { value: 'open', label: { i18nKey: 'compliance.nc_status_open', en: 'Open' }, tone: 'error' },
    { value: 'corrective_action', label: { i18nKey: 'compliance.nc_status_corrective_action', en: 'Corrective action' }, tone: 'warning' },
    { value: 'effectiveness_review', label: { i18nKey: 'compliance.nc_status_effectiveness_review', en: 'Effectiveness review' }, tone: 'info' },
    { value: 'closed', label: { i18nKey: 'compliance.nc_status_closed', en: 'Closed' }, tone: 'success' },
];

export const OBJECTIVE_STATUSES: readonly Choice[] = [
    { value: 'active', label: { i18nKey: 'compliance.obj_status_active', en: 'Active' }, tone: 'info' },
    { value: 'achieved', label: { i18nKey: 'compliance.obj_status_achieved', en: 'Achieved' }, tone: 'success' },
    { value: 'dropped', label: { i18nKey: 'compliance.obj_status_dropped', en: 'Dropped' }, tone: 'neutral' },
];

export const OBLIGATION_KINDS: readonly Choice[] = [
    { value: 'policy_review', label: { i18nKey: 'compliance.obl_kind_policy_review', en: 'Policy review' } },
    { value: 'soa_review', label: { i18nKey: 'compliance.obl_kind_soa_review', en: 'SoA review' } },
    { value: 'internal_audit', label: { i18nKey: 'compliance.obl_kind_internal_audit', en: 'Internal audit' } },
    { value: 'management_review', label: { i18nKey: 'compliance.obl_kind_management_review', en: 'Management review' } },
    { value: 'training', label: { i18nKey: 'compliance.obl_kind_training', en: 'Training' } },
    { value: 'access_review', label: { i18nKey: 'compliance.obl_kind_access_review', en: 'Access review' } },
    { value: 'supplier_review', label: { i18nKey: 'compliance.obl_kind_supplier_review', en: 'Supplier review' } },
    { value: 'pentest', label: { i18nKey: 'compliance.obl_kind_pentest', en: 'Penetration test' } },
    { value: 'custom', label: { i18nKey: 'compliance.obl_kind_custom', en: 'Custom' } },
];

export const SOA_DECISIONS: readonly Choice[] = [
    { value: 'todo', label: { i18nKey: 'compliance.soa_decision_todo', en: 'To review' }, tone: 'warning' },
    { value: 'reviewed', label: { i18nKey: 'compliance.soa_decision_reviewed', en: 'Reviewed' }, tone: 'info' },
    { value: 'approved', label: { i18nKey: 'compliance.soa_decision_approved', en: 'Approved' }, tone: 'success' },
];

/** ISO 27001 Annex A themes (compliance/iso/controls.js THEMES: 5–8). */
export const SOA_THEMES: readonly Choice[] = [
    { value: '5', label: { i18nKey: 'compliance.soa_theme_a5', en: 'A.5 Organisational' } },
    { value: '6', label: { i18nKey: 'compliance.soa_theme_a6', en: 'A.6 People' } },
    { value: '7', label: { i18nKey: 'compliance.soa_theme_a7', en: 'A.7 Physical' } },
    { value: '8', label: { i18nKey: 'compliance.soa_theme_a8', en: 'A.8 Technological' } },
];

export const POLICY_STATUSES: readonly Choice[] = [
    { value: 'draft', label: { i18nKey: 'compliance.policies_draft', en: 'Draft — not yet published' }, tone: 'warning' },
    { value: 'published', label: { i18nKey: 'compliance.policies_status_published', en: 'Published' }, tone: 'success' },
];

export const CUSTOM_STATUSES: readonly Choice[] = [
    { value: 'draft', label: { i18nKey: 'compliance.custom_status_fw_draft', en: 'Draft' }, tone: 'neutral' },
    { value: 'active', label: { i18nKey: 'compliance.custom_status_fw_active', en: 'Active' }, tone: 'success' },
];

export const CUSTOM_OUTCOMES: readonly Choice[] = [
    { value: 'compliant', label: { i18nKey: 'compliance.custom_outcome_compliant', en: 'Compliant' }, tone: 'success' },
    { value: 'partial', label: { i18nKey: 'compliance.custom_outcome_partial', en: 'Partly compliant' }, tone: 'warning' },
    { value: 'non_compliant', label: { i18nKey: 'compliance.custom_outcome_non_compliant', en: 'Not compliant' }, tone: 'error' },
    { value: 'not_applicable', label: { i18nKey: 'compliance.custom_outcome_not_applicable', en: 'Not applicable' }, tone: 'neutral' },
];

export const MACHINERY_CLASSES: readonly Choice[] = [
    { value: 'safety_component', label: { i18nKey: 'compliance.mach_classification_safety_component', en: 'Safety component' }, tone: 'error' },
    { value: 'monitoring_only', label: { i18nKey: 'compliance.mach_classification_monitoring_only', en: 'Monitoring only' }, tone: 'info' },
    { value: 'not_safety_component', label: { i18nKey: 'compliance.mach_classification_not_safety_component', en: 'Not a safety component' }, tone: 'success' },
];

export const DPIA_RISKS: readonly Choice[] = [
    { value: 'low', label: { i18nKey: 'compliance.dpia_risk_low', en: 'Low' } },
    { value: 'medium', label: { i18nKey: 'compliance.dpia_risk_medium', en: 'Medium' } },
    { value: 'high', label: { i18nKey: 'compliance.dpia_risk_high', en: 'High' } },
];

/** A compliance check's result (registry.js): pass · warn · fail · not_applicable · pending. */
export const CHECK_STATUSES: readonly Choice[] = [
    { value: 'pass', label: { i18nKey: 'compliance.status_pass', en: 'Passing' }, tone: 'success' },
    { value: 'warn', label: { i18nKey: 'compliance.status_warn', en: 'Needs attention' }, tone: 'warning' },
    { value: 'fail', label: { i18nKey: 'compliance.status_fail', en: 'Failing' }, tone: 'error' },
    { value: 'not_applicable', label: { i18nKey: 'compliance.status_na', en: 'Not applicable' }, tone: 'neutral' },
    { value: 'pending', label: { i18nKey: 'compliance.status_pending', en: 'Not yet run' }, tone: 'neutral' },
];

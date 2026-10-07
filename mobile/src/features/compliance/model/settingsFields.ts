/**
 * The compliance settings form, ported from the web's declarative table
 * (agent-hub pages/settings/settingsFields.js; `settingsLockstep.test.ts`
 * holds the field names and kinds to it). Every name is a
 * `compliance_settings` column in the server's SETTINGS_FIELDS whitelist
 * (stores/complianceStore.js), which PUT /api/compliance/settings runs the
 * body through; a `relevance` field is not a column — it goes to
 * POST /frameworks/:id/relevance.
 *
 * The phone saves only the columns the admin changed. The server merges a
 * patch (sanitizeSettingsPatch + saveSettings), so an unchanged column —
 * including the DORA contact list the phone shows but does not edit — is
 * left exactly as stored.
 */

import type { Choice, Label } from './types';

export type SettingKind =
    | 'text' | 'email' | 'url' | 'number' | 'date' | 'select' | 'toggle'
    | 'chips' | 'emails' | 'strings' | 'stamp' | 'user' | 'contacts' | 'relevance';

export interface SettingField {
    readonly name: string;
    readonly kind: SettingKind;
    readonly label: Label;
    readonly hint?: Label;
    readonly options?: readonly Choice[];
    readonly dependsOn?: string;
    /** A toggle that reads as on while the server holds no value (web: defaultOn). */
    readonly defaultOn?: boolean;
}

export interface SettingGroup {
    readonly id: string;
    /** The framework the group belongs to; a group of a framework that is off folds shut. */
    readonly framework: string;
    readonly title: Label;
    readonly description: Label;
    readonly fields: readonly SettingField[];
}

const L = (i18nKey: string, en: string): Label => ({ i18nKey, en });
const f = (name: string, kind: SettingKind, label: Label, extra: Partial<SettingField> = {}): SettingField => ({ name, kind, label, ...extra });
const UNANSWERED: Choice = { value: '', label: { i18nKey: 'compliance.set_unanswered', en: 'Not answered yet' } };

export const LEGAL_BASES: readonly Choice[] = [
    { value: 'consent', label: { i18nKey: 'compliance.lb_consent', en: 'Consent' } },
    { value: 'contract', label: { i18nKey: 'compliance.lb_contract', en: 'Contract' } },
    { value: 'legal_obligation', label: { i18nKey: 'compliance.lb_legal_obligation', en: 'Legal obligation' } },
    { value: 'vital_interests', label: { i18nKey: 'compliance.lb_vital_interests', en: 'Vital interests' } },
    { value: 'public_task', label: { i18nKey: 'compliance.lb_public_task', en: 'Public task' } },
    { value: 'legitimate_interests', label: { i18nKey: 'compliance.lb_legitimate_interests', en: 'Legitimate interests' } },
];

const RESIDENCY: readonly Choice[] = [
    { value: 'eu', label: { i18nKey: 'compliance.residency_eu', en: 'EU-only' } },
    { value: 'internal', label: { i18nKey: 'compliance.residency_internal', en: 'Self-hosted only' } },
    { value: 'hybrid', label: { i18nKey: 'compliance.residency_hybrid', en: 'Hybrid' } },
];

const NIS2_CLASSES: readonly Choice[] = [
    UNANSWERED,
    { value: 'not_in_scope', label: { i18nKey: 'compliance.set_nis2_class_not_in_scope', en: 'Not in scope' } },
    { value: 'supplier_only', label: { i18nKey: 'compliance.set_nis2_class_supplier_only', en: 'Supplier to an in-scope entity' } },
    { value: 'important', label: { i18nKey: 'compliance.set_nis2_class_important', en: 'Important entity' } },
    { value: 'essential', label: { i18nKey: 'compliance.set_nis2_class_essential', en: 'Essential entity' } },
];

const CRA_ROLES: readonly Choice[] = [
    UNANSWERED,
    { value: 'manufacturer', label: { i18nKey: 'compliance.set_cra_role_manufacturer', en: 'Manufacturer' } },
    { value: 'distributor', label: { i18nKey: 'compliance.set_cra_role_distributor', en: 'Importer / distributor' } },
    { value: 'user_only', label: { i18nKey: 'compliance.set_cra_role_user_only', en: 'User only' } },
];

const CONFORMANCE: readonly Choice[] = [
    UNANSWERED,
    { value: 'WCAG 2.1 AA', label: { i18nKey: 'compliance.set_eaa_level_wcag21aa', en: 'WCAG 2.1 AA' } },
    { value: 'WCAG 2.2 AA', label: { i18nKey: 'compliance.set_eaa_level_wcag22aa', en: 'WCAG 2.2 AA' } },
    { value: 'EN 301 549', label: { i18nKey: 'compliance.set_eaa_level_en301549', en: 'EN 301 549' } },
    { value: 'partial', label: { i18nKey: 'compliance.set_eaa_level_partial', en: 'Partially conformant' } },
];

/** The three answers POST /frameworks/:id/relevance accepts. */
export const RELEVANCE: readonly Choice[] = [
    { value: 'unknown', label: { i18nKey: 'compliance.set_relevance_unknown', en: 'Not answered yet' } },
    { value: 'relevant', label: { i18nKey: 'compliance.set_relevance_relevant', en: 'Applies to us' } },
    { value: 'not_relevant', label: { i18nKey: 'compliance.set_relevance_not_relevant', en: 'Does not apply to us' } },
];

export const SETTING_GROUPS: readonly SettingGroup[] = [
    {
        id: 'general',
        framework: 'gdpr',
        title: L('compliance.set_group_general', 'General'),
        description: L('compliance.set_group_general_desc', 'The organisation facts every framework reads: who is accountable, where data may live, and how people reach you.'),
        fields: [
            f('dpo_name', 'text', L('compliance.dpo_name', 'DPO name')),
            f('dpo_email', 'email', L('compliance.dpo_email', 'DPO email')),
            f('dpo_phone', 'text', L('compliance.dpo_phone', 'DPO phone')),
            f('legal_bases', 'chips', L('compliance.settings_legal_bases', 'Legal bases'), { options: LEGAL_BASES, hint: L('compliance.settings_legal_bases_desc', 'GDPR Art. 6 grounds you rely on for processing personal data.') }),
            f('data_residency', 'select', L('compliance.data_residency', 'Data residency'), { options: RESIDENCY }),
            f('default_retention_days', 'number', L('compliance.default_retention_days', 'Memory retention (days)')),
            f('datatable_review_days', 'number', L('compliance.settings.datatable_review_days', 'Re-confirm a registered processing every (days)'), { hint: L('compliance.settings.datatable_review_days_hint', 'How long an entry in the processing register may stand before someone reads it again. 180 days when left empty.') }),
            f('project_retention_days', 'number', L('compliance.settings.project_retention_days', 'Keep unused projects with personal data for (days)'), { hint: L('compliance.settings.project_retention_days_hint', 'How long a collaborative project may go unused while it holds personal data. 365 days when left empty.') }),
            f('privacy_notice_url', 'url', L('compliance.privacy_notice_url', 'Privacy notice URL')),
            f('breach_recipients', 'emails', L('compliance.settings_breach', 'Breach notification recipients'), { hint: L('compliance.settings_breach_desc', 'Emails alerted on anomalous data-access events.') }),
            f('public_base_url', 'url', L('compliance.set_public_base_url', 'Public base URL'), { hint: L('compliance.set_public_base_url_hint', 'The address your customers reach — the checks probe security.txt, the privacy notice and the accessibility statement here.') }),
            f('sso_enforces_mfa', 'toggle', L('compliance.set_sso_enforces_mfa', 'Our SSO enforces multi-factor authentication'), { hint: L('compliance.set_sso_enforces_mfa_hint', 'Bee Flow cannot see what your identity provider requires — answer for it.') }),
            f('project_owner_hints_enabled', 'toggle', L('compliance.settings.project_owner_hints_enabled', 'Show project owners one gentle hint they can act on'), {
                defaultOn: true,
                hint: L('compliance.settings.project_owner_hints_enabled_hint', 'At most one dismissible suggestion per project — members from outside, accounts that are gone, files not checked. Never about personal data in the project; that stays with you.'),
            }),
        ],
    },
    {
        id: 'ai_act',
        framework: 'aia',
        title: L('compliance.set_group_ai_act', 'AI Act'),
        description: L('compliance.set_group_ai_act_desc', 'AI literacy (Art. 4) and the marking of AI-generated content (Art. 50(2)).'),
        fields: [
            f('ai_literacy_material_url', 'url', L('compliance.ai_literacy_url', 'Training material URL (optional)')),
            f('ai_literacy_confirmed_at', 'stamp', L('compliance.settings_ai_literacy', 'AI literacy (EU AI Act Art. 4)')),
            f('ai_content_marking_enabled', 'toggle', L('compliance.set_ai_marking', 'Mark AI-generated content'), { hint: L('compliance.set_ai_marking_hint', 'Required from 2 December 2026 (AI Act Art. 50(2)): documents and pages the AI writes carry a machine-readable marking and a visible note.') }),
            f('ai_content_marking_footer', 'text', L('compliance.set_ai_marking_footer', 'Visible footer text (optional)'), { dependsOn: 'ai_content_marking_enabled', hint: L('compliance.set_ai_marking_footer_hint', 'Leave empty for the default sentence.') }),
        ],
    },
    {
        id: 'nis2',
        framework: 'nis2',
        title: L('compliance.set_group_nis2', 'NIS2'),
        description: L('compliance.set_group_nis2_desc', 'Your entity class, the national registration and the channels an incident report travels through.'),
        fields: [
            f('nis2_entity_class', 'select', L('compliance.set_nis2_class', 'Entity class'), { options: NIS2_CLASSES, hint: L('compliance.set_nis2_class_hint', 'Annex I/II of the directive, as implemented nationally.') }),
            f('nis2_registration_reference', 'text', L('compliance.set_nis2_reference', 'Registration reference')),
            f('nis2_registered_at', 'date', L('compliance.set_nis2_registered_at', 'Registered on')),
            f('nis2_authority_channel', 'text', L('compliance.set_nis2_authority', 'Authority reporting channel'), { hint: L('compliance.set_nis2_authority_hint', 'Where the 24-hour early warning goes — a portal URL or an address.') }),
            f('nis2_csirt_contact', 'text', L('compliance.set_nis2_csirt', 'CSIRT contact')),
            f('nis2_board_training_at', 'date', L('compliance.set_nis2_board_training', 'Management-body training on'), { hint: L('compliance.set_nis2_board_training_hint', 'Art. 20(2): the management body follows cyber-risk training.') }),
        ],
    },
    {
        id: 'cra',
        framework: 'cra',
        title: L('compliance.set_group_cra', 'Cyber Resilience Act'),
        description: L('compliance.set_group_cra_desc', 'Your role in the product chain, the vulnerability-handling channels and the support window you promise.'),
        fields: [
            f('cra_role', 'select', L('compliance.set_cra_role', 'Role under the CRA'), { options: CRA_ROLES }),
            f('cra_reporting_channel', 'text', L('compliance.set_cra_reporting_channel', 'ENISA / CSIRT reporting channel'), { hint: L('compliance.set_cra_reporting_channel_hint', 'Where the 24-hour early warning for an actively exploited vulnerability goes.') }),
            f('psirt_contact_email', 'email', L('compliance.set_psirt_email', 'PSIRT e-mail')),
            f('vuln_disclosure_url', 'url', L('compliance.set_vuln_disclosure_url', 'Coordinated disclosure policy URL')),
            f('security_txt_policy_enabled', 'toggle', L('compliance.set_security_txt', 'Publish security.txt'), { hint: L('compliance.set_security_txt_hint', 'Serves /.well-known/security.txt on the public base URL with the PSIRT address and the policy link.') }),
            f('support_policy_url', 'url', L('compliance.set_support_policy_url', 'Support policy URL')),
            f('support_end_date', 'date', L('compliance.set_support_end_date', 'Support period ends on'), { hint: L('compliance.set_support_end_date_hint', 'At least five years from placing the product on the market, unless its expected lifetime is shorter.') }),
            f('security_update_channel', 'text', L('compliance.set_update_channel', 'Security-update channel')),
        ],
    },
    {
        id: 'data_act',
        framework: 'data_act',
        title: L('compliance.set_group_data_act', 'Data Act'),
        description: L('compliance.set_group_data_act_desc', 'Switching and exit: the notice period you grant and the last time the exit procedure was actually rehearsed.'),
        fields: [
            f('data_act_provider_role', 'toggle', L('compliance.set_data_act_provider', 'We are a data-processing-service provider'), { hint: L('compliance.set_data_act_provider_hint', 'Chapter VI applies when you resell or host this workspace for customers.') }),
            f('notice_period_days', 'number', L('compliance.set_notice_period_days', 'Notice period (days)')),
            f('exit_procedure_tested_at', 'date', L('compliance.set_exit_tested_at', 'Exit procedure tested on')),
            f('exit_procedure_tested_by', 'user', L('compliance.set_exit_tested_by', 'Tested by')),
        ],
    },
    {
        id: 'eaa',
        framework: 'eaa',
        title: L('compliance.set_group_eaa', 'Accessibility (EAA)'),
        description: L('compliance.set_group_eaa_desc', 'The accessibility statement for your public surfaces and the level you declare in it.'),
        fields: [
            f('accessibility_statement_url', 'url', L('compliance.set_a11y_url', 'Accessibility statement URL')),
            f('accessibility_conformance_level', 'select', L('compliance.set_a11y_level', 'Declared conformance level'), { options: CONFORMANCE }),
            f('accessibility_conformance_at', 'date', L('compliance.set_a11y_at', 'Declared on')),
        ],
    },
    {
        id: 'dora',
        framework: 'dora',
        title: L('compliance.set_group_dora', 'DORA'),
        description: L('compliance.set_group_dora_desc', 'As an ICT third-party provider to financial entities: who you warn, how fast, and on which contract terms.'),
        fields: [
            f('dora', 'relevance', L('compliance.set_dora_relevance', 'Do we serve financial entities?'), { hint: L('compliance.set_dora_relevance_hint', 'DORA reaches you through your customers, not through your own sector.') }),
            f('incident_customer_contacts', 'contacts', L('compliance.set_dora_contacts', 'Customer incident contacts'), { hint: L('compliance.set_dora_contacts_hint', 'The people at your financial customers who must hear about a major ICT incident.') }),
            f('dora_customer_notice_hours', 'number', L('compliance.set_dora_notice_hours', 'Customer notice (hours)'), { hint: L('compliance.set_dora_notice_hours_hint', 'The contractual window in which you warn the customer. Default 4.') }),
            f('dora_contract_clauses_confirmed_at', 'date', L('compliance.set_dora_clauses_at', 'Contract clauses confirmed on')),
            f('dora_contract_clauses_confirmed_by', 'user', L('compliance.set_dora_clauses_by', 'Confirmed by')),
            f('dora_contract_template_url', 'url', L('compliance.set_dora_template_url', 'Contract template URL')),
        ],
    },
    {
        id: 'machinery',
        framework: 'machinery',
        title: L('compliance.set_group_machinery', 'Machinery Regulation'),
        description: L('compliance.set_group_machinery_desc', 'Only when this workspace drives or advises machinery: the subjects that need a safety assessment.'),
        fields: [
            f('machinery', 'relevance', L('compliance.set_machinery_relevance', 'Does our AI touch machinery?'), { hint: L('compliance.set_machinery_relevance_hint', 'Agents that control, monitor or advise on industrial equipment.') }),
            f('machinery_manual_subjects', 'strings', L('compliance.set_machinery_subjects', 'Manually added subjects'), { hint: L('compliance.set_machinery_subjects_hint', 'Integrations the detector cannot see — one line per machine or bridge.') }),
        ],
    },
];

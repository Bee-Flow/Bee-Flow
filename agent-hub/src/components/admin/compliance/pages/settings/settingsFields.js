/**
 * settingsFields — the declarative description of the compliance settings form.
 *
 * Every field name is EXACTLY a `compliance_settings` column from PLAN.md §1.3
 * (the server's table-driven `saveSettings` whitelist, `SETTINGS_FIELDS` in
 * `stores/complianceStore.js`); a name that is not in that whitelist is dropped
 * server-side, so the two lists are meant to be read side by side.
 *
 * The groups follow the frameworks, not the database: an organisation that has
 * only GDPR on sees General + AI Act; NIS2/CRA/Data Act/EAA/DORA/Machinery
 * groups carry a `framework` id so the page can fold the ones that are off.
 *
 * `{key, en}` label tables live here — this file belongs on `KEY_TABLE_FILES`
 * in `i18nGuard.test.js` (ask in the DONE file).
 */

/* ── option tables ───────────────────────────────────────────────────────── */

export const LEGAL_BASES = Object.freeze([
    Object.freeze({ value: 'consent', key: 'compliance.lb_consent', en: 'Consent' }),
    Object.freeze({ value: 'contract', key: 'compliance.lb_contract', en: 'Contract' }),
    Object.freeze({ value: 'legal_obligation', key: 'compliance.lb_legal_obligation', en: 'Legal obligation' }),
    Object.freeze({ value: 'vital_interests', key: 'compliance.lb_vital_interests', en: 'Vital interests' }),
    Object.freeze({ value: 'public_task', key: 'compliance.lb_public_task', en: 'Public task' }),
    Object.freeze({ value: 'legitimate_interests', key: 'compliance.lb_legitimate_interests', en: 'Legitimate interests' }),
]);

const RESIDENCY = Object.freeze([
    Object.freeze({ value: 'eu', key: 'compliance.residency_eu', en: 'EU-only' }),
    Object.freeze({ value: 'internal', key: 'compliance.residency_internal', en: 'Self-hosted only' }),
    Object.freeze({ value: 'hybrid', key: 'compliance.residency_hybrid', en: 'Hybrid' }),
]);

export const NIS2_ENTITY_CLASSES = Object.freeze([
    Object.freeze({ value: '', key: 'compliance.set_unanswered', en: 'Not answered yet' }),
    Object.freeze({ value: 'not_in_scope', key: 'compliance.set_nis2_class_not_in_scope', en: 'Not in scope' }),
    Object.freeze({ value: 'supplier_only', key: 'compliance.set_nis2_class_supplier_only', en: 'Supplier to an in-scope entity' }),
    Object.freeze({ value: 'important', key: 'compliance.set_nis2_class_important', en: 'Important entity' }),
    Object.freeze({ value: 'essential', key: 'compliance.set_nis2_class_essential', en: 'Essential entity' }),
]);

export const CRA_ROLES = Object.freeze([
    Object.freeze({ value: '', key: 'compliance.set_unanswered', en: 'Not answered yet' }),
    Object.freeze({ value: 'manufacturer', key: 'compliance.set_cra_role_manufacturer', en: 'Manufacturer' }),
    Object.freeze({ value: 'distributor', key: 'compliance.set_cra_role_distributor', en: 'Importer / distributor' }),
    Object.freeze({ value: 'user_only', key: 'compliance.set_cra_role_user_only', en: 'User only' }),
]);

export const CONFORMANCE_LEVELS = Object.freeze([
    Object.freeze({ value: '', key: 'compliance.set_unanswered', en: 'Not answered yet' }),
    Object.freeze({ value: 'WCAG 2.1 AA', key: 'compliance.set_eaa_level_wcag21aa', en: 'WCAG 2.1 AA' }),
    Object.freeze({ value: 'WCAG 2.2 AA', key: 'compliance.set_eaa_level_wcag22aa', en: 'WCAG 2.2 AA' }),
    Object.freeze({ value: 'EN 301 549', key: 'compliance.set_eaa_level_en301549', en: 'EN 301 549' }),
    Object.freeze({ value: 'partial', key: 'compliance.set_eaa_level_partial', en: 'Partially conformant' }),
]);

/** The three answers `frameworks.setRelevance(id, value, note)` accepts. */
export const RELEVANCE_OPTIONS = Object.freeze([
    Object.freeze({ value: 'unknown', key: 'compliance.set_relevance_unknown', en: 'Not answered yet' }),
    Object.freeze({ value: 'relevant', key: 'compliance.set_relevance_relevant', en: 'Applies to us' }),
    Object.freeze({ value: 'not_relevant', key: 'compliance.set_relevance_not_relevant', en: 'Does not apply to us' }),
]);

/* ── the groups ──────────────────────────────────────────────────────────── */

/**
 * field kinds:
 *  text · email · url · number · date · select · toggle (`defaultOn`: absent reads as on)
 *  stamp    — "confirm now" button that writes an ISO timestamp (+ who, server-side)
 *  user     — org-member select, stores the user id
 *  chips    — multi-select of `options` into an array (legal bases)
 *  emails   — editable list of e-mail addresses (+ org-member picker)
 *  strings  — editable list of free-text lines
 *  contacts — list of {name, email, entity} rows
 *  relevance— NOT a settings column: routed to frameworks.setRelevance(framework)
 */
export const SETTINGS_GROUPS = Object.freeze([
    Object.freeze({
        id: 'general',
        framework: 'gdpr',
        titleKey: 'compliance.set_group_general', titleEn: 'General',
        descKey: 'compliance.set_group_general_desc',
        descEn: 'The organisation facts every framework reads: who is accountable, where data may live, and how people reach you.',
        fields: Object.freeze([
            Object.freeze({ name: 'dpo_user', kind: 'userfill', labelKey: 'compliance.pick_org_user', labelEn: 'Fill from an organisation member' }),
            Object.freeze({ name: 'dpo_name', kind: 'text', labelKey: 'compliance.dpo_name', labelEn: 'DPO name', placeholder: 'Jane Doe' }),
            Object.freeze({ name: 'dpo_email', kind: 'email', labelKey: 'compliance.dpo_email', labelEn: 'DPO email', placeholder: 'dpo@example.com' }),
            Object.freeze({ name: 'dpo_phone', kind: 'text', labelKey: 'compliance.dpo_phone', labelEn: 'DPO phone', placeholder: '+31 6 …' }),
            Object.freeze({
                name: 'legal_bases', kind: 'chips', options: LEGAL_BASES,
                labelKey: 'compliance.settings_legal_bases', labelEn: 'Legal bases',
                hintKey: 'compliance.settings_legal_bases_desc', hintEn: 'GDPR Art. 6 grounds you rely on for processing personal data.',
            }),
            Object.freeze({ name: 'data_residency', kind: 'select', options: RESIDENCY, labelKey: 'compliance.data_residency', labelEn: 'Data residency' }),
            Object.freeze({ name: 'default_retention_days', kind: 'number', min: 0, labelKey: 'compliance.default_retention_days', labelEn: 'Memory retention (days)', placeholder: '365' }),
            // Art. 30(4): a record has to be kept up to date. This is how long
            // an entry in the processing register may stand before someone
            // reads it again — GDPR-Art30-datatable-registrations warns past it.
            Object.freeze({
                name: 'datatable_review_days', kind: 'number', min: 30, max: 3650, placeholder: '180',
                labelKey: 'compliance.settings.datatable_review_days', labelEn: 'Re-confirm a registered processing every (days)',
                hintKey: 'compliance.settings.datatable_review_days_hint', hintEn: 'How long an entry in the processing register may stand before someone reads it again. 180 days when left empty.',
            }),
            // Collaborative projects: how long an unused project with personal
            // data may stay (GDPR-Art5-1-e-project-retention, 365 when empty),
            // and whether owners see the one gentle hint they can act on.
            Object.freeze({
                name: 'project_retention_days', kind: 'number', min: 30, max: 3650, placeholder: '365',
                labelKey: 'compliance.settings.project_retention_days', labelEn: 'Keep unused projects with personal data for (days)',
                hintKey: 'compliance.settings.project_retention_days_hint', hintEn: 'How long a collaborative project may go unused while it holds personal data. 365 days when left empty.',
            }),
            Object.freeze({
                // On unless switched off: an absent value must not read as "off"
                // and be saved back as a decision nobody made.
                name: 'project_owner_hints_enabled', kind: 'toggle', defaultOn: true,
                labelKey: 'compliance.settings.project_owner_hints_enabled', labelEn: 'Show project owners one gentle hint they can act on',
                hintKey: 'compliance.settings.project_owner_hints_enabled_hint', hintEn: 'At most one dismissible suggestion per project — members from outside, accounts that are gone, files not checked. Never about personal data in the project; that stays with you.',
            }),
            Object.freeze({ name: 'privacy_notice_url', kind: 'url', labelKey: 'compliance.privacy_notice_url', labelEn: 'Privacy notice URL', placeholder: 'https://yourcompany.com/privacy' }),
            Object.freeze({
                name: 'breach_recipients', kind: 'emails',
                labelKey: 'compliance.settings_breach', labelEn: 'Breach notification recipients',
                hintKey: 'compliance.settings_breach_desc', hintEn: 'Emails alerted on anomalous data-access events.',
            }),
            Object.freeze({
                name: 'public_base_url', kind: 'url',
                labelKey: 'compliance.set_public_base_url', labelEn: 'Public base URL',
                hintKey: 'compliance.set_public_base_url_hint', hintEn: 'The address your customers reach — the checks probe security.txt, the privacy notice and the accessibility statement here.',
                placeholder: 'https://yourcompany.com',
            }),
            Object.freeze({
                name: 'sso_enforces_mfa', kind: 'toggle',
                labelKey: 'compliance.set_sso_enforces_mfa', labelEn: 'Our SSO enforces multi-factor authentication',
                hintKey: 'compliance.set_sso_enforces_mfa_hint', hintEn: 'Bee Flow cannot see what your identity provider requires — answer for it.',
            }),
        ]),
    }),

    Object.freeze({
        id: 'ai_act',
        framework: 'aia',
        titleKey: 'compliance.set_group_ai_act', titleEn: 'AI Act',
        descKey: 'compliance.set_group_ai_act_desc',
        descEn: 'AI literacy (Art. 4) and the marking of AI-generated content (Art. 50(2)).',
        fields: Object.freeze([
            Object.freeze({ name: 'ai_literacy_material_url', kind: 'url', labelKey: 'compliance.ai_literacy_url', labelEn: 'Training material URL (optional)', placeholder: 'https://intranet.example.com/ai-training' }),
            Object.freeze({
                name: 'ai_literacy_confirmed_at', kind: 'stamp',
                labelKey: 'compliance.settings_ai_literacy', labelEn: 'AI literacy (EU AI Act Art. 4)',
                actionKey: 'compliance.ai_literacy_confirm', actionEn: 'Confirm measures now',
                setKey: 'compliance.ai_literacy_confirmed_at', setEn: 'Confirmed {date} — remember to save',
                unsetKey: 'compliance.ai_literacy_never', unsetEn: 'Not confirmed yet',
            }),
            Object.freeze({
                name: 'ai_content_marking_enabled', kind: 'toggle',
                labelKey: 'compliance.set_ai_marking', labelEn: 'Mark AI-generated content',
                hintKey: 'compliance.set_ai_marking_hint', hintEn: 'Required from 2 December 2026 (AI Act Art. 50(2)): documents and pages the AI writes carry a machine-readable marking and a visible note.',
            }),
            Object.freeze({
                name: 'ai_content_marking_footer', kind: 'text',
                labelKey: 'compliance.set_ai_marking_footer', labelEn: 'Visible footer text (optional)',
                hintKey: 'compliance.set_ai_marking_footer_hint', hintEn: 'Leave empty for the default sentence.',
                placeholder: 'This document was produced with AI assistance.',
                dependsOn: 'ai_content_marking_enabled',
            }),
        ]),
    }),

    Object.freeze({
        id: 'nis2',
        framework: 'nis2',
        titleKey: 'compliance.set_group_nis2', titleEn: 'NIS2',
        descKey: 'compliance.set_group_nis2_desc',
        descEn: 'Your entity class, the national registration and the channels an incident report travels through.',
        fields: Object.freeze([
            Object.freeze({
                name: 'nis2_entity_class', kind: 'select', options: NIS2_ENTITY_CLASSES,
                labelKey: 'compliance.set_nis2_class', labelEn: 'Entity class',
                hintKey: 'compliance.set_nis2_class_hint', hintEn: 'Annex I/II of the directive, as implemented nationally.',
            }),
            Object.freeze({ name: 'nis2_registration_reference', kind: 'text', labelKey: 'compliance.set_nis2_reference', labelEn: 'Registration reference', placeholder: 'RDI-2026-00123' }),
            Object.freeze({ name: 'nis2_registered_at', kind: 'date', labelKey: 'compliance.set_nis2_registered_at', labelEn: 'Registered on' }),
            Object.freeze({
                name: 'nis2_authority_channel', kind: 'text',
                labelKey: 'compliance.set_nis2_authority', labelEn: 'Authority reporting channel',
                hintKey: 'compliance.set_nis2_authority_hint', hintEn: 'Where the 24-hour early warning goes — a portal URL or an address.',
            }),
            Object.freeze({ name: 'nis2_csirt_contact', kind: 'text', labelKey: 'compliance.set_nis2_csirt', labelEn: 'CSIRT contact', placeholder: 'csirt@example.org' }),
            Object.freeze({
                name: 'nis2_board_training_at', kind: 'date',
                labelKey: 'compliance.set_nis2_board_training', labelEn: 'Management-body training on',
                hintKey: 'compliance.set_nis2_board_training_hint', hintEn: 'Art. 20(2): the management body follows cyber-risk training.',
            }),
        ]),
    }),

    Object.freeze({
        id: 'cra',
        framework: 'cra',
        titleKey: 'compliance.set_group_cra', titleEn: 'Cyber Resilience Act',
        descKey: 'compliance.set_group_cra_desc',
        descEn: 'Your role in the product chain, the vulnerability-handling channels and the support window you promise.',
        fields: Object.freeze([
            Object.freeze({ name: 'cra_role', kind: 'select', options: CRA_ROLES, labelKey: 'compliance.set_cra_role', labelEn: 'Role under the CRA' }),
            Object.freeze({
                name: 'cra_reporting_channel', kind: 'text',
                labelKey: 'compliance.set_cra_reporting_channel', labelEn: 'ENISA / CSIRT reporting channel',
                hintKey: 'compliance.set_cra_reporting_channel_hint', hintEn: 'Where the 24-hour early warning for an actively exploited vulnerability goes.',
            }),
            Object.freeze({ name: 'psirt_contact_email', kind: 'email', labelKey: 'compliance.set_psirt_email', labelEn: 'PSIRT e-mail', placeholder: 'psirt@example.com' }),
            Object.freeze({ name: 'vuln_disclosure_url', kind: 'url', labelKey: 'compliance.set_vuln_disclosure_url', labelEn: 'Coordinated disclosure policy URL', placeholder: 'https://yourcompany.com/security' }),
            Object.freeze({
                name: 'security_txt_policy_enabled', kind: 'toggle',
                labelKey: 'compliance.set_security_txt', labelEn: 'Publish security.txt',
                hintKey: 'compliance.set_security_txt_hint', hintEn: 'Serves /.well-known/security.txt on the public base URL with the PSIRT address and the policy link.',
            }),
            Object.freeze({ name: 'support_policy_url', kind: 'url', labelKey: 'compliance.set_support_policy_url', labelEn: 'Support policy URL' }),
            Object.freeze({
                name: 'support_end_date', kind: 'date',
                labelKey: 'compliance.set_support_end_date', labelEn: 'Support period ends on',
                hintKey: 'compliance.set_support_end_date_hint', hintEn: 'At least five years from placing the product on the market, unless its expected lifetime is shorter.',
            }),
            Object.freeze({ name: 'security_update_channel', kind: 'text', labelKey: 'compliance.set_update_channel', labelEn: 'Security-update channel' }),
        ]),
    }),

    Object.freeze({
        id: 'data_act',
        framework: 'data_act',
        titleKey: 'compliance.set_group_data_act', titleEn: 'Data Act',
        descKey: 'compliance.set_group_data_act_desc',
        descEn: 'Switching and exit: the notice period you grant and the last time the exit procedure was actually rehearsed.',
        fields: Object.freeze([
            Object.freeze({
                name: 'data_act_provider_role', kind: 'toggle',
                labelKey: 'compliance.set_data_act_provider', labelEn: 'We are a data-processing-service provider',
                hintKey: 'compliance.set_data_act_provider_hint', hintEn: 'Chapter VI applies when you resell or host this workspace for customers.',
            }),
            Object.freeze({ name: 'notice_period_days', kind: 'number', min: 0, labelKey: 'compliance.set_notice_period_days', labelEn: 'Notice period (days)', placeholder: '60' }),
            Object.freeze({ name: 'exit_procedure_tested_at', kind: 'date', labelKey: 'compliance.set_exit_tested_at', labelEn: 'Exit procedure tested on' }),
            Object.freeze({ name: 'exit_procedure_tested_by', kind: 'user', labelKey: 'compliance.set_exit_tested_by', labelEn: 'Tested by' }),
        ]),
    }),

    Object.freeze({
        id: 'eaa',
        framework: 'eaa',
        titleKey: 'compliance.set_group_eaa', titleEn: 'Accessibility (EAA)',
        descKey: 'compliance.set_group_eaa_desc',
        descEn: 'The accessibility statement for your public surfaces and the level you declare in it.',
        fields: Object.freeze([
            Object.freeze({ name: 'accessibility_statement_url', kind: 'url', labelKey: 'compliance.set_a11y_url', labelEn: 'Accessibility statement URL', placeholder: 'https://yourcompany.com/accessibility' }),
            Object.freeze({ name: 'accessibility_conformance_level', kind: 'select', options: CONFORMANCE_LEVELS, labelKey: 'compliance.set_a11y_level', labelEn: 'Declared conformance level' }),
            Object.freeze({ name: 'accessibility_conformance_at', kind: 'date', labelKey: 'compliance.set_a11y_at', labelEn: 'Declared on' }),
        ]),
    }),

    Object.freeze({
        id: 'dora',
        framework: 'dora',
        titleKey: 'compliance.set_group_dora', titleEn: 'DORA',
        descKey: 'compliance.set_group_dora_desc',
        descEn: 'As an ICT third-party provider to financial entities: who you warn, how fast, and on which contract terms.',
        fields: Object.freeze([
            Object.freeze({
                name: 'dora', kind: 'relevance',
                labelKey: 'compliance.set_dora_relevance', labelEn: 'Do we serve financial entities?',
                hintKey: 'compliance.set_dora_relevance_hint', hintEn: 'DORA reaches you through your customers, not through your own sector.',
            }),
            Object.freeze({
                name: 'incident_customer_contacts', kind: 'contacts',
                labelKey: 'compliance.set_dora_contacts', labelEn: 'Customer incident contacts',
                hintKey: 'compliance.set_dora_contacts_hint', hintEn: 'The people at your financial customers who must hear about a major ICT incident.',
            }),
            Object.freeze({
                name: 'dora_customer_notice_hours', kind: 'number', min: 1,
                labelKey: 'compliance.set_dora_notice_hours', labelEn: 'Customer notice (hours)',
                hintKey: 'compliance.set_dora_notice_hours_hint', hintEn: 'The contractual window in which you warn the customer. Default 4.',
            }),
            Object.freeze({ name: 'dora_contract_clauses_confirmed_at', kind: 'date', labelKey: 'compliance.set_dora_clauses_at', labelEn: 'Contract clauses confirmed on' }),
            Object.freeze({ name: 'dora_contract_clauses_confirmed_by', kind: 'user', labelKey: 'compliance.set_dora_clauses_by', labelEn: 'Confirmed by' }),
            Object.freeze({ name: 'dora_contract_template_url', kind: 'url', labelKey: 'compliance.set_dora_template_url', labelEn: 'Contract template URL' }),
        ]),
    }),

    Object.freeze({
        id: 'machinery',
        framework: 'machinery',
        titleKey: 'compliance.set_group_machinery', titleEn: 'Machinery Regulation',
        descKey: 'compliance.set_group_machinery_desc',
        descEn: 'Only when this workspace drives or advises machinery: the subjects that need a safety assessment.',
        fields: Object.freeze([
            Object.freeze({
                name: 'machinery', kind: 'relevance',
                labelKey: 'compliance.set_machinery_relevance', labelEn: 'Does our AI touch machinery?',
                hintKey: 'compliance.set_machinery_relevance_hint', hintEn: 'Agents that control, monitor or advise on industrial equipment.',
            }),
            Object.freeze({
                name: 'machinery_manual_subjects', kind: 'strings',
                labelKey: 'compliance.set_machinery_subjects', labelEn: 'Manually added subjects',
                hintKey: 'compliance.set_machinery_subjects_hint', hintEn: 'Integrations the detector cannot see — one line per machine or bridge.',
                placeholder: 'Press brake bridge',
            }),
        ]),
    }),
]);

/** Every settings column this form writes (a `relevance`/`userfill` field is not one). */
export const SETTINGS_FIELD_NAMES = Object.freeze(
    SETTINGS_GROUPS.flatMap(g => g.fields.filter(f => f.kind !== 'relevance' && f.kind !== 'userfill').map(f => f.name)),
);

const FIELD_BY_NAME = new Map(
    SETTINGS_GROUPS.flatMap(g => g.fields.map(f => [f.name, f])),
);

export function fieldSpec(name) {
    return FIELD_BY_NAME.get(name) || null;
}

/* ── form state ──────────────────────────────────────────────────────────── */

const asArray = (v) => (Array.isArray(v) ? v : []);
const asText = (v) => (v === null || v === undefined ? '' : String(v));
/** A date column into the `YYYY-MM-DD` an <input type="date"> wants. */
const asDate = (v) => (v ? String(v).slice(0, 10) : '');

/** Server settings → form state. Unknown/absent values become the empty answer, never a guess. */
export function normaliseSettings(settings) {
    const s = settings || {};
    const form = {};
    for (const group of SETTINGS_GROUPS) {
        for (const f of group.fields) {
            switch (f.kind) {
                case 'relevance': case 'userfill': break;
                case 'toggle': form[f.name] = f.defaultOn ? s[f.name] !== false : s[f.name] === true; break;
                case 'chips': case 'emails': case 'strings': form[f.name] = asArray(s[f.name]); break;
                case 'contacts':
                    form[f.name] = asArray(s[f.name]).filter(c => c && typeof c === 'object')
                        .map(c => ({ name: asText(c.name), email: asText(c.email), entity: asText(c.entity) }));
                    break;
                case 'date': form[f.name] = asDate(s[f.name]); break;
                case 'stamp': form[f.name] = s[f.name] || null; break;
                default: form[f.name] = asText(s[f.name]);
            }
        }
    }
    return form;
}

/**
 * Form state → the PUT body: an explicit allow-list built from the field table,
 * never "the form object minus a few keys" — a field added next year must be
 * declared here before it can travel (BFSF-441 discipline).
 */
export function buildSettingsBody(form) {
    const f = form || {};
    const body = {};
    for (const group of SETTINGS_GROUPS) {
        for (const spec of group.fields) {
            const name = spec.name;
            const v = f[name];
            switch (spec.kind) {
                case 'relevance': case 'userfill': continue;
                case 'toggle': body[name] = v === true; break;
                case 'chips': case 'emails':
                    body[name] = asArray(v).map(x => String(x).trim()).filter(Boolean);
                    break;
                case 'strings':
                    body[name] = asArray(v).filter(x => (typeof x === 'string' ? x.trim() : x)).map(x => (typeof x === 'string' ? x.trim() : x));
                    break;
                case 'contacts':
                    body[name] = asArray(v)
                        .map(c => ({ name: String(c?.name || '').trim(), email: String(c?.email || '').trim(), entity: String(c?.entity || '').trim() }))
                        .filter(c => c.name || c.email || c.entity);
                    break;
                case 'number': {
                    const n = String(v ?? '').trim();
                    body[name] = n === '' ? null : Number(n);
                    break;
                }
                case 'stamp': body[name] = v || null; break;
                default: {
                    const s = String(v ?? '').trim();
                    body[name] = s === '' ? null : s;
                }
            }
        }
    }
    return body;
}

/** True when the group's framework is off for this org (the page folds it shut). */
export function groupIsInactive(group, frameworks) {
    if (!group.framework || !frameworks || typeof frameworks.isEnabled !== 'function') return false;
    return !frameworks.isEnabled(group.framework);
}

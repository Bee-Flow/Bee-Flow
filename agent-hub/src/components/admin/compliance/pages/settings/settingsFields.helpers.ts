import type { SettingsOption } from './settingsFields.types';

export const LEGAL_BASES: readonly SettingsOption[] = Object.freeze([
    Object.freeze({ value: 'consent', key: 'compliance.lb_consent', en: 'Consent' }),
    Object.freeze({ value: 'contract', key: 'compliance.lb_contract', en: 'Contract' }),
    Object.freeze({ value: 'legal_obligation', key: 'compliance.lb_legal_obligation', en: 'Legal obligation' }),
    Object.freeze({ value: 'vital_interests', key: 'compliance.lb_vital_interests', en: 'Vital interests' }),
    Object.freeze({ value: 'public_task', key: 'compliance.lb_public_task', en: 'Public task' }),
    Object.freeze({ value: 'legitimate_interests', key: 'compliance.lb_legitimate_interests', en: 'Legitimate interests' }),
]);

export const RESIDENCY: readonly SettingsOption[] = Object.freeze([
    Object.freeze({ value: 'eu', key: 'compliance.residency_eu', en: 'EU-only' }),
    Object.freeze({ value: 'internal', key: 'compliance.residency_internal', en: 'Self-hosted only' }),
    Object.freeze({ value: 'hybrid', key: 'compliance.residency_hybrid', en: 'Hybrid' }),
]);

export const NIS2_ENTITY_CLASSES: readonly SettingsOption[] = Object.freeze([
    Object.freeze({ value: '', key: 'compliance.set_unanswered', en: 'Not answered yet' }),
    Object.freeze({ value: 'not_in_scope', key: 'compliance.set_nis2_class_not_in_scope', en: 'Not in scope' }),
    Object.freeze({ value: 'supplier_only', key: 'compliance.set_nis2_class_supplier_only', en: 'Supplier to an in-scope entity' }),
    Object.freeze({ value: 'important', key: 'compliance.set_nis2_class_important', en: 'Important entity' }),
    Object.freeze({ value: 'essential', key: 'compliance.set_nis2_class_essential', en: 'Essential entity' }),
]);

export const CRA_ROLES: readonly SettingsOption[] = Object.freeze([
    Object.freeze({ value: '', key: 'compliance.set_unanswered', en: 'Not answered yet' }),
    Object.freeze({ value: 'manufacturer', key: 'compliance.set_cra_role_manufacturer', en: 'Manufacturer' }),
    Object.freeze({ value: 'distributor', key: 'compliance.set_cra_role_distributor', en: 'Importer / distributor' }),
    Object.freeze({ value: 'user_only', key: 'compliance.set_cra_role_user_only', en: 'User only' }),
]);

export const CONFORMANCE_LEVELS: readonly SettingsOption[] = Object.freeze([
    Object.freeze({ value: '', key: 'compliance.set_unanswered', en: 'Not answered yet' }),
    Object.freeze({ value: 'WCAG 2.1 AA', key: 'compliance.set_eaa_level_wcag21aa', en: 'WCAG 2.1 AA' }),
    Object.freeze({ value: 'WCAG 2.2 AA', key: 'compliance.set_eaa_level_wcag22aa', en: 'WCAG 2.2 AA' }),
    Object.freeze({ value: 'EN 301 549', key: 'compliance.set_eaa_level_en301549', en: 'EN 301 549' }),
    Object.freeze({ value: 'partial', key: 'compliance.set_eaa_level_partial', en: 'Partially conformant' }),
]);

/** The three answers `frameworks.setRelevance(id, value, note)` accepts. */
export const RELEVANCE_OPTIONS: readonly SettingsOption[] = Object.freeze([
    Object.freeze({ value: 'unknown', key: 'compliance.set_relevance_unknown', en: 'Not answered yet' }),
    Object.freeze({ value: 'relevant', key: 'compliance.set_relevance_relevant', en: 'Applies to us' }),
    Object.freeze({ value: 'not_relevant', key: 'compliance.set_relevance_not_relevant', en: 'Does not apply to us' }),
]);

export const asArray = <T = unknown>(v: unknown): T[] => (Array.isArray(v) ? v : []); // Array.isArray yields any[]: the caller names T for what it reads.

export const asText = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** A date column into the `YYYY-MM-DD` an <input type="date"> wants. */
export const asDate = (v: unknown) => (v ? String(v).slice(0, 10) : '');

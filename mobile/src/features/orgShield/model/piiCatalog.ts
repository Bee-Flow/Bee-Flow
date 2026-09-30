/**
 * The 21 kinds of personal data the org shield can look for — a port of the
 * web's agent-hub/src/config/piiCategories.ts (ids, order, groups and label
 * keys), pinned by piiCatalog.lockstep.test.ts.
 *
 * Not the personal screen's list (features/org/model/piiCategories.ts): that
 * one regroups the ids for a phone picker and carries English labels. The org
 * editor mirrors the web admin's grouping and borrows its `pii.*` keys, so an
 * administrator's translation reaches both.
 */

export type PiiGroup =
    | 'Personal'
    | 'Contact'
    | 'Financial'
    | 'Identity'
    | 'Digital'
    | 'Organization'
    | 'EU / Netherlands';

export interface PiiCategoryDef {
    id: string;
    group: PiiGroup;
    i18nKey: string;
    fallback: string;
}

const def = (id: string, group: PiiGroup, i18nKey: string, fallback: string): PiiCategoryDef => ({
    id,
    group,
    i18nKey,
    fallback,
});

export const PII_CATALOG: readonly PiiCategoryDef[] = [
    def('Person', 'Personal', 'pii.person_name', 'Person Names'),
    def('DateOfBirth', 'Personal', 'pii.date_of_birth', 'Date of Birth'),
    def('PhoneNumber', 'Contact', 'pii.phone_number', 'Phone Numbers'),
    def('Email', 'Contact', 'pii.email_address', 'Email Addresses'),
    def('Address', 'Contact', 'pii.physical_address', 'Home and street addresses'),
    def('CreditCardNumber', 'Financial', 'pii.credit_card', 'Credit Card Numbers'),
    def('BankAccountNumber', 'Financial', 'pii.bank_account', 'Bank Account Numbers'),
    def('InternationalBankingAccountNumber', 'Financial', 'pii.iban', 'IBAN Numbers'),
    def('USSocialSecurityNumber', 'Identity', 'pii.ssn', 'Social Security Numbers'),
    def('PassportNumber', 'Identity', 'pii.passport', 'Passport Numbers'),
    def('DriversLicenseNumber', 'Identity', 'pii.drivers_license', "Driver's License Numbers"),
    def('IPAddress', 'Digital', 'pii.ip_address', 'IP Addresses'),
    def('URL', 'Digital', 'pii.url', 'Web addresses'),
    def('ApiKeyOrSecret', 'Digital', 'pii.api_key_or_secret', 'Passwords and access keys'),
    def('Organization', 'Organization', 'pii.organization', 'Company names'),
    def('NationalIdentificationNumber', 'EU / Netherlands', 'pii.national_id', 'National ID numbers (BSN and equivalents)'),
    def('TaxIdentificationNumber', 'EU / Netherlands', 'pii.tax_id', 'Tax numbers (VAT / BTW / RSIN)'),
    def('HealthInsuranceNumber', 'EU / Netherlands', 'pii.health_insurance', 'Health Insurance Numbers'),
    def('MedicalCondition', 'EU / Netherlands', 'pii.medical_condition', 'Medical Conditions'),
    def('Medication', 'EU / Netherlands', 'pii.medication', 'Medications'),
    def('LicensePlateNumber', 'EU / Netherlands', 'pii.license_plate', 'License Plates'),
];

/** Group → its web label key (categoryMatrixModel.ts GROUP_KEYS), in catalogue order. */
export const PII_GROUP_KEYS: readonly { group: PiiGroup; key: string; fallback: string }[] = [
    { group: 'Personal', key: 'pii.group_personal', fallback: 'Personal' },
    { group: 'Contact', key: 'pii.group_contact', fallback: 'Contact' },
    { group: 'Financial', key: 'pii.group_financial', fallback: 'Financial' },
    { group: 'Identity', key: 'pii.group_identity', fallback: 'Identity' },
    { group: 'Digital', key: 'pii.group_digital', fallback: 'Digital' },
    { group: 'Organization', key: 'pii.group_organization', fallback: 'Organisation' },
    { group: 'EU / Netherlands', key: 'pii.group_eu_nl', fallback: 'EU / Netherlands' },
];

export const PII_IDS: ReadonlySet<string> = new Set(PII_CATALOG.map((c) => c.id));

export function categoriesIn(group: PiiGroup): PiiCategoryDef[] {
    return PII_CATALOG.filter((c) => c.group === group);
}

export function categoryDef(id: string): PiiCategoryDef | null {
    return PII_CATALOG.find((c) => c.id === id) ?? null;
}

/** Sensitivity presets (PiiSensitivityPicker.jsx), low → high sensitivity. */
export const SENSITIVITY_PRESETS = [
    { id: 'strict', value: 0.85, key: 'privacy.sensitivity_strict', fallback: 'Low sensitivity' },
    { id: 'balanced', value: 0.7, key: 'privacy.sensitivity_balanced', fallback: 'Balanced' },
    { id: 'high', value: 0.45, key: 'privacy.sensitivity_high', fallback: 'High sensitivity' },
] as const;

export type SensitivityPreset = (typeof SENSITIVITY_PRESETS)[number];

/** The preset a threshold sits on, within the web's snap of 0.024. */
export function presetFor(value: number): SensitivityPreset | null {
    return SENSITIVITY_PRESETS.find((p) => Math.abs(p.value - value) < 0.024) ?? null;
}

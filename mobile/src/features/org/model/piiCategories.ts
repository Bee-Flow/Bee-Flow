/**
 * The PII categories the Privacy Shield can detect.
 *
 * Mirrored from server/core/privacy/piiDetection/categories.js — the ids MUST
 * match exactly, because they are what `piiDetectionCategories` stores and
 * what the GLiNER guard is asked to look for. A typo here does not fail
 * loudly; it silently narrows what gets redacted.
 *
 * Grouped the way the server groups them, and ordered so the categories most
 * people care about are reachable without scrolling.
 */

/** A sentence that travels as data: its catalogue key and its English fallback. */
export interface Words {
    i18nKey: string;
    en: string;
}

export interface PiiCategory {
    id: string;
    /** The word on the chip, rendered `t(i18nKey, en)`. */
    i18nKey: string;
    en: string;
    /** A `PII_GROUPS` id (the server's own group names, never shown). */
    group: string;
}

export const PII_CATEGORIES: PiiCategory[] = [
    { id: 'Person', i18nKey: 'mobile.org.pii_person', en: 'Person name', group: 'Personal' },
    { id: 'DateOfBirth', i18nKey: 'mobile.org.pii_date_of_birth', en: 'Date of birth', group: 'Personal' },

    { id: 'PhoneNumber', i18nKey: 'mobile.org.pii_phone_number', en: 'Phone number', group: 'Contact' },
    { id: 'Email', i18nKey: 'mobile.org.pii_email', en: 'Email address', group: 'Contact' },
    { id: 'Address', i18nKey: 'mobile.org.pii_address', en: 'Physical address', group: 'Contact' },

    { id: 'CreditCardNumber', i18nKey: 'mobile.org.pii_credit_card', en: 'Credit card number', group: 'Financial' },
    { id: 'BankAccountNumber', i18nKey: 'mobile.org.pii_bank_account', en: 'Bank account number', group: 'Financial' },
    { id: 'InternationalBankingAccountNumber', i18nKey: 'mobile.org.pii_iban', en: 'IBAN', group: 'Financial' },

    { id: 'NationalIdentificationNumber', i18nKey: 'mobile.org.pii_national_id', en: 'National ID (BSN and equivalents)', group: 'Identity' },
    { id: 'TaxIdentificationNumber', i18nKey: 'mobile.org.pii_tax_id', en: 'Tax ID (BTW, RSIN, VAT)', group: 'Identity' },
    { id: 'PassportNumber', i18nKey: 'mobile.org.pii_passport', en: 'Passport number', group: 'Identity' },
    { id: 'DriversLicenseNumber', i18nKey: 'mobile.org.pii_drivers_licence', en: 'Driving licence', group: 'Identity' },
    { id: 'USSocialSecurityNumber', i18nKey: 'mobile.org.pii_ssn', en: 'SSN (US)', group: 'Identity' },
    { id: 'LicensePlateNumber', i18nKey: 'mobile.org.pii_licence_plate', en: 'Licence plate', group: 'Identity' },

    { id: 'HealthInsuranceNumber', i18nKey: 'mobile.org.pii_health_insurance', en: 'Health insurance number', group: 'Health' },
    { id: 'MedicalCondition', i18nKey: 'mobile.org.pii_medical_condition', en: 'Medical condition', group: 'Health' },
    { id: 'Medication', i18nKey: 'mobile.org.pii_medication', en: 'Medication', group: 'Health' },

    { id: 'IPAddress', i18nKey: 'mobile.org.pii_ip_address', en: 'IP address', group: 'Digital' },
    { id: 'URL', i18nKey: 'mobile.org.pii_url', en: 'URL', group: 'Digital' },
    { id: 'ApiKeyOrSecret', i18nKey: 'mobile.org.pii_api_key', en: 'API key or secret', group: 'Digital' },

    { id: 'Organization', i18nKey: 'mobile.org.pii_organisation', en: 'Organisation name', group: 'Organisation' },
];

/**
 * The groups in display order. Where the web's `pii.group_*` says the same
 * word it is borrowed, so an administrator's translation reaches the phone;
 * the web has no "Health" group of its own (those categories sit under its
 * EU / Netherlands one), so that one is the phone's.
 */
export const PII_GROUPS: readonly (Words & { id: string })[] = [
    { id: 'Personal', i18nKey: 'pii.group_personal', en: 'Personal' },
    { id: 'Contact', i18nKey: 'pii.group_contact', en: 'Contact' },
    { id: 'Financial', i18nKey: 'pii.group_financial', en: 'Financial' },
    { id: 'Identity', i18nKey: 'pii.group_identity', en: 'Identity' },
    { id: 'Health', i18nKey: 'mobile.org.pii_group_health', en: 'Health' },
    { id: 'Digital', i18nKey: 'pii.group_digital', en: 'Digital' },
    { id: 'Organisation', i18nKey: 'pii.group_organization', en: 'Organisation' },
];

/**
 * What an empty category list means.
 *
 * Nothing. Literally: `piiDetection.js` falls back to ALL canonical categories
 * when the list is empty, so a user who has never picked gets the WIDEST
 * protection rather than none. The UI has to say this, because "none selected"
 * reads as "nothing is protected" and would be exactly backwards.
 */
export const EMPTY_MEANS_ALL: Words = {
    i18nKey: 'mobile.org.pii_empty_means_all',
    en: 'With nothing selected, Bee Flow looks for every category it knows — the widest protection, not the narrowest.',
};

/** Human labels for the two actions the shield can take on a match. */
export const PII_ACTIONS: { id: string; label: Words; description: Words }[] = [
    {
        id: 'tokenize',
        label: { i18nKey: 'mobile.org.pii_action_tokenize', en: 'Replace it' },
        description: {
            i18nKey: 'mobile.org.pii_action_tokenize_desc',
            en: 'Sensitive values are swapped for placeholders before the model sees them, and swapped back in the answer. The conversation still works.',
        },
    },
    {
        id: 'block',
        label: { i18nKey: 'mobile.org.pii_action_block', en: 'Stop the message' },
        description: {
            i18nKey: 'mobile.org.pii_action_block_desc',
            en: 'The message is not sent at all and you are told what was found. Strictest, and the most interruptive.',
        },
    },
];

/** What to do when the guard service itself cannot be reached. */
export const PII_FAILURE_MODES: { id: string; label: Words; description: Words }[] = [
    {
        id: 'fail_closed',
        label: { i18nKey: 'mobile.org.pii_failure_closed', en: 'Refuse to send' },
        description: {
            i18nKey: 'mobile.org.pii_failure_closed_desc',
            en: 'If the detector is installed but unreachable, nothing goes to the model. Safe by default.',
        },
    },
    {
        // The web's own word for the same choice (admin.shield_pii_failuremode_open_label).
        id: 'fail_open',
        label: { i18nKey: 'admin.shield_pii_failuremode_open_label', en: 'Send anyway' },
        description: {
            i18nKey: 'mobile.org.pii_failure_open_desc',
            en: 'Messages go through undetected when the detector is down. Convenient, and a real risk.',
        },
    },
];

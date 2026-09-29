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

export interface PiiCategory {
    id: string;
    label: string;
    group: string;
}

export const PII_CATEGORIES: PiiCategory[] = [
    { id: 'Person', label: 'Person name', group: 'Personal' },
    { id: 'DateOfBirth', label: 'Date of birth', group: 'Personal' },

    { id: 'PhoneNumber', label: 'Phone number', group: 'Contact' },
    { id: 'Email', label: 'Email address', group: 'Contact' },
    { id: 'Address', label: 'Physical address', group: 'Contact' },

    { id: 'CreditCardNumber', label: 'Credit card number', group: 'Financial' },
    { id: 'BankAccountNumber', label: 'Bank account number', group: 'Financial' },
    { id: 'InternationalBankingAccountNumber', label: 'IBAN', group: 'Financial' },

    { id: 'NationalIdentificationNumber', label: 'National ID (BSN and equivalents)', group: 'Identity' },
    { id: 'TaxIdentificationNumber', label: 'Tax ID (BTW, RSIN, VAT)', group: 'Identity' },
    { id: 'PassportNumber', label: 'Passport number', group: 'Identity' },
    { id: 'DriversLicenseNumber', label: 'Driving licence', group: 'Identity' },
    { id: 'USSocialSecurityNumber', label: 'SSN (US)', group: 'Identity' },
    { id: 'LicensePlateNumber', label: 'Licence plate', group: 'Identity' },

    { id: 'HealthInsuranceNumber', label: 'Health insurance number', group: 'Health' },
    { id: 'MedicalCondition', label: 'Medical condition', group: 'Health' },
    { id: 'Medication', label: 'Medication', group: 'Health' },

    { id: 'IPAddress', label: 'IP address', group: 'Digital' },
    { id: 'URL', label: 'URL', group: 'Digital' },
    { id: 'ApiKeyOrSecret', label: 'API key or secret', group: 'Digital' },

    { id: 'Organization', label: 'Organisation name', group: 'Organisation' },
];

export const PII_GROUPS: string[] = [
    'Personal',
    'Contact',
    'Financial',
    'Identity',
    'Health',
    'Digital',
    'Organisation',
];

/**
 * What an empty category list means.
 *
 * Nothing. Literally: `piiDetection.js` falls back to ALL canonical categories
 * when the list is empty, so a user who has never picked gets the WIDEST
 * protection rather than none. The UI has to say this, because "none selected"
 * reads as "nothing is protected" and would be exactly backwards.
 */
export const EMPTY_MEANS_ALL =
    'With nothing selected, Bee Flow looks for every category it knows — the widest protection, not the narrowest.';

/** Human labels for the two actions the shield can take on a match. */
export const PII_ACTIONS: { id: string; label: string; description: string }[] = [
    {
        id: 'tokenize',
        label: 'Replace it',
        description:
            'Sensitive values are swapped for placeholders before the model sees them, and swapped back in the answer. The conversation still works.',
    },
    {
        id: 'block',
        label: 'Stop the message',
        description:
            'The message is not sent at all and you are told what was found. Strictest, and the most interruptive.',
    },
];

/** What to do when the guard service itself cannot be reached. */
export const PII_FAILURE_MODES: { id: string; label: string; description: string }[] = [
    {
        id: 'fail_closed',
        label: 'Refuse to send',
        description:
            'If the detector is installed but unreachable, nothing goes to the model. Safe by default.',
    },
    {
        id: 'fail_open',
        label: 'Send anyway',
        description:
            'Messages go through undetected when the detector is down. Convenient, and a real risk.',
    },
];

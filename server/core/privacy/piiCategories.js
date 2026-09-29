// @typecheck
/**
 * Canonical PII-category encoding for the monitoring ledgers.
 *
 * `pii_categories_detected` (integration_activity_log) and
 * `violation_categories` (guardrail_events) are comma-separated strings, and
 * historically every producer invented its own vocabulary AND its own
 * separator: the chat paths wrote GLiNER's human labels ('Email Address')
 * joined with ', ', the automation scanner wrote its own labels ('EU National
 * ID / BSN'), and the three readers parsed with ', ', ',' and ILIKE '%…%'
 * respectively. The same email leak could show up as three different
 * categories that never aggregate together.
 *
 * One rule now:
 *   - WRITE through encodeCategories(): canonical ids, deduped, sorted,
 *     joined with a bare ','.
 *   - READ by splitting on ',' + trim (tolerates every legacy encoding).
 *   - Ids are the PII_CATEGORIES keys from core/piiDetection.js — the same
 *     ids the org shield's category picker stores, so a dashboard drill and
 *     a shield setting speak the same names.
 *
 * This module is deliberately a LEAF (no requires): piiDetection.js pulls in
 * config stores and the DLP stack, and both stores and producers need this
 * file. The id list is mirrored instead of imported; piiCategories.test.js
 * cross-checks it against piiDetection.ALL_PII_CATEGORY_IDS so it cannot
 * drift silently.
 */

// Mirror of Object.keys(PII_CATEGORIES) in core/piiDetection.js — see header.
const CANONICAL_IDS = [
    'Person', 'DateOfBirth',
    'PhoneNumber', 'Email', 'Address',
    'CreditCardNumber', 'BankAccountNumber', 'InternationalBankingAccountNumber',
    'USSocialSecurityNumber', 'PassportNumber', 'DriversLicenseNumber',
    'IPAddress', 'URL', 'ApiKeyOrSecret',
    'Organization',
    'NationalIdentificationNumber', 'TaxIdentificationNumber',
    'HealthInsuranceNumber', 'MedicalCondition', 'Medication',
    'LicensePlateNumber',
];
const CANONICAL_SET = new Set(CANONICAL_IDS);

// Every label any producer has historically written, lowercased → id.
// GLiNER human labels (piiDetection PII_CATEGORIES[*].label) + the regex
// scanner's old names + a few obvious variants.
const LABEL_TO_ID = {
    'person name': 'Person',
    'person': 'Person',
    'name': 'Person',
    'date of birth': 'DateOfBirth',
    'phone number': 'PhoneNumber',
    'phone': 'PhoneNumber',
    'email address': 'Email',
    'email': 'Email',
    'physical address': 'Address',
    'address': 'Address',
    'credit card number': 'CreditCardNumber',
    'credit card': 'CreditCardNumber',
    'bank account number': 'BankAccountNumber',
    'bank account': 'BankAccountNumber',
    'iban': 'InternationalBankingAccountNumber',
    'ssn (us)': 'USSocialSecurityNumber',
    'ssn': 'USSocialSecurityNumber',
    'social security number': 'USSocialSecurityNumber',
    'passport number': 'PassportNumber',
    'passport': 'PassportNumber',
    "driver's license": 'DriversLicenseNumber',
    'drivers license': 'DriversLicenseNumber',
    'ip address': 'IPAddress',
    'url': 'URL',
    'api key / secret': 'ApiKeyOrSecret',
    'api key': 'ApiKeyOrSecret',
    'secret': 'ApiKeyOrSecret',
    'organization': 'Organization',
    'organisation': 'Organization',
    'eu national id / bsn': 'NationalIdentificationNumber',
    'bsn': 'NationalIdentificationNumber',
    'tax id (btw / rsin / vat)': 'TaxIdentificationNumber',
    'tax id': 'TaxIdentificationNumber',
    'health insurance number': 'HealthInsuranceNumber',
    'medical condition': 'MedicalCondition',
    'medication': 'Medication',
    'license plate': 'LicensePlateNumber',
};

/**
 * One label (from any producer, any era) → canonical id.
 * Unknown labels are returned trimmed rather than dropped: an unrecognised
 * category in an audit ledger is information, not noise.
 */
function normalizeCategory(label) {
    const raw = String(label ?? '').trim();
    if (!raw) return null;
    if (CANONICAL_SET.has(raw)) return raw;
    const lower = raw.toLowerCase();
    if (LABEL_TO_ID[lower]) return LABEL_TO_ID[lower];
    // The National ID label carries a long parenthetical suffix that has
    // already changed once ('National ID (BSN / DNI / …)') — prefix-match it.
    if (lower.startsWith('national id')) return 'NationalIdentificationNumber';
    if (lower.startsWith('scan_')) return raw; // audit markers (scan_timeout …) pass through
    return raw;
}

/** Array of labels → the ONE canonical wire encoding: deduped, sorted, ','-joined. */
function encodeCategories(labels) {
    const ids = new Set();
    for (const l of labels || []) {
        const id = normalizeCategory(l);
        if (id) ids.add(id);
    }
    return ids.size ? [...ids].sort().join(',') : null;
}

/** Wire string (any era: 'a,b' or 'a, b') → array of normalized categories. */
function decodeCategories(str) {
    if (!str || typeof str !== 'string') return [];
    return [...new Set(
        str.split(',').map(s => normalizeCategory(s)).filter(Boolean),
    )];
}

module.exports = { CANONICAL_IDS, normalizeCategory, encodeCategories, decodeCategories };

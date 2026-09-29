// @typecheck
/**
 * Category registry — the categories the PII Guard can emit, the legacy ids
 * old shield configs still reference, the default confidence threshold, and
 * which actions mask a message instead of refusing it.
 */

// ── PII Categories ──────────────────────────────────────────────────────
// Only categories the PII Guard service (GLiNER) can emit. Adding rows
// here without a corresponding label mapping in
// guard-service/app/services/pii.py means admins will see toggles that
// silently never fire.
const PII_CATEGORIES = {
    // Personal
    'Person':           { label: 'Person Name',          group: 'Personal',   icon: '👤' },
    'DateOfBirth':      { label: 'Date of Birth',        group: 'Personal',   icon: '📅' },

    // Contact
    'PhoneNumber':      { label: 'Phone Number',         group: 'Contact',    icon: '📱' },
    'Email':            { label: 'Email Address',        group: 'Contact',    icon: '📧' },
    'Address':          { label: 'Physical Address',     group: 'Contact',    icon: '🏠' },

    // Financial
    'CreditCardNumber':                    { label: 'Credit Card Number',  group: 'Financial',  icon: '💳' },
    'BankAccountNumber':                   { label: 'Bank Account Number', group: 'Financial',  icon: '🏦' },
    'InternationalBankingAccountNumber':   { label: 'IBAN',                group: 'Financial',  icon: '🌐' },

    // Identity / Government
    'USSocialSecurityNumber':              { label: 'SSN (US)',            group: 'Identity',   icon: '🆔' },
    'PassportNumber':                      { label: 'Passport Number',     group: 'Identity',   icon: '🛂' },
    'DriversLicenseNumber':                { label: "Driver's License",    group: 'Identity',   icon: '🪪' },

    // Digital / Secrets
    'IPAddress':         { label: 'IP Address',     group: 'Digital',  icon: '🌐' },
    'URL':               { label: 'URL',            group: 'Digital',  icon: '🔗' },
    'ApiKeyOrSecret':    { label: 'API key / secret', group: 'Digital', icon: '🔑' },

    // Organization
    'Organization':   { label: 'Organization',   group: 'Organization',  icon: '🏢' },

    // EU / Netherlands — labels the GLiNER multi-PII model returns natively.
    // No regex used; we trust the model's recall for these categories.
    'NationalIdentificationNumber':  { label: 'National ID (BSN / DNI / NIE / codice fiscale / Steuer-ID / INSEE / rijksregister)', group: 'EU / Netherlands', icon: '🆔' },
    'TaxIdentificationNumber':       { label: 'Tax ID (BTW / RSIN / VAT)',  group: 'EU / Netherlands', icon: '🧾' },
    'HealthInsuranceNumber':         { label: 'Health Insurance Number',     group: 'EU / Netherlands', icon: '🏥' },
    'MedicalCondition':              { label: 'Medical Condition',           group: 'EU / Netherlands', icon: '❤️‍🩹' },
    'Medication':                    { label: 'Medication',                  group: 'EU / Netherlands', icon: '💊' },
    'LicensePlateNumber':            { label: 'License Plate',               group: 'EU / Netherlands', icon: '🚗' },
};

const ALL_PII_CATEGORY_IDS = Object.keys(PII_CATEGORIES);

// Legacy → canonical category aliases. Existing org Privacy Shield configs
// may reference IDs from earlier releases; map them to the current canonical
// ID so a rename never requires a config migration.
const LEGACY_CATEGORY_ALIASES = {
    'EUNationalIdentificationNumber': 'NationalIdentificationNumber',
    // AzureStorageAccountKey collapsed to the generic ApiKeyOrSecret when
    // the Azure PII backend was removed. Kept here so old shield configs
    // that reference the Azure-branded id continue to resolve.
    'AzureStorageAccountKey': 'ApiKeyOrSecret',
};

// Default confidence threshold for PII detection
const DEFAULT_PII_CONFIDENCE_THRESHOLD = 0.7;

// Actions that MASK the message rather than refuse it. Everything else blocks.
//
// One predicate, deliberately, because the cache-hit path and the fresh-scan
// path have to agree and used not to: the cache-hit branch tested only
// `=== 'tokenize'`, so a `redact` org saw the very same message tokenized on a
// miss and hard-blocked on a hit, purely depending on whether an identical
// message was still in the 5-minute LRU.
//
// 'warn' is here because routes/orgPrivacyShield.js:252 accepts and persists
// it, while this path knew only tokenize/redact/allow and fell through to
// `// Default: block` — so an admin who chose "warn" got hard blocking, the
// strictest action available. The canonical resolver maps warn → 'ask'
// (orgShield.js:211), but "ask" needs an interactive channel and this legacy
// path runs precisely when DLP is off, i.e. when there is none. Masking is the
// closest achievable meaning: the model never sees the raw value, and the user
// is not stopped. (The SPA never offered 'warn', so this is reachable only via
// the API or a legacy stored value.)
const MASKING_ACTIONS = new Set(['tokenize', 'redact', 'warn']);

module.exports = {
    PII_CATEGORIES,
    ALL_PII_CATEGORY_IDS,
    LEGACY_CATEGORY_ALIASES,
    DEFAULT_PII_CONFIDENCE_THRESHOLD,
    MASKING_ACTIONS,
};

/**
 * Consent registry — the descriptors for the consents the product still
 * records.
 *
 * The clickwrap legal-document set (terms, privacy, DPA, …) was retired, so
 * there is no signup click-through and no re-consent gate. What remains are the
 * consents that stand on their own and that live features depend on:
 *
 *   • the consumer right-of-withdrawal waiver, acknowledged at Stripe checkout;
 *   • the optional (freely opt-in/out) consents — marketing, and the GDPR
 *     Art. 9(2)(a) explicit consent that voiceprint enrolment requires.
 *
 * Both are versioned here so `consent_acceptances` rows stay meaningful
 * evidence: a row records exactly which descriptor version was presented.
 */

// The consumer right-of-withdrawal waiver is a checkout-time acknowledgement.
const WITHDRAWAL_WAIVER = {
    docId: 'withdrawal_waiver',
    version: 1,
    scope: 'b2c',
    urlPath: '/terms#consumers',
};

// ── Optional (freely opt-in/out) consents — e.g. marketing ───────
// These are NOT click-through gates; users grant/withdraw them at will.
// Seed catalog; an admin can enable/disable or edit it at runtime via legalStore.
// Voiceprint enrollment is GDPR Art. 9 special-category (biometric) data, so
// it needs its OWN explicit consent. Modelled as an optional consent because
// that is exactly the shape Art. 9(2)(a) requires: freely given, unticked by
// default, withdrawable at any moment. Withdrawing it deletes the template (see
// POST /auth/consents/optional) — a "granted: false" that leaves biometric
// data behind would be the textbook violation.
const VOICEPRINT_CONSENT_ID = 'voiceprint_biometric';
const VOICEPRINT_CONSENT_VERSION = 1;

const OPTIONAL_CONSENTS_DEFAULT = [
    { id: 'marketing', version: 1, category: 'marketing', enabled: true, labelKey: 'consent.marketing_label' },
    {
        id: VOICEPRINT_CONSENT_ID, version: VOICEPRINT_CONSENT_VERSION,
        category: 'biometric', enabled: true, labelKey: 'consent.voiceprint_label',
    },
];

function optionalConsents() {
    let ov = null;
    try {
        const legalStore = require('./legalStore');
        if (legalStore.isLoaded()) ov = legalStore.getOptionalOverride();
    } catch (_) { /* fall back to defaults */ }
    if (!Array.isArray(ov) || !ov.length) return OPTIONAL_CONSENTS_DEFAULT.map(c => ({ ...c }));
    const byId = {};
    for (const d of OPTIONAL_CONSENTS_DEFAULT) byId[d.id] = { ...d };
    for (const o of ov) { if (o && o.id) byId[o.id] = { ...(byId[o.id] || {}), ...o }; }
    // Coerce version to a positive integer (defends against hand-edited config —
    // the ledger's doc_version is NOT NULL INTEGER).
    return Object.values(byId).map(c => ({ ...c, version: Number(c.version) || 1 }));
}

function getOptionalConsent(id) {
    return optionalConsents().find(c => c.id === id) || null;
}

/**
 * The current withdrawal-waiver descriptor (checkout, consumers only).
 */
function getWithdrawalWaiver() {
    return { ...WITHDRAWAL_WAIVER };
}

module.exports = {
    WITHDRAWAL_WAIVER,
    OPTIONAL_CONSENTS_DEFAULT,
    VOICEPRINT_CONSENT_ID,
    VOICEPRINT_CONSENT_VERSION,
    getWithdrawalWaiver,
    optionalConsents,
    getOptionalConsent,
};

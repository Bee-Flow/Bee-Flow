// @typecheck strict
'use strict';

/**
 * A valid organisation attestation for the KB query log (what PUT /api/kb/:id/query-log/settings needs
 * to switch logging on), so tests that merely enable the log do not each spell it out.
 */

const ATTESTATION = Object.freeze({
    purpose: 'ai_quality',
    dpia: 'not_required',
    worksCouncil: 'not_applicable',
    worksCouncilReason: 'no_works_council',
    privacyNoticeUpdated: true,
});

/** The body of an enabling PUT, with extra settings merged in. @param {Record<string, unknown>} [extra] */
const enableBody = (extra = {}) => ({ enabled: true, attestation: { ...ATTESTATION }, ...extra });

module.exports = { ATTESTATION, enableBody };

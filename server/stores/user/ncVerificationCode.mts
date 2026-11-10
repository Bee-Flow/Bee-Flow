/**
 * The emailed one-time code of a pending Nextcloud binding: its caps, its
 * hash, and the SQL predicates ncBindings.js builds its statements from.
 */

import crypto from 'node:crypto';

export const NC_VERIFICATION_TTL_SECONDS = 15 * 60;
export const NC_VERIFICATION_MAX_ATTEMPTS = 5;
// Hard caps per pending row that never reset while the row is live: a new code
// (resend, retarget, re-bootstrap) resets the per-code counter above, so the
// row itself carries a budget of codes sent and of attempts.
export const NC_VERIFICATION_MAX_CODE_SENDS = 5;
export const NC_VERIFICATION_MAX_TOTAL_ATTEMPTS = NC_VERIFICATION_MAX_ATTEMPTS * (NC_VERIFICATION_MAX_CODE_SENDS + 1);

// SQL predicate (over the existing row, `t`) for a live row that has used up a
// lifetime budget. Such a row gets no new code and no TTL extension, so it runs
// out and a later bootstrap starts over on a fresh row.
export const _ncRowSpentSql = (t: string): string => `(${t}.expires_at > NOW()
    AND (COALESCE(${t}.verification_attempts_total, 0) >= ${NC_VERIFICATION_MAX_TOTAL_ATTEMPTS}
      OR COALESCE(${t}.verification_code_sends, 0) >= ${NC_VERIFICATION_MAX_CODE_SENDS}))`;

// SQL predicate (over the existing row, `t`) for a live row whose code has been
// sent. The code confirms the connection as it was when the code was sent, so a
// later bootstrap leaves such a row as it is: code, address and connection data.
export const _ncRowCodeSentSql = (t: string): string => `(${t}.expires_at > NOW()
    AND COALESCE(${t}.verification_code_sends, 0) > 0)`;

// Salt the code hash with org_id:nc_instance_id (both stable across the
// createPendingNcVerification upsert) rather than the row id — ON CONFLICT keeps
// the original row id, so an id-based salt would desync on re-bootstrap.
export function _hashNcVerificationCode(orgId: string, ncInstanceId: string, code: string): string {
    return crypto.createHash('sha256')
        .update(`${orgId}:${ncInstanceId}:${code}`)
        .digest('hex');
}

type CodeRow = { verification_code_hash?: string | null; org_id: string; nc_instance_id: string };

export function _ncCodeMatches(row: CodeRow | null | undefined, code: string): boolean {
    if (!row?.verification_code_hash || !code) return false;
    const expected = _hashNcVerificationCode(row.org_id, row.nc_instance_id, code);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(row.verification_code_hash), 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

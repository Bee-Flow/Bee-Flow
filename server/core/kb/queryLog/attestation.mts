/**
 * attestation.mts: the organisation's attestation that the preconditions of the KB query log are met.
 *
 * The legal basis is legitimate interest (GDPR Art. 6(1)(f)), not consent, so what stands between a
 * manager and a log is a statement about the organisation: the log serves quality control only, a DPIA
 * is done (or not required), the works council is dealt with and the privacy notice mentions the log.
 * The statement is stored with who made it and when, and goes into the audit and the evidence.
 *
 * Nothing here is free text: the stored value is enum values, one DPIA id and a boolean.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const PURPOSES = ['ai_quality'] as const;
export const DPIA_STATES = ['done', 'not_required'] as const;

export interface Attestation {
    purpose: typeof PURPOSES[number];
    dpia: typeof DPIA_STATES[number];
    dpiaId: string | null;
    worksCouncil: string;
    worksCouncilReason: string | null;
    privacyNoticeUpdated: true;
}

export type AttestationCheck = { ok: true; value: Attestation } | { ok: false; missing: string[] };

interface Vocab { WORKS_COUNCIL: readonly string[]; WORKS_COUNCIL_REASONS: readonly string[] }
const vocab = (): Vocab => nodeRequire('../../../stores/lib/chatMonitoringVocab');

/** The works-council answers that settle the matter ('pending' does not: it is still open). */
export const settledWorksCouncil = (): string[] => vocab().WORKS_COUNCIL.filter((v) => v !== 'pending');
export const worksCouncilReasons = (): readonly string[] => vocab().WORKS_COUNCIL_REASONS;

export type DpiaLookup = (orgId: string, dpiaId: string) => Promise<boolean>;

const defaultDpiaLookup: DpiaLookup = async (orgId, dpiaId) =>
    !!(await nodeRequire('../../../stores/dpiaStore').getByIdForOrg(orgId, dpiaId));

/**
 * Check what the caller sent. `missing` names every field that is absent or not allowed, so the
 * client can point at it. A DPIA id of another organisation counts as missing: the org-scoped lookup
 * finds nothing, and the answer does not tell the two cases apart.
 */
export async function validateAttestation(raw: unknown, orgId: string, lookup: DpiaLookup = defaultDpiaLookup): Promise<AttestationCheck> {
    const a = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
    const missing: string[] = [];
    if (a.purpose !== 'ai_quality') missing.push('purpose');
    if (!(DPIA_STATES as readonly unknown[]).includes(a.dpia)) missing.push('dpia');
    if (a.privacyNoticeUpdated !== true) missing.push('privacyNoticeUpdated');
    if (typeof a.worksCouncil !== 'string' || !settledWorksCouncil().includes(a.worksCouncil)) missing.push('worksCouncil');
    const reasonNeeded = a.worksCouncil === 'not_applicable';
    const reason = typeof a.worksCouncilReason === 'string' ? a.worksCouncilReason : null;
    if (reasonNeeded && !(reason && worksCouncilReasons().includes(reason))) missing.push('worksCouncilReason');
    let dpiaId: string | null = null;
    if (a.dpia === 'done') {
        const id = typeof a.dpiaId === 'number' ? String(a.dpiaId) : typeof a.dpiaId === 'string' ? a.dpiaId.trim() : '';
        if (!id || !(await lookup(orgId, id).catch(() => false))) missing.push('dpiaId');
        else dpiaId = id;
    }
    if (missing.length > 0) return { ok: false, missing };
    return {
        ok: true,
        value: {
            purpose: 'ai_quality', dpia: a.dpia as Attestation['dpia'], dpiaId, worksCouncil: a.worksCouncil as string,
            worksCouncilReason: reasonNeeded ? reason : null, privacyNoticeUpdated: true,
        },
    };
}

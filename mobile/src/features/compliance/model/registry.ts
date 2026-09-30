/**
 * Every register the hub edits, by id. A `records` section lists its types
 * (sections.ts `types`); a record's detail route is
 * `/org/compliance/<type id>/<record id>`.
 */

import { AUDITS, NCS, OBJECTIVES, REVIEWS } from './recordsAudit';
import { CUSTOM, MACHINERY } from './recordsCustom';
import { DSR_REQUESTS } from './recordsDsr';
import { INCIDENTS, VULNERABILITIES } from './recordsIncidents';
import { POLICIES, RISKS, SOA } from './recordsIso';
import { CONNECTORS, DPIA } from './recordsMisc';
import { OBLIGATIONS, PERSONNEL } from './recordsTraining';
import type { ComplianceSection } from './sections';
import type { RecordType } from './types';

export const RECORD_TYPES: readonly RecordType[] = [
    DSR_REQUESTS,
    INCIDENTS,
    VULNERABILITIES,
    DPIA,
    RISKS,
    SOA,
    POLICIES,
    AUDITS,
    REVIEWS,
    NCS,
    OBJECTIVES,
    PERSONNEL,
    OBLIGATIONS,
    CONNECTORS,
    CUSTOM,
    MACHINERY,
];

const BY_ID = new Map(RECORD_TYPES.map((t) => [t.id, t]));

export function recordType(id: string | null | undefined): RecordType | null {
    return BY_ID.get(id ?? '') ?? null;
}

/** The record types behind a section, in tab order. */
export function typesOfSection(section: ComplianceSection): RecordType[] {
    return (section.types ?? []).map((id) => BY_ID.get(id)).filter((t): t is RecordType => t !== undefined);
}

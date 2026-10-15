/**
 * Types of the register hooks (registers.ts and registersAudit.ts): the hook
 * options, the row shapes the server sends and the envelope helper. Types only,
 * so importing them costs nothing at runtime.
 */

/** A plain JSON object as the server sends it. */
export type Rec = Record<string, unknown>;

/** A busy marker: the id (or key) of the row a control is working on. */
export type BusyKey = string | number | null;

/** The options every register hook takes. */
export interface RegisterOptions {
    enabled?: boolean;
    onChanged?: () => void;
    refreshCore?: () => unknown;
}

/** A `{ requests }`-style envelope, when the list arrives wrapped. */
export interface Envelope<T> {
    requests?: T[];
    incidents?: T[];
}

// ── Shapes ─────────────────────────────────────────────────────────────────

/** A data-subject request (DSR) row. */
export interface DsrRequest {
    id: number | string;
    status?: string | null;
    [key: string]: unknown;
}

/** A DPIA row, one per processing agent. */
export interface DpiaRow {
    [key: string]: unknown;
}

/** An incident or vulnerability row. */
export interface IncidentRow {
    id: number | string;
    status?: string | null;
    [key: string]: unknown;
}

/** A policy document row. */
export interface PolicyDoc {
    slug: string;
    [key: string]: unknown;
}

/** A connector row (evidence source). */
export interface ConnectorRow {
    id: number | string;
    [key: string]: unknown;
}

/** A risk row. */
export interface RiskRow {
    id: number | string;
    [key: string]: unknown;
}

/** A risk-treatment row. */
export interface TreatmentRow {
    [key: string]: unknown;
}

/** Audit payload (GET /iso/audit). */
export interface AuditPayload {
    audits?: unknown[];
    findings?: unknown[];
    reviews?: unknown[];
    ncs?: unknown[];
    objectives?: unknown[];
    mr_inputs?: Rec | null;
    error?: string;
    [key: string]: unknown;
}

/** Training payload (GET /iso/training). */
export interface TrainingPayload {
    personnel?: unknown[];
    obligations?: unknown[];
    error?: string;
    [key: string]: unknown;
}

/** One row of the access-audit log. */
export interface AccessActionRow {
    [key: string]: unknown;
}

/** A member of the organisation, for the pickers. */
export interface OrgUser {
    id: number | string;
    [key: string]: unknown;
}


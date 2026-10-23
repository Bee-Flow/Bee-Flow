import type { LessonUser, HasFeature } from '../../../onboarding/lessons.types';
import type { KindKey } from '../../../shared/kindColors';

/** One row of the aggregate, once it can be placed. */
export interface AttentionFinding {
    source: string | null;
    code: string;
    severity: string;
    kind: string | null;
    targetId: string | null;
    message: string | null;
    remediation: string | null;
    deepLink: string | null;
}

/** A row as the endpoint sends it; read defensively, so every member may be missing. */
export interface RawAttentionRow {
    source?: unknown;
    code?: unknown;
    severity: string;
    kind?: unknown;
    targetId?: unknown;
    message?: unknown;
    remediation?: unknown;
    deepLink?: unknown;
}

/** The body of GET /api/studio/attention. */
export interface AttentionBody {
    rows?: RawAttentionRow[];
    unavailable?: string[];
    gated?: string[];
    capped?: string[];
    total?: unknown;
    complete?: unknown;
}

/** What one evaluated check reports. */
export interface AttentionVerdict {
    findings: AttentionFinding[];
    unavailable: string[];
    capped: string[];
    skipped: string[];
    truncated: number;
    complete: boolean;
}

/** A run of the register: everything found and every hole in it. */
export interface AttentionRun {
    findings: AttentionFinding[];
    unavailable: string[];
    capped: string[];
    complete: boolean;
    checked: string[];
    skipped: string[];
    truncated: number;
}

/** What a gate is asked with: the signed-in user and the licence probe. */
export interface AttentionCtx {
    user?: LessonUser | null;
    hasFeature?: HasFeature | null;
}

/** Who may see a source: a permission, a licence feature, or both. */
export interface AttentionGate {
    permission?: string;
    feature?: string;
}

/** One entry of the register. Methods, so a check that reads a narrower body stays assignable. */
export interface AttentionCheck {
    gate?: AttentionGate;
    fetchState(ctx?: AttentionCtx): Promise<unknown>;
    evaluate(data: AttentionBody | null | undefined): Partial<AttentionVerdict> | null | undefined;
}

/** One line of copy for a source. */
export interface SourceLabel {
    kind: string;
    key: string;
    fallback: string;
}

/** An item the screen draws. */
export interface AttentionItem {
    key: string;
    finding: AttentionFinding;
    kind: KindKey;
    severity: string;
    message: string | null;
    labelKey: string | null;
    labelFallback: string | null;
    remediation: string | null;
    deepLink: string | null;
}

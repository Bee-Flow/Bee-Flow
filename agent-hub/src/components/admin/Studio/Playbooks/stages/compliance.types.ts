/** The shapes of the compliance phase's artifacts that the finding rows read. */

/** The thing a finding is about. */
export interface FindingTarget {
    kind?: string;
    id?: string | number;
    name?: string;
}

/** One thing the review wants tidied up. */
export interface Finding {
    code: string;
    severity: string;
    title?: string;
    framework?: string;
    article?: string;
    subject?: string;
    source?: string;
    why?: string;
    fix?: string;
    /** Stamped by the review: what kind of fix the finding takes. */
    fix_kind?: string;
    link?: string;
    target?: FindingTarget | null;
}

/** What the review read, before it judged: the app and the table it looked at. */
export interface ComplianceFacts {
    app?: { id?: string } | null;
    table?: { id?: string | number } | null;
}

/** One change a resolve plan makes. */
export interface ResolveCall {
    kind?: string;
    body?: Record<string, unknown>;
}

/**
 * The server's proposal for ONE finding, in words and in calls. The fields are
 * required because `planResolve` (server/playbooks/resolvePlan.js) always sets
 * them, even when nothing could be proposed (`calls: []`, `empty: true`).
 */
export interface ResolvePlan {
    code: string;
    title: string;
    what: string[];
    calls: ResolveCall[];
    unresolved: Array<{ what?: string }>;
    note: string | null;
    modelFailed: string | null;
    empty: boolean;
}

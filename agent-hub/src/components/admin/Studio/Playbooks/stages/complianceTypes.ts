/**
 * Shapes of the compliance phase: the review's findings and facts, the
 * registration the person fills in, and the retention preview.
 */

/** What a finding is about (a table, an automation or an app). */
export interface FindingTarget {
    kind?: string;
    id?: string;
    name?: string;
}

/** One finding of the compliance review. */
export interface Finding {
    code: string;
    severity?: string;
    source?: string;
    title?: string;
    message?: string;
    detail?: string;
    why?: string;
    fix?: string;
    framework?: string;
    article?: string;
    subject?: string;
    link?: string;
    target?: FindingTarget | null;
    fix_kind?: string | null;
    [field: string]: unknown;
}

/** The proposal "Resolve with AI" shows for one finding, in words. */
export interface ResolveProposal {
    title?: string;
    what?: string[] | null;
    note?: string | null;
    unresolved?: Array<{ what: string }> | null;
    modelFailed?: boolean;
    empty?: boolean;
    [field: string]: unknown;
}

/** A column the review found personal data in. */
export interface PersonalColumn {
    key?: string;
    name?: string;
    kind?: string;
    kinds?: string[];
    [field: string]: unknown;
}

/** The table a review was run on. */
export interface TableFacts {
    id?: string;
    name?: string;
    columns?: Array<{ key: string; name?: string; type?: string }>;
    personal?: PersonalColumn[] | null;
    lawfulBasis?: string | null;
    retentionDays?: number | string | null;
    retentionField?: string | null;
    subjectColumn?: string | null;
    [field: string]: unknown;
}

/** The organisation's compliance settings the review read. */
export interface OrgFacts {
    legalBases?: string[] | null;
    defaultRetentionDays?: number | string | null;
    [field: string]: unknown;
}

/** What the review knew when it ran. */
export interface ComplianceFacts {
    table?: TableFacts | null;
    org?: OrgFacts | null;
    app?: { id?: string } | null;
    personalMethod?: string | null;
    [field: string]: unknown;
}

export interface ComplianceChecks {
    ran?: number | null;
    clean?: number | null;
}

/** The compliance phase's artifacts (the review's result). */
export interface ComplianceArtifacts {
    findings?: Finding[] | null;
    checks?: ComplianceChecks | null;
    frameworks?: string[] | null;
    facts?: ComplianceFacts | null;
    registered?: RegisteredInfo | null;
    rechecks?: Array<{ was: number; now: number }> | null;
    modelFailed?: boolean;
    [field: string]: unknown;
}

/** What a retention period would mean for the rows that exist. */
export interface RetentionPreview {
    usable?: boolean;
    retentionFieldName?: string | null;
    retentionField?: string | null;
    outsideWindow?: number;
    oldestDays?: number;
    rowCount?: number;
    retentionDays?: number;
}

/** What the register wrote. */
export interface RegisteredInfo {
    written?: string[] | null;
}

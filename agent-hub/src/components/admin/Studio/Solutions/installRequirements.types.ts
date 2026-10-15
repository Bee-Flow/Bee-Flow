/** A JSON object as the file gave it: any keys, any values until they are read. */
export type Json = Record<string, unknown>;

/** A step of an automation definition, addressed for the wizard's state. */
export interface StepAddress {
    ref: string;
    title: string;
    stepId: string;
    layerKey: string | null;
}

/** A table the installer has to pick (or create) because the file does not bring it. */
export interface TableRequirement {
    key: string;
    steps: StepAddress[];
}

/** What the file says about its own origin. A claim, shown as a claim. */
export interface SourceClaim {
    blueprintId: string | null;
    orgId: string | null;
    orgName: string | null;
    version: number | null;
}

/** One page's request for a grant, as a row the Connect step can show. */
export interface GrantRow {
    ref: string | null;
    name: string;
    kind: 'integration' | 'automation' | 'public_ai';
    tool?: string;
    flags?: Json;
}

/** What the three wizard steps show, read off a manifest. */
export interface BlueprintRequirements {
    tables: TableRequirement[];
    connections: StepAddress[];
    approvers: StepAddress[];
}

/** The read of a manifest: `ok: false` for anything that is not a Blueprint. */
export type BlueprintReading =
    | { ok: false }
    | {
        ok: true;
        name: string;
        description: string;
        version: number;
        counts: Record<string, number>;
        notCarried: string[];
        source: SourceClaim;
        requires: BlueprintRequirements;
        grants: GrantRow[];
    };

/** The wizard's answers, keyed by row. */
export interface BlueprintAnswers {
    tables?: Record<string, string>;
    connections?: Record<string, string>;
    approvers?: Record<string, string>;
}

/** The body `POST /package/install` takes. */
export interface BlueprintResolutions {
    tables: Array<{ key: string; create?: boolean; datatableId?: string }>;
    connections: Array<{ ref: string; stepId: string; layerKey: string | null; connectionId: string }>;
    approvers: Array<{ ref: string; stepId: string; layerKey: string | null; seat: { userId: string } | { groupId: string } }>;
}

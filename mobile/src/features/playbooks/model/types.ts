/**
 * The playbook shapes, taken from the server's own serialisers:
 *   Playbook          stores/playbookStore.js mapRow — the whole entity, with
 *                     its phases (status, brief, artifacts) and `version`, the
 *                     optimistic lock every write carries;
 *   PlaybookSummary   routes/playbooks/phaseList.js summarise — the list row;
 *   Recipe            playbooks/recipeDoc.js — the document compose returns
 *                     and create accepts back;
 *   AccessPlan        playbooks/accessPlan.js resolveNames — a proposal;
 *   Finding / facts   playbooks/phases/compliancePhase.js — the review.
 *
 * `artifacts` stays an open record: every phase kind writes its own keys, and
 * the stages read them with a tolerant accessor (model/artifacts.ts).
 */

export type PhaseStatus = 'pending' | 'ready' | 'running' | 'awaiting' | 'done' | 'failed' | 'skipped' | 'locked';

export type PhaseKind = 'table' | 'automation' | 'fill' | 'design' | 'app' | 'app_turn' | 'access' | 'compliance';

export type Artifacts = Record<string, unknown>;

export interface Phase {
    key: string;
    /** Absent on rows from before recipe documents; kindOf() derives it. */
    kind: string | null;
    /** A custom recipe's own words for the phase. */
    label: string | null;
    status: PhaseStatus;
    attempt: number;
    brief: string | null;
    artifacts: Artifacts;
    summary: string | null;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    requires: string | null;
    /** Page-local: a builder asked something (never on the wire). */
    needsInput?: boolean;
    /** Page-local: a running status the server has not confirmed yet. */
    optimistic?: boolean;
}

export type PlaybookStatus = 'active' | 'stopped' | 'done';

export interface Playbook {
    id: string;
    title: string;
    status: PlaybookStatus;
    recipeId: string;
    options: Record<string, unknown>;
    phases: Phase[];
    currentPhase: string | null;
    version: number;
    createdAt: string | null;
    updatedAt: string | null;
}

export interface PlaybookSummary {
    id: string;
    title: string;
    recipeLabel: string | null;
    status: PlaybookStatus;
    currentPhase: string | null;
    progress: { done: number; total: number; locked: number };
    phases: Pick<Phase, 'key' | 'kind' | 'label' | 'status'>[];
    updatedAt: string | null;
}

export interface RecipeInput {
    key: string;
    label: string;
    kind: string;
    default: string | null;
    placeholder: string | null;
}

export interface RecipeField {
    key: string;
    name: string;
    type: string;
}

/** The composed recipe: what the preview shows, and — unchanged — what create sends back. */
export interface Recipe {
    title: string;
    description: string;
    phases: { key: string; label: string | null }[];
    fields: RecipeField[] | null;
    inputs: RecipeInput[];
    needsApprover: boolean;
    warnings: string[];
    /** The document as the server wrote it; create sends this back untouched. */
    raw: Record<string, unknown>;
}

/** A table an "existing table" playbook may fill. */
export interface TableChoice {
    id: string;
    name: string;
    rowCount: number | null;
    managedKind: string | null;
}

export interface ComposeResult {
    recipe: Recipe;
    warnings: string[];
}

export interface AccessAudience {
    kind: 'private' | 'organisation' | 'groups';
    groupIds: string[];
    groupNames: string[];
}

export interface AccessPlan {
    note: string;
    audience: AccessAudience | null;
    roles: { key: string; label: string }[];
    tableRules: { tableId: string; roleKey: string; expr: string }[];
    defaultRole: string | null;
    byGroup: Record<string, string>;
    members: { userId: string; roleKey: string; name: string }[];
    /** The names the assistant could not match to anything real. */
    unresolved: string[];
    empty: boolean;
}

/** Where the app stands before the access phase changes anything. */
export interface AppAccess {
    id: string;
    name: string;
    isPublished: boolean;
    sharedGroups: string[];
}

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
    code: string;
    severity: string;
    title: string;
    why: string | null;
    fix: string | null;
    framework: string | null;
    article: string | null;
    subject: string | null;
    target: { kind: string; id: string; name: string | null } | null;
    link: string | null;
}

export interface RegisterResult {
    playbook: Playbook | null;
    written: string[];
    failed: { what: string; error: string | null }[];
}

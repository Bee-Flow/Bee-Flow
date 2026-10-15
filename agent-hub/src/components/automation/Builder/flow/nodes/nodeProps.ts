/**
 * The shapes every canvas node component receives.
 *
 * `flow/layout.js` puts a step and its run row on each React Flow node's
 * `data`; the per-type files under nodes/ read them from there. Only the
 * members the cards actually read are named, and an index signature carries
 * the rest of a step through untouched — the server owns the full schema.
 */
import type { FlowStep } from '../types';
import type { SidecarEntry } from '../diagramPaneTypes';

/** The translator every card reads from `useTranslation()`. */
export type TFn = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** A summary line under a card's name: plain text, or `{ muted }` for "not answered yet". */
export type SummaryText = string | { muted: string };

/** One validation record (flow/matchValidationToStep.ts). */
export interface StepIssue {
    path: string;
    message?: string;
    code?: string;
    [key: string]: unknown;
}

export interface StepIssues {
    errors: StepIssue[];
    warnings: StepIssue[];
}

/** A step's run row, as far as the cards read it (flow/runStatus.js). */
export interface NodeRunStep {
    status?: string;
    output?: {
        count?: number;
        restored?: number;
        unresolved?: number;
        unresolvedTokens?: string[];
        [key: string]: unknown;
    };
    [key: string]: unknown;
}

/** An app-event trigger's filter: every key the provider flavours know. */
export interface AppEventFilter {
    labelId?: string;
    from?: string;
    to?: string;
    cc?: string;
    subjectContains?: string;
    subjectRegex?: string;
    labelIds?: string[];
    excludeLabelIds?: string[];
    hasAttachment?: boolean;
    excludeFromSelf?: boolean;
    maxAgeMinutes?: number;
    leadMinutes?: number;
    calendarId?: string;
    statusEquals?: string;
    attendeeEmailContains?: string;
    includeAllDay?: boolean;
    folderId?: string;
    mimeType?: string;
    nameContains?: string;
    excludeOwnUploads?: boolean;
    inFolder?: string;
    extension?: string;
    actorEquals?: string;
    kindEquals?: string;
    type?: string;
    objectNameContains?: string;
    app?: string;
    [key: string]: unknown;
}

export interface AppEventConfig {
    provider?: string;
    event?: string;
    filter?: AppEventFilter | null;
    [key: string]: unknown;
}

export interface TriggerParam {
    name: string;
    type?: string;
    required?: boolean;
    [key: string]: unknown;
}

export interface SwitchCase {
    name?: string;
    expr?: string;
    [key: string]: unknown;
}

/** A step as the cards read it: the common head plus every field a card shows. */
export interface NodeStep extends FlowStep {
    label?: string;
    kind?: string;
    arrayRef?: string;
    count?: number | string;
    mode?: string;
    keyField?: string;
    field?: string;
    op?: string;
    amount?: number | string;
    unit?: string;
    part?: string;
    format?: string;
    seconds?: number | string;
    datatableId?: string;
    where?: Array<{ field?: string } | null>;
    matchColumn?: string;
    knowledgeBaseId?: string;
    sourceUri?: string;
    content?: string;
    title?: string;
    fileName?: string;
    preset?: string;
    logo?: string;
    image?: string;
    layout?: string;
    chart?: { type?: string; [key: string]: unknown } | null;
    stats?: unknown;
    slides?: unknown;
    documentId?: string;
    documentName?: string;
    values?: Record<string, unknown>;
    prompt?: string;
    approval?: { expiresInHours?: number | string; [key: string]: unknown } | null;
    expiresInHours?: number | string;
    forEach?: { overRef?: string; [key: string]: unknown } | null;
    sourceRef?: string;
    onFound?: { stop?: boolean; mask?: boolean; [key: string]: unknown };
    message?: string;
    expr?: string;
    tool?: string;
    sideEffect?: boolean;
    method?: unknown;
    url?: unknown;
    blockPrivateTargets?: boolean;
    channels?: string[];
    body?: unknown;
    branches?: unknown[];
    failOnAnyBranchError?: boolean;
    cases?: SwitchCase[];
    defaultBranch?: boolean;
    tools?: unknown[];
    modelTier?: string;
    allowTools?: boolean;
    code?: string;
    codeHash?: string;
    waitSeconds?: number | string;
    navigateTo?: { screenId?: string; [key: string]: unknown } | null;
    toast?: { message?: string; [key: string]: unknown } | null;
    refresh?: string;
    overRef?: string;
    itemVar?: string;
    maxIterations?: number;
    batchSize?: number;
    blockId?: string;
    layerKey?: string;
    inputs?: Record<string, unknown> | null;
    fields?: unknown;
    appEvent?: AppEventConfig | null;
    schedule?: { cron?: string; tz?: string; [key: string]: unknown } | null;
    toolName?: string;
    parametersSchema?: { properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown } | null;
    params?: TriggerParam[];
    form?: { title?: string; fields?: unknown[]; [key: string]: unknown } | null;
}

/** A step's fields without its identity: what the one-line summaries read. */
export type StepFields = Partial<NodeStep>;

/** What `flow/layout.js` puts on a step node. */
export interface StepNodeData<S extends NodeStep = NodeStep> {
    step: S;
    runStep?: NodeRunStep | null;
    issues?: StepIssues;
    isTrigger?: boolean;
    onAddAfter?: ((nodeId: string) => void) | null;
    onDiagnose?: (() => void) | null;
    stepLabelById?: Map<string, string> | null;
    datatablesById?: Record<string, { scope?: string; pending?: boolean; name?: string }>;
    tableNameById?: Record<string, string>;
    kbNameById?: Record<string, string>;
    agentNameById?: Record<string, string>;
    toolPortActive?: boolean;
    inlineExpanded?: SidecarEntry;
    inlineParent?: SidecarEntry;
}

/** The props React Flow hands a step node component (the ones the cards use). */
export interface StepNodeProps<S extends NodeStep = NodeStep> {
    id: string;
    data: StepNodeData<S>;
}

/** An output port a branch card draws: its handle id, label and chip tone. */
export interface SourceHandleSpec {
    id: string;
    label?: string;
    tone: string;
}

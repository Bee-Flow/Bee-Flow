// The shapes of the run-check answers (compare, golden runs, form scenarios).
// The readers that build them are in runChecksParse.ts; the hooks in runChecks.ts.

type CompareVerdict = 'same' | 'soft' | 'changed';
export type StepVerdict = 'same' | 'changed' | 'soft' | 'only_a' | 'only_b' | 'status_changed' | 'not_comparable';
export type SoftReason = 'ai' | 'simulated';
export type ChangeKind = 'added' | 'removed' | 'changed' | 'type_changed';

/** One difference inside a step: values are JSON text, already cut by the server. */
export interface Change {
    path: string;
    change: ChangeKind;
    before: string | null;
    after: string | null;
}

export interface FilePart {
    kind: string;
    index: number;
    title: string | null;
    name: string | null;
    rows: number | null;
    cols: number | null;
    textChars: number | null;
    textHash: string | null;
}

export interface FileSummary {
    name: string;
    mime: string;
    size: number | null;
    sha256: string | null;
    parts: FilePart[];
}

export interface FileCompare {
    stepId: string | null;
    a: FileSummary | null;
    b: FileSummary | null;
    change: 'same' | 'changed' | 'added' | 'removed';
}

export interface StepCompare {
    key: string;
    stepId: string;
    stepType: string | null;
    parentStepId: string | null;
    a: { present: boolean; status: string | null };
    b: { present: boolean; status: string | null };
    verdict: StepVerdict;
    softReason: SoftReason | null;
    /** 'json', 'generated_file', or the kind of a differ a later release registers. */
    kind: string;
    changes: Change[];
    changesTruncated: boolean;
    files: FileCompare[];
}

export interface CompareSide {
    runId: string;
    status: string | null;
    mode: string | null;
    version: number | null;
    triggerKind: string | null;
    startedAt: string | null;
}

export interface CompareSummary {
    same: number;
    changed: number;
    soft: number;
    onlyA: number;
    onlyB: number;
    notComparable: number;
}

export interface CompareResult {
    a: CompareSide;
    b: CompareSide;
    verdict: CompareVerdict;
    summary: CompareSummary;
    steps: StepCompare[];
    truncated: boolean;
}

export type ReplayStatus = 'running' | 'same' | 'soft' | 'changed' | 'error' | 'interrupted';
export type AiAnswers = 'live' | 'cache';

export interface GoldenReplay {
    status: ReplayStatus;
    at: string | null;
    replayRunId: string | null;
    summary: Partial<CompareSummary> | null;
    errorCode: string | null;
}

export interface GoldenItem {
    goldenId: string;
    runId: string;
    label: string | null;
    ignorePaths: string[];
    createdAt: string | null;
    createdBy: string | null;
    run: { status: string | null; mode: string | null; version: number | null; triggerKind: string | null; startedAt: string | null } | null;
    lastReplay: GoldenReplay | null;
}

export interface GoldenList {
    goldens: GoldenItem[];
    /** The per-automation cap; null when unlimited. */
    max: number | null;
}

interface ScenarioPage { stepId: string; fieldCount: number }
interface ScenarioSkip { stepId: string | null; field: string; reason: string }

export interface ScenarioItem {
    scenarioId: string;
    name: string;
    sourceRunId: string | null;
    createdAt: string | null;
    createdBy: string | null;
    hasTriggerAnswers: boolean;
    pages: ScenarioPage[];
    skipped: ScenarioSkip[];
}

interface ScenarioAnswers {
    trigger: Record<string, unknown> | null;
    pages: Record<string, Record<string, unknown>>;
}

export interface ScenarioDetail extends ScenarioItem { answers: ScenarioAnswers }

export interface ScenarioList { scenarios: ScenarioItem[]; max: number | null }

export interface ScenarioDryRun {
    runId: string | null;
    status: string | null;
}

// Defensive readers for the run-check wire answers: a field this build does
// not know is dropped, a missing one gets a neutral value, so a newer server (a
// new differ kind, a new replay status) never breaks a screen.

import type {
    Change, ChangeKind, CompareResult, CompareSide, CompareSummary, FileCompare, FilePart, FileSummary,
    GoldenItem, GoldenList, GoldenReplay, ReplayStatus, ScenarioDetail, ScenarioItem, ScenarioList,
    StepCompare, StepVerdict,
} from './runChecksTypes';

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v: unknown): number => num(v) ?? 0;
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
    (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? v as T : fallback);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** Change values are JSON text; anything else is shown as its JSON. */
function valueText(v: unknown): string | null {
    if (v === undefined) return null;
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v) ?? null; } catch { return null; }
}

const CHANGE_KINDS = ['added', 'removed', 'changed', 'type_changed'] as const;

export function parseChange(raw: unknown): Change | null {
    if (!isRecord(raw)) return null;
    return {
        path: typeof raw.path === 'string' ? raw.path : '',
        change: oneOf(raw.change, CHANGE_KINDS, 'changed'),
        before: valueText(raw.before),
        after: valueText(raw.after),
    };
}

function parsePart(raw: unknown): FilePart | null {
    if (!isRecord(raw)) return null;
    return {
        kind: str(raw.kind) ?? 'part',
        index: count(raw.index),
        title: str(raw.title),
        name: str(raw.name),
        rows: num(raw.rows),
        cols: num(raw.cols),
        textChars: num(raw.textChars),
        textHash: str(raw.textHash),
    };
}

export function parseFileSummary(raw: unknown): FileSummary | null {
    if (!isRecord(raw)) return null;
    return {
        name: str(raw.name) ?? 'file',
        mime: str(raw.mime) ?? '',
        size: num(raw.size),
        sha256: str(raw.sha256),
        parts: list(raw.parts).map(parsePart).filter((p): p is FilePart => p !== null),
    };
}

function parseFileCompare(raw: unknown): FileCompare | null {
    if (!isRecord(raw)) return null;
    return {
        stepId: str(raw.stepId),
        a: parseFileSummary(raw.a),
        b: parseFileSummary(raw.b),
        change: oneOf(raw.change, ['same', 'changed', 'added', 'removed'] as const, 'changed'),
    };
}

const STEP_VERDICTS = ['same', 'changed', 'soft', 'only_a', 'only_b', 'status_changed', 'not_comparable'] as const;

function parseSide(raw: unknown): { present: boolean; status: string | null } {
    const o = isRecord(raw) ? raw : {};
    return { present: o.present === true, status: str(o.status) };
}

function parseStep(raw: unknown): StepCompare | null {
    if (!isRecord(raw)) return null;
    const stepId = str(raw.stepId);
    if (!stepId) return null;
    return {
        key: str(raw.key) ?? stepId,
        stepId,
        stepType: str(raw.stepType),
        parentStepId: str(raw.parentStepId),
        a: parseSide(raw.a),
        b: parseSide(raw.b),
        verdict: oneOf(raw.verdict, STEP_VERDICTS, 'changed'),
        softReason: raw.softReason === 'ai' || raw.softReason === 'simulated' ? raw.softReason : null,
        kind: str(raw.kind) ?? 'json',
        changes: list(raw.changes).map(parseChange).filter((c): c is Change => c !== null),
        changesTruncated: raw.changesTruncated === true,
        files: list(raw.files).map(parseFileCompare).filter((f): f is FileCompare => f !== null),
    };
}

function parseCompareSide(raw: unknown): CompareSide {
    const o = isRecord(raw) ? raw : {};
    return {
        runId: str(o.runId) ?? '',
        status: str(o.status),
        mode: str(o.mode),
        version: num(o.version),
        triggerKind: str(o.triggerKind),
        startedAt: str(o.startedAt),
    };
}

function parseSummary(raw: unknown): CompareSummary {
    const o = isRecord(raw) ? raw : {};
    return {
        same: count(o.same), changed: count(o.changed), soft: count(o.soft),
        onlyA: count(o.onlyA), onlyB: count(o.onlyB), notComparable: count(o.notComparable),
    };
}

/** The wire CompareResult, reduced to what the screen uses. Exported for the test. */
export function parseCompare(raw: unknown): CompareResult {
    const o = isRecord(raw) ? raw : {};
    return {
        a: parseCompareSide(o.a),
        b: parseCompareSide(o.b),
        verdict: oneOf(o.verdict, ['same', 'soft', 'changed'] as const, 'changed'),
        summary: parseSummary(o.summary),
        steps: list(o.steps).map(parseStep).filter((s): s is StepCompare => s !== null),
        truncated: o.truncated === true,
    };
}

const REPLAY_STATUSES = ['running', 'same', 'soft', 'changed', 'error', 'interrupted'] as const;

function parseReplay(raw: unknown): GoldenReplay | null {
    if (!isRecord(raw) || typeof raw.status !== 'string') return null;
    return {
        status: oneOf(raw.status, REPLAY_STATUSES, 'error'),
        at: str(raw.at),
        replayRunId: str(raw.replayRunId),
        summary: isRecord(raw.summary) ? parseSummary(raw.summary) : null,
        errorCode: str(raw.errorCode),
    };
}

export function parseGolden(raw: unknown): GoldenItem | null {
    if (!isRecord(raw)) return null;
    const goldenId = str(raw.goldenId);
    const runId = str(raw.runId);
    if (!goldenId || !runId) return null;
    const run = isRecord(raw.run) ? raw.run : null;
    return {
        goldenId,
        runId,
        label: str(raw.label),
        ignorePaths: list(raw.ignorePaths).filter((p): p is string => typeof p === 'string'),
        createdAt: str(raw.createdAt),
        createdBy: str(raw.createdBy),
        run: run ? {
            status: str(run.status), mode: str(run.mode), version: num(run.version),
            triggerKind: str(run.triggerKind), startedAt: str(run.startedAt),
        } : null,
        lastReplay: parseReplay(raw.lastReplay),
    };
}

/** The cap the server reports; 0 or missing reads as no cap. */
function maxOf(raw: unknown): number | null {
    const limits = isRecord(raw) ? raw : {};
    const max = num(limits.max);
    return max && max > 0 ? max : null;
}

export function parseGoldenList(raw: unknown): GoldenList {
    const o = isRecord(raw) ? raw : {};
    return {
        goldens: list(o.goldens).map(parseGolden).filter((g): g is GoldenItem => g !== null),
        max: maxOf(o.limits),
    };
}

export function parseScenario(raw: unknown): ScenarioItem | null {
    if (!isRecord(raw)) return null;
    const scenarioId = str(raw.scenarioId);
    if (!scenarioId) return null;
    return {
        scenarioId,
        name: str(raw.name) ?? '',
        sourceRunId: str(raw.sourceRunId),
        createdAt: str(raw.createdAt),
        createdBy: str(raw.createdBy),
        hasTriggerAnswers: raw.hasTriggerAnswers === true,
        pages: list(raw.pages).filter(isRecord).flatMap(p => (str(p.stepId)
            ? [{ stepId: String(p.stepId), fieldCount: count(p.fieldCount) }] : [])),
        skipped: list(raw.skipped).filter(isRecord).flatMap(s => (str(s.field)
            ? [{ stepId: str(s.stepId), field: String(s.field), reason: str(s.reason) ?? '' }] : [])),
    };
}

export function parseScenarioDetail(raw: unknown): ScenarioDetail | null {
    const base = parseScenario(raw);
    if (!base || !isRecord(raw)) return null;
    const answers = isRecord(raw.answers) ? raw.answers : {};
    const pages: Record<string, Record<string, unknown>> = {};
    if (isRecord(answers.pages)) {
        for (const [stepId, values] of Object.entries(answers.pages)) if (isRecord(values)) pages[stepId] = values;
    }
    return { ...base, answers: { trigger: isRecord(answers.trigger) ? answers.trigger : null, pages } };
}

export function parseScenarioList(raw: unknown): ScenarioList {
    const o = isRecord(raw) ? raw : {};
    return {
        scenarios: list(o.scenarios).map(parseScenario).filter((s): s is ScenarioItem => s !== null),
        max: maxOf(o.limits),
    };
}

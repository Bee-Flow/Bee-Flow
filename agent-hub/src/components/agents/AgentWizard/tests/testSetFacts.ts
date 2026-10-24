import type { TestItem, TestRunResults, TestRun, AgentTest, Refusal, RunProgress, RunSummary, SummariseRunArgs, RefusalForArgs } from './testSetFacts.types';
export type { TestItem, TestRunResults, TestRun, AgentTest, Refusal, RunProgress, RunSummary } from './testSetFacts.types';
/** De vier toestanden van "wat weten we van de laatste run". */
export const RUN_STATE = Object.freeze({
    NEVER: 'never',
    UNKNOWN: 'unknown',
    UNFINISHED: 'unfinished',
    RESULT: 'result',
});

/** Wat er met één test gebeurde. Spiegelt `testSandbox.STATUSES`. */
export const ITEM_STATUS = Object.freeze(['pass', 'fail', 'blocked', 'error']);

/**
 * The order in which a problem asks for attention.
 *
 * `fail` first: that is the only verdict about the AGENT. `error` after that: there we do
 * not know, and not knowing is more urgent than an expectation that this run could not
 * check by definition. `blocked` last: that says something about the sandbox, not about
 * the agent.
 */
const PROBLEM_RANK = Object.freeze<Record<string, number>>({ fail: 0, error: 1, blocked: 2 });

/** A finite, non-negative integer, or null. */
function intOrNull(value: unknown) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

function asArray<T = unknown>(value: unknown): T[] {
    return Array.isArray(value) ? value : [];
}

/** Een tijdstip als millis, of null — nooit NaN, dat vergelijkt overal false. */
function timeOf(value: string | number | Date | null | undefined) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

/**
 * Is this row a COMPLETED result?
 *
 * All three checks ask "does the row contradict itself", and all three land on
 * `unfinished` instead of on a number.
 */
function looksFinished(run: TestRun) {
    const total = intOrNull(run.total);
    if (total === null || total === 0) return false;
    const passed = intOrNull(run.passed);
    if (passed === null || passed > total) return false;
    const items = run.results && Array.isArray(run.results.items) ? run.results.items : null;
    if (items && items.length !== total) return false;
    return true;
}

export function summariseRun({ lastRun = null, lastRunUnknown = false, tests = null }: SummariseRunArgs = {}): RunSummary {
    const now = asArray<AgentTest>(tests);
    const knowTests = Array.isArray(tests);
    const empty: RunSummary = {
        state: RUN_STATE.NEVER,
        passed: null, total: null,
        items: [], itemsKnown: false,
        ranAt: null, version: null, source: null, unpublishedChanges: null,
        coverage: null,
        stale: { added: false, changed: false, removed: false },
        isStale: false,
    };

    // Unknown goes before everything: a failed read that happened to yield no row is not
    // "never run".
    if (lastRunUnknown === true) return { ...empty, state: RUN_STATE.UNKNOWN };
    if (!lastRun || typeof lastRun !== 'object') return empty;

    const results: TestRunResults = (lastRun.results && typeof lastRun.results === 'object') ? lastRun.results : {};
    const items = Array.isArray(results.items) ? results.items : null;
    const ranAt = lastRun.ranAt || null;
    const base = {
        ...empty,
        items: items || [],
        itemsKnown: !!items,
        ranAt,
        version: intOrNull(lastRun.version),
        source: typeof results.source === 'string' ? results.source : null,
        unpublishedChanges: intOrNull(results.unpublishedChanges),
    };

    if (!looksFinished(lastRun)) return { ...base, state: RUN_STATE.UNFINISHED };

    const total = intOrNull(lastRun.total);
    const passed = Math.min(Number(intOrNull(lastRun.passed)), Number(total));

    // Coverage: this run covered `total` questions; there are `of` now. Next to the row comes
    // `results.testCount`, how many there were THEN, but the card speaks to someone who looks
    // at the list of NOW, so that is the number that belongs next to the counter.
    const ranAtMs = timeOf(ranAt);
    const ranIds = new Set((items || []).map(i => i && i.testId).filter(id => typeof id === 'string'));
    const stale = { added: false, changed: false, removed: false };
    if (ranAtMs !== null) {
        for (const t of now) {
            const created = timeOf(t && t.createdAt);
            const updated = timeOf(t && t.updatedAt);
            if (created !== null && created > ranAtMs) stale.added = true;
            else if (updated !== null && updated > ranAtMs) stale.changed = true;
        }
    }
    if (knowTests && ranIds.size > 0) {
        const liveIds = new Set(now.map(t => t && t.id).filter(id => typeof id === 'string'));
        for (const id of ranIds) if (!liveIds.has(id)) { stale.removed = true; break; }
    }

    return {
        ...base,
        state: RUN_STATE.RESULT,
        passed, total,
        // `of` is how many questions stand NOW, because the card speaks to someone who looks at
        // the list of now. If it does not know that list (the read was refused or failed), it
        // falls back on `results.testCount`: how many stood when this run ran. `when` says which
        // of the two it is, so that the sentence next to it does not lie about WHEN there were
        // that many questions.
        coverage: knowTests
            ? { ran: total, of: now.length, when: 'now' }
            : (intOrNull(results.testCount) === null
                ? { ran: total, of: null, when: 'now' }
                : { ran: total, of: intOrNull(results.testCount), when: 'then' }),
        stale,
        isStale: stale.added || stale.changed || stale.removed,
    };
}

/**
 * Why this test is not green, as a FACT and not as a sentence.
 *
 * The `reason` the server stored is English and comes from a closed list. The card writes
 * its own translatable rule from `kind` + `names`, and falls back on that text only if
 * there is nothing else (`error`, where the reason carries the real cause).
 */
export function problemFor(item: TestItem | null | undefined) {
    if (!item || typeof item !== 'object') return null;
    const status = ITEM_STATUS.includes(item.status) ? item.status : 'error';
    if (status === 'pass') return null;

    const forbidden = asArray<string>(item.forbiddenHits).filter(n => typeof n === 'string' && n);
    const missing = asArray<string>(item.toolsMissing).filter(n => typeof n === 'string' && n);
    const withheld = asArray<string>(item.toolsWithheld).filter(n => typeof n === 'string' && n);

    if (status === 'blocked') return { status, kind: 'withheld', names: withheld, reason: item.reason || '' };
    if (status === 'error') return { status, kind: 'ungraded', names: [], reason: item.reason || '' };
    // A fail that is decided by a FACT says which fact. That is more precise than the sentence
    // from the closed list, and it is not written by a model.
    if (forbidden.length) return { status, kind: 'forbidden', names: forbidden, reason: item.reason || '' };
    if (missing.length) return { status, kind: 'tools_missing', names: missing, reason: item.reason || '' };
    return { status, kind: `decided:${item.decidedBy || 'overall'}`, names: [], reason: item.reason || '' };
}

/**
 * The FAILURE LINE: the one non-green result that the card shows, plus how many more
 * there are.
 *
 * One line and not all of them: the card is a summary, and "View" is where the rest is.
 * Which one is shown is not arbitrary but the most urgent (see PROBLEM_RANK), because the
 * first in the list can be a `blocked` while further down there is a real error.
 */
export function firstProblem(items: unknown) {
    const rows = asArray<TestItem>(items).filter(i => i && typeof i === 'object' && i.status !== 'pass');
    if (rows.length === 0) return null;
    let best = null as { item: TestItem; index: number } | null;
    let bestRank = Infinity;
    rows.forEach((item, index) => {
        const rank = PROBLEM_RANK[item.status] === undefined ? PROBLEM_RANK.error : PROBLEM_RANK[item.status];
        if (rank < bestRank) { bestRank = rank; best = { item, index }; }
    });
    if (!best) return null;
    return {
        item: best.item,
        problem: problemFor(best.item),
        moreCount: rows.length - 1,
        totalProblems: rows.length,
    };
}

// ── Weigeringen ──────────────────────────────────────────────────────

/**
 * The closed vocabulary in which the card can draw a refusal.
 *
 * `retryable` means "does trying again make sense". A read check that fell over does; a
 * model that is not set up does not. A button that promises it is up to you, while
 * nothing is set up, makes people press thirty times.
 */
export const REFUSAL = Object.freeze({
    NO_GRADER: 'no_grader',
    NO_SUGGESTER: 'no_suggester',
    MODEL_UNREADABLE: 'model_unreadable',
    SUGGESTION_UNREADABLE: 'suggestion_unreadable',
    LIMIT: 'limit',
    CHECK_FAILED: 'check_failed',
    NOTHING_TO_RUN: 'nothing_to_run',
    NOT_EDITABLE: 'not_editable',
    NOT_FOUND: 'not_found',
    TOO_MANY: 'too_many',
    NOT_SAVED: 'not_saved',
    /**
     * The stream broke OFF halfway. Unlike every refusal above, tests WERE run, just not all
     * of them. `run_failed` comes from the server only after `test_result` events have
     * already gone over the line, so the sentence beside it may not be "Nothing was tested"
     * while the results are shown beneath it.
     */
    RUN_STOPPED: 'run_stopped',
    UNKNOWN: 'unknown',
});

const BY_CODE = Object.freeze<Record<string, { kind: string; retryable: boolean }>>({
    no_grading_model: { kind: REFUSAL.NO_GRADER, retryable: false },
    no_suggestion_model: { kind: REFUSAL.NO_SUGGESTER, retryable: false },
    grading_model_unavailable: { kind: REFUSAL.MODEL_UNREADABLE, retryable: true },
    suggestion_model_unavailable: { kind: REFUSAL.MODEL_UNREADABLE, retryable: true },
    suggestion_unreadable: { kind: REFUSAL.SUGGESTION_UNREADABLE, retryable: true },
    limit_reached: { kind: REFUSAL.LIMIT, retryable: false },
    org_check_failed: { kind: REFUSAL.CHECK_FAILED, retryable: true },
    limit_check_failed: { kind: REFUSAL.CHECK_FAILED, retryable: true },
    no_tests: { kind: REFUSAL.NOTHING_TO_RUN, retryable: false },
    no_turn: { kind: REFUSAL.NOTHING_TO_RUN, retryable: false },
    agent_not_editable: { kind: REFUSAL.NOT_EDITABLE, retryable: false },
    too_many_tests: { kind: REFUSAL.TOO_MANY, retryable: false },
    not_saved: { kind: REFUSAL.NOT_SAVED, retryable: true },
    // The catch-all of the route (`/:id/tests/run`), and that fires ONLY once the stream was
    // already running. Without this rule it fell on REFUSAL.UNKNOWN, and therefore on
    // "Could not run the tests. Nothing was tested.", with five results shown beneath it.
    run_failed: { kind: REFUSAL.RUN_STOPPED, retryable: true },
});

export function refusalFor({ status = 0, body = null, code = null }: RefusalForArgs = {}): Refusal | null {
    const httpOk = Number(status) >= 200 && Number(status) < 300;
    const bodyCode = (body && typeof body.code === 'string' && body.code) || null;
    const found = code || bodyCode;
    if (httpOk && !found) return null;
    const known = found && BY_CODE[found];
    return {
        kind: known ? known.kind : REFUSAL.UNKNOWN,
        code: found || null,
        status: Number(status) || 0,
        retryable: known ? known.retryable : true,
        // De zin van de server reist mee als laatste redmiddel; de kaart
        // schrijft zijn eigen vertaalde regel voor elke bekende soort.
        serverMessage: (body && typeof body.error === 'string' && body.error) || '',
    };
}

// ── Een run terwijl hij loopt ────────────────────────────────────────

/** What a running run can be. Only COMPLETE is a result. */
export const PROGRESS = Object.freeze({
    RUNNING: 'running',
    COMPLETE: 'complete',
    UNFINISHED: 'unfinished',
});

/** The starting state of a press on Run, before the `start` event. */
export function startProgress(): RunProgress {
    return { status: PROGRESS.RUNNING, total: null, done: 0, items: [], passed: null, notStored: null };
}

/**
 * One SSE event of `POST /:id/tests/run` goes in, the new state comes out.
 *
 * Pure and without React, so the most important rule is testable without a stream: as
 * long as `done` has not been seen, this is NOT a result. An `error` event sets it to
 * `unfinished`, not to "0 passed". A run that fell over has no result, not even the worst one.
 */
export function applyRunEvent(state: RunProgress | null | undefined, event: string, data: unknown): RunProgress {
    const s = state && typeof state === 'object' ? state : startProgress();
    const payload = (data && typeof data === 'object' ? data : {}) as TestItem & Record<string, unknown>;
    switch (event) {
        case 'start':
            return { ...s, status: PROGRESS.RUNNING, total: intOrNull(payload.total), done: 0, items: [] };
        case 'test_result': {
            const items = [...s.items, payload];
            return { ...s, items, done: items.length };
        }
        case 'done':
            return {
                ...s,
                status: PROGRESS.COMPLETE,
                passed: intOrNull(payload.passed),
                total: intOrNull(payload.total) === null ? s.total : intOrNull(payload.total),
                // A "Test as" run is deliberately not stored; the card may therefore show it, but must
                // not keep it as the new last run.
                notStored: typeof payload.notStored === 'string' ? payload.notStored : null,
                run: (payload.run as TestRun | undefined) || null,
            };
        case 'error':
            return { ...s, status: PROGRESS.UNFINISHED, refusal: refusalFor({ status: 0, body: payload }) };
        default:
            return s;
    }
}

/**
 * De stream is afgelopen. Alles wat op dat moment nog `running` staat is
 * onafgemaakt — de verbinding viel weg, de tab ging dicht, de server stopte.
 */
export function endProgress(state: RunProgress | null | undefined): RunProgress {
    const s = state && typeof state === 'object' ? state : startProgress();
    if (s.status === PROGRESS.RUNNING) return { ...s, status: PROGRESS.UNFINISHED };
    return s;
}

/** Groen tellen doen we zelf: alleen `pass` telt, precies zoals de server. */
export function countPassed(items: unknown) {
    return asArray<TestItem>(items).filter(i => i && i.status === 'pass').length;
}

/**
 * The result of the run you JUST saw running.
 *
 * Why this exists: the card fell back after a completed run on `summariseRun(lastRun)`, and
 * `lastRun` is deliberately NOT updated for a run that is not stored: a "Test as"
 * simulation (by design never stored) or a run whose storing failed. The header then showed
 * the tally of the PREVIOUS run, while the failure line, the question lines and the refusal
 * beneath it were about the run just executed. "11 of 12 passed" above twelve red questions.
 *
 * `passed` comes preferably from the `done` event (the server counts itself), and falls back
 * on our own tally over the results that came in. `kept` says whether this result stayed
 * anywhere. If it did not, no version line may accompany it that is about a DIFFERENT run.
 *
 * @returns {{passed: number, total: number, kept: boolean, notStored: string|null}|null}
 *   null as long as there is no completed run to talk about.
 */
export function justRanScore(progress: RunProgress | null | undefined) {
    if (!progress || typeof progress !== 'object') return null;
    if (progress.status !== PROGRESS.COMPLETE) return null;
    const items = asArray<TestItem>(progress.items);
    const passed = intOrNull(progress.passed) === null ? countPassed(items) : intOrNull(progress.passed);
    const total = intOrNull(progress.total) === null ? items.length : intOrNull(progress.total);
    return {
        passed: Math.min(Number(passed), Number(total)),
        total,
        kept: !!progress.run && !progress.notStored,
        notStored: typeof progress.notStored === 'string' ? progress.notStored : null,
    };
}

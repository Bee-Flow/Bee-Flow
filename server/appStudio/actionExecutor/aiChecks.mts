/**
 * The answer checks of an App Studio AI step (ai_generate / ai_extract) at run time: the step's
 * answer is checked with the automation ai_step's checks (core/automationRunner/aiStepChecks.js),
 * a failing answer gets up to `repairRounds` repair messages (aiStepRepair.js: what failed, and
 * what the model itself wrote there), and then the step fails with code `ai_check_failed`.
 *
 * With no readable check (`rel.active` false) nothing here runs beyond the one ask the step always
 * made: same call, same output.
 *
 * Each repair round is one more model call through aiRuntime, so it has the per-call deadline and
 * retry of aiCallGuard.mts, is logged as its own usage row and counts as an AI call in the run log.
 * The rounds are bounded by LIMITS.MAX_AI_REPAIR_ROUNDS. A repair round offers no tools, as in
 * automations.
 *
 * Privacy: the repair message quotes only the model's own answer (max 200 characters per failing
 * path), never the lists or source data a check compared it with. App AI steps run without the
 * automation Privacy Shield, so the repair message gets the same treatment as the prompt: none.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
/** What this file reads of aiReliability.mts readAppReliability (spelled out: no .mts type import here). */
type AppReliability = { active: boolean; checks: Obj[]; repairRounds: number };
type Message = { role: string; content: unknown };
type CheckError = { code: string; path: string; message: string; modelValue: string };
type CheckReport = { passed: boolean; repaired: boolean; fallbackUsed: boolean; errors: Array<{ code: string; path: string; message: string }>; rounds: number };

/** What a check reads of one answer: the step's cleaned output, the model's own raw output, and the text of the answer for the repair conversation. */
export type AnswerView = { output: unknown; modelOutput: unknown; prior: unknown };

export type CheckedIo<A> = {
    /** One model call; `followUp` (the repair round's assistant + user messages) is null for the first ask. */
    ask: (followUp: Message[] | null) => Promise<A>;
    view: (answer: A) => AnswerView;
    /** An answer the step already has (ai_extract asks itself, with its own no-rows retry). */
    first?: A;
};

// The automation repair message goes through the Privacy Shield input guard; an app step has none,
// and this policy makes that guard a no-op (safetyGuard.guardAiInput returns at once).
const NO_GUARD_POLICY = Object.freeze({ piiEnabled: false, regexRules: [], scope: {} });

type ChecksModule = {
    evaluateAnswer: (p: { restored: unknown; modelOutput: unknown; rel: { checks: Obj[] }; lists: unknown[]; runState: Obj; mode: string; ctx: Obj; schema?: unknown }) => CheckError[];
    errorSummary: (errors: CheckError[]) => string;
};
type RepairModule = {
    buildRepairMessages: (p: { base: Message[]; prior: unknown; errors: CheckError[]; policy: unknown; auditBase: unknown; mode: string; ctx: unknown }) => Promise<Message[] | null>;
    makeCheckReport: (p: { passed: boolean; repaired: boolean; fallbackUsed: boolean; errors: CheckError[] }) => Omit<CheckReport, 'rounds'>;
};

const checksModule = () => nodeRequire('../../core/automationRunner/aiStepChecks.js') as ChecksModule;
const repairModule = () => nodeRequire('../../core/automationRunner/aiStepRepair.js') as RepairModule;

/** Check one answer. `output` is copied first: a list match rewrites it to the list's spelling. */
function judge(view: AnswerView, rel: AppReliability, scope: Obj): { output: unknown; errors: CheckError[] } {
    const output = view.output && typeof view.output === 'object' ? structuredClone(view.output) : view.output;
    const errors = checksModule().evaluateAnswer({
        restored: output, modelOutput: view.modelOutput, rel: { checks: rel.checks }, lists: [],
        runState: scope, mode: 'live', ctx: {},
    });
    return { output, errors };
}

/** The step failure after the last round: a 422 the step-error mapping passes through (code ai_check_failed, retryable). */
function checkFailure(errors: CheckError[], rounds: number, report: CheckReport): Error {
    const after = rounds ? ` after ${rounds} repair round${rounds === 1 ? '' : 's'}` : '';
    const e = new Error(`The AI answer did not pass its checks${after}: ${checksModule().errorSummary(errors)}`);
    return Object.assign(e, { status: 422, code: 'ai_check_failed', checkReport: report });
}

/**
 * The step's answer, checked. Without checks: the first answer and its view's output, unchanged.
 * With checks: the first answer that passes (with a `checkReport`), or a thrown `ai_check_failed`.
 */
export async function checkedAnswer<A>(rel: AppReliability, scope: Obj, io: CheckedIo<A>): Promise<{ answer: A; output: unknown; checkReport?: CheckReport }> {
    let answer = io.first !== undefined ? io.first : await io.ask(null);
    if (!rel.active) return { answer, output: io.view(answer).output };
    let view = io.view(answer);
    let { output, errors } = judge(view, rel, scope);
    let rounds = 0;
    while (errors.length && rounds < rel.repairRounds) {
        const followUp = await repairModule().buildRepairMessages({
            base: [], prior: view.prior, errors, policy: NO_GUARD_POLICY, auditBase: null, mode: 'live', ctx: null,
        });
        if (!followUp) break;
        rounds += 1;
        answer = await io.ask(followUp);
        view = io.view(answer);
        ({ output, errors } = judge(view, rel, scope));
    }
    const report = { ...repairModule().makeCheckReport({ passed: !errors.length, repaired: rounds > 0, fallbackUsed: false, errors }), rounds };
    if (errors.length) throw checkFailure(errors, rounds, report);
    return { answer, output, checkReport: report };
}

// ── The two steps (aiSteps.js) ────────────────────────────────────────────────
// `rt` is appStudio/aiRuntime (passed in: aiSteps requires it lazily, tests hand a fake one).

type Fields = Array<{ name: string }>;
export type Runtime = {
    runStructuredWithTools: (app: unknown, model: unknown, args: Obj) => Promise<{ structured: Obj }>;
    runTextWithTools: (app: unknown, model: unknown, args: Obj) => Promise<{ text: string }>;
    coerceRowToFields: (row: unknown, fields: Fields) => Obj;
    MAX_EXTRACT_ROWS: number;
};
/** One step's model call: the runtime, the app, the resolved model (with the step's temperature), the checks and the scope. */
export type StepCall = { rt: Runtime; app: unknown; model: unknown; rel: AppReliability; scope: Obj };

/** The arguments of one ask: the first with the step's tools, a repair round with none and its messages. */
export function callArgs(base: Obj, tools: unknown[], followUp: Message[] | null): Obj {
    return { ...base, tools: followUp ? [] : tools, ...(followUp ? { followUp } : {}) };
}

/** ai_generate, structured: the coerced object, checked as is ("category"). */
export function answerStructured(c: StepCall, base: Obj, tools: unknown[], fields: Fields) {
    return checkedAnswer(c.rel, c.scope, {
        ask: (followUp) => c.rt.runStructuredWithTools(c.app, c.model, callArgs(base, tools, followUp)),
        view: (r) => ({ output: c.rt.coerceRowToFields(r.structured, fields), modelOutput: r.structured, prior: r.structured }),
    });
}

/** ai_generate, text: checked as { text } (a check's field is "text"). */
export function answerText(c: StepCall, base: Obj, tools: unknown[]) {
    return checkedAnswer(c.rel, c.scope, {
        ask: (followUp) => c.rt.runTextWithTools(c.app, c.model, callArgs(base, tools, followUp)),
        view: (r) => ({ output: { text: r.text }, modelOutput: { text: r.text }, prior: r.text }),
    });
}

/**
 * ai_extract, after its own first answer (and its no-rows retry): the rows checked as { rows }
 * ("rows[].category"). A repair answer without a rows list is the step's no-records failure.
 */
export async function checkExtractRows(c: StepCall, base: Obj, fields: Fields, first: Obj, noRows: () => Error) {
    const rowsOf = (s: Obj) => (s.rows as unknown[]).slice(0, c.rt.MAX_EXTRACT_ROWS).map((r) => c.rt.coerceRowToFields(r, fields));
    const checked = await checkedAnswer<Obj>(c.rel, c.scope, {
        first,
        ask: async (followUp) => {
            const { structured } = await c.rt.runStructuredWithTools(c.app, c.model, callArgs(base, [], followUp));
            if (!Array.isArray(structured.rows)) throw noRows();
            return structured;
        },
        view: (s) => ({ output: { rows: rowsOf(s) }, modelOutput: { rows: s.rows }, prior: { rows: s.rows } }),
    });
    return { rows: (checked.output as { rows: Obj[] }).rows, checkReport: checked.checkReport };
}

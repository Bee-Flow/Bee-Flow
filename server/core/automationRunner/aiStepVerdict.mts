/**
 * An AI step's own verdict on its work, when the step asks for one (`reportOutcome: true`; Cowork sets it on the run
 * copy of a plan, core/cowork/plan/planRunCopy.mts, and nothing else does): `{ outcome, reason }`, with outcome
 *
 *   done           it did what it was asked;
 *   nothing_to_do  it checked and there was genuinely nothing this time (no meetings in the period);
 *   failed         it could not do what it was asked: the data it needed was missing, the input made no sense, a tool
 *                  it used errored.
 *
 * It is asked in the step's structured output, the way the step's JSON answer is produced already
 * (./aiStepAnswer.js): a step with an object schema gets one more field, `coworkOutcome`; a step that answers in text
 * answers `{ answer, coworkOutcome }` instead, and its output is the `answer` again. Either way the verdict is taken
 * OUT of the output before anything binds to it (the output is the bindable namespace, and a downstream step reads it
 * exactly as before) and recorded beside it (automation_run_steps.verdict). A model that gives no verdict, or one that
 * does not parse, gives none: the step's output is then whatever it answered.
 *
 * Pure.
 */

export type Outcome = 'done' | 'nothing_to_do' | 'failed';
export interface Verdict { outcome: Outcome; reason: string | null }

export const VERDICT_FIELD = 'coworkOutcome';
const ANSWER_FIELD = 'answer';
const OUTCOMES: readonly Outcome[] = ['done', 'nothing_to_do', 'failed'];
/** One short sentence. */
export const REASON_MAX = 200;

type Schema = { type?: unknown; properties?: Record<string, unknown>; required?: unknown; [key: string]: unknown };
export interface Contract {
    inferred: unknown;
    inferredFields: string[] | null;
    outputContract: { schema?: unknown; declared?: boolean; source?: string | null; [key: string]: unknown };
    effectiveSchema: Schema | null;
    /** The step answers in text: its output is the `answer` of the structured reply. */
    verdictWrapped?: boolean;
}

const VERDICT_SCHEMA = Object.freeze({
    type: 'object',
    description: 'Your own verdict on this step, last. outcome: "done" when you did what the task asks; "nothing_to_do" when you checked and there was genuinely nothing this time (for example no meetings in the period); "failed" when you could not do what the task asks (the data you needed was missing or empty where it should not be, the input made no sense, or a tool errored). reason: at most one short sentence.',
    properties: {
        outcome: { type: 'string', enum: [...OUTCOMES] },
        reason: { type: 'string', description: 'At most one short sentence.' },
    },
    required: ['outcome'],
});

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const objectSchema = (s: Schema | null): s is Schema => !!s && s.type === 'object' && isPlain(s.properties);

/** The contract with the verdict asked for, when the step asks for one; else the contract as it was. */
export function withVerdict<C extends Contract>(contract: C, step: { reportOutcome?: unknown }): C {
    if (step.reportOutcome !== true) return contract;
    const schema = contract.effectiveSchema;
    if (objectSchema(schema)) {
        const next = { ...schema, properties: { ...schema.properties, [VERDICT_FIELD]: VERDICT_SCHEMA } };
        return { ...contract, effectiveSchema: next, outputContract: { ...contract.outputContract, schema: next } };
    }
    // A flat field map (`{ digest: 'string' }`, read as an object schema by ./aiStepEnum.js toToolParameters).
    const map = schema as Record<string, unknown> | null;
    if (isPlain(map) && !('type' in map) && !('properties' in map)) {
        const next: Schema = { ...map, [VERDICT_FIELD]: VERDICT_SCHEMA };
        return { ...contract, effectiveSchema: next, outputContract: { ...contract.outputContract, schema: next } };
    }
    if (schema) return contract; // a list or a scalar schema: nothing to add a field to
    const wrapped: Schema = {
        type: 'object',
        properties: { [ANSWER_FIELD]: { type: 'string', description: 'Your answer to the task, as you would write it.' }, [VERDICT_FIELD]: VERDICT_SCHEMA },
        required: [ANSWER_FIELD],
    };
    return {
        ...contract,
        inferred: { textField: ANSWER_FIELD },
        inferredFields: [ANSWER_FIELD],
        effectiveSchema: wrapped,
        outputContract: { ...contract.outputContract, schema: wrapped, declared: false },
        verdictWrapped: true,
    };
}

/** A verdict as the model gave it, cleaned; null when there is none that parses. */
export function verdictOf(value: unknown): Verdict | null {
    if (!isPlain(value)) return null;
    const outcome = typeof value.outcome === 'string' ? value.outcome.trim().toLowerCase() : '';
    if (!(OUTCOMES as readonly string[]).includes(outcome)) return null;
    const raw = typeof value.reason === 'string' ? value.reason.trim().replace(/\s+/g, ' ') : '';
    return { outcome: outcome as Outcome, reason: raw ? raw.slice(0, REASON_MAX) : null };
}

/** Take the verdict out of the step's answer: the output as downstream steps read it, and the verdict beside it. */
export function splitVerdict(output: unknown, contractIn: object): { output: unknown; verdict: Verdict | null } {
    const contract = contractIn as { verdictWrapped?: boolean };
    if (!isPlain(output) || !(VERDICT_FIELD in output || (contract.verdictWrapped && ANSWER_FIELD in output))) return { output, verdict: null };
    const { [VERDICT_FIELD]: raw, ...rest } = output;
    const verdict = verdictOf(raw);
    if (!contract.verdictWrapped) return { output: rest, verdict };
    const answer = rest[ANSWER_FIELD];
    return { output: typeof answer === 'string' ? answer : (answer ?? ''), verdict };
}

const RANK: Readonly<Record<Outcome, number>> = { nothing_to_do: 0, done: 1, failed: 2 };

/**
 * The verdict of a step that ran once per item: failed when one item failed, else done when one item had work, else
 * nothing to do.
 */
export function worstVerdict(verdicts: readonly Verdict[]): Verdict | null {
    let worst: Verdict | null = null;
    for (const v of verdicts) if (!worst || RANK[v.outcome] > RANK[worst.outcome]) worst = v;
    return worst;
}

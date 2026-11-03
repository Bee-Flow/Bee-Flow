/**
 * The approval decisions of a finished (or paused) journey, kept so the same
 * run can be played again: a golden replay, "restart with my answers" from the
 * builder (POST /:id/dry-run { answersFromRunId }). The sibling of
 * formAnswers.js, which keeps the form answers.
 *
 *   approvals = { [approvalStepId]: { decision: 'approve'|'reject', answers: { [field]: value } } }
 *
 * Where a decision lives: an approve (and a reject that continued on the
 * 'on_rejected' edge) is the OUTPUT of the approval's step row, injected by the
 * resume and recorded as a 'success' row in the leg that continued
 * (core/automationRunner/runContext.js recordResumeBoundary), in the one
 * approval output shape (automationModel/approvalOutput.mts). A reject that
 * ended the run closed the paused row as 'rejected'.
 *
 * What is kept, by the same rules as formAnswers.js: only the answers to
 * questions the approval declares, never an uploaded file or a record picked
 * from an app, never who decided, when or why (by, reason, decidedAt stay
 * behind). An output a dry run synthesised (nobody decided) is not a decision
 * and is left out, so a replay of it synthesises again and says so.
 *
 * Pure: reads the rows it is given, never writes, never fetches.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Field = { name: string; type?: string };
type ContractFns = {
    normalizeFields: (form: unknown) => Field[];
    isDisplayField: (f: Field) => boolean;
};

export type ApprovalAnswer = { decision: 'approve' | 'reject'; answers: Record<string, unknown> };
export type ApprovalAnswers = Record<string, ApprovalAnswer>;

type StepDef = { id?: unknown; type?: unknown; approval?: { fields?: unknown } | null };
type StepRow = { stepId?: unknown; parentStepId?: unknown; status?: unknown; output?: unknown };

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const UNKEPT_TYPES = new Set(['file', 'app_pick']);

function contract(): ContractFns {
    return nodeRequire('../formTriggerContract') as ContractFns;
}

/** The answers to the questions the approval declares; files and app picks left out. */
function keptAnswers(fields: unknown, answers: unknown): Record<string, unknown> {
    const kept: Record<string, unknown> = {};
    if (!isPlainObject(answers) || !Array.isArray(fields) || !fields.length) return kept;
    const { normalizeFields, isDisplayField } = contract();
    const declared = new Map(normalizeFields({ fields }).filter((f) => !isDisplayField(f)).map((f) => [f.name, f]));
    for (const key of Object.keys(answers)) {
        const field = declared.get(key);
        if (!field || key.startsWith('_') || UNKEPT_TYPES.has(String(field.type))) continue;
        kept[key] = answers[key];
    }
    return kept;
}

/** The decision a row records, or null when it records none. */
function decisionOf(step: StepDef, row: StepRow): ApprovalAnswer | null {
    if (row.status === 'rejected') return { decision: 'reject', answers: {} };
    if (row.status !== 'success' || !isPlainObject(row.output)) return null;
    const out = row.output;
    if (out._dryRunSynthesised === true || out._scenarioMissing === true || typeof out.approved !== 'boolean') return null;
    return {
        decision: out.approved ? 'approve' : 'reject',
        answers: keptAnswers(step.approval?.fields, out.answers),
    };
}

/**
 * @param input.definition  the definition the journey ran (its version)
 * @param input.steps       the rows of the whole journey (getRunStepsForChain), oldest leg first
 */
export function approvalAnswersFromJourney(input: { definition: unknown; steps: unknown }): ApprovalAnswers {
    const def = isPlainObject(input.definition) ? input.definition : {};
    const rows = (Array.isArray(input.steps) ? input.steps : []) as StepRow[];
    const out: ApprovalAnswers = {};
    for (const step of (Array.isArray(def.steps) ? def.steps : []) as StepDef[]) {
        if (!step || step.type !== 'approval' || typeof step.id !== 'string' || !step.id) continue;
        let found: ApprovalAnswer | null = null;
        // The last decided row wins: a later leg holds the latest decision.
        for (const row of rows) {
            if (!row || row.stepId !== step.id || row.parentStepId) continue;
            const decided = decisionOf(step, row);
            if (decided) found = decided;
        }
        if (found) out[step.id] = found;
    }
    return out;
}

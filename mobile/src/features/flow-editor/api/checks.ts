/**
 * Two read-outs about an automation the web builder shows beside its flow:
 *
 *   - POST /api/automation/:id/diagnose-trigger
 *     (routes/automation/diagnoseTrigger.js, mounted by runs.js; needs edit
 *     access): probes an app-event trigger's pipeline — the integration, the
 *     credentials, the subscription, a recent match — read-only. Each check
 *     is `ok | warn | error | skipped`, with an optional `detail`;
 *   - GET /api/compliance/ai-act/assessments/automation/:id
 *     (routes/compliance/aiAct.js): the AI Act self-declaration saved for the
 *     automation, the answers it was made from, and the signals the checks see.
 *     A 404 is "not deployed here / the compliance module is off" (the web's
 *     `absent`), not a failure.
 *
 * And one write: PUT on the same path with `{ answers }` — the three-question
 * ladder's declaration. The server recomputes the outcome from its own live
 * signals, stamps who and when, and answers the stored row.
 */

import { api, ApiError } from '@/core/api/client';
import { field, pick, shapeOf } from '@/core/api/contract';

import { flowPath } from './definition';

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skipped';

export interface TriggerCheck {
    name: string;
    status: CheckStatus;
    message: string;
    detail: unknown;
}

export interface TriggerDiagnosis {
    ok: boolean;
    kind: string;
    checks: TriggerCheck[];
}

const readCheck = shapeOf({
    name: field.str(''),
    status: field.oneOf<CheckStatus>(['ok', 'warn', 'error', 'skipped'], 'skipped'),
    message: field.str(''),
    detail: field.raw,
});

export const readDiagnosis: (raw: unknown) => TriggerDiagnosis = shapeOf({
    ok: field.bool(false),
    kind: field.str('unknown'),
    checks: field.list(readCheck),
});

export async function diagnoseTrigger(id: string): Promise<TriggerDiagnosis> {
    return readDiagnosis(await api.post<unknown>(`${flowPath(id)}/diagnose-trigger`, {}, { retry: false }));
}

export type AiActOutcome = 'not_applicable' | 'prohibited' | 'high_risk' | 'transparency' | 'minimal';

export interface AiActSignals {
    containsAi: boolean | null;
    customerFacing: boolean | null;
    generatesContent: boolean | null;
    /** The customer-facing text says it was made with AI (Art. 50(1)); null when unknown. */
    disclosurePresent: boolean | null;
    /** The org marks AI-generated content (Art. 50(2)); null when unknown. */
    markingEnabled: boolean | null;
    /** How many AI steps the checks counted; null when the server did not list them. */
    aiSteps: number | null;
    /** Their names, where they have one. */
    aiStepLabels: string[];
    /** Annex III domains the automation's own wording mentions: an ordering hint, never an answer. */
    annexHints: string[];
}

export type AiActYesNo = 'yes' | 'no';

/** The declaration's own answers, as far as the ladder reads them back. */
export interface AiActAnswers {
    art5: AiActYesNo | null;
    annexIii: AiActYesNo | null;
    /** The one area a row from before the ten questions named with its answer (`annex_iii.category`), or null. */
    annexCategory: string | null;
    /** The Annex III domains answered yes or no; an open one is absent. */
    annexDomains: Partial<Record<string, AiActYesNo>>;
}

export interface AiActAssessment {
    outcome: AiActOutcome | null;
    attestedAt: string | null;
    expiresAt: string | null;
    /** False once the declaration has lapsed (or was never made). */
    current: boolean;
    signals: AiActSignals;
    /** Null until a declaration was made. */
    answers: AiActAnswers | null;
}

/** What the ladder sends (the web's ladderOutcome.toAnswers): PUT … `{ answers }`. */
export interface AiActAnswersBody {
    art5: { answer: AiActYesNo | null; practices: string[] };
    art50: { interacts: boolean | null; disclosure: boolean | null; generates: boolean | null; marking: boolean | null };
    annex_iii: { answer: AiActYesNo | null; category: string | null; domains: Partial<Record<string, AiActYesNo>> };
}

const tri = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const yesNo = field.oneOfOrNull<AiActYesNo>(['yes', 'no']);

function readSignals(raw: unknown): AiActSignals {
    const ai = pick(pick(raw, 'steps'), 'ai');
    const questions = pick(raw, 'annex_iii_questions');
    return {
        containsAi: tri(pick(raw, 'contains_ai')),
        customerFacing: tri(pick(raw, 'customer_facing')),
        generatesContent: tri(pick(raw, 'generates_content')),
        disclosurePresent: tri(pick(raw, 'disclosure_present')),
        markingEnabled: tri(pick(raw, 'marking_enabled')),
        aiSteps: Array.isArray(ai) ? ai.length : null,
        aiStepLabels: Array.isArray(ai) ? ai.map((s) => field.str('')(pick(s, 'label'))).filter(Boolean) : [],
        annexHints: Array.isArray(questions)
            ? questions.filter((q) => pick(q, 'hint') === true).map((q) => field.str('')(pick(q, 'id'))).filter(Boolean)
            : [],
    };
}

function readDomains(raw: unknown): Partial<Record<string, AiActYesNo>> {
    const out: Partial<Record<string, AiActYesNo>> = {};
    for (const [id, value] of Object.entries(field.recordOrNull(raw) ?? {})) {
        const answer = yesNo(value);
        if (answer) out[id] = answer;
    }
    return out;
}

function readAnswers(raw: unknown): AiActAnswers | null {
    if (!field.recordOrNull(raw)) return null;
    const annex = pick(raw, 'annex_iii');
    return {
        art5: yesNo(pick(pick(raw, 'art5'), 'answer')),
        annexIii: yesNo(pick(annex, 'answer')),
        annexCategory: field.strOrNull(pick(annex, 'category')),
        annexDomains: readDomains(pick(annex, 'domains')),
    };
}

export function readAssessment(raw: unknown): AiActAssessment {
    return {
        outcome: field.oneOfOrNull<AiActOutcome>(['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal'])(pick(raw, 'outcome')),
        attestedAt: field.strOrNull(pick(raw, 'attested_at')),
        expiresAt: field.strOrNull(pick(raw, 'expires_at')),
        current: field.bool(false)(pick(raw, 'current')),
        signals: readSignals(pick(raw, 'signals')),
        answers: readAnswers(pick(raw, 'answers')),
    };
}

const assessmentPath = (id: string) => `/api/compliance/ai-act/assessments/automation/${encodeURIComponent(id)}`;

/** The saved assessment, or null where the compliance routes are not there (404). */
export async function getAiActAssessment(id: string): Promise<AiActAssessment | null> {
    try {
        return readAssessment(await api.get<unknown>(assessmentPath(id)));
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
    }
}

/** Record the ladder's answers as a self-declaration; answers the stored row. Never retried: each PUT stamps a new one. */
export async function saveAiActAssessment(id: string, answers: AiActAnswersBody): Promise<AiActAssessment> {
    return readAssessment(await api.put<unknown>(assessmentPath(id), { answers }, { retry: false }));
}

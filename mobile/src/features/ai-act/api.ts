/**
 * The AI Act declaration for an agent or an automation (routes/compliance/aiAct.js):
 *
 *   - GET  /api/compliance/ai-act/assessments            every saved declaration (Systems);
 *   - GET  /api/compliance/ai-act/assessments/:kind/:id  the saved declaration, its answers
 *          and the signals the checks see. A 404 is "not deployed here / the compliance
 *          module is off" (the web's `absent`), not a failure;
 *   - GET  …/:kind/:id/signals                           the live signals alone;
 *   - PUT  …/:kind/:id `{ answers }`                     the ladder's declaration. The server
 *          recomputes the outcome from its own signals, stamps who and when, and answers the row;
 *   - PUT  /api/compliance/settings                      the ladder's "Enable marking".
 */

import { api, ApiError } from '@/core/api/client';
import { field, pick, shapeListOf } from '@/core/api/contract';

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
    /** How many steps the target has, where the server says (the web subtitle's '{n} steps'). */
    stepCount?: number | null;
    /** The customer-facing surface ('form', 'published_agent', 'webpage', …), where the server says. */
    surface?: string | null;
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
const readOutcome = field.oneOfOrNull<AiActOutcome>(['not_applicable', 'prohibited', 'high_risk', 'transparency', 'minimal']);

export function readSignals(raw: unknown): AiActSignals {
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
        stepCount: typeof pick(raw, 'step_count') === 'number' ? (pick(raw, 'step_count') as number) : null,
        surface: field.strOrNull(pick(raw, 'surface')),
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
        outcome: readOutcome(pick(raw, 'outcome')),
        attestedAt: field.strOrNull(pick(raw, 'attested_at')),
        expiresAt: field.strOrNull(pick(raw, 'expires_at')),
        current: field.bool(false)(pick(raw, 'current')),
        signals: readSignals(pick(raw, 'signals')),
        answers: readAnswers(pick(raw, 'answers')),
    };
}

export type AiActKind = 'agent' | 'automation';

/** One row of the Systems list (GET /ai-act/assessments). */
export interface AiActAssessmentRow {
    kind: AiActKind;
    id: string;
    title: string | null;
    outcome: AiActOutcome | null;
    attestedAt: string | null;
    expiresAt: string | null;
    current: boolean;
}

const readRows = shapeListOf({
    target_kind: field.oneOf<AiActKind>(['agent', 'automation'], 'automation'),
    target_id: (v: unknown) => (typeof v === 'number' ? String(v) : field.str('')(v)),
    title: field.strOrNull,
    outcome: readOutcome,
    attested_at: field.strOrNull,
    expires_at: field.strOrNull,
    current: field.bool(false),
});

export function readAssessmentRows(raw: unknown): AiActAssessmentRow[] {
    return readRows(raw)
        .filter((r) => r.target_id !== '')
        .map((r) => ({
            kind: r.target_kind,
            id: r.target_id,
            title: r.title,
            outcome: r.outcome,
            attestedAt: r.attested_at,
            expiresAt: r.expires_at,
            current: r.current,
        }));
}

const BASE = '/api/compliance/ai-act/assessments';
const assessmentPath = (kind: AiActKind, id: string) => `${BASE}/${kind}/${encodeURIComponent(id)}`;

async function orNullOn404<T>(load: () => Promise<T>): Promise<T | null> {
    try {
        return await load();
    } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
    }
}

/** Every saved declaration in the org: the Systems list. */
export async function listAiActAssessments(): Promise<AiActAssessmentRow[]> {
    return readAssessmentRows(await api.get<unknown>(BASE));
}

/** The saved assessment, or null where the compliance routes are not there (404). */
export async function getAiActAssessment(kind: AiActKind, id: string): Promise<AiActAssessment | null> {
    return orNullOn404(async () => readAssessment(await api.get<unknown>(assessmentPath(kind, id))));
}

/** The live signals alone (after a setting changed), or null on a 404. */
export async function getAiActSignals(kind: AiActKind, id: string): Promise<AiActSignals | null> {
    return orNullOn404(async () => readSignals(await api.get<unknown>(`${assessmentPath(kind, id)}/signals`)));
}

/** Record the ladder's answers as a self-declaration; answers the stored row. Never retried: each PUT stamps a new one. */
export async function saveAiActAssessment(kind: AiActKind, id: string, answers: AiActAnswersBody): Promise<AiActAssessment> {
    return readAssessment(await api.put<unknown>(assessmentPath(kind, id), { answers }, { retry: false }));
}

/** Art. 50(2): switch the org's AI content marking on (PUT /api/compliance/settings). */
export async function enableMarking(): Promise<void> {
    await api.put<unknown>('/api/compliance/settings', { ai_content_marking_enabled: true }, { retry: false });
}

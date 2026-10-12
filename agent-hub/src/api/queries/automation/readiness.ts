// "Ready to activate?" and the AI Act check of one automation: the ONLY place
// that knows the wire contract of GET /:id/readiness, GET /:id/ai-act,
// GET /:id/ai-act/suggestion and PUT /:id/ai-act (routes/automation/aiAct.js,
// handoff 5 package S4). The automatic check (GET /:id/ai-act/check, PUT
// /:id/ai-act/answers) is in aiActCheck.ts.
// The requests themselves go through ./http.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AutomationRequestError, getAutomationJson, putAutomationJson } from './http';

export type AiActStatus = 'not_required' | 'missing' | 'valid' | 'expired' | 'outdated' | 'prohibited';
export type Tri = 'yes' | 'no' | 'unknown';

export interface Readiness {
    stepsComplete: { ok: boolean; issues: number; firstIssue: { code: string; path: string | null; message: string } | null };
    lastTest: { ok: boolean; at: string | null } | null;
    aiAct: { required: boolean; status: AiActStatus; expiresAt: string | null; outcome: string | null };
    description: { ok: boolean };
    canActivate: boolean;
}

/** The three wizard questions, in order (server ids). */
export const AI_ACT_QUESTIONS = ['usesAi', 'externalOutput', 'sensitiveUse'] as const;
export type AiActQuestion = typeof AI_ACT_QUESTIONS[number];

/** The ten Annex III areas (compliance/aiAct/annexIii.js). */
export const ANNEX_III_DOMAINS = [
    'biometrics', 'critical_infrastructure', 'education', 'employment', 'essential_services',
    'credit', 'insurance', 'law_enforcement', 'migration', 'justice',
] as const;
export type AnnexDomainId = typeof ANNEX_III_DOMAINS[number];

/** What PUT /:id/ai-act takes and GET /:id/ai-act reads back. */
export interface AiActAnswers {
    usesAi: Tri;
    externalOutput: Tri;
    sensitiveUse: Tri;
    domains: AnnexDomainId[];
}

/** One "why Bee thinks this": translate by code, `text` is the English fallback. */
export interface AiActReason { code: string; params: Record<string, unknown>; text: string }

export interface AiActDomain { id: AnnexDomainId; article: string; hint: boolean }

export interface AiActSuggestion {
    /** Bee's answer per question; sensitiveUse is never prefilled (null). */
    suggested: Record<AiActQuestion, Tri | null>;
    reasons: Record<AiActQuestion, AiActReason[]>;
    /** All ten areas, the ones the text hints at first. */
    domains: AiActDomain[];
    /** False when there is no AI: question 3 then does not change the outcome. */
    sensitiveApplicable: boolean;
    /** The answers recorded last time, if any. */
    previous: AiActAnswers | null;
}

export interface AiActState {
    required: boolean;
    status: AiActStatus;
    expiresAt: string | null;
    outcome: string | null;
    attestedAt: string | null;
    answers: AiActAnswers | null;
    canEdit: boolean;
}

export const automationReadinessKeys = {
    readiness: (id: string) => ['automation-readiness', id] as const,
    suggestion: (id: string) => ['automation-readiness', 'ai-act-suggestion', id] as const,
    /** The automatic check (aiActCheck.ts); the automation's stamp follows it. */
    check: (id: string) => ['automation-readiness', 'ai-act-check', id] as const,
};

function obj(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function str(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}
function dateOrNull(v: unknown): string | null {
    return typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? v : null;
}
function tri(v: unknown): Tri {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    return v === 'yes' || v === 'no' ? v : 'unknown';
}
function isDomain(v: unknown): v is AnnexDomainId {
    return ANNEX_III_DOMAINS.includes(v as AnnexDomainId);
}

const STATUSES: readonly AiActStatus[] = ['not_required', 'missing', 'valid', 'expired', 'outdated', 'prohibited'];
const statusOf = (v: unknown): AiActStatus => (STATUSES.includes(v as AiActStatus) ? v as AiActStatus : 'not_required');

/** Normalise GET /:id/readiness. Exported for the test; tolerant of junk. */
export function parseReadiness(body: unknown): Readiness {
    const raw = obj(body);
    const steps = obj(raw.stepsComplete);
    const test = raw.lastTest && typeof raw.lastTest === 'object' ? obj(raw.lastTest) : null;
    const ai = obj(raw.aiAct);
    const issues = typeof steps.issues === 'number' ? steps.issues
        : (Array.isArray(steps.issues) ? steps.issues.length : 0);
    const first = steps.firstIssue && typeof steps.firstIssue === 'object' ? obj(steps.firstIssue) : null;
    return {
        stepsComplete: {
            ok: steps.ok === true,
            issues,
            firstIssue: first ? { code: str(first.code) || '', path: str(first.path), message: str(first.message) || '' } : null,
        },
        lastTest: test ? { ok: test.ok === true, at: dateOrNull(test.at) } : null,
        aiAct: {
            required: ai.required === true,
            status: statusOf(ai.status),
            expiresAt: dateOrNull(ai.expiresAt),
            outcome: str(ai.outcome),
        },
        description: { ok: obj(raw.description).ok === true },
        canActivate: raw.canActivate === true,
    };
}

function parseAnswers(v: unknown): AiActAnswers | null {
    if (!v || typeof v !== 'object') return null;
    const o = obj(v);
    return {
        usesAi: tri(o.usesAi),
        externalOutput: tri(o.externalOutput),
        sensitiveUse: tri(o.sensitiveUse),
        domains: Array.isArray(o.domains) ? o.domains.filter(isDomain) : [],
    };
}

function parseReasons(v: unknown): AiActReason[] {
    if (!Array.isArray(v)) return [];
    return v.map(obj).filter(r => str(r.code)).map(r => ({ code: str(r.code) as string, params: obj(r.params), text: str(r.text) || '' }));
}

/** Normalise GET /:id/ai-act/suggestion (`{ questions: [{ id, suggested, reasons }], previous }`). */
export function parseSuggestion(body: unknown): AiActSuggestion {
    const raw = obj(body);
    const questions = (Array.isArray(raw.questions) ? raw.questions : []).map(obj);
    const byId = (id: AiActQuestion) => questions.find(q => q.id === id) || {};
    const suggested = {} as AiActSuggestion['suggested'];
    const reasons = {} as AiActSuggestion['reasons'];
    for (const id of AI_ACT_QUESTIONS) {
        const q = byId(id);
        suggested[id] = q.suggested === 'yes' || q.suggested === 'no' ? q.suggested : null;
        reasons[id] = parseReasons(q.reasons);
    }
    const sensitive = byId('sensitiveUse');
    const listed = (Array.isArray(sensitive.domains) ? sensitive.domains : []).map(obj)
        .filter(d => isDomain(d.id))
        .map(d => ({ id: d.id as AnnexDomainId, article: str(d.article) || '', hint: d.hint === true }));
    // Always all ten, even from a server that sent fewer.
    const domains = [...listed, ...ANNEX_III_DOMAINS.filter(id => !listed.some(d => d.id === id)).map(id => ({ id, article: '', hint: false }))];
    return {
        suggested,
        reasons,
        domains,
        sensitiveApplicable: sensitive.applicable !== false,
        previous: parseAnswers(raw.previous),
    };
}

/** Normalise the AiActState of GET/PUT /:id/ai-act. */
export function parseAiActState(body: unknown): AiActState {
    const raw = obj(body);
    return {
        required: raw.required === true,
        status: statusOf(raw.status),
        expiresAt: dateOrNull(raw.expiresAt),
        outcome: str(raw.outcome),
        attestedAt: dateOrNull(raw.attestedAt),
        answers: parseAnswers(raw.answers),
        canEdit: raw.canEdit === true,
    };
}

/** The PUT body: domains only travel with a "yes" (the server ignores them otherwise). */
export function answersToBody(a: AiActAnswers): Record<string, unknown> {
    return {
        usesAi: a.usesAi,
        externalOutput: a.externalOutput,
        sensitiveUse: a.sensitiveUse,
        ...(a.sensitiveUse === 'yes' ? { domains: a.domains } : {}),
    };
}

export async function fetchReadiness(id: string, signal?: AbortSignal): Promise<Readiness> {
    return parseReadiness(await getAutomationJson(id, '/readiness', 'readiness', signal));
}

export async function fetchAiActSuggestion(id: string, signal?: AbortSignal): Promise<AiActSuggestion> {
    return parseSuggestion(await getAutomationJson(id, '/ai-act/suggestion', 'ai act suggestion', signal));
}

export async function saveAiActCheck(id: string, answers: AiActAnswers): Promise<AiActState> {
    return parseAiActState(await putAutomationJson(id, '/ai-act', answersToBody(answers), 'ai act check'));
}

/**
 * The key part that makes the checklist follow a save: the working version
 * (steps), the row's updatedAt (any save) and whether there is a description
 * (a description save does not bump the version). Every reader uses it, so
 * the page, the section and the rail share ONE cached answer.
 */
export function readinessStamp(a: { version?: unknown; updatedAt?: unknown; description?: unknown } | null | undefined): string {
    if (!a) return '';
    const described = typeof a.description === 'string' && a.description.trim() ? 1 : 0;
    return `${String(a.version ?? '')}|${String(a.updatedAt ?? '')}|${described}`;
}

export function useReadiness(id: string | null | undefined, stamp = '') {
    return useQuery({
        queryKey: [...automationReadinessKeys.readiness(id || ''), stamp],
        queryFn: ({ signal }) => fetchReadiness(id as string, signal),
        enabled: !!id,
        staleTime: 15_000,
        retry: false,
        placeholderData: (prev) => prev,
    });
}

export function useAiActSuggestion(id: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
    return useQuery({
        queryKey: automationReadinessKeys.suggestion(id || ''),
        queryFn: ({ signal }) => fetchAiActSuggestion(id as string, signal),
        enabled: !!id && enabled,
        staleTime: 60_000,
        retry: false,
    });
}

export function useSaveAiActCheck(id: string, { onDone }: { onDone?: (s: AiActState) => void } = {}) {
    const qc = useQueryClient();
    return useMutation<AiActState, AutomationRequestError, AiActAnswers>({
        mutationFn: (answers) => saveAiActCheck(id, answers),
        onSuccess: (s) => {
            void qc.invalidateQueries({ queryKey: automationReadinessKeys.readiness(id) });
            void qc.invalidateQueries({ queryKey: automationReadinessKeys.suggestion(id) });
            void qc.invalidateQueries({ queryKey: automationReadinessKeys.check(id) });
            onDone?.(s);
        },
    });
}

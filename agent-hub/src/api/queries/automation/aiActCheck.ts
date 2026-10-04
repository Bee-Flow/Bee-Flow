// The AI Act check that does itself (routes/automation/aiAct.js,
// automation/aiActAuto.js): the ONLY place that knows the wire contract of
// GET /:id/ai-act/check and PUT /:id/ai-act/answers.
//
// Bee answers every question it can and records the check by itself; what it
// cannot tell comes back as `questions`, and only those are asked. The same
// questions travel with a 409 `ai_act_check_required` from Activate / Make
// live, which is why the dialog there reads this hook too.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type AutomationRequestError, getAutomationJson, putAutomationJson } from './http';
import {
    ANNEX_III_DOMAINS, automationReadinessKeys,
    type AiActDomain, type AiActStatus, type AnnexDomainId, type Tri,
} from './readiness';

export const AI_ACT_CHECK_QUESTIONS = ['usesAi', 'externalOutput', 'sensitiveUse', 'prohibitedUse'] as const;
export type AiActCheckQuestion = typeof AI_ACT_CHECK_QUESTIONS[number];
export type AiActConfidence = 'certain' | 'likely' | 'unknown';
export type AiActSource = 'auto' | 'mixed' | 'manual';

/** One line of "why": translate by code, `text` is the English fallback. */
export interface AiActEvidence { code: string; params: Record<string, unknown>; text: string }

/** What was answered per question, by whom, and why. */
export interface AiActFinding {
    id: AiActCheckQuestion;
    answer: Tri;
    confidence: AiActConfidence;
    by: 'bee' | 'person' | 'open';
    evidence: AiActEvidence[];
    domains: AnnexDomainId[];
    practices: string[];
}

/** A question Bee could not answer. `suggested` is preselected only when `confidence` is 'likely'. */
export interface AiActOpenQuestion {
    id: AiActCheckQuestion;
    confidence: AiActConfidence;
    suggested: 'yes' | 'no' | null;
    evidence: AiActEvidence[];
    /** sensitiveUse: all ten areas, hinted first. */
    domains: AiActDomain[];
    suggestedDomains: AnnexDomainId[];
    /** prohibitedUse: the practices Bee thinks it may be. */
    practices: string[];
}

export interface AiActCheckResult {
    required: boolean;
    status: AiActStatus;
    expiresAt: string | null;
    outcome: string | null;
    attestedAt: string | null;
    attestedBy: string | null;
    source: AiActSource | null;
    canEdit: boolean;
    /** This call recorded a new check. */
    recorded: boolean;
    findings: AiActFinding[];
    questions: AiActOpenQuestion[];
}

/** What PUT /:id/ai-act/answers takes: only the questions being answered. */
export interface AiActAnswerBody {
    usesAi?: Tri;
    externalOutput?: Tri;
    sensitiveUse?: Tri;
    prohibitedUse?: Tri;
    domains?: AnnexDomainId[];
    practices?: string[];
}

function obj(v: unknown): Record<string, unknown> {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function str(v: unknown): string | null { return typeof v === 'string' && v ? v : null; }
function list(v: unknown): unknown[] { return Array.isArray(v) ? v : []; }
function dateOrNull(v: unknown): string | null { return typeof v === 'string' && v && !Number.isNaN(Date.parse(v)) ? v : null; }
function tri(v: unknown): Tri { return v === 'yes' || v === 'no' ? v : 'unknown'; }
function isQuestion(v: unknown): v is AiActCheckQuestion { return AI_ACT_CHECK_QUESTIONS.includes(v as AiActCheckQuestion); }
function isDomain(v: unknown): v is AnnexDomainId { return ANNEX_III_DOMAINS.includes(v as AnnexDomainId); }
function confidence(v: unknown): AiActConfidence { return v === 'certain' || v === 'likely' ? v : 'unknown'; }
const STATUSES: readonly AiActStatus[] = ['not_required', 'missing', 'valid', 'expired', 'outdated', 'prohibited'];
const SOURCES: readonly AiActSource[] = ['auto', 'mixed', 'manual'];

function parseEvidence(v: unknown): AiActEvidence[] {
    return list(v).map(obj).filter(e => str(e.code)).map(e => ({ code: str(e.code) as string, params: obj(e.params), text: str(e.text) || '' }));
}
const strings = (v: unknown) => list(v).filter((x): x is string => typeof x === 'string');

/** Normalise a check answer. Exported for the test; tolerant of junk. */
export function parseAiActCheck(body: unknown): AiActCheckResult {
    const raw = obj(body);
    const findings = list(raw.findings).map(obj).filter(f => isQuestion(f.id)).map(f => ({
        id: f.id as AiActCheckQuestion,
        answer: tri(f.answer),
        confidence: confidence(f.confidence),
        by: (f.by === 'person' || f.by === 'open' ? f.by : 'bee') as AiActFinding['by'],
        evidence: parseEvidence(f.evidence),
        domains: strings(f.domains).filter(isDomain),
        practices: strings(f.practices),
    }));
    const questions = list(raw.questions).map(obj).filter(q => isQuestion(q.id)).map(q => {
        const listed = list(q.domains).map(obj).filter(d => isDomain(d.id))
            .map(d => ({ id: d.id as AnnexDomainId, article: str(d.article) || '', hint: d.hint === true }));
        return {
            id: q.id as AiActCheckQuestion,
            confidence: confidence(q.confidence),
            suggested: (q.suggested === 'yes' || q.suggested === 'no' ? q.suggested : null) as AiActOpenQuestion['suggested'],
            evidence: parseEvidence(q.evidence),
            domains: q.id === 'sensitiveUse'
                ? [...listed, ...ANNEX_III_DOMAINS.filter(id => !listed.some(d => d.id === id)).map(id => ({ id, article: '', hint: false }))]
                : [],
            suggestedDomains: strings(q.suggestedDomains).filter(isDomain),
            practices: strings(q.practices),
        };
    });
    return {
        required: raw.required === true,
        status: STATUSES.includes(raw.status as AiActStatus) ? raw.status as AiActStatus : 'not_required',
        expiresAt: dateOrNull(raw.expiresAt),
        outcome: str(raw.outcome),
        attestedAt: dateOrNull(raw.attestedAt),
        attestedBy: str(raw.attestedBy),
        source: SOURCES.includes(raw.source as AiActSource) ? raw.source as AiActSource : null,
        canEdit: raw.canEdit === true,
        recorded: raw.recorded === true,
        findings,
        questions,
    };
}

export async function fetchAiActCheck(id: string, signal?: AbortSignal): Promise<AiActCheckResult> {
    return parseAiActCheck(await getAutomationJson(id, '/ai-act/check', 'ai act check', signal));
}

export async function answerAiAct(id: string, answers: AiActAnswerBody): Promise<AiActCheckResult> {
    return parseAiActCheck(await putAutomationJson(id, '/ai-act/answers', answers, 'ai act answers'));
}

/**
 * Bee checks the automation. `stamp` is readinessStamp(automation): a save asks
 * again. When the check recorded something, the checklist is refetched.
 * `fresh` asks again on every mount (the Activate dialog).
 */
export function useAiActCheck(id: string | null | undefined, stamp = '', { enabled = true, fresh = false }: { enabled?: boolean; fresh?: boolean } = {}) {
    const qc = useQueryClient();
    return useQuery({
        queryKey: [...automationReadinessKeys.check(id || ''), stamp],
        queryFn: async ({ signal }) => {
            const r = await fetchAiActCheck(id as string, signal);
            if (r.recorded) void qc.invalidateQueries({ queryKey: automationReadinessKeys.readiness(id as string) });
            return r;
        },
        enabled: !!id && enabled,
        staleTime: fresh ? 0 : 30_000,
        refetchOnMount: fresh ? 'always' : true,
        retry: false,
        placeholderData: (prev) => prev,
    });
}

/** Answer the open questions; the answer is the new check, shared with every reader. */
export function useAnswerAiAct(id: string, { onDone }: { onDone?: (r: AiActCheckResult) => void } = {}) {
    const qc = useQueryClient();
    return useMutation<AiActCheckResult, AutomationRequestError, AiActAnswerBody>({
        mutationFn: (answers) => answerAiAct(id, answers),
        onSuccess: (r) => {
            qc.setQueriesData({ queryKey: automationReadinessKeys.check(id) }, r);
            void qc.invalidateQueries({ queryKey: automationReadinessKeys.readiness(id) });
            void qc.invalidateQueries({ queryKey: automationReadinessKeys.suggestion(id) });
            onDone?.(r);
        },
    });
}

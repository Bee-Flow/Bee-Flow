// "Your own data" test bench: the ONLY place that knows the
// /api/org-privacy-shield/:orgId/custom-data/* wire contract.
//
// Four POST routes. The preview is a read (it calls no model and has no side
// effect), so it is a query keyed on exactly what it would send: when the
// name, the description or an example changes, the card re-asks, and the
// assistant can never be shown one thing and sent another. The other three
// are mutations.
//
// Every response goes through an allow-list parser: fields are copied by
// name, junk reads as the empty state, and nothing the server adds later
// reaches a component by accident.
//
// Errors carry the server's `code` (see core/http/errors.js, whose terminal
// handler answers `{ error, code, details?, correlationId }`), never its
// sentence: the components word each code themselves.

import { useMutation, useQuery } from '@tanstack/react-query';
import type {
    CustomDataType, Method, Sentence, SentenceOrigin, Span, Summary, WordsSpec,
} from '../../components/admin/security/guardrails/orgShield/ownData/ownDataModel';
import { API_BASE, authFetch } from '../../utils/helpers';

export type CustomDataErrorCode =
    | 'invalid_request' | 'not_org_admin' | 'feature_locked' | 'preview_stale'
    | 'assist_personal_data' | 'pattern_unsafe' | 'assist_no_usable_output'
    | 'assist_check_unavailable' | 'no_assist_model' | 'assist_failed'
    | 'guard_unavailable' | 'tune_needs_gold' | 'rate_limited' | 'network' | 'unknown';

const KNOWN_CODES = new Set<string>([
    'invalid_request', 'not_org_admin', 'feature_locked', 'preview_stale',
    'assist_personal_data', 'pattern_unsafe', 'assist_no_usable_output',
    'assist_check_unavailable', 'no_assist_model', 'assist_failed',
    'guard_unavailable', 'tune_needs_gold',
]);

export interface PersonalDataFinding { field: string; start: number; end: number; category: string }

export class CustomDataError extends Error {
    code: CustomDataErrorCode;
    status: number;
    findings: PersonalDataFinding[];
    reason: string | null;
    constructor(code: CustomDataErrorCode, status = 0, extra: { findings?: PersonalDataFinding[]; reason?: string | null } = {}) {
        super(code);
        this.name = 'CustomDataError';
        this.code = code;
        this.status = status;
        this.findings = extra.findings || [];
        this.reason = extra.reason ?? null;
    }
}

export function customDataErrorCode(e: unknown): CustomDataErrorCode {
    return e instanceof CustomDataError ? e.code : 'network';
}

// ── Allow-list parsers ──────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const METHODS = new Set<string>(['words', 'pattern', 'ai']);
const ORIGINS = new Set<string>(['assistant', 'nearmiss', 'own', 'feedback']);
const MARK_KINDS = new Set<string>(['hit', 'missed', 'false_alarm', 'found']);

function spans(v: unknown): Span[] {
    if (!Array.isArray(v)) return [];
    return v.filter(isObj)
        .map(s => ({ start: num(s.start), end: num(s.end) }))
        .filter(s => s.end > s.start);
}

function sentences(v: unknown, fallback: SentenceOrigin): Sentence[] {
    if (!Array.isArray(v)) return [];
    return v.filter(isObj)
        .filter(s => str(s.id) && str(s.text))
        .map(s => ({
            id: str(s.id),
            text: str(s.text),
            // Absent and empty mean different things: no `gold` is "not
            // marked yet", `[]` is "nothing should be hidden" (a near miss).
            ...(Array.isArray(s.gold) ? { gold: spans(s.gold) } : {}),
            origin: (ORIGINS.has(str(s.origin)) ? str(s.origin) : fallback) as SentenceOrigin,
        }));
}

function summary(v: unknown): Summary {
    const s = isObj(v) ? v : {};
    return { found: num(s.found), total: num(s.total), falseAlarms: num(s.falseAlarms), sentences: num(s.sentences) };
}

export interface Outbound { name: string; description: string; lookalikes: string[] }
export interface AssistPreview { outbound: Outbound; keepFixedProposal: string[] }

function outbound(v: unknown): Outbound {
    const o = isObj(v) ? v : {};
    return { name: str(o.name), description: str(o.description), lookalikes: strings(o.lookalikes) };
}

export function parsePreview(body: unknown): AssistPreview {
    const b = isObj(body) ? body : {};
    return { outbound: outbound(b.outbound), keepFixedProposal: strings(b.keepFixedProposal) };
}

export interface AssistResult {
    outbound: Outbound;
    suggestedMethod: Method | null;
    sentences: Sentence[];
    nearMisses: Sentence[];
    candidates: { patterns: { source: string; describe: string }[]; aiLabels: string[] };
}

export function parseAssist(body: unknown): AssistResult {
    const b = isObj(body) ? body : {};
    const c = isObj(b.candidates) ? b.candidates : {};
    return {
        outbound: outbound(b.outbound),
        suggestedMethod: METHODS.has(str(b.suggestedMethod)) ? str(b.suggestedMethod) as Method : null,
        sentences: sentences(b.sentences, 'assistant'),
        nearMisses: sentences(b.nearMisses, 'nearmiss'),
        candidates: {
            patterns: (Array.isArray(c.patterns) ? c.patterns : []).filter(isObj)
                .map(p => ({ source: str(p.source), describe: str(p.describe) }))
                .filter(p => p.source),
            aiLabels: strings(c.aiLabels),
        },
    };
}

export interface TestMark extends Span { kind: 'hit' | 'missed' | 'false_alarm' | 'found'; partial?: boolean }
export interface TestResult {
    results: { id: string; marks: TestMark[] }[];
    summary: Summary;
    preview: string | null;
    engine: 'local' | 'guard';
    /** The matcher ran only partly (a timeout, a failed part): the result may be incomplete. */
    degraded: boolean;
}

export function parseTest(body: unknown): TestResult {
    const b = isObj(body) ? body : {};
    const results = (Array.isArray(b.results) ? b.results : []).filter(isObj).map(r => ({
        id: str(r.id),
        marks: (Array.isArray(r.marks) ? r.marks : []).filter(isObj)
            .filter(m => MARK_KINDS.has(str(m.kind)) && num(m.end) > num(m.start))
            .map(m => ({
                start: num(m.start),
                end: num(m.end),
                kind: str(m.kind) as TestMark['kind'],
                ...(m.partial === true ? { partial: true } : {}),
            })),
    })).filter(r => r.id);
    return {
        results,
        summary: summary(b.summary),
        preview: typeof b.preview === 'string' ? b.preview : null,
        engine: b.engine === 'guard' ? 'guard' : 'local',
        degraded: b.degraded === true,
    };
}

export type Sensitivity = 'low' | 'medium' | 'high';
export interface TuneResult {
    best: {
        config: Pick<CustomDataType, 'words' | 'pattern' | 'ai'>;
        summary: Summary;
        describe: { label: string | null; sensitivity: Sensitivity | null; patternWords: string | null; wholeWord: boolean | null; caseSensitive: boolean | null };
    };
    before: { summary: Summary };
    improved: boolean;
    tried: number;
}

/** `describe.flags` is either a list of flag names or an object of booleans. */
function flag(flags: unknown, name: 'wholeWord' | 'caseSensitive', alias: string): boolean | null {
    if (Array.isArray(flags)) return flags.includes(name) || flags.includes(alias);
    if (isObj(flags) && typeof flags[name] === 'boolean') return flags[name] as boolean;
    return null;
}

function tuneConfig(v: unknown): TuneResult['best']['config'] {
    const c = isObj(v) ? v : {};
    const out: TuneResult['best']['config'] = {};
    if (isObj(c.words)) {
        // Tuning a list changes its flags; `values` only rides along when the
        // server sends it, so a flags-only answer never empties the list.
        out.words = {
            ...(Array.isArray(c.words.values) ? { values: strings(c.words.values) } : {}),
            caseSensitive: c.words.caseSensitive === true,
            wholeWord: c.words.wholeWord !== false,
        } as WordsSpec;
    }
    if (isObj(c.pattern) && str(c.pattern.source)) {
        out.pattern = { source: str(c.pattern.source), caseSensitive: c.pattern.caseSensitive === true };
    }
    if (isObj(c.ai) && str(c.ai.prompt)) out.ai = { prompt: str(c.ai.prompt), floor: num(c.ai.floor) || 0.5 };
    return out;
}

export function parseTune(body: unknown): TuneResult {
    const b = isObj(body) ? body : {};
    const best = isObj(b.best) ? b.best : {};
    const d = isObj(best.describe) ? best.describe : {};
    const sens = str(d.sensitivity);
    return {
        best: {
            config: tuneConfig(best.config),
            summary: summary(best.summary),
            describe: {
                label: str(d.label) || null,
                sensitivity: sens === 'low' || sens === 'medium' || sens === 'high' ? sens : null,
                patternWords: str(d.patternWords) || null,
                wholeWord: flag(d.flags, 'wholeWord', 'whole_word'),
                caseSensitive: flag(d.flags, 'caseSensitive', 'case_sensitive'),
            },
        },
        before: { summary: summary(isObj(b.before) ? b.before.summary : null) },
        improved: b.improved === true,
        tried: num(b.tried),
    };
}

// ── Transport ───────────────────────────────────────────────────────────

function errorFrom(status: number, body: unknown): CustomDataError {
    const b = isObj(body) ? body : {};
    const details = isObj(b.details) ? b.details : b;
    const raw = str(b.code);
    let code: CustomDataErrorCode = KNOWN_CODES.has(raw) ? raw as CustomDataErrorCode : 'unknown';
    if (code === 'unknown' && status === 429) code = 'rate_limited';
    const findings = (Array.isArray(details.findings) ? details.findings : []).filter(isObj).map(f => ({
        field: str(f.field), start: num(f.start), end: num(f.end), category: str(f.category),
    }));
    return new CustomDataError(code, status, { findings, reason: str(details.reason) || null });
}

async function post(orgId: string, path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let res: Response;
    try {
        res = await authFetch(`${API_BASE}/api/org-privacy-shield/${encodeURIComponent(orgId)}/custom-data/${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal,
        });
    } catch {
        throw new CustomDataError('network');
    }
    let data: unknown = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) throw errorFrom(res.status, data);
    return data;
}

/** What the assistant card shows and the preview/assist routes receive. */
export interface AssistInput {
    type: Pick<CustomDataType, 'id' | 'name' | 'description' | 'method'>;
    examples: string[];
    keepFixed?: string[];
}

export const customDataKeys = {
    all: ['custom-data'] as const,
    preview: (orgId: string, input: AssistInput) => [
        ...customDataKeys.all, 'preview', orgId, input.type.id, input.type.name,
        input.type.description, input.type.method, input.examples, input.keepFixed || [],
    ] as const,
};

export function useAssistPreviewQuery(orgId: string, input: AssistInput, { enabled = true } = {}) {
    return useQuery<AssistPreview, CustomDataError>({
        queryKey: customDataKeys.preview(orgId, input),
        queryFn: async ({ signal }) => parsePreview(await post(orgId, 'assist/preview', {
            type: input.type, examples: input.examples, ...(input.keepFixed?.length ? { keepFixed: input.keepFixed } : {}),
        }, signal)),
        enabled: enabled && !!orgId && !!input.type.name.trim(),
        // The preview is deterministic for its key, so an answer stays good
        // until something in the key changes.
        staleTime: Infinity,
        retry: false,
    });
}

export function useAssistMutation(orgId: string) {
    return useMutation<AssistResult, CustomDataError, AssistInput & { expectLookalikes: string[] }>({
        mutationFn: async (input) => parseAssist(await post(orgId, 'assist', {
            type: input.type,
            examples: input.examples,
            ...(input.keepFixed?.length ? { keepFixed: input.keepFixed } : {}),
            expectLookalikes: input.expectLookalikes,
        })),
    });
}

export function useTestMutation(orgId: string) {
    return useMutation<TestResult, CustomDataError, { type: CustomDataType; sentences: Sentence[] }>({
        mutationFn: async (input) => parseTest(await post(orgId, 'test', input)),
    });
}

export interface TuneInput {
    type: CustomDataType;
    sentences: Sentence[];
    examples: string[];
    candidates?: { aiLabels?: string[]; patterns?: string[] };
}

export function useTuneMutation(orgId: string) {
    return useMutation<TuneResult, CustomDataError, TuneInput>({
        mutationFn: async (input) => parseTune(await post(orgId, 'tune', input)),
    });
}

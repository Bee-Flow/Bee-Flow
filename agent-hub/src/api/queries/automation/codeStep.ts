// Code step v2: the ONLY place that knows the wire contract of
//   POST /api/automation/code/analyze                        (analysis + approvals)
//   POST /api/automation/:id/steps/:stepId/code-approvals    (record approvals)
//   POST /api/automation/code/test                           (a test run, nothing sent)
//   POST /api/automation/builder/code/assist                 (the assistant, SSE)
// Shapes: the shared contract "Code step v2", sections 1 to 3. Every reader
// below is defensive: a field the server leaves out reads as "nothing", never
// as a crash, so an older server simply shows less.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { readEventStream } from '../../../utils/sseStream';
import { apiClient, ApiError } from '../../client';

export type CodeParamType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

export interface CodeParam {
    name: string;
    label: string;
    description: string | null;
    type: CodeParamType;
    format?: string;
    items?: { type: string };
    enum?: Array<string | number>;
    required: boolean;
    default?: unknown;
    line: number;
}

export type FindingSeverity = 'block' | 'warn' | 'info';

export interface CodeFinding {
    ruleId: string;
    severity: FindingSeverity;
    approver: 'author' | 'admin' | null;
    line: number;
    column: number;
    endLine: number | null;
    endColumn: number | null;
    message: string;
    messageKey: string | null;
    fix: string | null;
    fixKey: string | null;
}

export interface CodeCapabilities {
    hosts: string[];
    dynamicHosts: boolean;
    tools: string[];
    inputsRead: string[];
    /** Read by the code but not described with @param: still editable, under "Other inputs". */
    undeclaredInputs: string[];
    usesHttp: boolean;
    usesDb: boolean;
    httpInLoop: boolean;
}

export interface CodeApproval {
    ruleId: string;
    codeHash: string | null;
    approverRole: 'author' | 'admin';
    approverName: string | null;
    createdAt: string | null;
}

export type AiReview = 'pending' | { verdict: string; category: string | null } | null;

export interface CodeAnalysis {
    ok: boolean;
    syntaxError: { message: string; line: number; column: number } | null;
    hash: string;
    description: string | null;
    params: CodeParam[];
    findings: CodeFinding[];
    capabilities: CodeCapabilities;
    approvals: CodeApproval[];
    aiReview: AiReview;
    /** null when the server does not say; the UI then lets the server refuse. */
    canApproveAdmin: boolean | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && !!s) : []);

const PARAM_TYPES: CodeParamType[] = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
const SEVERITIES: FindingSeverity[] = ['block', 'warn', 'info'];

function parseParam(raw: unknown): CodeParam | null {
    const r = obj(raw);
    const name = str(r.name);
    if (!name) return null;
    const type = PARAM_TYPES.includes(r.type as CodeParamType) ? r.type as CodeParamType : 'string';
    const param: CodeParam = {
        name,
        label: str(r.label) || name,
        description: str(r.description),
        type,
        required: r.required === true,
        line: num(r.line, 1),
    };
    if (str(r.format)) param.format = r.format as string;
    if (Array.isArray(r.enum)) param.enum = r.enum.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
    if (r.items && typeof obj(r.items).type === 'string') param.items = { type: obj(r.items).type as string };
    if ('default' in r && r.default !== undefined) param.default = r.default;
    return param;
}

function parseFinding(raw: unknown): CodeFinding | null {
    const r = obj(raw);
    const message = str(r.message);
    if (!message || !str(r.ruleId)) return null;
    return {
        ruleId: r.ruleId as string,
        severity: SEVERITIES.includes(r.severity as FindingSeverity) ? r.severity as FindingSeverity : 'warn',
        approver: r.approver === 'admin' || r.approver === 'author' ? r.approver : null,
        line: num(r.line, 1),
        column: num(r.column, 1),
        endLine: typeof r.endLine === 'number' ? r.endLine : null,
        endColumn: typeof r.endColumn === 'number' ? r.endColumn : null,
        message,
        messageKey: str(r.messageKey),
        fix: str(r.fix),
        fixKey: str(r.fixKey),
    };
}

export function parseApprovals(raw: unknown): CodeApproval[] {
    if (!Array.isArray(raw)) return [];
    return raw.map(obj).filter(a => !!str(a.ruleId)).map(a => ({
        ruleId: a.ruleId as string,
        codeHash: str(a.codeHash),
        approverRole: a.approverRole === 'admin' ? 'admin' : 'author',
        approverName: str(a.approverName) || str(a.approvedByName),
        createdAt: str(a.createdAt),
    }));
}

function parseAiReview(raw: unknown): AiReview {
    if (raw === 'pending') return 'pending';
    const r = obj(raw);
    return str(r.verdict) ? { verdict: r.verdict as string, category: str(r.category) } : null;
}

/** The analyse response, reduced to what is whole. */
export function parseCodeAnalysis(body: unknown): CodeAnalysis {
    const b = obj(body);
    const syntax = obj(b.syntaxError);
    const caps = obj(b.capabilities);
    const viewer = obj(b.viewer);
    return {
        ok: b.ok !== false,
        syntaxError: str(syntax.message) ? { message: syntax.message as string, line: num(syntax.line, 1), column: num(syntax.column, 1) } : null,
        hash: str(b.hash) || '',
        description: str(b.description),
        params: (Array.isArray(b.params) ? b.params : []).map(parseParam).filter((p): p is CodeParam => !!p),
        findings: (Array.isArray(b.findings) ? b.findings : []).map(parseFinding).filter((f): f is CodeFinding => !!f),
        capabilities: {
            hosts: strings(caps.hosts),
            dynamicHosts: caps.dynamicHosts === true,
            tools: strings(caps.tools),
            inputsRead: strings(caps.inputsRead),
            undeclaredInputs: strings(caps.undeclaredInputs),
            usesHttp: caps.usesHttp === true,
            usesDb: caps.usesDb === true,
            httpInLoop: caps.httpInLoop === true,
        },
        approvals: parseApprovals(b.approvals),
        aiReview: parseAiReview(b.aiReview),
        canApproveAdmin: typeof viewer.canApproveAdmin === 'boolean' ? viewer.canApproveAdmin : null,
    };
}

export interface AnalyzeRequest {
    code: string;
    allowedTools: string[];
    allowedHosts: string[];
    automationId: string | null;
    stepId: string | null;
}

const ANALYZE_KEY = ['automation', 'code', 'analyze'] as const;

/**
 * The live analysis of one code step. The caller debounces `code` (the
 * contract asks for 400 ms); the previous answer stays on screen while the
 * next one is on its way, so the form and the markers never blink.
 */
export function useCodeAnalysis(req: AnalyzeRequest, enabled = true) {
    return useQuery({
        queryKey: [...ANALYZE_KEY, req.automationId, req.stepId, req.code, req.allowedHosts, req.allowedTools],
        queryFn: async ({ signal }) => parseCodeAnalysis(await apiClient.post('/api/automation/code/analyze', {
            code: req.code,
            allowedTools: req.allowedTools,
            allowedHosts: req.allowedHosts,
            ...(req.automationId ? { automationId: req.automationId } : {}),
            ...(req.stepId ? { stepId: req.stepId } : {}),
        }, { signal, retry: false })),
        enabled: enabled && req.code.trim().length > 0,
        placeholderData: keepPreviousData,
        staleTime: 60_000,
        retry: false,
    });
}

/** Why an approval did not go through, as the UI tells it. */
export interface CodeTestCall {
    kind: 'http' | 'tool' | 'db';
    name: string;
    args: unknown;
}

export interface CodeTestResult {
    ok: boolean;
    result: unknown;
    logs: string[];
    calls: CodeTestCall[];
    durationMs: number | null;
    error: string | null;
}

export function parseCodeTest(body: unknown): CodeTestResult {
    const b = obj(body);
    const err = typeof b.error === 'string' ? b.error : str(obj(b.error).message);
    const calls = (Array.isArray(b.calls) ? b.calls : []).map(obj).filter(c => !!str(c.name)).map(c => ({
        kind: (c.kind === 'tool' || c.kind === 'db' ? c.kind : 'http') as CodeTestCall['kind'],
        name: c.name as string,
        args: c.args ?? null,
    }));
    return {
        ok: !err,
        result: b.result ?? null,
        logs: (Array.isArray(b.logs) ? b.logs : []).map(l => (typeof l === 'string' ? l : JSON.stringify(l))),
        calls,
        durationMs: typeof b.durationMs === 'number' ? b.durationMs : null,
        error: err,
    };
}

export interface CodeTestRequest {
    code: string;
    inputs: Record<string, unknown>;
    allowedTools: string[];
    allowedHosts: string[];
    automationId: string | null;
}

/** A test run: the server stubs every outward call and records it. */
export function useCodeTest() {
    return useMutation({
        mutationFn: async (req: CodeTestRequest): Promise<CodeTestResult> => {
            try {
                return parseCodeTest(await apiClient.post('/api/automation/code/test', {
                    code: req.code, inputs: req.inputs, allowedTools: req.allowedTools, allowedHosts: req.allowedHosts,
                    ...(req.automationId ? { automationId: req.automationId } : {}),
                }, { retry: false }));
            } catch (err) {
                // A refusal (a BLOCK finding, the rate limit) is an answer, not a crash.
                if (err instanceof ApiError && err.status && err.status < 500) {
                    return { ...parseCodeTest(err.body), ok: false, error: err.message };
                }
                throw err;
            }
        },
    });
}

export interface AssistMessage { role: 'user' | 'assistant'; content: string }

export interface AssistRequest {
    messages: AssistMessage[];
    code: string;
    allowedTools: string[];
    allowedHosts: string[];
    upstreamFields: Array<{ path: string; label: string; type: string }>;
    automationId: string | null;
    stepId: string | null;
}

export type AssistEvent =
    | { type: 'delta'; text: string }
    | { type: 'edit'; op: string; summary: string }
    | { type: 'code'; code: string }
    | { type: 'error'; message: string }
    | { type: 'done' };

/** One SSE event of the assistant, in the UI's terms; null for one it does not know. */
export function toAssistEvent(event: string, data: unknown): AssistEvent | null {
    const d = obj(data);
    if (event === 'delta') {
        const text = [d.text, d.delta, d.content].find(v => typeof v === 'string');
        return typeof text === 'string' ? { type: 'delta', text } : null;
    }
    if (event === 'edit') return { type: 'edit', op: str(d.op) || 'edit', summary: str(d.summary) || '' };
    if (event === 'code') return typeof d.code === 'string' ? { type: 'code', code: d.code } : null;
    if (event === 'error') return { type: 'error', message: str(d.message) || str(d.error) || '' };
    if (event === 'done') return { type: 'done' };
    return null;
}

/** Stream one assistant turn. Resolves when the stream ends; a refused request throws with the server's words. */
export async function streamCodeAssist(req: AssistRequest, onEvent: (e: AssistEvent) => void, signal?: AbortSignal): Promise<void> {
    const res: Response = await authFetch(`${API_BASE}/api/automation/builder/code/assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
            messages: req.messages, code: req.code, allowedTools: req.allowedTools, allowedHosts: req.allowedHosts,
            upstreamFields: req.upstreamFields,
            ...(req.automationId ? { automationId: req.automationId } : {}),
            ...(req.stepId ? { stepId: req.stepId } : {}),
        }),
        signal,
    });
    if (!res.ok) {
        let message = '';
        try { message = str(obj(await res.json()).error) || ''; } catch { /* not JSON */ }
        throw new ApiError(message || `HTTP ${res.status}`, { status: res.status });
    }
    await readEventStream(res.body as ReadableStream, (event: string, data: unknown) => {
        const e = toAssistEvent(event, data);
        if (e) onEvent(e);
    }, signal);
}

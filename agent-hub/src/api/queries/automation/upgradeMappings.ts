// "Koppelingen bijwerken" (POST /api/automation/:id/upgrade-mappings): the
// stored refs of one routine as picks (an expr stays a Formula), and its "run
// once per item" steps as a repeat, only where the value stays the same.
// `?dryRun=1` is the preview; without it the server saves a new version. The
// report names steps, fields and labels, never a value from a run
// (server/routes/automation/upgradeMappings.js, shared/mapping upgrade.mjs).
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// dialog renders a failure as a sentence, and its test mocks `authFetch`.
//
// M8b: `/ai-fix` asks the AI for the fields that stay a Formula and answers
// only suggestions a dry run on the recent runs shows give the same result;
// the apply takes the ones the person ticked (`aiFixes`). `applyUpgradeOnOpen`
// is the builder's update when an automation is opened (`auto: true`): the
// server saves only when the organisation switched that on (`autoOff`
// otherwise), and answers `previous` so the builder can offer Undo.

import { useMutation, useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';
import type { UpgradeEntry } from '@shared/mapping/index.mjs';

const BASE = `${API_BASE}/api/automation`;

export type { UpgradeEntry };

/** A report line; `ai` marks a field written from an AI suggestion (apply only). */
export type ReportEntry = UpgradeEntry & { ai?: boolean };

export interface UpgradeReport {
    dryRun: boolean;
    saved: boolean;
    /** The version the report is of (the preview), or the one just saved. */
    version: number | null;
    changed: ReportEntry[];
    kept: ReportEntry[];
    /** Whether a recent run, a pinned sample, both or neither were there to compare with. */
    evidence: { lastRun: boolean; sample: boolean };
    /** The saved routine row (apply only). */
    automation: Record<string, unknown> | null;
    /** The version a save replaced, for Undo (its row id may be unknown). */
    previous: { version: number; versionId: string | null } | null;
    /** An update on open the organisation did not switch on: nothing was read or saved. */
    autoOff: boolean;
}

/** An AI suggestion that passed the dry run: what to write, and what it reads (labels only). */
export interface AiSuggestion {
    stepId: string;
    step: string | null;
    field: string;
    kind: 'ref' | 'expr';
    /** The pick or compose to write (paths only, never a value). */
    binding: Record<string, unknown>;
    take?: string;
    root?: string;
    source?: string | null;
    label?: string;
    /** For a compose: how many values it writes into the text. */
    composed?: number;
}

export interface AiFixReport {
    version: number | null;
    suggestions: AiSuggestion[];
    counts: { candidates: number; noEvidence: number; asked: number; accepted: number; discarded: number; truncated: boolean };
}

/** One applied suggestion, as the apply takes it. */
export interface AiFix { stepId: string; field: string; binding: Record<string, unknown> }

/** A refused request, with the machine code the dialog branches on. */
export class UpgradeMappingsError extends Error {
    status: number;
    code: string | null;
    constructor(message: string, status: number, code: string | null = null) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

function entry(raw: unknown): ReportEntry | null {
    const e = obj(raw);
    const field = str(e.field);
    const kind = e.kind === 'ref' || e.kind === 'expr' || e.kind === 'for_each' ? e.kind : null;
    if (!field || !kind) return null;
    return {
        stepId: str(e.stepId),
        step: str(e.step),
        ...(str(e.layer) ? { layer: str(e.layer) as string } : {}),
        field,
        kind,
        ...(str(e.take) ? { take: e.take as UpgradeEntry['take'] } : {}),
        ...(str(e.reason) ? { reason: e.reason as UpgradeEntry['reason'] } : {}),
        ...(str(e.root) ? { root: str(e.root) as string } : {}),
        ...(e.source !== undefined ? { source: str(e.source) } : {}),
        ...(str(e.label) !== null ? { label: str(e.label) as string } : {}),
        ...(e.ai === true ? { ai: true } : {}),
    };
}

export function parseUpgradeReport(body: unknown): UpgradeReport {
    const raw = obj(body);
    const list = (v: unknown) => (Array.isArray(v) ? v.map(entry).filter((x): x is ReportEntry => !!x) : []);
    const evidence = obj(raw.evidence);
    const row = obj(raw.automation);
    const previous = obj(raw.previous);
    return {
        dryRun: raw.dryRun === true,
        saved: raw.saved === true,
        version: typeof raw.version === 'number' ? raw.version : null,
        changed: list(raw.changed),
        kept: list(raw.kept),
        evidence: { lastRun: evidence.lastRun === true, sample: evidence.sample === true },
        automation: str(row.id) ? row : null,
        previous: typeof previous.version === 'number' ? { version: previous.version, versionId: str(previous.versionId) } : null,
        autoOff: raw.autoOff === true,
    };
}

function suggestion(raw: unknown): AiSuggestion | null {
    const e = obj(raw);
    const stepId = str(e.stepId);
    const field = str(e.field);
    const kind = e.kind === 'ref' || e.kind === 'expr' ? e.kind : null;
    const binding = obj(e.binding);
    if (!stepId || !field || !kind || (binding.kind !== 'pick' && binding.kind !== 'compose')) return null;
    return {
        stepId, step: str(e.step), field, kind, binding,
        ...(str(e.take) ? { take: e.take as string } : {}),
        ...(str(e.root) ? { root: e.root as string } : {}),
        ...(e.source !== undefined ? { source: str(e.source) } : {}),
        ...(str(e.label) !== null ? { label: e.label as string } : {}),
        ...(typeof e.composed === 'number' ? { composed: e.composed } : {}),
    };
}

export function parseAiFixReport(body: unknown): AiFixReport {
    const raw = obj(body);
    const c = obj(raw.counts);
    const n = (v: unknown) => (typeof v === 'number' ? v : 0);
    return {
        version: typeof raw.version === 'number' ? raw.version : null,
        suggestions: Array.isArray(raw.suggestions) ? raw.suggestions.map(suggestion).filter((x): x is AiSuggestion => !!x) : [],
        counts: {
            candidates: n(c.candidates), noEvidence: n(c.noEvidence), asked: n(c.asked),
            accepted: n(c.accepted), discarded: n(c.discarded), truncated: c.truncated === true,
        },
    };
}

async function send(url: string, body: Record<string, unknown>, fallback: string): Promise<unknown> {
    const res = await authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        let message = fallback;
        let code: string | null = null;
        try {
            const b = obj(await res.json());
            if (str(b.error)) message = b.error as string;
            code = str(b.code);
        } catch { /* not JSON: keep the fallback */ }
        throw new UpgradeMappingsError(message, res.status, code);
    }
    return res.json();
}

interface PostOpts { dryRun: boolean; version?: number | null; aiFixes?: AiFix[]; auto?: boolean }

async function post(id: string, { dryRun, version, aiFixes, auto }: PostOpts): Promise<UpgradeReport> {
    const body: Record<string, unknown> = typeof version === 'number' ? { version } : {};
    if (aiFixes && aiFixes.length) body.aiFixes = aiFixes;
    if (auto) body.auto = true;
    return parseUpgradeReport(await send(
        `${BASE}/${encodeURIComponent(id)}/upgrade-mappings${dryRun ? '?dryRun=1' : ''}`, body,
        dryRun ? 'Could not check the mappings.' : 'Could not update the mappings.',
    ));
}

/** The dry run, read fresh every time the dialog opens. */
export function useUpgradeMappingsPreview(id: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
    return useQuery<UpgradeReport, UpgradeMappingsError>({
        queryKey: ['automation', 'upgrade-mappings', id],
        queryFn: () => post(id as string, { dryRun: true }),
        enabled: enabled && !!id,
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
}

/**
 * Apply the upgrade the preview showed (`version` is the preview's), with the
 * AI suggestions the person ticked.
 */
export function useApplyUpgradeMappings(id: string | null | undefined) {
    return useMutation<UpgradeReport, UpgradeMappingsError, { version: number | null; aiFixes?: AiFix[] }>({
        mutationFn: ({ version, aiFixes }) => post(id as string, { dryRun: false, version, aiFixes }),
    });
}

/** Ask the AI about the fields that stay a Formula; nothing is saved. */
export function useAiFixMappings(id: string | null | undefined) {
    return useMutation<AiFixReport, UpgradeMappingsError, number | null>({
        mutationFn: async (version) => parseAiFixReport(await send(
            `${BASE}/${encodeURIComponent(id as string)}/upgrade-mappings/ai-fix`,
            typeof version === 'number' ? { version } : {},
            'Could not ask the AI right now.',
        )),
    });
}

/**
 * The update when an automation is opened: saved only when the organisation
 * switched it on (`autoOff` otherwise), never with AI suggestions.
 */
export function applyUpgradeOnOpen(id: string, version: number | null): Promise<UpgradeReport> {
    return post(id, { dryRun: false, version, auto: true });
}

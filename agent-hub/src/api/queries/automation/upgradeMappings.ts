// "Koppelingen bijwerken" (POST /api/automation/:id/upgrade-mappings): the
// stored refs of one routine as picks (an expr stays a Formula), and its "run
// once per item" steps as a repeat, only where the value stays the same.
// `?dryRun=1` is the preview; without it the server saves a new version. The
// report names steps, fields and labels, never a value from a run
// (server/routes/automation/upgradeMappings.js, shared/mapping upgrade.mjs).
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// dialog renders a failure as a sentence, and its test mocks `authFetch`.

import { useMutation, useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';
import type { UpgradeEntry } from '@shared/mapping/index.mjs';

const BASE = `${API_BASE}/api/automation`;

export type { UpgradeEntry };

export interface UpgradeReport {
    dryRun: boolean;
    saved: boolean;
    /** The version the report is of (the preview), or the one just saved. */
    version: number | null;
    changed: UpgradeEntry[];
    kept: UpgradeEntry[];
    /** Whether a recent run, a pinned sample, both or neither were there to compare with. */
    evidence: { lastRun: boolean; sample: boolean };
    /** The saved routine row (apply only). */
    automation: Record<string, unknown> | null;
}

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

function entry(raw: unknown): UpgradeEntry | null {
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
    };
}

export function parseUpgradeReport(body: unknown): UpgradeReport {
    const raw = obj(body);
    const list = (v: unknown) => (Array.isArray(v) ? v.map(entry).filter((x): x is UpgradeEntry => !!x) : []);
    const evidence = obj(raw.evidence);
    const row = obj(raw.automation);
    return {
        dryRun: raw.dryRun === true,
        saved: raw.saved === true,
        version: typeof raw.version === 'number' ? raw.version : null,
        changed: list(raw.changed),
        kept: list(raw.kept),
        evidence: { lastRun: evidence.lastRun === true, sample: evidence.sample === true },
        automation: str(row.id) ? row : null,
    };
}

async function post(id: string, { dryRun, version }: { dryRun: boolean; version?: number | null }): Promise<UpgradeReport> {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/upgrade-mappings${dryRun ? '?dryRun=1' : ''}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(typeof version === 'number' ? { version } : {}),
    });
    if (!res.ok) {
        let message = dryRun ? 'Could not check the mappings.' : 'Could not update the mappings.';
        let code: string | null = null;
        try {
            const b = obj(await res.json());
            if (str(b.error)) message = b.error as string;
            code = str(b.code);
        } catch { /* not JSON: keep the fallback */ }
        throw new UpgradeMappingsError(message, res.status, code);
    }
    return parseUpgradeReport(await res.json());
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

/** Apply the upgrade the preview showed (`version` is the preview's). */
export function useApplyUpgradeMappings(id: string | null | undefined) {
    return useMutation<UpgradeReport, UpgradeMappingsError, number | null>({
        mutationFn: (version) => post(id as string, { dryRun: false, version }),
    });
}

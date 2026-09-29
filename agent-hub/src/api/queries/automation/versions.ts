// Automation versions: the ONLY place that knows the /api/automation/:id/versions
// wire contract (handoff 5, artboard 5d).
//
// The parsers are tolerant on purpose. Older servers return the pre-handoff-5
// row (`savedByName`, `changeSummary`, no live flags); the parser fills the
// live/editing flags from the automation row the tab already has, so the tab
// renders on either shape.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../../client';

export interface DescriptionEntry {
    code: string;
    params: Record<string, unknown>;
}

export interface VersionRow {
    /** Row id: the restore and read-one endpoints take this. */
    id: string;
    /** Version number: name and field-diff take this. */
    version: number;
    savedAt: string | null;
    savedByName: string | null;
    /** A milestone name; null = not a milestone. */
    name: string | null;
    description: string | null;
    descriptionJson: DescriptionEntry[];
    changeSummary: string | null;
    isLive: boolean;
    liveSince: string | null;
    isEditing: boolean;
    runs: { total: number; failed: number } | null;
}

export interface FieldChange {
    stepId: string;
    stepNumber: number | null;
    stepLabel: string;
    change: 'added' | 'removed' | 'changed' | 'moved';
    setting: string | null;
    settingLabel: string | null;
    before: unknown;
    after: unknown;
}

export interface FieldDiff {
    changes: FieldChange[];
    stepIds: { added: string[]; removed: string[]; changed: string[] };
}

export interface VersionContext {
    /** automation.liveVersion; null = never live. */
    liveVersion: number | null;
    liveAt?: string | null;
    /** automation.version: the working copy. */
    currentVersion: number | null;
}

type Obj = Record<string, unknown>;
const asObj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

function parseDescriptionJson(v: unknown): DescriptionEntry[] {
    const list = Array.isArray(v) ? v : (v ? [v] : []);
    const out: DescriptionEntry[] = [];
    for (const item of list) {
        const o = asObj(item);
        const code = str(o?.code);
        if (code) out.push({ code, params: asObj(o?.params) ?? {} });
    }
    return out;
}

function parseVersionRow(o: Obj, version: number, ctx: VersionContext): VersionRow {
    const savedBy = asObj(o.savedBy);
    const runs = asObj(o.runs);
    const isLive = typeof o.isLive === 'boolean' ? o.isLive : ctx.liveVersion === version;
    const isEditing = typeof o.isEditing === 'boolean'
        ? o.isEditing
        : ctx.currentVersion === version && ctx.liveVersion !== version;
    const liveSince = str(o.liveSince) ?? (isLive ? (ctx.liveAt ?? null) : null);
    return {
        id: str(o.id) ?? String(version),
        version,
        savedAt: str(o.savedAt),
        savedByName: str(savedBy?.name) ?? str(o.savedByName),
        name: str(o.name),
        description: str(o.description),
        descriptionJson: parseDescriptionJson(o.descriptionJson),
        changeSummary: str(o.changeSummary),
        isLive,
        liveSince,
        isEditing,
        runs: runs ? { total: num(runs.total) ?? 0, failed: num(runs.failed) ?? 0 } : null,
    };
}

/** Normalise one GET /:id/versions body. Exported for the test. */
export function parseVersions(body: unknown, ctx: VersionContext): VersionRow[] {
    const raw = asObj(body);
    const list = Array.isArray(raw?.versions) ? raw!.versions as unknown[] : (Array.isArray(body) ? body : []);
    const rows: VersionRow[] = [];
    for (const item of list) {
        const o = asObj(item);
        const version = num(o?.version);
        if (o && version != null) rows.push(parseVersionRow(o, version, ctx));
    }
    return rows.sort((a, b) => b.version - a.version);
}

/** Normalise one field-diff body. Exported for the test. */
export function parseFieldDiff(body: unknown): FieldDiff {
    const raw = asObj(body);
    const changes: FieldChange[] = [];
    for (const item of Array.isArray(raw?.changes) ? raw!.changes as unknown[] : []) {
        const o = asObj(item);
        if (!o) continue;
        const change = o.change === 'added' || o.change === 'removed' || o.change === 'moved' ? o.change : 'changed';
        changes.push({
            stepId: str(o.stepId) ?? '',
            stepNumber: num(o.stepNumber),
            stepLabel: str(o.stepLabel) ?? str(o.stepId) ?? '',
            change,
            setting: str(o.setting),
            settingLabel: str(o.settingLabel),
            before: o.before,
            after: o.after,
        });
    }
    const ids = asObj(raw?.stepIds);
    return {
        changes,
        stepIds: { added: strList(ids?.added), removed: strList(ids?.removed), changed: strList(ids?.changed) },
    };
}

export const versionKeys = {
    list: (automationId: string) => ['automation', automationId, 'versions'] as const,
    one: (automationId: string, versionId: string) => ['automation', automationId, 'versions', 'one', versionId] as const,
    fieldDiff: (automationId: string, version: number, other: number) =>
        ['automation', automationId, 'versions', 'fielddiff', version, other] as const,
};

const base = (automationId: string) => `/api/automation/${encodeURIComponent(automationId)}/versions`;

export function useVersionsQuery(automationId: string | null | undefined, ctx: VersionContext) {
    return useQuery({
        queryKey: versionKeys.list(automationId ?? ''),
        queryFn: ({ signal }) => apiClient.get<unknown>(base(automationId!), { signal }),
        enabled: !!automationId,
        select: (body) => parseVersions(body, ctx),
        retry: false,
    });
}

/** One version's definition, for the mini canvas and the read-only view. */
export function useVersionDefinitionQuery(automationId: string | null | undefined, versionId: string | null | undefined) {
    return useQuery({
        queryKey: versionKeys.one(automationId ?? '', versionId ?? ''),
        queryFn: async ({ signal }) => {
            const body = asObj(await apiClient.get<unknown>(`${base(automationId!)}/${encodeURIComponent(versionId!)}`, { signal }));
            return asObj(asObj(body?.version)?.definition) ?? {};
        },
        enabled: !!automationId && !!versionId,
        staleTime: Infinity, // a stored version never changes
        retry: false,
    });
}

/** Per-field differences: what `version` holds relative to `other`. */
export function useFieldDiffQuery(automationId: string | null | undefined, version: number | null, other: number | null) {
    return useQuery({
        queryKey: versionKeys.fieldDiff(automationId ?? '', version ?? 0, other ?? 0),
        queryFn: async ({ signal }) => parseFieldDiff(
            await apiClient.get<unknown>(`${base(automationId!)}/${version}/fielddiff/${other}`, { signal })),
        enabled: !!automationId && version != null && other != null && version !== other,
        staleTime: 60_000,
        retry: false,
    });
}

/** Name a version (a milestone), or clear the name with null. */
export function useNameVersionMutation(automationId: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ version, name }: { version: number; name: string | null }) =>
            apiClient.put<unknown>(`${base(automationId)}/${version}/name`, { name }),
        onSettled: () => qc.invalidateQueries({ queryKey: versionKeys.list(automationId) }),
    });
}

/** Restore a version into the working copy. Resolves with the updated automation row. */
export function useRestoreVersionMutation(automationId: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: async (versionId: string) => {
            const body = asObj(await apiClient.post<unknown>(`${base(automationId)}/${encodeURIComponent(versionId)}/restore`));
            return asObj(body?.automation);
        },
        onSettled: () => qc.invalidateQueries({ queryKey: ['automation', automationId, 'versions'] }),
    });
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import useAutomationApi from '../../hooks/useAutomationApi';
import type { AutomationApiError } from '../../hooks/useAutomationApi';
import { toast } from '../shared/Toast';
import { planRefusalText } from './planRefusal';
import {
    duplicateAutomationOnServer,
    invalidateAutomationTrash,
} from '../../api/queries/automation/library';

/** One row of the sidebar's automation list. */
export interface AutomationListRow {
    id: string;
    title?: string;
    description?: string | null;
    /** null = at the top level, outside every folder. */
    folderId?: string | null;
    isActive?: boolean;
    isDraft?: boolean;
    definition?: unknown;
    [key: string]: unknown;
}

/** One sidebar folder. */
export interface AutomationFolder {
    id: string;
    name?: string;
    [key: string]: unknown;
}

/** One reusable Step (an automation of kind 'block'). */
export interface StepRow {
    id: string;
    title?: string;
    [key: string]: unknown;
}

export interface AutomationLibrary {
    automationApi: ReturnType<typeof useAutomationApi>;
    automations: AutomationListRow[];
    setAutomations: Dispatch<SetStateAction<AutomationListRow[]>>;
    folders: AutomationFolder[];
    automationsLoading: boolean;
    pendingDeleteAutomation: AutomationListRow | null;
    setPendingDeleteAutomation: Dispatch<SetStateAction<AutomationListRow | null>>;
    steps: StepRow[];
    stepsLoading: boolean;
    /** Ids of the automations executing right now — the sidebar's live dot. */
    activeRunIds: Set<string>;
    fetchAutomations: () => Promise<void>;
    fetchFolders: () => Promise<void>;
    createFolder: (name: string) => Promise<void>;
    renameFolder: (id: string, name: string) => Promise<void>;
    deleteFolder: (folder: AutomationFolder) => Promise<void>;
    moveToFolder: (automationId: string, folderId: string | null) => Promise<void>;
    fetchSteps: () => Promise<void>;
    onDeleteStep: (step: StepRow) => Promise<void>;
    toggleAutomation: (a: AutomationListRow) => Promise<void>;
    requestDeleteAutomation: (a: AutomationListRow) => void;
    confirmDeleteAutomation: () => Promise<void>;
    duplicateAutomation: (a: AutomationListRow) => Promise<void>;
    exportAutomationJson: (a: AutomationListRow) => Promise<void>;
    importAutomationFile: (file: File | null) => Promise<void>;
    copyAutomationId: (a: AutomationListRow) => Promise<void>;
}

export interface UseAutomationLibraryOptions {
    confirm: (opts: {
        title: string;
        description?: string;
        confirmLabel?: string;
        destructive?: boolean;
    }) => Promise<boolean>;
    builderAutomationId: string | null;
    openingBuilder: boolean;
    builderStepId: string | null;
    setBuilderAutomationId: (id: string | null) => void;
    setBuilderInitialTab: (tab: string | null) => void;
    setBuilderStepId: (id: string | null) => void;
    setOpeningBuilder: (opening: boolean) => void;
    setSegment: (segment: string) => void;
}

/** What a failed request said, for a toast the user can act on. */
const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Everything the sidebar lists: automations, their folders, the reusable
 * Steps, and which of them are running right now. Every action here is a
 * call plus the refetch that keeps the list true — the list is the source of
 * truth for the sidebar, Cmd/Ctrl+K and the open builder alike.
 *
 * The builder setters come in because a duplicate, an import and a delete all
 * move the user: a fresh copy opens, an imported routine opens, and deleting
 * the open one closes it.
 */
export default function useAutomationLibrary({
    confirm, builderAutomationId, openingBuilder, builderStepId,
    setBuilderAutomationId, setBuilderInitialTab, setBuilderStepId, setOpeningBuilder, setSegment,
}: UseAutomationLibraryOptions): AutomationLibrary {
    const automationApi = useAutomationApi();
    const [automations, setAutomations] = useState<AutomationListRow[]>([]);
    const [folders, setFolders] = useState<AutomationFolder[]>([]);
    const [automationsLoading, setAutomationsLoading] = useState(false);
    const [pendingDeleteAutomation, setPendingDeleteAutomation] = useState<AutomationListRow | null>(null);
    const [steps, setSteps] = useState<StepRow[]>([]);
    const [stepsLoading, setStepsLoading] = useState(false);

    const fetchAutomations = useCallback(async () => {
        setAutomationsLoading(true);
        try {
            const r = await automationApi.listAutomations<{ automations?: AutomationListRow[] }>();
            setAutomations(r.automations || []);
        } catch (err) {
            console.warn('[AITasksDesigner] fetchAutomations failed:', failureText(err));
        }
        setAutomationsLoading(false);
    }, [automationApi]);

    const fetchFolders = useCallback(async () => {
        try {
            const r = await automationApi.listFolders<{ folders?: AutomationFolder[] }>();
            setFolders(r.folders || []);
        } catch (err) {
            // A sidebar without folders is still a usable sidebar — never let
            // this take the automation list down with it.
            console.warn('[AITasksDesigner] fetchFolders failed:', failureText(err));
        }
    }, [automationApi]);

    useEffect(() => { fetchAutomations(); }, [fetchAutomations]);
    useEffect(() => { fetchFolders(); }, [fetchFolders]);

    // The sidebar owns the naming input and the removal confirmation — both are
    // in-app, so nothing here reaches for window.prompt/confirm. Failures land
    // in the same toast host as every other error in this view.
    const createFolder = useCallback(async (name: string) => {
        if (!name || !name.trim()) return;
        try {
            await automationApi.createFolder({ name: name.trim() });
            await fetchFolders();
        } catch (err) {
            toast.error(failureText(err) || 'Could not create that folder.');
        }
    }, [automationApi, fetchFolders]);

    const renameFolder = useCallback(async (id: string, name: string) => {
        try {
            await automationApi.updateFolder(id, { name });
            await fetchFolders();
        } catch (err) {
            toast.error(failureText(err) || 'Could not rename that folder.');
            await fetchFolders();
        }
    }, [automationApi, fetchFolders]);

    const deleteFolder = useCallback(async (folder: AutomationFolder) => {
        try {
            const r = await automationApi.deleteFolder<{ detached?: number }>(folder.id);
            await Promise.all([fetchFolders(), fetchAutomations()]);
            if (r?.detached) {
                toast.success(`Folder removed — ${r.detached} automation${r.detached === 1 ? '' : 's'} moved back to the top.`);
            }
        } catch (err) {
            toast.error(failureText(err) || 'Could not remove that folder.');
        }
    }, [automationApi, fetchFolders, fetchAutomations]);

    const moveToFolder = useCallback(async (automationId: string, folderId: string | null) => {
        const current = automations.find(a => a.id === automationId);
        if (!current || (current.folderId || null) === (folderId || null)) return;
        // Optimistic: the row jumps immediately, then the server confirms.
        setAutomations(list => list.map(a => (a.id === automationId ? { ...a, folderId: folderId || null } : a)));
        try {
            await automationApi.moveAutomationToFolder(automationId, folderId);
            await fetchFolders();
        } catch (err) {
            console.warn('[AITasksDesigner] moveToFolder failed:', failureText(err));
            await fetchAutomations();
        }
    }, [automationApi, automations, fetchFolders, fetchAutomations]);


    // Refresh the automation list whenever the builder closes — covers the
    // case where the user finalised a draft, renamed via the inline title,
    // toggled active, etc. and the sidebar should show the new state.
    useEffect(() => {
        if (builderAutomationId === null && !openingBuilder) { fetchAutomations(); }
    }, [builderAutomationId, openingBuilder, fetchAutomations]);

    // ── Reusable Steps (kind='block') ──────────────────────────────────────
    const fetchSteps = useCallback(async () => {
        setStepsLoading(true);
        try {
            const r = await automationApi.listSteps<{ steps?: StepRow[] }>();
            setSteps(r.steps || []);
        } catch (err) {
            console.warn('[AITasksDesigner] fetchSteps failed:', failureText(err));
        }
        setStepsLoading(false);
    }, [automationApi]);

    useEffect(() => { fetchSteps(); }, [fetchSteps]);
    // Refresh the Step list when the Step builder closes.
    useEffect(() => {
        if (builderStepId === null) fetchSteps();
    }, [builderStepId, fetchSteps]);

    const onDeleteStep = useCallback(async (step: StepRow) => {
        if (!step?.id) return;
        if (!(await confirm({ title: `Delete the Step "${step.title || 'Untitled'}"?`, description: "This can't be undone.", confirmLabel: 'Delete', destructive: true }))) return;
        try {
            await automationApi.deleteStep(step.id);
            if (builderStepId === step.id) setBuilderStepId(null);
            await fetchSteps();
        } catch (err) {
            if ((err as AutomationApiError | null)?.status === 409) {
                toast.error('This Step is still used by one or more automations. Remove it there first.');
            } else {
                toast.error(`Could not delete the Step: ${failureText(err)}`);
            }
        }
    }, [automationApi, fetchSteps, builderStepId, confirm, setBuilderStepId]);

    // Poll active runs every 5s so the sidebar can show a live ● dot on
    // any automation currently executing. n8n-style ambient awareness so
    // the user knows their scheduled flows ran without opening each one.
    const [activeRunIds, setActiveRunIds] = useState<Set<string>>(new Set());
    useEffect(() => {
        let alive = true;
        const tick = async () => {
            try {
                const r = await automationApi.getActiveRuns<{ active?: Array<{ automationId: string }> }>();
                if (!alive || !r) return;
                const nextIds = (r.active || []).map(x => x.automationId);
                // Only replace the Set (and re-render the whole designer —
                // sidebar + open builder) when the set of active runs actually
                // CHANGED. Every 5s tick previously minted a fresh Set even
                // when identical, forcing a full re-render on a timer.
                setActiveRunIds(prev => {
                    if (prev.size === nextIds.length && nextIds.every(id => prev.has(id))) return prev;
                    return new Set(nextIds);
                });
            } catch { /* silent — non-critical */ }
        };
        tick();
        const handle = setInterval(tick, 5000);
        return () => { alive = false; clearInterval(handle); };
    }, [automationApi]);

    // Per-row in-flight dedupe for the active/pause toggle. Without this,
    // a rapid double-click fires two PATCHes against the same automation
    // (the second sees the post-first state and immediately reverses it).
    // The ref-based check survives stale React state and the toast
    // surfaces failures the user used to only see in console.warn.
    const togglePendingRef = useRef<Set<string>>(new Set());
    const toggleAutomation = useCallback(async (a: AutomationListRow) => {
        if (togglePendingRef.current.has(a.id)) return;
        togglePendingRef.current.add(a.id);
        try {
            if (a.isActive) await automationApi.deactivate(a.id);
            else await automationApi.activate(a.id);
            await fetchAutomations();
        } catch (err) {
            // A plan refusal (a step the plan does not include) reads as its
            // step sentences rather than as `feature_locked` (planRefusal.ts).
            const why = planRefusalText(err) || failureText(err);
            console.warn('[AITasksDesigner] toggleAutomation failed:', why);
            toast.error(`Could not ${a.isActive ? 'pause' : 'activate'} “${a.title || a.id}”: ${why}`);
        } finally {
            togglePendingRef.current.delete(a.id);
        }
    }, [automationApi, fetchAutomations]);

    const requestDeleteAutomation = useCallback((a: AutomationListRow) => setPendingDeleteAutomation(a), []);
    const confirmDeleteAutomation = useCallback(async () => {
        if (!pendingDeleteAutomation) return;
        try {
            // A delete moves the routine to the trash (runs are kept); the
            // "Recently deleted" section reads it fresh.
            await automationApi.deleteAutomation(pendingDeleteAutomation.id);
            invalidateAutomationTrash();
            if (builderAutomationId === pendingDeleteAutomation.id) {
                setBuilderAutomationId(null);
                setOpeningBuilder(false);
            }
            await fetchAutomations();
        } catch (err) {
            console.warn('[AITasksDesigner] deleteAutomation failed:', failureText(err));
            toast.error(failureText(err) || 'Could not delete that automation.');
        }
        setPendingDeleteAutomation(null);
    }, [pendingDeleteAutomation, automationApi, fetchAutomations, builderAutomationId, setBuilderAutomationId, setOpeningBuilder]);

    /** Duplicate an automation: a draft copy without runs, made by the
     *  server (POST /:id/duplicate), which also drops the app-button link
     *  and records "Copied from" as the copy's first version. */
    const duplicateAutomation = useCallback(async (a: AutomationListRow) => {
        try {
            const newId = await duplicateAutomationOnServer(a.id);
            await fetchAutomations();
            if (newId) {
                setBuilderInitialTab(null); // a fresh copy always opens on the Editor
                setSegment('automation');
                setBuilderAutomationId(newId);
            }
        } catch (err) {
            console.warn('[AITasksDesigner] duplicateAutomation failed:', failureText(err));
            toast.error(failureText(err) || 'Could not duplicate that automation.');
        }
    }, [fetchAutomations, setBuilderAutomationId, setBuilderInitialTab, setSegment]);

    /**
     * Export a routine as a portable JSON envelope.
     *
     * Goes through `GET /:id/export`, NOT `GET /:id`. The raw row carries
     * `builderSession` — the entire AI conversation that built the routine —
     * plus userId, organizationId and createdFromChatId, and it keeps the
     * pinned step outputs (captured live data). The export route hands back an
     * allow-listed envelope with all of that stripped, and it is the only shape
     * `POST /import` will accept back.
     */
    const exportAutomationJson = useCallback(async (a: AutomationListRow) => {
        try {
            const { envelope, warnings } = await automationApi.exportAutomation<
                { envelope: unknown; warnings?: string[] }
            >(a.id);
            const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${(a.title || 'automation').replace(/[^a-z0-9-_]+/gi, '_')}.json`;
            link.click();
            // Chrome needs the object URL to outlive the click.
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            if (warnings?.length) toast.success(warnings[0]);
        } catch (err) {
            console.warn('[AITasksDesigner] exportAutomationJson failed:', failureText(err));
            toast.error(failureText(err) || 'Could not export that automation.');
        }
    }, [automationApi]);

    /**
     * Import one back. Always creates a NEW automation, never overwrites: the
     * file carries no identity that could safely address an existing row, and
     * silently replacing a live routine is not something a file picker should
     * be able to do. The server re-keys every step id, so an import of the
     * routine you exported five minutes ago is a genuine copy rather than a
     * second document pointing at the first one's steps.
     */
    const importAutomationFile = useCallback(async (file: File | null) => {
        if (!file) return;
        try {
            const text = await file.text();
            let payload: { format?: string } | null;
            try { payload = JSON.parse(text); }
            catch { toast.error('That file is not JSON.'); return; }
            // Cheap local check so an obviously wrong file gets an obviously
            // right message instead of a server round trip.
            if (!payload || payload.format !== 'beeflow.automation') {
                toast.error('That is not a Bee Flow automation export.');
                return;
            }
            const r = await automationApi.importAutomation<
                { automation?: { id?: string }; warnings?: string[] }
            >(payload);
            await fetchAutomations();
            const warned = r.warnings?.length
                ? ` — ${r.warnings.length} thing${r.warnings.length === 1 ? '' : 's'} to check`
                : '';
            toast.success(`Imported as a draft${warned}.`);
            if (r.automation?.id) {
                setBuilderInitialTab(null);
                setBuilderAutomationId(r.automation.id);
            }
        } catch (err) {
            console.warn('[AITasksDesigner] importAutomation failed:', failureText(err));
            toast.error(failureText(err) || 'Could not import that file.');
        }
    }, [automationApi, fetchAutomations, setBuilderAutomationId, setBuilderInitialTab]);

    const copyAutomationId = useCallback(async (a: AutomationListRow) => {
        try { await navigator.clipboard.writeText(a.id); }
        catch (err) { console.warn('[AITasksDesigner] copyAutomationId failed:', failureText(err)); }
    }, []);


    return {
        automationApi,
        automations, setAutomations,
        folders,
        automationsLoading,
        pendingDeleteAutomation, setPendingDeleteAutomation,
        steps,
        stepsLoading,
        activeRunIds,
        fetchAutomations,
        fetchFolders,
        createFolder,
        renameFolder,
        deleteFolder,
        moveToFolder,
        fetchSteps,
        onDeleteStep,
        toggleAutomation,
        requestDeleteAutomation,
        confirmDeleteAutomation,
        duplicateAutomation,
        exportAutomationJson,
        importAutomationFile,
        copyAutomationId,
    };
}

import { API_BASE, authFetch, parseSaveError } from '../../../../utils/helpers';

// Edit-handler factories for BuilderSplit, moved here verbatim. Each factory
// is called once per render from the exact position the handlers used to be
// defined at, and the handlers close over the deps object properties exactly
// as they closed over the parent scope before. No hooks in this module.

/** A category row from GET/POST /agents/categories. */
export interface CategoryRow {
    id: string;
    name?: string;
    existing?: boolean;
    [key: string]: unknown;
}

/** The mutable editor state the autosave reads from. */
type EditorStateRef = { current: Record<string, unknown> };

interface FieldUpdaterDeps {
    setName: (v: string) => void;
    setInstructions: (v: string) => void;
    setAvatar: (v: string) => void;
    memoryEnabled: boolean;
    setMemoryEnabled: (v: boolean) => void;
    useGeneralMemory: boolean;
    setUseGeneralMemory: (v: boolean) => void;
    attachedSkillIds: string[];
    setAttachedSkillIds: (v: string[]) => void;
    enabledIntegrations: string[] | null;
    setEnabledIntegrations: (v: string[]) => void;
    setKnowledgeBaseIds: (v: string[]) => void;
    setStrictKnowledge: (v: boolean) => void;
    setIncludeSourceReferences: (v: boolean) => void;
    setDescription: (v: string) => void;
    setModel: (v: string) => void;
    setSelectedTier: (v: string | null) => void;
    setCategoryId: (v: string | null) => void;
    stateRef: EditorStateRef;
    dirtyRef: { current: boolean };
    queueSave: (immediate: boolean) => void;
    patchConfig: (patch: Record<string, unknown>) => void;
}

export function createFieldUpdaters({ setName, setInstructions, setAvatar, memoryEnabled, setMemoryEnabled, useGeneralMemory, setUseGeneralMemory, attachedSkillIds, setAttachedSkillIds, enabledIntegrations, setEnabledIntegrations, setKnowledgeBaseIds, setStrictKnowledge, setIncludeSourceReferences, setDescription, setModel, setSelectedTier, setCategoryId, stateRef, dirtyRef, queueSave, patchConfig }: FieldUpdaterDeps) {
    // Typing: debounced.
    const updateName = (v: string) => { setName(v); stateRef.current.name = v; queueSave(false); };
    const updateInstructions = (v: string) => { setInstructions(v); stateRef.current.systemPrompt = v; queueSave(false); };
    // Discrete actions: save immediately so a quick navigation still persists.
    // Avatar is now written only to the canonical top-level column. Reads still
    // fall through to config.avatar via pickAgentAvatar so legacy agents keep
    // displaying until the one-shot backfill migration lands.
    const updateAvatar = (v: string) => {
        setAvatar(v);
        stateRef.current.avatar = v;
        queueSave(true);
    };
    const toggleMemory = () => {
        const next = !memoryEnabled;
        setMemoryEnabled(next);
        patchConfig({ memoryEnabled: next });
    };
    const toggleUseGeneralMemory = () => {
        const next = !useGeneralMemory;
        setUseGeneralMemory(next);
        patchConfig({ useGeneralMemory: next });
    };
    const toggleSkill = (id: string) => {
        const next = attachedSkillIds.includes(id) ? attachedSkillIds.filter(x => x !== id) : [...attachedSkillIds, id];
        setAttachedSkillIds(next);
        patchConfig({ attachedSkillIds: next });
    };
    const toggleIntegration = (id: string, available: { id: string }[]) => {
        // null = legacy "all enabled" — materialise the implicit list before toggling.
        const baseList = Array.isArray(enabledIntegrations)
            ? enabledIntegrations
            : available.map(a => a.id);
        const next = baseList.includes(id) ? baseList.filter(x => x !== id) : [...baseList, id];
        setEnabledIntegrations(next);
        patchConfig({ enabledIntegrations: next });
    };
    const onKnowledgeBaseIdsChange = (next: string[]) => {
        setKnowledgeBaseIds(next);
        patchConfig({ knowledge_base_ids: next });
    };
    const onStrictKnowledgeChange = (v: boolean) => { setStrictKnowledge(v); patchConfig({ strictKnowledge: v }); };
    const onIncludeSourceReferencesChange = (v: boolean) => { setIncludeSourceReferences(v); patchConfig({ includeSourceReferences: v }); };

    // Identity / model / category — typed fields debounce, dropdowns/toggles immediate.
    const updateDescription = (v: string) => { setDescription(v); stateRef.current.description = v; queueSave(false); };
    const updateModel = (tierName: string | null) => {
        const v = tierName ? `tier:${tierName}` : '';
        setModel(v);
        setSelectedTier(tierName);
        // model is a top-level agent column (not under config). Stash it on
        // stateRef so the save picks it up (also for drafts, so the first POST
        // includes it), then queue an immediate save (a no-op without an id).
        stateRef.current.model = v;
        queueSave(true);
    };
    const updateCategory = (id: string | null) => { setCategoryId(id); stateRef.current.categoryId = id; dirtyRef.current = true; queueSave(true); };

    return { updateName, updateInstructions, updateAvatar, toggleMemory, toggleUseGeneralMemory, toggleSkill, toggleIntegration, onKnowledgeBaseIdsChange, onStrictKnowledgeChange, onIncludeSourceReferencesChange, updateDescription, updateModel, updateCategory };
}

interface CategoryActionDeps {
    setCategories: (updater: (prev: CategoryRow[]) => CategoryRow[]) => void;
    updateCategory: (id: string | null) => void;
    bootstrap: { refreshCategories?: () => void };
    stateRef: EditorStateRef;
    flush: () => Promise<unknown>;
}

type CategoryResponse = CategoryRow & { error?: string; code?: string; count?: number };

export function createCategoryActions({ setCategories, updateCategory, bootstrap, stateRef, flush }: CategoryActionDeps) {
    // BFSF-272: category CRUD for the CategoryField manage popover. Every
    // mutation also refreshes the bootstrap provider — its mirror effect
    // (setCategories(bootstrap.categories) above) would otherwise resurrect
    // deleted/renamed rows on the next re-fire. Errors return inline
    // (rendered by CategoryField) instead of alert().
    const createCategory = async (name: string) => {
        const trimmed = name?.trim();
        if (!trimmed) return { ok: false, error: 'Name is required' };
        try {
            const res = await authFetch(`${API_BASE}/agents/categories`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmed }),
            });
            if (!res.ok) throw new Error(await res.text());
            const created = await res.json() as CategoryRow;
            // Idempotent create: `existing: true` = case-insensitive duplicate —
            // select the existing row, never append a doppelgänger option.
            setCategories(prev => (prev.some(c => c.id === created.id) ? prev : [...prev, created]));
            updateCategory(created.id);
            bootstrap.refreshCategories?.();
            return { ok: true, category: created, existed: !!created.existing };
        } catch (err) {
            return { ok: false, error: (err as Error).message || 'Failed to create category' };
        }
    };
    const renameCategory = async (id: string, name: string) => {
        try {
            const res = await authFetch(`${API_BASE}/agents/categories/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name }),
            });
            const data = await res.json().catch(() => ({})) as CategoryResponse;
            if (!res.ok) return { ok: false, error: data.error || 'Rename failed', code: data.code };
            setCategories(prev => prev.map(c => (c.id === id ? { ...c, ...data } : c)));
            bootstrap.refreshCategories?.();
            return { ok: true, category: data };
        } catch (err) {
            return { ok: false, error: (err as Error).message || 'Rename failed' };
        }
    };
    const deleteCategory = async (id: string, reassignTo?: string | null) => {
        try {
            // On the DEFINITIVE call (reassignTo set): if the open agent uses
            // this category, move it locally FIRST and flush the save. The
            // server-side reassign bumps `rev` on every agent still in the
            // category — pre-moving keeps this editor's baseVersion current
            // so the next autosave doesn't hit a spurious 409 conflict modal.
            // (Not on the bare first attempt: that may 409 with "in use" and
            // the user could still cancel.)
            if (reassignTo && stateRef.current.categoryId === id) {
                updateCategory(reassignTo !== 'none' ? reassignTo : null);
                try { await flush(); } catch (_) { /* best-effort */ }
            }
            const qs = reassignTo ? `?reassignTo=${encodeURIComponent(reassignTo)}` : '';
            const res = await authFetch(`${API_BASE}/agents/categories/${id}${qs}`, { method: 'DELETE' });
            const data = await res.json().catch(() => ({})) as CategoryResponse;
            if (!res.ok) return { ok: false, error: data.error || 'Delete failed', code: data.code, count: data.count };
            setCategories(prev => prev.filter(c => c.id !== id));
            // Bare-delete success while a DRAFT (unpersisted) agent still
            // points at the category — clear the dangling local selection.
            if (stateRef.current.categoryId === id) {
                updateCategory(null);
            }
            bootstrap.refreshCategories?.();
            return { ok: true };
        } catch (err) {
            return { ok: false, error: (err as Error).message || 'Delete failed' };
        }
    };

    return { createCategory, renameCategory, deleteCategory };
}

interface PublishActionDeps {
    agentIdRef: { current: string | null | undefined };
    isPublished: boolean;
    sharedGroups: string[];
    setIsPublished: (v: boolean) => void;
    setSharedGroups: (v: string[]) => void;
    setSaveErrorMsg: (v: string) => void;
}

export function createPublishActions({ agentIdRef, isPublished, sharedGroups, setIsPublished, setSharedGroups, setSaveErrorMsg }: PublishActionDeps) {
    // Publishing — uses the dedicated PATCH /agents/:id/publish endpoint instead
    // of the canonical PUT, since publish state lives in a column the regular
    // update path doesn't touch.
    const callPublish = async (next: boolean, groups: string[]) => {
        const id = agentIdRef.current;
        if (!id) return;
        try {
            const res = await authFetch(`${API_BASE}/agents/${id}/publish`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isPublished: next, sharedGroups: groups }),
            });
            if (!res.ok) {
                // Surface the real reason in the save banner. The old path did
                // `throw new Error(await res.text())` then `alert(err.message)`,
                // so a bodyless proxy error (e.g. NC session-bridge failure)
                // produced a BLANK popup and the share silently never applied
                // (BFSF-220). parseSaveError falls back to "Save failed (<status>)".
                const info = await parseSaveError(res);
                setSaveErrorMsg(info.message);
                return;  // don't flip optimistic state on failure
            }
            setIsPublished(next);
            setSharedGroups(groups);
            setSaveErrorMsg('');
        } catch (err) {
            console.error('Publish toggle failed:', err);
            setSaveErrorMsg(String((err as Error | null)?.message || err || 'Failed to update publish settings').slice(0, 500));
        }
    };
    const togglePublishedToOrg = () => {
        // "Publish to entire organisation" → empty sharedGroups.
        callPublish(!isPublished, []);
    };
    // Explicit setters for the three publish modes — used by the menu so the
    // user can switch directly between Personal / Entire Org / Specific
    // Groups without first toggling the master switch off and on.
    const setPublishPersonal = () => callPublish(false, []);
    const setPublishEntireOrg = () => callPublish(true, []);
    const togglePublishGroup = (gid: string) => {
        const next = sharedGroups.includes(gid) ? sharedGroups.filter(x => x !== gid) : [...sharedGroups, gid];
        // Setting any group implies published=true.
        callPublish(true, next);
    };

    return { togglePublishedToOrg, setPublishPersonal, setPublishEntireOrg, togglePublishGroup };
}

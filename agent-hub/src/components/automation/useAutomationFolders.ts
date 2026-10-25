import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type useAutomationApi from '../../hooks/useAutomationApi';
import { toast } from '../shared/Toast';
import type { AutomationFolder, AutomationListRow } from './useAutomationLibrary';

/** What a failed request said, for a toast the user can act on. */
const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Options {
    automationApi: ReturnType<typeof useAutomationApi>;
    automations: AutomationListRow[];
    setAutomations: Dispatch<SetStateAction<AutomationListRow[]>>;
    fetchAutomations: () => Promise<void>;
}

/**
 * The sidebar's folders: the nested tree (each folder with a `parentId`) and
 * every action on it. Each action is a call plus the refetch that keeps the list
 * true. The sidebar owns the naming input and the removal confirmation, so
 * nothing here reaches for window.prompt/confirm; failures land in the same
 * toast host as every other error in the view.
 */
export default function useAutomationFolders({ automationApi, automations, setAutomations, fetchAutomations }: Options) {
    const [folders, setFolders] = useState<AutomationFolder[]>([]);

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

    const createFolder = useCallback(async (name: string, parentId: string | null = null) => {
        if (!name || !name.trim()) return;
        try {
            await automationApi.createFolder(parentId ? { name: name.trim(), parentId } : { name: name.trim() });
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

    // The server refuses a loop, a tree that is too deep and a name taken in the
    // new parent, in words; they are shown as they come.
    const moveFolder = useCallback(async (id: string, parentId: string | null) => {
        const current = folders.find(f => f.id === id);
        if (!current || (current.parentId || null) === (parentId || null)) return;
        try {
            await automationApi.updateFolder(id, { parentId });
        } catch (err) {
            toast.error(failureText(err));
        }
        await fetchFolders();
    }, [automationApi, folders, fetchFolders]);

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
    }, [automationApi, automations, setAutomations, fetchFolders, fetchAutomations]);

    return { folders, fetchFolders, createFolder, renameFolder, moveFolder, deleteFolder, moveToFolder };
}

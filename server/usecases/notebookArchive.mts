/**
 * Archiving a notebook, as one sequence for every route that does it: the
 * Documents library (POST /api/studio-documents/notebooks/:id/archive) and the
 * older DELETE /api/notebooks/:id, which archives a live notebook so an app
 * version that still "deletes" can no longer lose one in a single tap.
 *
 * Owner-only (stores/notebookLibrary.setNotebookArchived). A co-edited project
 * notebook is folded back into its own row first, as a page is: once archived
 * nobody co-edits it. A task that linked it keeps existing; the link goes, as
 * for an archived document.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/** What happens around an archive and a delete for good. */
export interface NotebookLifecycle {
    beforeDelete: (kind: string, id: string, userId: string) => Promise<unknown>;
    dropTaskLinks: (kind: string, id: string) => Promise<unknown>;
    deleteForGood: (id: string, userId: string) => Promise<{ deleted: boolean; sources: number; kbs: number }>;
    forgetTokens: (id: string) => void;
}

/** The store calls an archive needs (stores/notebookLibrary). */
export interface ArchiveLibrary {
    setNotebookArchived: (userId: string, notebookId: string, archived: boolean) => Promise<unknown>;
    ownNotebookState?: (userId: string, notebookId: string) => Promise<{ archived: boolean } | null>;
}

const realLibrary = (): Required<ArchiveLibrary> => nodeRequire('../stores/notebookLibrary') as Required<ArchiveLibrary>;

interface Log { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void }

/** The lifecycle over the real modules, each required on use. */
export function realNotebookLifecycle(): NotebookLifecycle {
    return {
        beforeDelete: (kind, id, userId) => nodeRequire('../core/projectContent/itemLifecycle').beforeDelete(kind, id, userId),
        dropTaskLinks: (kind, id) => nodeRequire('../stores/projectTaskStore').dropLinksTo(null, kind, id),
        deleteForGood: (id, userId) => nodeRequire('../core/kb/notebookCascade').deleteNotebookCascade(id, userId),
        forgetTokens: (id) => nodeRequire('../core/dlp/dlpRunner').clearConversationState(id),
    };
}

/**
 * Archive `notebookId` for its owner `userId`. False when the caller does not
 * own it (or it is not there); archiving an archived notebook is still true.
 */
export async function archiveOwnNotebook(
    userId: string,
    notebookId: string,
    deps: { library?: ArchiveLibrary; lifecycle?: NotebookLifecycle } = {},
): Promise<boolean> {
    const lifecycle = deps.lifecycle ?? realNotebookLifecycle();
    const library = deps.library ?? realLibrary();
    await lifecycle.beforeDelete('notebook', notebookId, userId);
    if (!await library.setNotebookArchived(userId, notebookId, true)) return false;
    try {
        await lifecycle.dropTaskLinks('notebook', notebookId);
    } catch (err) {
        (nodeRequire('../telemetry/log') as Log).warn(`[Notebooks] task links to notebook ${notebookId} not dropped: ${(err as Error).message}`);
    }
    return true;
}

/**
 * The older DELETE /api/notebooks/:id: archive the owner's LIVE notebook and
 * answer true, so the app versions that still call it to delete one can no
 * longer lose it in a single tap (the owner restores it from the Documents
 * library's Archived view, and only from there deletes it for good). False for
 * an archived notebook, or one that is not the caller's: the route goes on to
 * its delete for good, which answers 404 to anybody but the owner.
 */
export async function archiveLiveNotebook(userId: string, notebookId: string): Promise<boolean> {
    const own = await realLibrary().ownNotebookState(userId, notebookId);
    if (!own || own.archived) return false;
    if (!await archiveOwnNotebook(userId, notebookId)) return false;
    (nodeRequire('../telemetry/log') as Log).info(`[Notebooks] archived ${notebookId} through DELETE`);
    return true;
}

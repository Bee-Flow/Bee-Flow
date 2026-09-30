/**
 * useNotebookCollab — whether this notebook is edited together, and how the
 * page should behave.
 *
 * A notebook filed in a collaborative workspace (or a legacy project) joins
 * the project's live co-editing session. While the editor follows that
 * session (`bound`) the session IS the save: the page sends no whole-document
 * saves at all. A session that is switched off, or that fails before its
 * first sync, leaves the notebook in its ordinary single-writer mode with
 * compare-and-set saves.
 *
 * Joining can hang (a proxy that buffers the stream, a server that is down):
 * after SLOW_MS the page offers to edit without the live session (`goSolo`),
 * and to try again later (`rejoin`). Nothing here interrupts typing.
 */
import { useEffect, useState } from 'react';
import useCollab, { type CollabHandle } from '../../../editor/collab/useCollab';
import { collabIsActive } from '../../../editor/react/useEditorCollab';
import type { NotebookSaveMode } from './NotebookSaveStatus';

const SLOW_MS = 8000;

interface Options {
    notebookId: string;
    projectId: string | null;
    eligible: boolean;
    user: { id: string; name?: string } | null;
}

export interface NotebookCollabState {
    handle: CollabHandle | null;
    /** The editor follows the live session: no local saves. */
    bound: boolean;
    /** Joining takes unusually long. */
    slow: boolean;
    /** The session ended after it had started (access revoked, item gone). */
    ended: boolean;
    /** The header's save status while co-edited, or null when not co-edited. */
    saveMode: NotebookSaveMode | null;
    goSolo: () => void;
    rejoin: () => void;
}

export default function useNotebookCollab({ notebookId, projectId, eligible, user }: Options): NotebookCollabState {
    const [solo, setSolo] = useState(false);
    const handle = useCollab({
        projectId,
        kind: 'notebook',
        resourceId: notebookId,
        enabled: eligible && !!projectId && !solo,
        user,
    });
    const active = collabIsActive(handle);
    const ready = !!handle?.ready;
    const [slow, setSlow] = useState(false);

    useEffect(() => {
        setSlow(false);
        if (!active || ready) return undefined;
        const timer = setTimeout(() => setSlow(true), SLOW_MS);
        return () => clearTimeout(timer);
    }, [active, ready]);

    const status = handle?.status || null;
    const ended = ready && (status === 'error' || status === 'disabled');
    let saveMode: NotebookSaveMode | null = null;
    if (active) {
        if (!ready) saveMode = 'connecting';
        else if (status === 'offline') saveMode = 'offline';
        else if (status === 'readonly' || !handle?.canEdit) saveMode = 'readonly';
        else if (!ended) saveMode = 'live';
    }

    return {
        handle: solo ? null : handle,
        bound: active,
        slow: slow && active && !ready,
        ended,
        saveMode,
        goSolo: () => setSolo(true),
        // From solo mode a new session starts by itself; otherwise the ended one is replaced.
        rejoin: () => { if (solo) setSolo(false); else handle?.retry(); },
    };
}

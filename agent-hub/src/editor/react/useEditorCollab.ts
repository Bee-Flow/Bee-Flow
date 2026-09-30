/**
 * useEditorCollab — BeeEditor's side of co-editing: bind the view to the
 * session's shared document once it is ready, unbind on teardown, and say
 * what the editor should do meanwhile.
 *
 *   active   the session is (or is becoming) the source of the content: the
 *            `content` prop and the save debounce are ignored;
 *   loading  joining, not yet synced: show the last saved content read-only;
 *   bound    the view edits the shared document;
 *   canEdit  whether typing is allowed (viewer, ended session → read-only).
 *
 * A session that is switched off or could not start before its first sync
 * leaves the editor in its ordinary single-writer mode, so the caller's own
 * save path keeps working.
 */
import { useEffect, useState } from 'react';
import { bindEditor, type CollabBinding } from '../collab/binding';
import type { CollabHandle } from '../collab/useCollab';

export interface EditorCollabState {
    active: boolean;
    loading: boolean;
    bound: boolean;
    canEdit: boolean;
    binding: CollabBinding | null;
}

export function collabIsActive(handle: CollabHandle | null | undefined): boolean {
    if (!handle) return false;
    if (handle.ready) return true;
    return handle.status === 'connecting';
}

export default function useEditorCollab(view: any, handle: CollabHandle | null | undefined): EditorCollabState {
    const [binding, setBinding] = useState<CollabBinding | null>(null);
    const ready = !!handle?.ready;
    const ydoc = handle?.ydoc || null;

    useEffect(() => {
        if (!view || !ready || !handle || !ydoc) return undefined;
        const b = bindEditor(view, {
            ydoc: handle.ydoc,
            fragment: handle.fragment,
            awareness: handle.awareness,
            // Codes only, never content: the view reloads from the shared state.
            onError: (e) => console.warn('[BeeEditor] a local change could not be shared; reloaded', (e as Error)?.name || 'Error'),
        });
        setBinding(b);
        return () => {
            b.destroy();
            setBinding((cur) => (cur === b ? null : cur));
        };
        // The handle object changes on every presence update; the document does not.
    }, [view, ready, ydoc]);

    const active = collabIsActive(handle);
    const bound = !!binding && active;
    const ended = handle?.status === 'error' || handle?.status === 'disabled';
    return {
        active,
        loading: active && !bound,
        bound,
        canEdit: bound && !!handle?.canEdit && !ended,
        binding: bound ? binding : null,
    };
}

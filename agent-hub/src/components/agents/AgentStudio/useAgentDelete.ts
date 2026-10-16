import { useEffect, useEffectEvent, useState } from 'react';
import { summariseDeleteBlock } from './deleteBlock';
import type { DeleteBlockBody } from './deleteBlock';
import { deleteAgentRequest } from '../../../api/agentStudio';
import { errorMessage } from '../../../utils/caughtError';

export type DeleteBlock = ReturnType<typeof summariseDeleteBlock>;
export interface DeleteTarget { id?: string | null; name?: string }

interface Options {
    /** Called once the server confirmed the delete of the agent with this id. */
    onDeleted: (id: string) => void;
    fetchAgents: () => Promise<void>;
}

/**
 * The delete flow of the agent grid: the confirmation dialog's state, the
 * DELETE call (with the 409 "still in use" second stage) and the keyboard
 * shortcuts of the dialog.
 */
export default function useAgentDelete({ onDeleted, fetchAgents }: Options) {
    const [pendingDelete, setPendingDelete] = useState<DeleteTarget | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    // The 409 from DELETE /agents/:id, read into "what uses this" + "what could
    // not be checked". Non-null puts the dialog in its second stage; it is the
    // ONLY way to reach the override, because the server requires ?confirm=1
    // and will not take an unconfirmed delete of an agent anything still uses.
    const [deleteBlocked, setDeleteBlocked] = useState<DeleteBlock | null>(null);

    // Open the in-app confirmation modal. The actual delete happens in confirmDelete().
    const requestDelete = (a: DeleteTarget | null | undefined) => {
        if (!a?.id) return;
        setDeleteError(null);
        setDeleteBlocked(null);
        setPendingDelete(a);
    };

    // `force` re-sends the same delete with ?confirm=1. That parameter is not
    // decoration: without it the server refuses to delete an agent that
    // anything still uses — and it refuses just as firmly when it could not
    // check. Until this second stage existed, no client sent it at all, so
    // deleting a published agent any colleague had chatted with simply failed
    // with a raw JSON body in the error line.
    const confirmDelete = async (force = false) => {
        const a = pendingDelete;
        if (!a?.id || deleting) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            const res = await deleteAgentRequest(a.id, force);
            // 409 is not an error to show as text — it is the answer to
            // "what would this break", and it belongs in the dialog. Reading
            // it must never turn an unparsable body into "nothing uses this":
            // summariseDeleteBlock reports every kind as unchecked instead.
            if (res.status === 409) {
                let body: DeleteBlockBody | null = null;
                try { body = await res.json(); } catch (_) { /* leave null: unreadable */ }
                setDeleteBlocked(summariseDeleteBlock(body));
                return;
            }
            if (!res.ok) {
                // Guard res.text() — an HTML error page or a body-less response
                // would otherwise reject inside the throw, swallowing the real
                // status code.
                let detail = '';
                try { detail = await res.text(); } catch (_) { /* ignore */ }
                throw new Error(detail || `HTTP ${res.status}`);
            }
            onDeleted(a.id);
            // Close the modal first so the user sees the action complete; the
            // refresh runs in the background and any failure surfaces via the
            // load-error banner rather than blocking the modal.
            setPendingDelete(null);
            fetchAgents();
        } catch (err) {
            setDeleteError(errorMessage(err) ?? null);
        } finally {
            setDeleting(false);
        }
    };

    // Escape closes the delete-confirm modal (when not in-flight).
    const confirmDeleteFromKey = useEffectEvent(() => confirmDelete());
    useEffect(() => {
        if (!pendingDelete) return undefined;
        const onKey = (e: KeyboardEvent) => {
            if (deleting) return;
            if (e.key === 'Escape') { setPendingDelete(null); return; }
            // Power-user accelerator: Cmd/Ctrl + Enter triggers the destructive
            // action, matching the pattern used by browser print dialogs and
            // most modal-confirm UIs.
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                confirmDeleteFromKey();
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [pendingDelete, deleting]);

    const dismissDelete = () => { if (!deleting) setPendingDelete(null); };
    const cancelDelete = () => { setDeleteError(null); setDeleteBlocked(null); setPendingDelete(null); };

    return { pendingDelete, deleting, deleteError, deleteBlocked, requestDelete, confirmDelete, dismissDelete, cancelDelete };
}

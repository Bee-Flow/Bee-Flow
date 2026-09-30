/**
 * useSessionJoin — join the live co-editing session after a save was refused
 * because the notebook is edited together right now (409 COLLAB_ACTIVE).
 *
 * Saving waits meanwhile (useDocumentAutosave holds it). This hook starts a
 * FRESH session and follows only that one, so what the page says is true:
 *
 *   joined         the session owns the document now; saving resumes (the
 *                  session saves);
 *   not co-edited  the server says the notebook is not edited together after
 *                  all: the page saves on its own again;
 *   failed         the session could not start: saving stays paused, so no
 *                  refused save piles up another copy in the history, and the
 *                  person is told so and can try again.
 *
 * It used to say "you joined the live session" whatever happened, and a
 * "rejoin" that changed nothing left the page in a silent fork.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '../../../hooks/useTranslation';
import type { NoticeWithAction } from './NotebookNotice';
import type { NotebookCollabState } from './useNotebookCollab';

interface Options {
    collab: NotebookCollabState;
    onNotice: (notice: NoticeWithAction | null) => void;
    onShowHistory: () => void;
    /** Saving may go again (joined, or not co-edited after all). */
    resume: () => void;
}

type Outcome = 'joined' | 'not_coedited' | 'failed' | null;

/** How a join that started from `from` stands (null: the new session has not answered yet). */
function outcomeOf(handle: NotebookCollabState['handle'], from: unknown): Outcome {
    if (!handle || handle.ydoc === from) return null;
    if (handle.ready) return 'joined';
    if (handle.status === 'disabled') return 'not_coedited';
    if (handle.status === 'error') return 'failed';
    return null;
}

export default function useSessionJoin({ collab, onNotice, onShowHistory, resume }: Options) {
    const { t } = useTranslation();
    const [joining, setJoining] = useState(false);
    // The session the join started from (a failed or stale one): only a NEW session answers.
    const fromRef = useRef<unknown>(undefined);
    const keptRef = useRef<string | null>(null);
    const { handle, rejoin } = collab;

    const start = useCallback((keptVersionId?: string | null) => {
        if (keptVersionId !== undefined) keptRef.current = keptVersionId;
        fromRef.current = handle?.ydoc ?? null;
        setJoining(true);
        onNotice({ kind: 'info', message: t('notebooks.collab_joining', 'This notebook is being edited together now. Joining the live session…'), action: null });
        rejoin();
    }, [handle, onNotice, rejoin, t]);

    const history = useCallback(() => ({ label: t('notebooks.show_history', 'Show history'), onClick: onShowHistory }), [onShowHistory, t]);

    useEffect(() => {
        if (!joining) return;
        const outcome = outcomeOf(handle, fromRef.current);
        if (outcome === 'failed') {
            fromRef.current = handle?.ydoc ?? null;
            onNotice({
                kind: 'error',
                message: t('notebooks.collab_join_failed', 'The live session could not be joined, so what you type now is not saved yet. It stays on this page; try again in a moment.'),
                action: { label: t('notebooks.collab_try_again', 'Try again'), onClick: () => start() },
            });
            return;
        }
        if (!outcome) return;
        setJoining(false);
        resume();
        if (outcome === 'not_coedited') { onNotice(null); return; }
        const kept = keptRef.current;
        onNotice({
            kind: 'info',
            message: kept
                ? t('notebooks.collab_joined_kept', 'This notebook is being edited together now, so you joined the live session. The text you had not saved yet is kept in the version history.')
                : t('notebooks.collab_joined', 'This notebook is being edited together now, so you joined the live session.'),
            action: kept ? history() : null,
        });
    }, [joining, handle, history, onNotice, resume, start, t]);

    return { joining, start };
}

/**
 * Where a draft card stands — waiting, working, done, saved, discarded,
 * failed — kept per draft for the app session.
 *
 * Module state rather than component state for the reason ratings.ts gives:
 * the transcript is a FlatList, a card scrolled far enough away unmounts,
 * and an e-mail that was sent must not come back offering "Send" again.
 * Not persisted: the server records what it carried out (a saved draft's
 * `status`), and that is what a reload shows.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { describeError } from '@/core/api/errors';

export type DraftStatus = 'pending' | 'working' | 'saving' | 'done' | 'saved' | 'discarded' | 'failed';

export interface DraftState {
    status: DraftStatus;
    /** The server's reason, on `failed`. */
    error?: string;
    /** Gmail's link to a saved draft, on `saved`. */
    link?: string | null;
}

const states = new Map<string, DraftState>();
const listeners = new Set<() => void>();

function set(key: string, state: DraftState): void {
    states.set(key, state);
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** What the server says a stored draft already is: sent and done are the same thing to a card. */
function initialOf(serverStatus: unknown): DraftState {
    return serverStatus === 'sent' || serverStatus === 'done' || serverStatus === 'executed' ? { status: 'done' } : { status: 'pending' };
}

export function useDraftAction(key: string, serverStatus?: unknown) {
    const read = () => states.get(key);
    const state = useSyncExternalStore(subscribe, read, read) ?? initialOf(serverStatus);

    /** Run the action once; `saving` for "Save as draft", whose success is `saved`. */
    const run = useCallback(
        (action: () => Promise<string | null | void>, { saving = false }: { saving?: boolean } = {}) => {
            const current = states.get(key)?.status;
            if (current === 'working' || current === 'saving') return;
            set(key, { status: saving ? 'saving' : 'working' });
            action()
                .then((link) => set(key, saving ? { status: 'saved', link: link ?? null } : { status: 'done' }))
                .catch((err: unknown) => set(key, { status: 'failed', error: describeError(err).message }));
        },
        [key],
    );
    const discard = useCallback(() => set(key, { status: 'discarded' }), [key]);

    return { ...state, run, discard };
}

/** Test seam. */
export function _resetDraftActions(): void {
    states.clear();
}

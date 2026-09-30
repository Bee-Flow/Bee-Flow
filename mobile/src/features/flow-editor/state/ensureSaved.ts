/**
 * Before anything reads the STORED definition — a test run, activation, a
 * version restore, a webhook for a trigger that was just added, an AI turn —
 * the server has to hold what is on screen. Otherwise the step run tests the
 * previous version, activation validates it, and the AI builds on top of it
 * and then overwrites the edits it never saw.
 */

import { translate } from '@/core/i18n';

import { peekDraftStore } from './registry';
import type { SaveError } from './types';

/** The latest edits could not be saved; carries why. */
export class UnsavedDraftError extends Error {
    constructor(readonly saveError: SaveError | null) {
        super(
            translate(
                'mobile.flow.unsaved_changes',
                'Your latest changes are not saved yet, so this would use an older version of the routine.',
            ),
        );
        this.name = 'UnsavedDraftError';
    }
}

/**
 * Flush the open draft for `flowKey` (a routine id, or a new routine's draft
 * key), creating the row if it does not exist yet, and answer the routine's
 * id. With no editor open for it, the key IS the id and there is nothing to
 * flush. Throws UnsavedDraftError when the save fails.
 */
export async function ensureDraftSaved(flowKey: string): Promise<string> {
    const store = peekDraftStore(flowKey);
    if (!store) return flowKey;
    const id = store.getState().automationId ?? (await store.getState().ensureCreated());
    const saved = await store.getState().flush();
    if (!saved) throw new UnsavedDraftError(store.getState().saveError);
    return id;
}

/** The routine id behind a key, without saving anything; null for a routine not created yet. Not reactive: see useFlowId. */
export function automationIdFor(flowKey: string): string | null {
    const store = peekDraftStore(flowKey);
    return store ? store.getState().automationId : flowKey;
}

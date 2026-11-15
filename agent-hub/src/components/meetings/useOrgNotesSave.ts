// The Save of the org-level Meeting Notes cards (Google Meet, Nextcloud Talk):
// the whole form PUT back (the server rebuilds the stored document from the
// body, no merge), and the reason in words when it fails, for the card's
// SaveFooter.

import { useState } from 'react';
import { apiRequest } from '@/api/typedRequest';
import { errorBody, RefusedError } from '@/api/mutate';
import { errorMessage } from '@/utils/caughtError';

/** The meeting source whose org settings are saved. */
export type OrgNotesSource = 'gmeet' | 'talk';

function put(source: OrgNotesSource, orgId: string, cfg: object): Promise<Response> {
    const init = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) };
    return source === 'gmeet'
        ? apiRequest('PUT /api/gmeet-notes-settings/{orgId}', { params: { orgId }, init })
        : apiRequest('PUT /api/talk-notes-settings/{orgId}', { params: { orgId }, init });
}

/** PUT the whole form: null when it was saved, else the refusal's own error text (or the failure's, '' without one). */
async function saveOrgNotesSettings(source: OrgNotesSource, orgId: string, cfg: object): Promise<string | null> {
    try {
        await put(source, orgId, cfg);
        return null;
    } catch (err) {
        // A failure without a message is still a failure: '' (no text), never null (saved).
        if (!(err instanceof RefusedError)) return errorMessage(err) ?? '';
        return errorBody(err)?.error || `HTTP ${err.status}`;
    }
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** The card's save: its SaveFooter state, the failure text, and save() for the form as it is now. */
export function useOrgNotesSave(source: OrgNotesSource, orgId: string | null | undefined, cfg: object) {
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [error, setError] = useState<string | null>(null);
    const save = async () => {
        if (!orgId) return;
        setSaveState('saving'); setError(null);
        const failure = await saveOrgNotesSettings(source, orgId, cfg);
        setError(failure);
        setSaveState(failure === null ? 'saved' : 'error');
    };
    return { saveState, error, saving: saveState === 'saving', save };
}

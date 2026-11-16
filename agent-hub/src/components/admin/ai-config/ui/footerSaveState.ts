import type { StatusMessage } from '../chatModelTiers/tierTypes';

export type FooterSaveState = 'idle' | 'saving' | 'saved' | 'error';

/** The SaveFooter status of a form that keeps `saving`, its last message and when it last saved. */
export function footerSaveState(saving: boolean, message: StatusMessage | null, lastSavedAt: Date | null): FooterSaveState {
    if (saving) return 'saving';
    if (message?.type === 'error') return 'error';
    return lastSavedAt ? 'saved' : 'idle';
}

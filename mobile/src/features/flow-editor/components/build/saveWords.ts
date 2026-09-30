/**
 * What the autosave is doing, in words: the header's subline says it
 * quietly ("Saving…", "Saved"), and a failed save gets a banner of its own
 * with Try again (SaveBanner).
 */

import { describeError } from '@/core/api/errors';
import type { TranslateFn } from '@/core/i18n';
import type { DraftState } from '@/features/flow-editor/state';

export function saveWords(state: Pick<DraftState, 'status' | 'saveError'>, t: TranslateFn): { text: string; error: boolean } {
    switch (state.status) {
        case 'pending':
            return { text: t('mobile.flow.save.pending', 'Unsaved changes'), error: false };
        case 'saving':
            return { text: t('common.saving', 'Saving…'), error: false };
        case 'saved':
            return { text: t('common.saved', 'Saved'), error: false };
        case 'error': {
            const why = state.saveError ? describeError(state.saveError.error).message : '';
            const retrying = state.saveError?.willRetry ? t('mobile.flow.save.retrying', 'trying again') : '';
            return { text: [t('routines.header.save_failed', 'Not saved'), retrying || why].filter(Boolean).join(' — '), error: true };
        }
        default:
            return { text: '', error: false };
    }
}

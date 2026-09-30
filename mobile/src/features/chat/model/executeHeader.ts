/**
 * The header of a draft carried out through an execute route — calendar,
 * contacts, Keep (DraftCardShell.jsx's chain): "{action} ✓", "Discarded",
 * the working word, "Failed", or "{action} — Awaiting Approval".
 */

import type { TranslateFn } from '@/core/i18n';

import type { DraftState } from '../hooks/useDraftAction';

export function executeHeader(state: DraftState, action: string, working: string, t: TranslateFn): string {
    switch (state.status) {
        case 'done':
        case 'saved':
            return t('chat.draft.done', '{action} ✓', { action });
        case 'discarded':
            return t('chat.draft.discarded', 'Discarded');
        case 'working':
        case 'saving':
            return working;
        case 'failed':
            return t('chat.draft.failed', 'Failed');
        default:
            return t('chat.draft.awaiting_approval', '{action} — Awaiting Approval', { action });
    }
}

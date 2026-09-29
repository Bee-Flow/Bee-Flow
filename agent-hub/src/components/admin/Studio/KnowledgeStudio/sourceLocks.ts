import type { TranslateFn } from '../../../../hooks/useTranslation';
import { licenceRefusal, useCapabilityLock, type LockReason } from '../Datatables/CapabilityLock';

/**
 * The two knowledge-source features that sit on a plan:
 *
 *   kb_datatable_sources  pointing a knowledge base at a datatable;
 *   kb_scheduled_refresh  refreshing a source on a schedule.
 *
 * Both lock NEW use only, and the words say so, because the two things a
 * person most needs to hear next to a lock are what still works: table
 * sources that already exist keep syncing, and refreshing by hand is free.
 * The server draws the same line (routes/knowledgeBases/sources.js).
 */

export type SourceLocks = { datatable: LockReason; schedule: LockReason };

/** Which of the two are locked for this viewer; null while unknown. */
export function useSourceLocks(): SourceLocks {
    return {
        datatable: useCapabilityLock('kb_datatable_sources'),
        schedule: useCapabilityLock('kb_scheduled_refresh'),
    };
}

export function datatableLockText(t: TranslateFn, reason: LockReason): string {
    return reason === 'not_granted'
        ? t('knowledge.locked.datatable_not_granted', 'Tables as knowledge sources are not switched on for your organisation. Ask an admin. Table sources you already have keep working.')
        : t('knowledge.locked.datatable', 'Tables as knowledge sources are available on a higher plan. Table sources you already have keep working.');
}

export function scheduleLockText(t: TranslateFn, reason: LockReason): string {
    return reason === 'not_granted'
        ? t('knowledge.locked.schedule_not_granted', 'Refreshing on a schedule is not switched on for your organisation. Ask an admin. Refreshing when you ask always works.')
        : t('knowledge.locked.schedule', 'Refreshing on a schedule is available on a higher plan. Refreshing when you ask always works.');
}

/**
 * A server licence refusal about a source, in words, or null when the error
 * was about something else. The refusal names its capability in
 * `body.feature`, which decides whose sentence it is.
 */
export function sourceLicenceMessage(t: TranslateFn, e: unknown): string | null {
    const reason = licenceRefusal(e);
    if (!reason) return null;
    const feature = (e as { body?: { feature?: string } | null } | null)?.body?.feature;
    if (feature === 'kb_scheduled_refresh') return scheduleLockText(t, reason);
    if (feature === 'kb_datatable_sources') return datatableLockText(t, reason);
    return reason === 'not_granted'
        ? t('knowledge.locked.other_not_granted', 'That is not switched on for your organisation. Ask an admin.')
        : t('knowledge.locked.other', 'That is available on a higher plan.');
}

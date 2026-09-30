/**
 * The one line a locked row carries — the web's studioLockHint
 * (studioApps.jsx), with its keys, so an administrator's translation of the
 * browser's hint reaches the phone too. `t` comes in as a parameter so this
 * stays pure.
 */

import type { TranslateFn } from '@/core/i18n';

import type { LockReason } from './types';

export function lockHint(reason: LockReason, t: TranslateFn): string {
    if (reason === 'not_granted') {
        return t('studio.locked_not_granted', 'Not switched on for your organisation — ask an admin');
    }
    if (reason === 'training') return t('studio.locked_training', 'Finish the required course first');
    return t('studio.locked_upgrade', 'Available on a higher plan');
}

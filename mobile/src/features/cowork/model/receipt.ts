/** What a run's receipt says in a history row: its number, and whether it carries a valid signature. */

import type { TranslateFn } from '@/core/i18n';

import type { CoworkReceipt } from './types';

export function receiptLabel(receipt: Pick<CoworkReceipt, 'seq' | 'signed'>, t: TranslateFn): string {
    return receipt.signed
        ? t('cowork_mobile.receipt.signed', 'Receipt #{seq} · signed', { seq: receipt.seq })
        : t('cowork_mobile.receipt.unsigned', 'Receipt #{seq} · not signed', { seq: receipt.seq });
}

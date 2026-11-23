/**
 * "Receipt #3 · signed" under an opened run. Read only when mounted, which the
 * history does for the opened row alone; no receipt yet (404), or a failed
 * read, shows nothing: the run's own line already says what happened.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Text } from '@/shared/ui';

import { useRunReceipt } from '../hooks/queries';
import { receiptLabel } from '../model/receipt';

export function ReceiptNote({ scheduleId, runId }: { scheduleId: string; runId: string }) {
    const t = useTranslation();
    const receipt = useRunReceipt(scheduleId, runId, true);
    if (!receipt.data) return null;
    return (
        <Text variant="caption" tone="tertiary" testID="cowork-receipt">
            {receiptLabel(receipt.data, t)}
        </Text>
    );
}

/**
 * Delete an automation, after asking what uses it: the app buttons that start it
 * (useAutomationUsage) in the shared guarded-delete sheet. The sheet opens
 * once the check has answered — an empty list shown while it is still asking
 * would read as "nothing uses this".
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { GuardedDeleteSheet, useToast } from '@/shared/ui';

import { useAutomationUsage, useDeleteAutomation } from '../hooks/lifecycle';
import type { Automation } from '../model/types';
import { usageGuard } from '../model/usageGuard';

export function DeleteAutomationSheet({
    automation,
    onClose,
    onDeleted,
    requireName = false,
}: {
    /** The automation to delete (its id and name are all the sheet reads); closed while this is null. */
    automation: Pick<Automation, 'id' | 'title'> | null;
    onClose: () => void;
    onDeleted?: () => void;
    /** Ask for the name to be typed even when nothing uses the automation (a form's danger zone does). */
    requireName?: boolean;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const usage = useAutomationUsage(automation?.id ?? '', automation !== null);
    const remove = useDeleteAutomation({
        onSuccess: () => {
            toast(t('mobile.automations.deleted', 'Automation deleted'), 'success');
            onClose();
            onDeleted?.();
        },
        onError: (err) => toast(describeError(err).message, 'error'),
    });
    // Fresh every time (staleTime 0): a cached answer from an earlier delete is not this one's.
    const settled = automation !== null && !usage.isFetching;
    return (
        <GuardedDeleteSheet
            guard={settled ? usageGuard(usage.data, usage.isError) : null}
            name={automation?.title ?? ''}
            requireName={requireName}
            busy={remove.isPending}
            onConfirm={() => automation && remove.mutate(automation.id)}
            onCancel={onClose}
        />
    );
}

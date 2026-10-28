/**
 * Forget the selected memories. The route silently skips rows the caller may
 * not touch, so the count it returns is the truth — never the number asked for.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useForgetMemories } from '../hooks/mutations';

export function ForgetSelectedSheet({
    visible,
    ids,
    onCancel,
    onForgotten,
}: {
    visible: boolean;
    ids: readonly string[];
    onCancel: () => void;
    onForgotten: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const removeMany = useForgetMemories({
        onSuccess: (deleted) => {
            toast(
                deleted === 1
                    ? t('chat.memory.forgotten', 'Forgotten')
                    : t('mobile.memory.n_forgotten', '{count} forgotten', { count: deleted }),
                'success',
            );
            onForgotten();
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });
    const count = ids.length;

    return (
        <ConfirmSheet
            visible={visible}
            title={nOf(t, 'mobile.memory.forget_selected_title', count, ['Forget this one?', 'Forget these {count}?'])}
            message={t(
                'mobile.memory.forget_selected_message',
                'They are deleted from the server, and Bee Flow stops using them in new conversations. Answers it already gave keep whatever they were based on. This cannot be undone.',
            )}
            confirmLabel={nOf(t, 'mobile.memory.forget_selected_confirm', count, ['Forget it', 'Forget {count}'])}
            busy={removeMany.isPending}
            onCancel={onCancel}
            onConfirm={() => removeMany.mutate([...ids])}
        />
    );
}

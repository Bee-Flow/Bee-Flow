/** Forget one memory, quoting enough of it to recognise, and saying what forgetting means. */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useForgetMemory } from '../hooks/mutations';
import { memoryLine, truncate } from '../model/format';
import type { Memory } from '../model/types';

export function ForgetMemorySheet({ memory, onDone }: { memory: Memory | null; onDone: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const removeOne = useForgetMemory({
        onSuccess: () => {
            toast(t('chat.memory.forgotten', 'Forgotten'), 'success');
            onDone();
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    return (
        <ConfirmSheet
            visible={Boolean(memory)}
            title={t('mobile.memory.forget_title', 'Forget this?')}
            message={
                memory
                    ? t(
                          'mobile.memory.forget_message',
                          '“{line}”\n\nIt is deleted from the server, and Bee Flow stops using it in new conversations. Answers it already gave keep whatever they were based on. This cannot be undone.',
                          { line: truncate(memoryLine(memory)) },
                      )
                    : ''
            }
            confirmLabel={t('mobile.memory.forget_it', 'Forget it')}
            busy={removeOne.isPending}
            onCancel={onDone}
            onConfirm={() => memory && removeOne.mutate(memory.id)}
        />
    );
}

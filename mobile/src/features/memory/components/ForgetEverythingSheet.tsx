/**
 * Forget everything. The message names what goes (every personal memory) and
 * what stays (conversations, notebooks, files, and anything shared with a
 * project team), because clearAllMemories really deletes the rows.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { nOf } from '@/shared/lib/plural';
import { ConfirmSheet, useToast } from '@/shared/ui';

import { useForgetEverything } from '../hooks/mutations';

export function ForgetEverythingSheet({
    visible,
    total,
    onCancel,
    onForgotten,
}: {
    visible: boolean;
    total: number;
    onCancel: () => void;
    onForgotten: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const clearAll = useForgetEverything({
        onSuccess: () => {
            toast(t('mobile.memory.everything_forgotten', 'Everything forgotten'), 'success');
            onForgotten();
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    return (
        <ConfirmSheet
            visible={visible}
            title={t('mobile.memory.forget_everything_title', 'Forget everything?')}
            message={nOf(t, 'mobile.memory.forget_everything_message', total, [
                'All {count} thing Bee Flow remembers about you is deleted from the server — preferences, people, projects, standing instructions, the lot. Your conversations, notebooks and files are untouched, and so is anything shared with a project team. Bee Flow starts over knowing nothing about you. This cannot be undone.',
                'All {count} things Bee Flow remembers about you are deleted from the server — preferences, people, projects, standing instructions, the lot. Your conversations, notebooks and files are untouched, and so is anything shared with a project team. Bee Flow starts over knowing nothing about you. This cannot be undone.',
            ])}
            confirmLabel={t('mobile.memory.forget_everything', 'Forget everything')}
            busy={clearAll.isPending}
            onCancel={onCancel}
            onConfirm={() => clearAll.mutate()}
        />
    );
}

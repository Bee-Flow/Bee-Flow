/**
 * Forget everything. The message names what goes (every personal memory) and
 * what stays (conversations, notebooks, files, and anything shared with a
 * project team), because clearAllMemories really deletes the rows.
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
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
    const { toast } = useToast();
    const clearAll = useForgetEverything({
        onSuccess: () => {
            toast('Everything forgotten', 'success');
            onForgotten();
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });

    return (
        <ConfirmSheet
            visible={visible}
            title="Forget everything?"
            message={`All ${total} thing${total === 1 ? '' : 's'} Bee Flow remembers about you ${total === 1 ? 'is' : 'are'} deleted from the server — preferences, people, projects, standing instructions, the lot. Your conversations, notebooks and files are untouched, and so is anything shared with a project team. Bee Flow starts over knowing nothing about you. This cannot be undone.`}
            confirmLabel="Forget everything"
            busy={clearAll.isPending}
            onCancel={onCancel}
            onConfirm={() => clearAll.mutate()}
        />
    );
}

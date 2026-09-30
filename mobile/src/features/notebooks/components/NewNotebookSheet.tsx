/** Create a notebook: a name is enough; sources come once it exists. */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Button, Sheet, Text, TextField } from '@/shared/ui';

import { useCreateNotebook } from '../hooks/mutations';
import type { Notebook } from '../model/types';

export function NewNotebookSheet({
    visible,
    onClose,
    onCreated,
}: {
    visible: boolean;
    onClose: () => void;
    onCreated: (notebook: Notebook | null) => void;
}) {
    const t = useTranslation();
    const [name, setName] = useState('');
    const create = useCreateNotebook({
        onSuccess: (notebook) => {
            setName('');
            onCreated(notebook);
        },
    });
    const submit = () => {
        if (name.trim()) create.mutate(name.trim());
    };

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('notebooks.new_notebook', 'New Notebook')}
            subtitle={t('notebooks.new_notebook_hint', 'Give it a name to get started')}
        >
            <TextField
                label={t('notebooks.sort_name', 'Name')}
                value={name}
                onChangeText={setName}
                autoFocus
                placeholder={t('notebooks.name_placeholder', 'Notebook name…')}
                onSubmitEditing={submit}
            />
            {create.isError ? (
                <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                    {describeError(create.error).message}
                </Text>
            ) : null}
            <Button
                label={t('notebooks.create', 'Create')}
                fullWidth
                loading={create.isPending}
                disabled={name.trim().length === 0}
                onPress={submit}
            />
        </Sheet>
    );
}

/** Rename and re-describe a routine. Its steps are the flow editor's (Edit flow). */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Banner, Button, Sheet, TextField, useToast } from '@/shared/ui';

import { useUpdateAutomation } from '../hooks/mutations';
import type { Automation } from '../model/types';

export function AutomationEditSheet({
    visible,
    automation,
    onClose,
}: {
    visible: boolean;
    automation: Automation;
    onClose: () => void;
}) {
    const t = useTranslation();
    const { toast } = useToast();
    const [title, setTitle] = useState(automation.title ?? '');
    const [description, setDescription] = useState(automation.description ?? '');

    const mutation = useUpdateAutomation(automation.id, {
        onSuccess: () => {
            toast(t('common.saved', 'Saved'), 'success');
            onClose();
        },
    });

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('mobile.automations.rename', 'Rename')}
            subtitle={t('mobile.automations.rename_subtitle', 'Its name, and what it is for.')}
            footer={
                <Button
                    label={t('common.save', 'Save')}
                    onPress={() => mutation.mutate({ title: title.trim(), description: description.trim() })}
                    disabled={!title.trim()}
                    loading={mutation.isPending}
                    fullWidth
                    size="lg"
                />
            }
        >
            {mutation.isError ? (
                <Banner tone="error">{describeError(mutation.error).message}</Banner>
            ) : null}
            <TextField label={t('common.name', 'Name')} value={title} onChangeText={setTitle} autoCapitalize="sentences" />
            <TextField
                label={t('common.description', 'Description')}
                value={description}
                onChangeText={setDescription}
                multiline
                maxLines={5}
                autoCapitalize="sentences"
                hint={t('mobile.automations.description_hint', 'What this routine is for, in a sentence.')}
            />
        </Sheet>
    );
}

/** Create a knowledge base: a name, and a sentence agents read to decide when to search it. */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { Banner, Button, Sheet, TextField } from '@/shared/ui';

import { useCreateKnowledgeBase } from '../hooks/mutations';
import type { KnowledgeBase } from '../model/types';

export function NewKnowledgeBaseSheet({
    visible,
    onClose,
    onCreated,
}: {
    visible: boolean;
    onClose: () => void;
    onCreated: (kb: KnowledgeBase | null) => void;
}) {
    const t = useTranslation();
    const [name, setName] = useState('');
    const [description, setDescription] = useState('');
    const create = useCreateKnowledgeBase({
        onSuccess: (kb) => {
            setName('');
            setDescription('');
            onCreated(kb);
        },
    });

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={t('knowledge.new', 'New knowledge base')}
            subtitle={t('mobile.knowledge.new_subtitle', 'It starts empty — add documents next')}
        >
            <TextField
                label={t('knowledge.form.name', 'Name')}
                value={name}
                onChangeText={setName}
                autoFocus
                placeholder={t('mobile.knowledge.new_name_placeholder', 'Policies')}
            />
            <TextField
                label={t('mobile.knowledge.new_purpose', 'What is it for?')}
                value={description}
                onChangeText={setDescription}
                multiline
                maxLines={4}
                placeholder={t('mobile.knowledge.new_purpose_placeholder', 'Everything HR publishes internally.')}
                hint={t('mobile.knowledge.new_purpose_hint', 'Agents read this to decide when to search here, so a plain sentence helps.')}
            />
            {create.isError ? <Banner tone="error">{describeError(create.error).message}</Banner> : null}
            <Button
                label={t('common.create', 'Create')}
                fullWidth
                loading={create.isPending}
                disabled={name.trim().length === 0}
                onPress={() => create.mutate({ name: name.trim(), description: description.trim() })}
            />
        </Sheet>
    );
}

/** Create a knowledge base: a name, and a sentence agents read to decide when to search it. */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
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
            title="New knowledge base"
            subtitle="It starts empty — add documents next"
        >
            <TextField label="Name" value={name} onChangeText={setName} autoFocus placeholder="Policies" />
            <TextField
                label="What is it for?"
                value={description}
                onChangeText={setDescription}
                multiline
                maxLines={4}
                placeholder="Everything HR publishes internally."
                hint="Agents read this to decide when to search here, so a plain sentence helps."
            />
            {create.isError ? <Banner tone="error">{describeError(create.error).message}</Banner> : null}
            <Button
                label="Create"
                fullWidth
                loading={create.isPending}
                disabled={name.trim().length === 0}
                onPress={() => create.mutate({ name: name.trim(), description: description.trim() })}
            />
        </Sheet>
    );
}

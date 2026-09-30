/**
 * The name and "what is in it" of a knowledge base, saved when the field is
 * left (the web's SettingsTab NameFields commit on blur). The description is
 * what an agent reads to decide whether to look here.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { TextField } from '@/shared/ui';

import type { KbSettingsPatch } from '../api/manageEndpoints';
import type { KnowledgeBase } from '../model/types';

export function KbNameFields({ kb, disabled, onSave }: { kb: KnowledgeBase; disabled: boolean; onSave: (patch: KbSettingsPatch) => void }) {
    const t = useTranslation();
    const [name, setName] = useState(kb.name);
    const [description, setDescription] = useState(kb.description ?? '');
    return (
        <>
            <TextField
                label={t('knowledge.settings.name', 'Name')}
                value={name}
                editable={!disabled}
                onChangeText={setName}
                onBlur={() => {
                    const next = name.trim();
                    if (next && next !== kb.name) onSave({ name: next });
                }}
                testID="kb-settings-name"
            />
            <TextField
                label={t('knowledge.settings.description', 'What is in it')}
                value={description}
                editable={!disabled}
                multiline
                maxLines={5}
                placeholder={t('knowledge.settings.description_hint', 'A sentence an agent can read to decide whether to look here.')}
                onChangeText={setDescription}
                onBlur={() => {
                    if (description !== (kb.description ?? '')) onSave({ description });
                }}
            />
        </>
    );
}

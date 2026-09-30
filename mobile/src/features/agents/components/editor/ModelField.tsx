/** The model the agent answers with: the org default or one of the person's tiers. */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import type { AgentForm } from '@/features/agents/hooks/useAgentForm';
import { modelLabel, modelOptions } from '@/features/agents/model/editorOptions';
import { useTiers } from '@/features/chat';
import { ActionMenu, Group, SettingRow } from '@/shared/ui';

export function ModelField({ form, disabled }: { form: AgentForm; disabled: boolean }) {
    const t = useTranslation();
    const tiers = useTiers('direct_chat');
    const [open, setOpen] = useState(false);
    const value = form.draft.model;
    const options = modelOptions(t, tiers.data, value);
    const label = t('agent_wizard.field.model', 'AI Model');

    return (
        <>
            <Group>
                <SettingRow label={label} value={modelLabel(t, options, value)} onPress={disabled ? undefined : () => setOpen(true)} />
            </Group>
            <ActionMenu
                visible={open}
                onClose={() => setOpen(false)}
                title={label}
                items={options.map((o) => ({
                    id: o.value || 'default',
                    label: o.label,
                    selected: o.value === value,
                    onPress: () => form.patch({ model: o.value }),
                }))}
            />
        </>
    );
}

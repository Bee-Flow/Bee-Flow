/** The web's Behavior picker: memory, copying, and the switch that blocks every outside tool. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { AgentForm } from '@/features/agents/hooks/useAgentForm';
import { configFlag } from '@/features/agents/model/draft';
import { Group, ToggleRow } from '@/shared/ui';

export function BehaviourFields({ form, disabled }: { form: AgentForm; disabled: boolean }) {
    const t = useTranslation();
    const { config } = form.draft;
    const memory = configFlag(config, 'memoryEnabled');
    return (
        <Group title={t('agent_wizard.section.behavior', 'Behavior')}>
            <ToggleRow
                label={t('agent_wizard.builder.memory', 'Memory')}
                description={t('agent_wizard.builder.memory_explainer', 'When on, this agent saves memories to its own private bucket — not your general memory. Other agents can\'t see what\'s stored here.')}
                value={memory}
                onValueChange={(memoryEnabled) => form.patchConfig({ memoryEnabled })}
                disabled={disabled}
            />
            {memory ? (
                <ToggleRow
                    label={t('agent_wizard.builder.memory_use_general_label', 'Also read from your general memory')}
                    description={t('agent_wizard.builder.memory_use_general_help', 'The agent can use facts already saved in your general memory (preferences, context). It still only writes to its own bucket.')}
                    value={configFlag(config, 'useGeneralMemory')}
                    onValueChange={(useGeneralMemory) => form.patchConfig({ useGeneralMemory })}
                    disabled={disabled}
                />
            ) : null}
            <ToggleRow
                label={t('agent_wizard.behavior.allow_copy_label', 'Allow copying')}
                description={t('agent_wizard.behavior.allow_copy_help', 'Users can copy message content to clipboard.')}
                value={configFlag(config, 'allowCopy')}
                onValueChange={(allowCopy) => form.patchConfig({ allowCopy })}
                disabled={disabled}
            />
            <ToggleRow
                label={t('agent_wizard.behavior.disable_external_label', 'Disable integrations & web search')}
                description={t('agent_wizard.behavior.disable_external_help', 'Block all integration tools and web search for this agent.')}
                value={configFlag(config, 'disableExternalTools')}
                onValueChange={(disableExternalTools) => form.patchConfig({ disableExternalTools })}
                disabled={disabled}
            />
        </Group>
    );
}

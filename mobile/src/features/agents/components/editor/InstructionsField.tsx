/**
 * The system prompt — the web's InstructionsEditor: a tall box that grows
 * with the text, because instructions are written in paragraphs.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { AgentForm } from '@/features/agents/hooks/useAgentForm';
import { Section, TextField } from '@/shared/ui';

export function InstructionsField({ form, disabled }: { form: AgentForm; disabled: boolean }) {
    const t = useTranslation();
    return (
        <Section title={t('agent_wizard.builder.instructions', 'Instructions')}>
            <TextField
                accessibilityLabel={t('agent_wizard.builder.instructions', 'Instructions')}
                placeholder={t('agent_wizard.builder.instructions_placeholder', 'Give your agent instructions on how it should behave.')}
                value={form.draft.systemPrompt}
                onChangeText={(systemPrompt) => form.patch({ systemPrompt })}
                editable={!disabled}
                multiline
                numberOfLines={8}
                maxLines={18}
                autoCapitalize="sentences"
            />
        </Section>
    );
}

/**
 * Where the agent looks before it answers: the knowledge bases it may search,
 * and the two rules for answering from them.
 *
 * A list that could not be read says so; it is never drawn as "no knowledge
 * bases", and linked ids stay linked whatever the read did.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { AgentForm } from '@/features/agents/hooks/useAgentForm';
import { configFlag, toggleId } from '@/features/agents/model/draft';
import { agentKnowledgeBases } from '@/features/agents/model/editorOptions';
import { useKnowledgeBases } from '@/features/knowledge';
import { CheckRow, Group, Section, Spinner, Text, ToggleRow } from '@/shared/ui';

function BaseList({ form, disabled }: { form: AgentForm; disabled: boolean }) {
    const t = useTranslation();
    const bases = useKnowledgeBases({ staleTime: 5 * 60_000 });
    const linked = form.draft.config.knowledge_base_ids ?? [];
    if (bases.isLoading) return <Spinner />;
    if (bases.isError) {
        return (
            <Text variant="caption" tone="warning">
                {t('agent_studio.can_use.kbs_unreadable', 'Could not load the knowledge bases, so their names and counts are missing here.')}
            </Text>
        );
    }
    const offered = agentKnowledgeBases(bases.data ?? []);
    if (offered.length === 0) {
        return (
            <Text variant="caption" tone="tertiary">
                {t('agent_studio.can_use.knowledge_empty', 'Nothing linked yet — this agent answers from its instructions alone.')}
            </Text>
        );
    }
    return (
        <Group title={t('agent_wizard.knowledge.kbs', 'Knowledge bases')}>
            {offered.map((kb) => (
                <CheckRow
                    key={kb.id}
                    label={kb.name}
                    checked={linked.includes(kb.id)}
                    onToggle={() => {
                        if (!disabled) form.patchConfig({ knowledge_base_ids: toggleId(linked, kb.id) });
                    }}
                />
            ))}
        </Group>
    );
}

export function KnowledgeField({ form, disabled }: { form: AgentForm; disabled: boolean }) {
    const t = useTranslation();
    const { config } = form.draft;
    return (
        <Section title={t('agent_studio.can_use.knowledge_title', 'Knowledge')} subtitle={t('agent_studio.can_use.knowledge_sub', 'Where it looks before it answers')}>
            <BaseList form={form} disabled={disabled} />
            <Group>
                <ToggleRow
                    label={t('agent_wizard.knowledge.strict_label', 'Strict Knowledge Mode')}
                    description={t('agent_wizard.knowledge.strict_help', 'Only answer from the knowledge base.')}
                    value={configFlag(config, 'strictKnowledge')}
                    onValueChange={(strictKnowledge) => form.patchConfig({ strictKnowledge })}
                    disabled={disabled}
                />
                <ToggleRow
                    label={t('agent_wizard.knowledge.sources_label', 'Include source references')}
                    description={t('agent_wizard.knowledge.sources_help', 'Cite source URLs when answering from knowledge.')}
                    value={configFlag(config, 'includeSourceReferences')}
                    onValueChange={(includeSourceReferences) => form.patchConfig({ includeSourceReferences })}
                    disabled={disabled}
                />
            </Group>
        </Section>
    );
}

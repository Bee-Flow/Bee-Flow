/**
 * "What it can use": the agent's tools, knowledge bases and skills. The tool
 * params are never rendered — fixed params routinely hold API keys and
 * customer-specific config — only whether the author pre-configured them.
 */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Card, Divider, Icon, ListRow, Section, type IconName } from '@/shared/ui';

import { ProfileToolRows } from './ProfileToolRows';
import { useAgentTools } from '../hooks/queries';
import type { Agent } from '../model/types';

export function ProfileCapabilities({ agent }: { agent: Agent }) {
    const theme = useTheme();
    const tools = useAgentTools(agent.id);
    const toolCount = (tools.data ?? []).length;
    const knowledgeCount = agent.config.knowledge_base_ids?.length ?? 0;
    const skillCount = agent.config.attachedSkillIds?.length ?? 0;
    const icon = (name: IconName) => (
        <Icon name={name} size={18} color={theme.colors.textMuted} />
    );

    return (
        <Section title="What it can use" subtitle="Tools and knowledge this agent reaches for on its own">
            <Card padded={false}>
                {toolCount === 0 && knowledgeCount === 0 && skillCount === 0 ? (
                    <ListRow
                        title="Just the model"
                        subtitle="No tools or knowledge bases are attached — it answers from what the model knows plus what you send it."
                    />
                ) : (
                    <>
                        <ProfileToolRows agent={agent} />
                        {knowledgeCount > 0 ? (
                            <>
                                {toolCount > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                                <ListRow
                                    title={knowledgeCount === 1 ? '1 knowledge base' : `${knowledgeCount} knowledge bases`}
                                    subtitle={
                                        agent.config.strictKnowledge
                                            ? 'It answers only from these, and says so when it cannot.'
                                            : 'Searched first, then combined with what the model knows.'
                                    }
                                    leading={icon('BookOpen')}
                                />
                            </>
                        ) : null}
                        {skillCount > 0 ? (
                            <>
                                <Divider inset={theme.spacing.lg} />
                                <ListRow
                                    title={skillCount === 1 ? '1 skill' : `${skillCount} skills`}
                                    subtitle="Extra instructions loaded when they are relevant."
                                    leading={icon('Zap')}
                                />
                            </>
                        ) : null}
                    </>
                )}
            </Card>
        </Section>
    );
}

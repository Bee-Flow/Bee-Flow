/** "Your conversations": the latest three with this agent, and a way to all of them. */

import React from 'react';
import { Pressable } from 'react-native';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Card, Divider, ListRow, Section, Text } from '@/shared/ui';

import { useAgentConversations } from '../hooks/queries';
import type { Agent } from '../model/types';

export function ProfileConversations({
    agent,
    onOpen,
    onSeeAll,
}: {
    agent: Agent;
    onOpen: (conversationId: string) => void;
    onSeeAll: () => void;
}) {
    const t = useTranslation(); // also re-renders when the language changes: timeAgo speaks it
    const theme = useTheme();
    const conversations = useAgentConversations(agent.id);
    const recent = (conversations.data ?? []).slice(0, 3);
    if (recent.length === 0) return null;

    return (
        <Section
            title={t('mobile.agents.your_conversations', 'Your conversations')}
            action={
                <Pressable
                    onPress={onSeeAll}
                    accessibilityRole="button"
                    accessibilityLabel={t('mobile.agents.see_all_conversations', 'See all conversations with this agent')}
                    hitSlop={theme.hitSlop}
                >
                    <Text variant="caption" tone="accent">
                        {t('mobile.agents.see_all', 'See all')}
                    </Text>
                </Pressable>
            }
        >
            <Card padded={false}>
                {recent.map((conversation, index) => (
                    <React.Fragment key={conversation.id}>
                        {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                        <ListRow
                            title={conversation.title || t('sidebar.untitled_chat', 'Untitled chat')}
                            meta={timeAgo(conversation.updated_at)}
                            onPress={() => onOpen(conversation.id)}
                        />
                    </React.Fragment>
                ))}
            </Card>
        </Section>
    );
}

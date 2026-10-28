/** Who this agent is: avatar, name, description, and who can see it. */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Text } from '@/shared/ui';

import { AgentAvatar } from './AgentAvatar';
import { pickAgentAvatar } from '../model/avatar';
import type { Agent } from '../model/types';

const makeStyles = (theme: Theme) => ({
    hero: { alignItems: 'center' as const, gap: theme.spacing.md },
    badges: { flexDirection: 'row' as const, gap: theme.spacing.sm },
});

export function ProfileHero({ agent }: { agent: Agent }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.hero}>
            <AgentAvatar name={agent.name} avatar={pickAgentAvatar(agent)} size={72} />
            <Text variant="title" center>
                {agent.name}
            </Text>
            {agent.description ? (
                <Text variant="body" tone="tertiary" center>
                    {agent.description}
                </Text>
            ) : null}
            <View style={styles.badges}>
                {agent.is_published ? (
                    <Badge label={t('mobile.agents.badge_shared', 'Shared with your organisation')} tone="accent" />
                ) : (
                    <Badge label={t('mobile.agents.badge_private_to_you', 'Private to you')} />
                )}
                {agent.config.strictKnowledge ? <Badge label={t('mobile.agents.badge_knowledge_only', 'Knowledge only')} /> : null}
            </View>
        </View>
    );
}

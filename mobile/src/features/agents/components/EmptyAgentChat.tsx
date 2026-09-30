/**
 * The zero state of an agent chat. The agent's own starter prompts are the
 * affordance; without them this is a blank box, which is the state this
 * exists to avoid.
 */

import React, { useMemo } from 'react';
import { ScrollView, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Text } from '@/shared/ui';

import { AgentAvatar } from './AgentAvatar';
import { pickAgentAvatar } from '../model/avatar';
import { parseStarterPrompts } from '../model/format';
import type { Agent } from '../model/types';

const makeStyles = (theme: Theme) => ({
    content: {
        flexGrow: 1,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        padding: theme.spacing.xl,
        gap: theme.spacing.md,
    },
    starters: { gap: theme.spacing.sm, width: '100%' as const, marginTop: theme.spacing.md },
    starter: { alignSelf: 'stretch' as const, justifyContent: 'center' as const },
});

export function EmptyAgentChat({ agent, onPick }: { agent: Agent; onPick: (prompt: string) => void }) {
    const styles = useThemedStyles(makeStyles);
    const starters = useMemo(() => parseStarterPrompts(agent.starter_prompts), [agent.starter_prompts]);
    return (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <AgentAvatar name={agent.name} avatar={pickAgentAvatar(agent)} size={64} />
            <Text variant="heading" center>
                {agent.name}
            </Text>
            {agent.description ? (
                <Text variant="body" tone="tertiary" center>
                    {agent.description}
                </Text>
            ) : null}
            {starters.length > 0 ? (
                <View style={styles.starters}>
                    {starters.slice(0, 4).map((prompt) => (
                        <Chip key={prompt} label={prompt} onPress={() => onPick(prompt)} style={styles.starter} />
                    ))}
                </View>
            ) : null}
        </ScrollView>
    );
}

/** "Try asking": the author's starter prompts; a tap opens a chat seeded with one. */

import React, { useMemo } from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Section } from '@/shared/ui';

import { parseStarterPrompts } from '../model/format';
import type { Agent } from '../model/types';

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.sm },
    starter: { alignSelf: 'stretch' as const, justifyContent: 'center' as const },
});

export function ProfileStarters({ agent, onPick }: { agent: Agent; onPick: (prompt: string) => void }) {
    const styles = useThemedStyles(makeStyles);
    const starters = useMemo(() => parseStarterPrompts(agent.starter_prompts), [agent.starter_prompts]);
    if (starters.length === 0) return null;
    return (
        <Section title="Try asking" subtitle="Written by whoever built this agent">
            <View style={styles.list}>
                {starters.map((prompt) => (
                    <Chip key={prompt} label={prompt} onPress={() => onPick(prompt)} style={styles.starter} />
                ))}
            </View>
        </Section>
    );
}

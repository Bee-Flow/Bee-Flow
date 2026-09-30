/** Start a chat, and star the agent. The star is optimistic (useToggleFavorite). */

import React from 'react';
import { View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon } from '@/shared/ui';

import { useToggleFavorite } from '../hooks/mutations';
import { useFavoriteAgents } from '../hooks/queries';
import type { Agent } from '../model/types';

const makeStyles = (theme: Theme) => ({
    actions: { gap: theme.spacing.sm },
});

export function ProfileActions({ agent, onChat }: { agent: Agent; onChat: () => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const favorites = useFavoriteAgents();
    const toggleFavorite = useToggleFavorite();
    const isFavorite = (favorites.data ?? []).includes(agent.id);

    return (
        <View style={styles.actions}>
            <Button
                label="Chat with this agent"
                onPress={onChat}
                size="lg"
                fullWidth
                icon={<Icon name="MessageSquare" size={18} color={theme.colors.accentPrimaryFg} />}
                accessibilityHint={`Starts a new conversation with ${agent.name}`}
            />
            <Button
                label={isFavorite ? 'Remove from favourites' : 'Add to favourites'}
                onPress={() => toggleFavorite.mutate({ id: agent.id, next: !isFavorite })}
                variant="secondary"
                fullWidth
                icon={
                    <Icon
                        name="Star"
                        size={18}
                        color={isFavorite ? theme.colors.warning : theme.colors.textSecondary}
                    />
                }
            />
        </View>
    );
}

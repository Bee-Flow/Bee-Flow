/**
 * One agent in a list.
 *
 * The subtitle is the agent's description because that is the only thing that
 * distinguishes two agents with similar names, and on a phone it is the only
 * chance to answer "which of these do I want" before tapping. The favourite
 * star is a separate 48dp target rather than a long-press, so it is reachable
 * without discovering it.
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';
import { View } from 'react-native';

import { AgentAvatar } from './AgentAvatar';
import { useTheme } from '../../../theme/ThemeProvider';
import { Badge } from '../../../ui/Badge';
import { IconButton } from '../../../ui/Button';
import { ListRow } from '../../../ui/List';
import { pickAgentAvatar } from '../avatar';
import type { Agent } from '../types';


export function AgentRow({
    agent,
    favorite,
    onPress,
    onToggleFavorite,
}: {
    agent: Agent;
    favorite: boolean;
    onPress: () => void;
    onToggleFavorite?: () => void;
}) {
    const theme = useTheme();

    return (
        <ListRow
            title={agent.name}
            subtitle={agent.description || 'No description yet.'}
            wrapTitle
            leading={<AgentAvatar name={agent.name} avatar={pickAgentAvatar(agent)} />}
            trailing={
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
                    {/* An unpublished agent is visible only to its owner. Saying
                        so is what stops "why can nobody else see this?". */}
                    {agent.is_published ? null : <Badge label="Private" />}
                    {onToggleFavorite ? (
                        <IconButton
                            icon={
                                <Feather
                                    name="star"
                                    size={18}
                                    color={favorite ? theme.colors.warning : theme.colors.textMuted}
                                />
                            }
                            tone={favorite ? 'accent' : 'default'}
                            accessibilityLabel={
                                favorite
                                    ? `Remove ${agent.name} from favourites`
                                    : `Add ${agent.name} to favourites`
                            }
                            onPress={onToggleFavorite}
                        />
                    ) : null}
                </View>
            }
            onPress={onPress}
        />
    );
}

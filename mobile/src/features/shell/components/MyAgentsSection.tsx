/**
 * The drawer's My Agents section — the web Sidebar's MyAgentsSection: the
 * agents you starred, each with its avatar, under a collapsible heading.
 * Nothing at all without a favourite (the web draws the section only then).
 *
 * A row is a quick start, as on the web (handleSelectAgent starts a new chat
 * with the agent): it opens a fresh conversation, not the agent's profile.
 * At most DRAWER_LIST_CAP of them — the Agents row above holds every one.
 */

import React, { useState } from 'react';
import { Pressable, View, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { AgentAvatar, useAgents, useFavoriteAgents, type Agent } from '@/features/agents';
import { SectionLabel, Text } from '@/shared/ui';

import { useDrawerActions } from '../hooks/drawerActions';
import { DRAWER_LIST_CAP } from '../model/nav';

function AgentRow({ agent }: { agent: Agent }) {
    const styles = useThemedStyles(makeStyles);
    const { push } = useDrawerActions();
    return (
        <Pressable
            onPress={() => push(`/agents/${encodeURIComponent(agent.id)}?c=new`)}
            accessibilityRole="link"
            accessibilityLabel={agent.name}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`drawer-agent-${agent.id}`}
        >
            <AgentAvatar name={agent.name} avatar={agent.avatar} size={28} />
            <Text variant="caption" style={styles.name} numberOfLines={1}>
                {agent.name}
            </Text>
        </Pressable>
    );
}

export function MyAgentsSection() {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const agents = useAgents().data ?? [];
    const favorites = new Set(useFavoriteAgents().data ?? []);
    const [expanded, setExpanded] = useState(true);
    const mine = agents.filter((agent) => favorites.has(agent.id)).slice(0, DRAWER_LIST_CAP);
    if (mine.length === 0) return null;
    return (
        <View style={styles.section}>
            <SectionLabel
                label={t('sidebar.my_agents', 'My Agents')}
                expanded={expanded}
                onPress={() => setExpanded((open) => !open)}
                testID="drawer-my-agents"
            />
            {expanded ? mine.map((agent) => <AgentRow key={agent.id} agent={agent} />) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    section: { marginTop: theme.spacing[2] } satisfies ViewStyle,
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[3],
        minHeight: 44,
        paddingHorizontal: theme.spacing[2],
        borderRadius: theme.radii.md,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    name: { flex: 1, color: theme.colors.textSecondary } satisfies TextStyle,
});

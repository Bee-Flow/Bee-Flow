/**
 * Every agent the signed-in user can open — the screen Agent Hub is named
 * after. Two things share it, behind one switch: the agents themselves, and
 * the recent chats across all of them.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Screen, ScreenHeader, Segmented } from '@/shared/ui';

import { AgentList } from '../components/AgentList';
import { NewAgentButton } from '../components/NewAgentButton';
import { RecentAgentChats } from '../components/RecentAgentChats';

type Tab = 'agents' | 'chats';

const makeStyles = (theme: Theme) => ({
    switch: {
        flexDirection: 'row' as const,
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingBottom: theme.spacing.sm,
    },
});

export function AgentsScreen() {
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const [tab, setTab] = useState<Tab>('agents');

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader title="Agents" subtitle="Purpose-built assistants" actions={<NewAgentButton />} />
            <View style={styles.switch}>
                {/* A single choice, so a segmented control — two chips would
                    announce a multi-select. */}
                <Segmented
                    accessibilityLabel="Agents or recent chats"
                    value={tab}
                    onChange={setTab}
                    options={[
                        { value: 'agents', label: 'Agents' },
                        { value: 'chats', label: 'Recent chats' },
                    ]}
                />
            </View>
            {tab === 'agents' ? (
                <AgentList onOpen={(id) => router.push(`/agents/${id}`)} />
            ) : (
                <RecentAgentChats
                    onOpen={(conversation) => router.push(`/agents/${conversation.agent_id}?c=${conversation.id}`)}
                />
            )}
        </Screen>
    );
}

/**
 * The agent screen's header. In chat it is the way back to the profile; on
 * the profile it is inert, so it does not look like a dead link.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, ScreenHeader } from '@/shared/ui';

import { AgentAvatar } from './AgentAvatar';
import { pickAgentAvatar } from '../model/avatar';
import type { Agent } from '../model/types';

export function AgentHeader({ id, agent, chatting }: { id: string; agent: Agent | null; chatting: boolean }) {
    const theme = useTheme();
    const router = useRouter();
    return (
        <ScreenHeader
            title={agent?.name ?? 'Agent'}
            onPressTitle={chatting ? () => router.push(`/agents/${id}`) : undefined}
            titleHint={chatting ? "Opens this agent's profile" : undefined}
            leading={chatting && agent ? <AgentAvatar name={agent.name} avatar={pickAgentAvatar(agent)} size={28} /> : null}
            actions={
                agent ? (
                    <IconButton
                        icon={<Icon name="MessageSquare" size={20} color={theme.colors.textPrimary} />}
                        accessibilityLabel={`Conversations with ${agent.name}`}
                        onPress={() => router.push(`/agents/${id}/conversations`)}
                    />
                ) : null
            }
        />
    );
}

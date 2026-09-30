/** An agent's profile — what this thing is for — composed from its sections. */

import React from 'react';
import { ScrollView } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';

import { ProfileActions } from './ProfileActions';
import { ProfileCapabilities } from './ProfileCapabilities';
import { ProfileConversations } from './ProfileConversations';
import { ProfileDetails } from './ProfileDetails';
import { ProfileEditActions } from './ProfileEditActions';
import { ProfileHero } from './ProfileHero';
import { ProfileStarters } from './ProfileStarters';
import type { Agent } from '../model/types';

const makeStyles = (theme: Theme) => ({
    content: { padding: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.xl },
});

export interface AgentProfileProps {
    agent: Agent;
    /** An empty prompt starts a blank chat; a starter seeds the composer. */
    onChat: (prompt?: string) => void;
    onOpenConversation: (conversationId: string) => void;
    onSeeAllConversations: () => void;
}

export function AgentProfile({ agent, onChat, onOpenConversation, onSeeAllConversations }: AgentProfileProps) {
    const styles = useThemedStyles(makeStyles);
    return (
        <ScrollView contentContainerStyle={styles.content}>
            <ProfileHero agent={agent} />
            <ProfileActions agent={agent} onChat={() => onChat()} />
            <ProfileEditActions agent={agent} />
            <ProfileStarters agent={agent} onPick={onChat} />
            <ProfileCapabilities agent={agent} />
            <ProfileConversations agent={agent} onOpen={onOpenConversation} onSeeAll={onSeeAllConversations} />
            <ProfileDetails agent={agent} />
        </ScrollView>
    );
}

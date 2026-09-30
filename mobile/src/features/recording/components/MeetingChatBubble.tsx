/** One turn of the meeting chat: the user's question, or the (live) answer. */

import React from 'react';
import { View } from 'react-native';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown/Markdown';
import { Spinner, Text } from '@/shared/ui';

import type { MeetingChatTurn } from '../hooks/useMeetingChat';

export function MeetingChatBubble({
    turn,
    content,
    isLast,
}: {
    turn: MeetingChatTurn;
    /** What to draw: the live stream for the trailing answer, else the turn. */
    content: string;
    isLast: boolean;
}) {
    const theme = useTheme();
    if (turn.role === 'user') {
        return (
            <View
                style={{
                    alignSelf: 'flex-end',
                    maxWidth: '85%',
                    paddingHorizontal: theme.spacing.md,
                    paddingVertical: theme.spacing.sm,
                    borderRadius: theme.radii.lg,
                    backgroundColor: theme.colors.userBubbleBg,
                }}
            >
                <Text variant="body" style={{ color: theme.colors.userBubbleFg }}>
                    {turn.content}
                </Text>
            </View>
        );
    }
    return (
        <View accessibilityLiveRegion={isLast ? 'polite' : 'none'}>
            {content ? <Markdown value={content} /> : <Spinner />}
        </View>
    );
}

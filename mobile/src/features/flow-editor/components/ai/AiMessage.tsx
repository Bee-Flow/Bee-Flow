/**
 * One message of the conversation with the builder — the web's
 * MessageBubble: the author's words in a bubble on the right (plain text,
 * line breaks kept), the assistant's answer as Markdown on the surface
 * itself, with what it did (ActivityList) under it.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown';
import { Text } from '@/shared/ui';

import type { ActivityRow } from './activity';
import { ActivityList } from './ActivityList';

const makeStyles = (theme: Theme) => ({
    user: { alignItems: 'flex-end', paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xs } satisfies ViewStyle,
    bubble: {
        maxWidth: '85%', padding: theme.spacing.md, borderRadius: theme.radii.lg, borderBottomRightRadius: 0,
        backgroundColor: theme.colors.bgTertiary,
    } satisfies ViewStyle,
    assistant: { paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.xs } satisfies ViewStyle,
});

export function AiMessage({ role, content, activity = [], running = false }: {
    role: 'user' | 'assistant';
    content: string;
    activity?: readonly ActivityRow[];
    running?: boolean;
}) {
    const styles = useThemedStyles(makeStyles);
    if (role === 'user') {
        return (
            <View style={styles.user}>
                <View style={styles.bubble}>
                    <Text variant="body" selectable>{content}</Text>
                </View>
            </View>
        );
    }
    return (
        <View style={styles.assistant}>
            {content ? <Markdown value={content} /> : null}
            <ActivityList rows={activity} running={running} />
        </View>
    );
}

/**
 * The one live status line before the first word of the answer (the web's
 * ActivityIndicator): what the server is doing now — "Searching knowledge
 * base…", "Protecting your data…" — or "Thinking…" when it says nothing.
 *
 * Once a tool has run, the activity card above owns the story; while one is
 * running this line says nothing, because the spinning row already does.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { phaseText } from '@/features/chat/model/phaseLabels';
import { visibleTools } from '@/features/chat/model/toolDisplay';
import type { ChatMessage } from '@/features/chat/model/types';
import { Spinner, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    line: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing.sm, minHeight: 28 },
    words: { flex: 1 },
});

export function PhaseLine({ message }: { message: ChatMessage }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const tools = visibleTools(message.tools);
    if (tools.some((tool) => tool.status === 'running')) return null;

    const phase = message.currentPhase;
    const words = phase ? phaseText(phase.stage, phase.detail, t) : t('chat.activity.thinking', 'Thinking…');
    return (
        // The gap between "send" and the first token is where the model picks
        // tools and reads context, and it can run to seconds. An empty block
        // renders as nothing, which reads as a message that failed to send.
        <View accessibilityLiveRegion="polite" style={styles.line}>
            <Spinner />
            <Text variant="body" tone="tertiary" numberOfLines={1} style={styles.words}>
                {words}
            </Text>
        </View>
    );
}

/**
 * The model's reasoning, above the answer (the web's ThinkingPanel.jsx).
 *
 * Open while the model thinks, so a person sees it working; folded once the
 * answer starts, with "Thought for 3.4s" as the header. A tap overrides
 * either way and sticks. The body is capped and scrolls on its own, because
 * a long reasoning trace would otherwise push the answer off the screen.
 */

import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import {
    formatThinkingDuration,
    hasThinking,
    thinkingDurationMs,
    thinkingLive,
    thinkingPartsOf,
    thinkingStart,
} from '@/features/chat/model/thinking';
import type { ChatMessage } from '@/features/chat/model/types';
import { Icon, Text } from '@/shared/ui';

import { ThinkingPartView } from './ThinkingPartView';

const makeStyles = (theme: Theme) => ({
    panel: {
        marginBottom: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
        backgroundColor: theme.colors.bgSecondary,
    },
    header: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.spacing.sm,
        minHeight: 40,
        paddingHorizontal: theme.spacing.md,
    },
    grow: { flex: 1 },
    body: { maxHeight: 280, paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing[2.5] },
});

/** A clock that ticks only while the model is thinking, for the live duration. */
function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(() => setNow(Date.now()), 500);
        return () => clearInterval(id);
    }, [active]);
    return now;
}

/** The header: "Thinking…" (with the clock past a second), "Thought for 3.4s", or "Reasoning". */
function useThinkingTitle(live: boolean, duration: number | null): string {
    const t = useTranslation();
    if (live) {
        const thinking = t('chat.msg.think_streaming', 'Thinking…');
        return duration != null && duration > 1000 ? `${thinking} · ${formatThinkingDuration(duration)}` : thinking;
    }
    return duration != null
        ? t('chat.msg.think_for', 'Thought for {duration}', { duration: formatThinkingDuration(duration) })
        : t('chat.msg.think_reasoning', 'Reasoning');
}

export function ThinkingPanel({ message }: { message: ChatMessage }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const parts = thinkingPartsOf(message);
    const live = thinkingLive(message.streaming, parts);
    const [userOpened, setUserOpened] = useState<boolean | null>(null);
    const now = useNow(live);
    const start = thinkingStart(parts);
    const duration = thinkingDurationMs(parts) ?? (live && start ? now - start : null);
    const title = useThinkingTitle(live, duration);

    if (!hasThinking(parts) && !live) return null;
    const open = userOpened ?? live;
    const redactedOnly = parts.length > 0 && parts.every((p) => p.redacted);

    return (
        <View style={styles.panel} accessibilityLabel={t('chat.msg.think_region', 'Model thinking')}>
            <Pressable
                onPress={() => setUserOpened(!open)}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
                style={styles.header}
            >
                <Icon name="Brain" size={14} color={theme.colors.typeAi} />
                <Text variant="caption" tone="secondary" weight="medium" style={styles.grow} numberOfLines={1}>
                    {title}
                </Text>
                {redactedOnly ? <Icon name="Lock" size={12} color={theme.colors.textMuted} /> : null}
                <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={12} color={theme.colors.textMuted} />
            </Pressable>
            {open ? (
                <ScrollView style={styles.body} nestedScrollEnabled>
                    {parts.map((part, index) => (
                        <ThinkingPartView key={part.id || index} part={part} divider={index > 0} live={live && !part.endedAt} />
                    ))}
                </ScrollView>
            ) : null}
        </View>
    );
}

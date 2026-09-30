/**
 * What the builder is doing right now ("kb search", a tool running) and a
 * refusal, above the composer. Each line subscribes to its own slice of the
 * live turn, so the transcript does not re-render with it.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useTurn, type TurnSource, type WebpageTurn } from '@/shared/stream';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        line: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xs },
    });

function activity(turn: WebpageTurn): string | null {
    const running = turn.tools.filter((tool) => tool.status === 'running');
    const last = running[running.length - 1];
    if (last) return last.name.replace(/[_-]+/g, ' ');
    return turn.phase;
}

export function BuildNotices({ store, streaming }: { store: TurnSource<WebpageTurn>; streaming: boolean }) {
    const styles = useThemedStyles(makeStyles);
    const doing = useTurn(store, activity);
    const blocked = useTurn(store, (turn) => turn.blocked);

    return (
        <View accessibilityLiveRegion="polite">
            {doing && streaming ? (
                <Text variant="caption" tone="tertiary" numberOfLines={1} style={styles.line}>
                    {doing}
                </Text>
            ) : null}
            {blocked ? (
                <Text variant="caption" tone="warning" style={styles.line}>
                    {blocked.detail ? `${blocked.reason} ${blocked.detail}` : blocked.reason}
                </Text>
            ) : null}
        </View>
    );
}

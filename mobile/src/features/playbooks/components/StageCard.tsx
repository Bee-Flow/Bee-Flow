/**
 * The frame every stage opens with — the web's StageShell/StageHeader: the
 * phase's kind tile, a title, and one status line (busy with a spinner, or
 * failed in the error ink), then the stage's own content.
 */

import React, { type ReactNode } from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, KindTile, Spinner, Text, type KindKey } from '@/shared/ui';

export type StageTone = 'busy' | 'error' | 'quiet';

export function StageCard({
    kind,
    title,
    subtitle,
    status,
    tone = 'quiet',
    children,
    testID,
}: {
    kind: KindKey;
    title: string;
    subtitle?: string | null;
    status?: string | null;
    tone?: StageTone;
    children?: ReactNode;
    testID?: string;
}) {
    const styles = useThemedStyles(makeStyles);
    return (
        <Card style={styles.card} testID={testID}>
            <View style={styles.head}>
                <KindTile kind={kind} size={36} />
                <View style={styles.titles}>
                    <Text variant="subheading">{title}</Text>
                    {subtitle ? (
                        <Text variant="caption" tone="secondary">
                            {subtitle}
                        </Text>
                    ) : null}
                </View>
            </View>
            {status ? (
                <View style={styles.status}>
                    {tone === 'busy' ? <Spinner /> : null}
                    <Text variant="caption" tone={tone === 'error' ? 'error' : 'secondary'} style={styles.grow}>
                        {status}
                    </Text>
                </View>
            ) : null}
            {children}
        </Card>
    );
}

const makeStyles = (theme: Theme) => ({
    card: { gap: theme.spacing[3] },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[3] },
    titles: { flex: 1, gap: theme.spacing[0.5] },
    status: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[2] },
    grow: { flex: 1 },
});

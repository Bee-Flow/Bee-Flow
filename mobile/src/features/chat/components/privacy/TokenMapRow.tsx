/** Which placeholder stood for which value — hidden until asked for, like the original message. */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { PayloadHeader } from './PayloadHeader';

const makeStyles = (theme: Theme) => ({
    row: { marginTop: theme.spacing.md, gap: theme.spacing.xs },
    pre: { borderRadius: theme.radii.sm, backgroundColor: theme.colors.bgPrimary, padding: theme.spacing.sm, gap: theme.spacing.xxs },
    pair: { flexDirection: 'row' as const, gap: theme.spacing.sm },
    value: { flex: 1 },
});

export function TokenMapRow({ tokenMap }: { tokenMap: Record<string, string> | undefined }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [revealed, setRevealed] = useState(false);
    const entries = Object.entries(tokenMap ?? {});
    if (entries.length === 0) return null;

    const count =
        entries.length === 1
            ? t('privacy.n_items', '· 1 item')
            : t('privacy.n_items_plural', '· {count} items', { count: entries.length });

    return (
        <View style={styles.row}>
            <PayloadHeader
                label={`${t('privacy.token_mapping', 'Token mapping').toUpperCase()} ${count}`}
                revealed={revealed}
                onReveal={() => setRevealed(true)}
                copyText={entries.map(([token, value]) => `${token}\t${value}`).join('\n')}
            />
            <View style={styles.pre}>
                {entries.map(([token, value]) => (
                    <View key={token} style={styles.pair}>
                        <Text variant="code" tone="accent">
                            {token}
                        </Text>
                        <Text variant="code" tone="tertiary">
                            →
                        </Text>
                        <Text variant="code" style={styles.value} selectable={revealed}>
                            {revealed ? value : '•'.repeat(Math.min(24, value.length))}
                        </Text>
                    </View>
                ))}
            </View>
        </View>
    );
}

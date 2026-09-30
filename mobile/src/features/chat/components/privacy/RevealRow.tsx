/**
 * One raw-payload row of the privacy sheet: a label, a hint, the text and a
 * Copy. A row that holds real personal data starts hidden behind "Click to
 * reveal", so opening the sheet in a meeting does not put a client's name on
 * the projector.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import { PayloadHeader } from './PayloadHeader';

const makeStyles = (theme: Theme) => ({
    row: { marginTop: theme.spacing.md, gap: theme.spacing.xs },
    pre: { borderRadius: theme.radii.sm, backgroundColor: theme.colors.bgPrimary, padding: theme.spacing.sm },
});

export function RevealRow({
    label,
    hint,
    text,
    revealable = false,
}: {
    label: string;
    hint?: string;
    text: string | undefined;
    revealable?: boolean;
}) {
    const styles = useThemedStyles(makeStyles);
    const [revealed, setRevealed] = useState(!revealable);
    if (!text) return null;
    return (
        <View style={styles.row}>
            <PayloadHeader
                label={hint ? `${label.toUpperCase()} · ${hint}` : label.toUpperCase()}
                revealed={revealed}
                onReveal={() => setRevealed(true)}
                copyText={text}
            />
            <View style={styles.pre}>
                <Text variant="code" selectable={revealed}>
                    {revealed ? text : '•••'.repeat(Math.min(20, Math.ceil(text.length / 4)))}
                </Text>
            </View>
        </View>
    );
}

/**
 * The preview sheet's footer: "Share or save…" for a file, "Share" for text.
 * The file button hands the file to Android's share sheet (shareServerFile),
 * which is where saving it or giving it to another app happens; it used to
 * say "Open with…", which that sheet is not.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexDirection: 'row', gap: theme.spacing.sm },
        half: { flex: 1 },
    });

export function PreviewActions({
    onShare,
    onOpenWith,
    busy,
}: {
    onShare?: () => void;
    onOpenWith?: () => void;
    busy: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.row}>
            {onOpenWith ? (
                <Button
                    label={t('mobile.knowledge.share_or_save', 'Share or save…')}
                    onPress={onOpenWith}
                    loading={busy}
                    icon={<Icon name="Share2" size={16} color={theme.colors.accentPrimaryFg} />}
                    style={styles.half}
                />
            ) : null}
            {onShare ? (
                <Button
                    label="Share"
                    variant="secondary"
                    onPress={onShare}
                    loading={busy && !onOpenWith}
                    icon={<Icon name="Share2" size={16} color={theme.colors.textPrimary} />}
                    style={styles.half}
                />
            ) : null}
        </View>
    );
}

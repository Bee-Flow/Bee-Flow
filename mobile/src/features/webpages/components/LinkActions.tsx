/**
 * A public URL, and the three things a phone can honestly do with one.
 *
 * Copy and Share are obvious. "Open" is for PUBLISHED links only — a public
 * page, a hosted form — whose whole point is how they look in a real browser
 * to the person who receives them: expo-web-browser hands the URL to Chrome
 * Custom Tabs, the same browser with the same cookies, showing what the
 * recipient will see. A page's own preview does not come through here: it
 * renders inside the app (components/PreviewTab.tsx).
 *
 * `createTask: false` keeps the tab attached to this app's task rather than
 * spawning a second entry in the Android recents list, so Back returns here.
 */

import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Share, StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Icon, Text, useToast } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        box: { gap: theme.spacing.md },
        row: { flexDirection: 'row', gap: theme.spacing.sm },
        third: { flex: 1 },
    });

export function LinkActions({
    url,
    shareTitle,
    /** Shown above the buttons. Pass false for a row that already shows it. */
    showUrl = true,
    /** Hidden for a link that only resolves inside a browser session. */
    allowOpen = true,
}: {
    url: string;
    shareTitle?: string;
    showUrl?: boolean;
    allowOpen?: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();

    const copy = async () => {
        await Clipboard.setStringAsync(url);
        toast(t('forms.studio.copied', 'Link copied'), 'success');
    };

    const share = async () => {
        try {
            await Share.share({ message: url, title: shareTitle });
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    const open = async () => {
        try {
            await WebBrowser.openBrowserAsync(url, { createTask: false });
        } catch (err) {
            toast(describeError(err).message, 'error');
        }
    };

    return (
        <View style={styles.box}>
            {showUrl ? (
                <Text variant="code" tone="secondary" selectable numberOfLines={2}>
                    {url}
                </Text>
            ) : null}
            <View style={styles.row}>
                <Button
                    label={t('common.copy', 'Copy')}
                    variant="secondary"
                    onPress={() => void copy()}
                    icon={<Icon name="Copy" size={16} color={theme.colors.textPrimary} />}
                    style={styles.third}
                    accessibilityHint={t('mobile.webpages.link.copy_hint', 'Copies the link to the clipboard')}
                />
                <Button
                    label={t('mobile.webpages.link.share', 'Share')}
                    variant="secondary"
                    onPress={() => void share()}
                    icon={<Icon name="Share2" size={16} color={theme.colors.textPrimary} />}
                    style={styles.third}
                />
                {allowOpen ? (
                    <Button
                        label={t('mobile.webpages.link.open', 'Open')}
                        variant="secondary"
                        onPress={() => void open()}
                        icon={<Icon name="ExternalLink" size={16} color={theme.colors.textPrimary} />}
                        style={styles.third}
                        accessibilityHint={t('mobile.webpages.link.open_hint', 'Opens the link in your browser')}
                    />
                ) : null}
            </View>
        </View>
    );
}

/**
 * The slim strip over the preview, after the web's preview toolbar
 * (WebpagePreview.jsx): the shielded mark, the Mobile/Desktop width toggle
 * and Reload — plus, for the page's owner, a switch between the page and the
 * AI chat that builds it.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, IconButton, Segmented, Text } from '@/shared/ui';

import type { PreviewDevice } from '../model/preview';

export type PreviewView = 'page' | 'chat';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        bar: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.xs,
        },
        shield: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs, flexShrink: 1 },
        grow: { flex: 1 },
    });

export interface PreviewToolbarProps {
    view: PreviewView;
    /** Absent for a viewer: there is no chat to switch to. */
    onView?: (view: PreviewView) => void;
    device: PreviewDevice;
    onDevice: (device: PreviewDevice) => void;
    onReload: () => void;
}

export function PreviewToolbar({ view, onView, device, onDevice, onReload }: PreviewToolbarProps) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const icon = (name: 'Smartphone' | 'Monitor') => <Icon name={name} size={16} color={theme.colors.textSecondary} />;

    return (
        <View style={styles.bar}>
            {onView ? (
                <Segmented<PreviewView>
                    options={[
                        { value: 'page', label: t('webpages.preview.title', 'Preview') },
                        { value: 'chat', label: t('webpages.chat.title', 'AI Chat') },
                    ]}
                    value={view}
                    onChange={onView}
                />
            ) : (
                <View
                    style={styles.shield}
                    accessibilityHint={t(
                        'webpages.preview.shielded_hint',
                        'The page runs in an isolated frame: it cannot reach your session, your cookies, or the app around it.',
                    )}
                >
                    <Icon name="Shield" size={14} color={theme.colors.textTertiary} />
                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                        {t('webpages.preview.shielded', 'Running shielded')}
                    </Text>
                </View>
            )}
            <View style={styles.grow} />
            {view === 'page' ? (
                <>
                    <Segmented<PreviewDevice>
                        iconOnly
                        accessibilityLabel={t('webpages.preview.device', 'Preview width')}
                        options={[
                            { value: 'mobile', label: t('webpages.preview.mobile', 'Mobile'), icon: icon('Smartphone') },
                            { value: 'desktop', label: t('webpages.preview.desktop', 'Desktop'), icon: icon('Monitor') },
                        ]}
                        value={device}
                        onChange={onDevice}
                    />
                    <IconButton
                        icon={<Icon name="RefreshCw" size={18} color={theme.colors.textSecondary} />}
                        accessibilityLabel={t('webpages.preview.reload', 'Reload')}
                        accessibilityHint={t('webpages.preview.reload_hint', 'Reload preview')}
                        onPress={onReload}
                    />
                </>
            ) : null}
        </View>
    );
}

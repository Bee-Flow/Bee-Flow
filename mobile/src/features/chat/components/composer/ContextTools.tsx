/**
 * "More" in the ＋ sheet: the composer's tools that open a panel of their own
 * (the web's ComposerToolsMenu rows) — create media, the apps this chat may
 * reach, and voice mode. Each closes the sheet first; only the ones this
 * person can use are listed.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, ListRow, type IconName } from '@/shared/ui';

import { ContextSectionLabel } from './ContextSectionLabel';

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.xs },
});

export interface ContextToolHandlers {
    onMedia?: () => void;
    onApps?: () => void;
    onVoice?: () => void;
}

export function ContextTools({ onClose, onMedia, onApps, onVoice }: ContextToolHandlers & { onClose: () => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const rows: { id: string; icon: IconName; title: string; subtitle?: string; run: () => void }[] = [];
    if (onMedia) rows.push({ id: 'media', icon: 'Sparkles', title: t('chat.composer.tools_media', 'Create image, music, video'), run: onMedia });
    if (onApps) {
        rows.push({
            id: 'apps',
            icon: 'LayoutGrid',
            title: t('chat.composer.tools_apps', 'Apps'),
            subtitle: t('chat.composer.tools_apps_hint', 'What this chat may reach — Drive, Gmail, and the rest'),
            run: onApps,
        });
    }
    if (onVoice) {
        rows.push({
            id: 'voice',
            icon: 'Volume2',
            title: t('chat.composer.tools_voice', 'Voice mode'),
            subtitle: t('chat.composer.tools_voice_hint', 'Talk with your assistant instead of typing'),
            run: onVoice,
        });
    }
    if (rows.length === 0) return null;
    return (
        <View style={styles.list}>
            <ContextSectionLabel>{t('chat.composer.tools_menu', 'Message tools')}</ContextSectionLabel>
            {rows.map((row) => (
                <ListRow
                    key={row.id}
                    title={row.title}
                    subtitle={row.subtitle}
                    leading={<Icon name={row.icon} size={18} color={theme.colors.textSecondary} />}
                    chevron
                    onPress={() => {
                        onClose();
                        row.run();
                    }}
                />
            ))}
        </View>
    );
}

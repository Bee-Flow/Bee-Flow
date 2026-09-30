/**
 * The interface language: "automatic" first, then the languages the
 * workspace offers — only the ones an administrator has added, because
 * offering a language the server has no strings for would be offering a 404.
 * A handful at most, so plain rows in one group.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Badge, Group, Icon, OptionRow } from '@/shared/ui';

import type { Locale } from '../model/types';

export function WorkspaceLocalesGroup({
    locales,
    preference,
    deviceName,
    onChoose,
}: {
    locales: Locale[];
    preference: string | null;
    deviceName: string;
    onChoose: (code: string | null) => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const footer =
        locales.length === 0
            ? t('mobile.settings.language_none', 'Your administrator has not added any languages, so Bee Flow uses English.')
            : t('mobile.settings.language_footer', 'Saved on this phone. Text that has not been translated yet stays in English.');
    return (
        <Group title={t('settings.interface_language', 'Interface Language')} footer={footer}>
            <OptionRow
                label={t('mobile.settings.language_auto', 'Automatic')}
                description={t('mobile.settings.language_auto_hint', "Your organisation's language, else your phone's ({device})", { device: deviceName })}
                selected={preference === null}
                onPress={() => onChoose(null)}
                leading={<Icon name="Smartphone" size={16} color={theme.colors.textSecondary} />}
            />
            {locales.map((locale) => (
                <OptionRow
                    key={locale.code}
                    label={locale.name || locale.code}
                    description={locale.code}
                    selected={preference === locale.code}
                    onPress={() => onChoose(locale.code)}
                    leading={
                        locale.isOrgDefault ? (
                            <Badge label={t('languages.default_badge', 'Default')} tone="accent" />
                        ) : (
                            <View style={styles.noBadge} />
                        )
                    }
                />
            ))}
        </Group>
    );
}

const styles = StyleSheet.create({
    noBadge: { width: 0 },
});

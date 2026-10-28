/** The licence, the source, and the open source this app is built from. */

import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Group, Icon, NoteRow, SettingRow, Text } from '@/shared/ui';

const DOCS_URL = 'https://docs.beeflow.ai/';
const REPO_URL = 'https://github.com/Bee-Flow/Bee-Flow';
const LICENSE_URL = 'https://github.com/Bee-Flow/Bee-Flow/blob/main/LICENSE.md';

type RowGlyph = 'BookOpen' | 'Github' | 'FileText';

export function SourceGroups() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const icon = (name: RowGlyph) => <Icon name={name} size={16} color={theme.colors.textSecondary} />;
    return (
        <>
            <Group
                title={t('mobile.settings.source_title', 'Licence and source')}
                footer={t(
                    'mobile.settings.source_footer',
                    'Bee Flow is fair-code: the source is public and you may self-host it, with commercial restrictions set out in the licence.',
                )}
            >
                <SettingRow
                    label={t('mobile.support.docs', 'Documentation')}
                    icon={icon('BookOpen')}
                    onPress={() => void WebBrowser.openBrowserAsync(DOCS_URL, { createTask: false })}
                />
                <SettingRow
                    label={t('mobile.settings.source_code', 'Source code')}
                    icon={icon('Github')}
                    onPress={() => void WebBrowser.openBrowserAsync(REPO_URL, { createTask: false })}
                />
                <SettingRow
                    label={t('mobile.org.licence_title', 'Licence')}
                    icon={icon('FileText')}
                    onPress={() => void WebBrowser.openBrowserAsync(LICENSE_URL, { createTask: false })}
                />
            </Group>

            <Group title={t('mobile.settings.open_source_title', 'Open source in this app')}>
                <NoteRow>
                    <View style={styles.note}>
                        <Text variant="caption" tone="tertiary">
                            {t(
                                'mobile.settings.open_source_body',
                                'Built with React Native and Expo. Cryptography by the Noble libraries (@noble/ciphers, @noble/curves, @noble/hashes), with Argon2id by argon2kt; icons by Lucide; typeface Inter.',
                            )}
                        </Text>
                        <Text variant="caption" tone="tertiary">
                            {t('mobile.settings.open_source_licences', 'Full dependency licences ship with the source repository.')}
                        </Text>
                    </View>
                </NoteRow>
            </Group>
        </>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        note: { gap: theme.spacing.xs },
    });

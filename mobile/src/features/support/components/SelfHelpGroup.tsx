/**
 * The answers that are already written down: the documentation (a public
 * site, in the in-app browser), and what changed recently — the server's own
 * release notes, which the About screen draws natively.
 */

import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, SettingRow } from '@/shared/ui';

const DOCS_URL = 'https://docs.beeflow.ai/';

export function SelfHelpGroup() {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <Group title={t('mobile.support.self_help', 'Find an answer yourself')}>
            <SettingRow
                label={t('mobile.support.docs', 'Documentation')}
                icon={<Icon name="BookOpen" size={16} color={theme.colors.textSecondary} />}
                onPress={() => void WebBrowser.openBrowserAsync(DOCS_URL, { createTask: false })}
            />
            <SettingRow
                label={t('mobile.support.changes', 'What changed recently')}
                icon={<Icon name="GitCommitHorizontal" size={16} color={theme.colors.textSecondary} />}
                onPress={() => router.push('/settings/about')}
                testID="support-release-notes"
            />
        </Group>
    );
}

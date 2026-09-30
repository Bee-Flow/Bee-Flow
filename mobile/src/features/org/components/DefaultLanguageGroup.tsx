/**
 * The interface language new members start in (OrgDefaultLanguage.jsx).
 * Hidden, as on the web, while the installation offers one language or
 * fewer. A pick saves at once; it is not part of the form's SaveBar.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, OptionRow } from '@/shared/ui';

import type { OrgLanguages } from '../model/sectionTypes';

export function DefaultLanguageGroup({
    languages,
    saving,
    onPick,
}: {
    languages: OrgLanguages | undefined;
    saving: boolean;
    onPick: (code: string) => void;
}) {
    const t = useTranslation();
    if (!languages || languages.locales.length <= 1) return null;
    return (
        <Group
            title={t('org.default_language', 'Default Language')}
            footer={`${t(
                'org.new_user_language_desc',
                'When a new user signs in for the first time, the interface will be displayed in this language. Users can change their language at any time in their personal settings.',
            )} ${t(
                'mobile.org.default_language_info',
                'Existing users keep the language they already chose.',
            )}`}
        >
            {languages.locales.map((locale) => (
                <OptionRow
                    key={locale.code}
                    testID={`locale-${locale.code}`}
                    label={locale.name || locale.code}
                    selected={languages.defaultLocale === locale.code}
                    disabled={saving}
                    onPress={() => onPick(locale.code)}
                />
            ))}
        </Group>
    );
}

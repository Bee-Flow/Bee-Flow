/**
 * The two facts worth a line under the picker: text size is Android's, and —
 * only when an administrator pinned one — the accent is the organisation's.
 * The accent is laid over whichever theme is chosen, so the previews above
 * already show it; this line says where it came from.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Text } from '@/shared/ui';

import type { EffectiveBranding } from '../model/types';

export function AppearanceFooter({ branding }: { branding: EffectiveBranding | null | undefined }) {
    const theme = useTheme();
    const t = useTranslation();
    const accent = theme.branding.accentColor;
    const pinned = Boolean(accent && branding?.source !== 'user');
    return (
        <Text variant="caption" tone="tertiary" center>
            {t('mobile.appearance.text_size', "Text size follows your phone's font size setting.")}
            {pinned && accent
                ? ` ${t('mobile.appearance.org_accent', 'Your organisation set the accent colour ({accent}).', { accent: accent.toUpperCase() })}`
                : null}
        </Text>
    );
}

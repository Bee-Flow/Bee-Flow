/**
 * One Studio section on the hub — the web Start screen's section card
 * (StudioStart.jsx): the glyph in its kind's colour, the name, its one-line
 * description, the count, and for a locked section the lock and the reason
 * (drawn by HubRow).
 */

import React from 'react';

import { lockHint } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { kindColor, navCount } from '@/shared/ui';

import { HubRow } from './HubRow';
import type { ResolvedSection } from '../model/types';

export interface SectionRowProps {
    section: ResolvedSection;
    count?: number | null;
    onPress: () => void;
}

export function SectionRow({ section, count, onPress }: SectionRowProps) {
    const theme = useTheme();
    const t = useTranslation();
    return (
        <HubRow
            testID={`studio-section-${section.id}`}
            icon={section.icon}
            iconColor={section.kind ? kindColor(theme, section.kind) : undefined}
            label={t(section.labelKey, section.labelFallback)}
            description={t(section.descKey, section.descFallback)}
            count={navCount(count)}
            lockHint={section.locked ? lockHint(section.locked, t) : null}
            onPress={onPress}
        />
    );
}

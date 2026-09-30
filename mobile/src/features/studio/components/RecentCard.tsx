/**
 * "Recently edited" on the Studio hub, after the web's recent/RecentWorkList:
 * the newest things across every section this person can open, each with its
 * status in one word. Three answers, not two — a section that could not be
 * read is named, and only a complete answer may say "nothing edited yet".
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Card, Text } from '@/shared/ui';

import { RecentRow } from './RecentRow';
import type { RecentWork } from '../model/recent';
import { studioSection } from '../model/registry';

function unreadable(work: RecentWork, t: TranslateFn): string | null {
    if (work.unavailable.length === 0) return null;
    const sections = work.unavailable
        .map((id) => {
            const s = studioSection(id);
            return t(s.labelKey, s.labelFallback);
        })
        .join(', ');
    return `${t('studio.recent.empty_unreadable', 'Some lists could not be read, so this is not the whole picture — not "nothing here".')} ${t('studio.attention.unavailable_named', 'Not checked: {sections}.', { sections })}`;
}

export function RecentCard({ work }: { work: RecentWork }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    // Nothing is claimed before every list has answered or failed.
    if (work.pending && work.items.length === 0) return null;
    const gap = unreadable(work, t);
    return (
        <Card testID="studio-recent">
            <View style={styles.body}>
                <Text variant="body" weight="semibold" accessibilityRole="header">
                    {t('studio.recent.title', 'Recently edited')}
                </Text>
                {gap ? (
                    <Text variant="caption" tone="secondary">
                        {gap}
                    </Text>
                ) : null}
                {work.items.length === 0 && work.complete ? (
                    <Text variant="caption" tone="tertiary">
                        {t('studio.recent.empty', 'Nothing edited yet.')}
                    </Text>
                ) : null}
                {work.items.map((item) => (
                    <RecentRow key={item.key} item={item} />
                ))}
            </View>
        </Card>
    );
}

const makeStyles = (theme: Theme) => ({
    body: { gap: theme.spacing[1] } satisfies ViewStyle,
});

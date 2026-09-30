/**
 * An empty builder chat: what it does, and the web's four example briefs —
 * each one is sent as the first message when tapped (WebpageChat.jsx).
 */

import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, ListRow, Card } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.lg },
        empty: { paddingVertical: theme.spacing.xl },
    });

export function BuildStarters({ onPick, disabled }: { onPick: (brief: string) => void; disabled: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const starters = [
        t('mobile.webpages.chat.quick_bakery', 'Landing page for a bakery — hero, menu grid, contact form.'),
        t('mobile.webpages.chat.quick_portfolio', 'Personal portfolio site with project gallery and about section.'),
        t('mobile.webpages.chat.quick_signup', 'Form that saves user signups to a database, with a thank-you screen.'),
        t('mobile.webpages.chat.quick_dashboard', 'Dashboard with a few stat cards and a simple chart.'),
    ];

    return (
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <EmptyState
                icon="Globe"
                title={t('mobile.webpages.chat.empty_title', 'Describe a page, get a webpage')}
                message={t(
                    'mobile.webpages.chat.empty_body',
                    "Tell me what you want. I'll scaffold the files, wire them up, and keep iterating with you.",
                )}
                style={styles.empty}
            />
            <Card padded={false}>
                {starters.map((brief) => (
                    <ListRow key={brief} title={brief} wrapTitle disabled={disabled} onPress={() => onPick(brief)} />
                ))}
            </Card>
        </ScrollView>
    );
}

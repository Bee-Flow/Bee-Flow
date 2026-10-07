/**
 * The window at a glance: what the shield caught, what left the building and
 * where it went. The web draws the destinations on a world map; a phone lists
 * the countries, busiest first. Top lists are capped at ten rows.
 *
 * Nothing here is a filter, so no total ever narrows another list: "Most
 * found" are the organisation's totals, health included (with a note that it
 * is a total only), and "Who triggered it most" ranks people over everything.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Group, InfoRow, Stat } from '@/shared/ui';

import { SPECIAL_TOTAL_NOTE, categoryLabel, countriesOf, namesSpecialCategory } from '../model/activity';
import type { ShieldActivity } from '../model/activityTypes';

const TOP = 10;

export function ActivitySummary({ activity }: { activity: ShieldActivity }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { guard, integrations } = activity;
    const countries = countriesOf(integrations.destinations).slice(0, TOP);
    const score = integrations.sovereigntyScore;
    return (
        <>
            <Group>
                <View style={styles.stats}>
                    <Stat label={t('mobile.orgShield.stat_events', 'Caught')} value={String(guard.totalEvents)} caption={t('mobile.orgShield.stat_events_caption', '{n} with personal data', { n: guard.piiCount })} />
                    <Stat label={t('mobile.orgShield.stat_calls', 'Outbound calls')} value={String(integrations.totalCalls)} caption={t('mobile.orgShield.stat_non_eu', '{n} outside the EU', { n: integrations.nonEuCount })} tone={integrations.piiNonEuCount > 0 ? 'warning' : 'primary'} />
                    <Stat label={t('mobile.orgShield.stat_score', 'Sovereignty')} value={score === null ? '—' : `${score}`} caption={t('mobile.orgShield.stat_score_caption', 'of 100')} tone="accent" />
                </View>
            </Group>
            {guard.topCategories.length > 0 ? (
                <Group
                    title={t('mobile.orgShield.top_categories', 'Most found')}
                    footer={namesSpecialCategory(guard.topCategories) ? t(SPECIAL_TOTAL_NOTE.key, SPECIAL_TOTAL_NOTE.en) : undefined}
                >
                    {guard.topCategories.slice(0, TOP).map((c) => (
                        <InfoRow key={c.category} label={categoryLabel(c.category, t)} value={String(c.count)} />
                    ))}
                </Group>
            ) : null}
            {countries.length > 0 ? (
                <Group title={t('mobile.orgShield.countries', 'Where calls went')}>
                    {countries.map((c) => (
                        <InfoRow
                            key={c.code}
                            label={c.isLocal ? t('mobile.orgShield.local', 'Your own network') : c.name}
                            value={c.piiEvents > 0 ? t('mobile.orgShield.country_value_pii', '{n} · {pii} with personal data', { n: c.total, pii: c.piiEvents }) : String(c.total)}
                            tone={!c.isEu && !c.isLocal && c.piiEvents > 0 ? 'warning' : undefined}
                        />
                    ))}
                </Group>
            ) : null}
            {guard.topUsers.length > 0 ? (
                <Group title={t('mobile.orgShield.top_people', 'Who triggered it most')}>
                    {guard.topUsers.slice(0, TOP).map((u) => (
                        <InfoRow key={u.userId} label={u.name} value={String(u.total)} />
                    ))}
                </Group>
            ) : null}
        </>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        stats: { flexDirection: 'row', gap: theme.spacing.md, paddingHorizontal: theme.spacing.lg, paddingVertical: theme.spacing.md },
    });

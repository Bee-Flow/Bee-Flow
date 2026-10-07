/**
 * The hub page 'calendar' (web: OverviewPage › Calendar, OverviewPage.jsx
 * 114-149): the full regulatory calendar with the not-legal-advice hint and
 * the link to the AI Act's phasing on its Timeline tab. Notices and old
 * `?tab=calendar` links land here (model/sections.ts LEGACY_TABS).
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Button, Group, GroupedScroll, Text } from '@/shared/ui';

import { RegulatoryCalendar } from './RegulatoryCalendar';
import { useCalendar } from '../hooks/calendar';
import { useComplianceAccess } from '../hooks/useComplianceAccess';
import { sectionRoute } from '../model/navigation';
import type { Label } from '../model/types';

/** The AI Act's Timeline tab, where its phasing lives. */
export const AIA_TIMELINE_ROUTE = `${sectionRoute('aia')}?tab=timeline`;

function CalendarPageBody() {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const gate = useComplianceAccess();
    const calendar = useCalendar(gate.open);
    const refresh = useUserRefresh(() => calendar.refetch());
    return (
        <GroupedScroll refresh={refresh} testID="calendar-page">
            <Group title={t('compliance.ovw_calendar_title', 'Regulatory calendar')}>
                <View style={styles.body}>
                    <Text variant="label" tone="tertiary">
                        {t('compliance.ovw_calendar_hint', 'Only the frameworks that affect you — not legal advice.')}
                    </Text>
                    <RegulatoryCalendar milestones={calendar.data?.milestones} failed={calendar.isError} testID="calendar-page-calendar" />
                    <View style={styles.link}>
                        <Button
                            variant="ghost"
                            size="sm"
                            iconName="ChevronRight"
                            label={t('compliance.ovw_aia_phasing_link', 'AI Act phasing → Timeline')}
                            onPress={() => router.push(AIA_TIMELINE_ROUTE)}
                            testID="calendar-aia-phasing"
                        />
                    </View>
                </View>
            </Group>
        </GroupedScroll>
    );
}

export const CalendarPage = CalendarPageBody;

export const calendarPage: { title: Label; Component: () => React.JSX.Element } = {
    title: { i18nKey: 'compliance.tab_overview_calendar', en: 'Calendar' },
    Component: CalendarPageBody,
};

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { paddingHorizontal: theme.spacing[3.5], paddingVertical: theme.spacing[3], gap: theme.spacing[2] },
        link: { alignSelf: 'flex-start' },
    });

/**
 * A framework's Timeline tab (web pages/framework/TimelineTab.jsx): its
 * phases as a vertical stepper, then the regulatory calendar filtered to
 * the framework, then where the dates come from (SourcesGroup). Milestones
 * come from GET /calendar, the list the calendar page reads too; when it has
 * nothing for the framework the catalogue record's phases fill the track.
 * For the AI Act a passed Art. 50 phase is "missed" while an Art. 50 check
 * fails today.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useUserRefresh } from '@/shared/patterns';
import { Group, GroupedScroll, Text } from '@/shared/ui';

import { RegulatoryCalendar } from './RegulatoryCalendar';
import { SourcesGroup } from './SourcesGroup';
import { TimelineStepper } from './TimelineStepper';
import { useCalendar } from '../hooks/calendar';
import { useChecks, useFrameworks } from '../hooks/hub';
import { useComplianceAccess } from '../hooks/useComplianceAccess';
import { resolveNow } from '../model/calendarMath';
import { frameworkIdOf, type ComplianceSection } from '../model/sections';
import { disclosureFails, frameworkRecord, milestonesOf, phasesOf } from '../model/timeline';

/** The line the Phases group shows instead of the track: loading, failed or no stages; null when it has a track. */
function trackState(s: { unread: boolean; failed: boolean; empty: boolean }, t: TranslateFn): { text: string; testID: string } | null {
    if (s.unread && !s.failed) return { text: t('common.loading', 'Loading...'), testID: 'timeline-loading' };
    if (s.unread) return { text: t('compliance.tbl_calendar_unavailable', 'The regulatory calendar could not be read.'), testID: 'timeline-failed' };
    return s.empty ? { text: t('compliance.tbl_timeline_none', 'This framework has no staged dates — it applies in full.'), testID: 'timeline-empty' } : null;
}

export function TimelineTab({ section, now }: { section: ComplianceSection; now?: number }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const gate = useComplianceAccess();
    const frameworkId = frameworkIdOf(section);
    const isAia = section.regulation === 'AIA';
    const calendar = useCalendar(gate.open);
    const frameworks = useFrameworks(gate.open);
    const checks = useChecks(frameworkId, gate.open && isAia);
    const refresh = useUserRefresh(() => Promise.all([calendar.refetch(), frameworks.refetch()]));
    const nowMs = resolveNow(now);
    const milestones = milestonesOf(calendar.data?.milestones, frameworkId);
    const record = frameworkRecord(frameworks.data?.frameworks, frameworkId);
    const art50Missed = isAia && disclosureFails(checks.data);
    const phases = phasesOf(milestones, record, frameworkId, { t, now: nowMs, art50Missed });
    const state = trackState({ unread: milestones === null && !record, failed: calendar.isError, empty: phases.length === 0 }, t);
    return (
        <GroupedScroll refresh={refresh} testID="timeline-tab">
            <Group title={t('compliance.tbl_timeline_phases', 'Phases')}>
                <View style={styles.body}>
                    {state ? (
                        <Text variant="caption" tone="tertiary" testID={state.testID}>
                            {state.text}
                        </Text>
                    ) : (
                        <TimelineStepper phases={phases} now={nowMs} />
                    )}
                </View>
            </Group>
            {milestones ? (
                <Group title={t('compliance.fw_calendar_title', 'Regulatory calendar')}>
                    <View style={styles.body}>
                        <RegulatoryCalendar milestones={milestones} now={nowMs} testID="timeline-calendar" />
                    </View>
                </Group>
            ) : null}
            {record ? <SourcesGroup sources={record.sources} review={record.legal_review} /> : null}
        </GroupedScroll>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        body: { paddingHorizontal: theme.spacing[3.5], paddingVertical: theme.spacing[3] },
    });

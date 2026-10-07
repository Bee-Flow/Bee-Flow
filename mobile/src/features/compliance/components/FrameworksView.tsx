/**
 * "More frameworks" (web pages/FrameworksPage.jsx): when the legal register
 * was last checked, the optional frameworks in two groups — Enabled and
 * Available, the own-framework door last — and the regulatory calendar
 * below them. Core frameworks are always on and not listed; a locked one is
 * shown with its lock line and "View plan", never hidden.
 *
 * Server: POST /frameworks/:id/enable | disable (403 when the plan lacks the
 * framework) and /frameworks/:id/relevance; GET /calendar.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ApiError } from '@/core/api/client';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useConfirm, useUserRefresh } from '@/shared/patterns';
import { Button, ErrorState, Group, GroupedScroll, LoadingState, NavRow, useToast } from '@/shared/ui';

import { FrameworkInfoSheet } from './FrameworkInfoSheet';
import { FrameworkRow, frameworkName } from './FrameworkRow';
import { LegalStatusBanner } from './LegalStatusBanner';
import { RegulatoryCalendar } from './RegulatoryCalendar';
import type { Framework } from '../api/hubReaders';
import { useCalendar } from '../hooks/calendar';
import { useCounts, useFrameworkRelevance, useFrameworks, useToggleFramework } from '../hooks/hub';
import { frameworkGroups, toggleFailureText } from '../model/frameworkCard';
import { sectionRoute } from '../model/navigation';

/** The phone's plan screen (web: settings/organisation/license). */
export const PLAN_ROUTE = '/org/billing';
export const CUSTOM_ROUTE = sectionRoute('custom');

function useFrameworkActions() {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const toggle = useToggleFramework();
    const relevance = useFrameworkRelevance();
    const onToggle = async (fw: Framework, enabled: boolean) => {
        const name = frameworkName(fw, t);
        if (!enabled) {
            const ok = await confirm({
                title: `${t('compliance.fw_disable', 'Disable')} · ${name}`,
                message: t('mobile.compliance.fw_disable_message', 'Its checks stop running and its registers leave the hub. The records stay; enabling it again brings them back.'),
                confirmLabel: t('compliance.fw_disable', 'Disable'),
            });
            if (!ok) return;
        }
        try {
            await toggle.mutateAsync({ id: fw.id, enabled });
            toast(enabled ? t('compliance.fw_toast_enabled', 'Framework enabled — its checks are running') : t('compliance.fw_toast_disabled', 'Framework disabled'), 'success');
        } catch (err) {
            toast(toggleFailureText(err instanceof ApiError ? err.status : undefined, t), 'error');
        }
    };
    const onRelevance = async (fw: Framework) => {
        try {
            await relevance.mutateAsync({ id: fw.id, relevance: fw.relevance === 'not_relevant' ? 'relevant' : 'not_relevant' });
        } catch (err) {
            toast(toggleFailureText(err instanceof ApiError ? err.status : undefined, t), 'error');
        }
    };
    return { onToggle, onRelevance, busy: toggle.isPending || relevance.isPending };
}

export function FrameworksView({ now }: { now?: number }) {
    const t = useTranslation();
    const router = useRouter();
    const styles = useThemedStyles(makeStyles);
    const frameworks = useFrameworks(true);
    const counts = useCounts(true);
    const calendar = useCalendar(true);
    const actions = useFrameworkActions();
    const [open, setOpen] = useState<Framework | null>(null);
    const refresh = useUserRefresh(() => Promise.all([frameworks.refetch(), calendar.refetch()]));

    if (frameworks.isLoading) return <LoadingState />;
    if (frameworks.isError || !frameworks.data) return <ErrorState error={frameworks.error} onRetry={() => void frameworks.refetch()} />;
    const groups = frameworkGroups(frameworks.data.frameworks) ?? { enabled: [], available: [] };
    const c = counts.data;
    const row = (fw: Framework) => (
        <FrameworkRow
            key={fw.id}
            framework={fw}
            now={now}
            busy={actions.busy}
            onToggle={(f, next) => void actions.onToggle(f, next)}
            onRelevance={(f) => void actions.onRelevance(f)}
            onOpen={setOpen}
            onViewPlan={() => router.push(PLAN_ROUTE)}
        />
    );
    return (
        <GroupedScroll refresh={refresh} testID="frameworks-view">
            <View style={styles.top}>
                <LegalStatusBanner
                    catalogue={frameworks.data.catalogue}
                    counts={{ active: c?.frameworksActive ?? null, candidates: c?.candidates ?? null, recent: c?.recentlyInForce ?? null }}
                />
                <View style={styles.add}>
                    <Button variant="secondary" size="sm" iconName="Plus" label={t('compliance.hdr_fw_add', 'Add framework')} onPress={() => router.push(CUSTOM_ROUTE)} testID="frameworks-add" />
                </View>
            </View>
            {groups.enabled.length > 0 ? <Group title={t('compliance.fw_group_enabled', 'Enabled')}>{groups.enabled.map(row)}</Group> : null}
            <Group
                title={t('compliance.fw_group_available', 'Available')}
                footer={t('compliance.fw_candidates_hint', 'not enabled yet — enabling a framework adds checks, registers and calendar dates')}
            >
                {groups.available.map(row)}
                <NavRow
                    icon="Plus"
                    label={t('compliance.fw_custom_title', 'Own framework')}
                    description={t('compliance.fw_custom_desc', "For example a customer's NIS2 questionnaire or a sector code: attest checks yourself, with evidence and the same clocks.")}
                    onPress={() => router.push(CUSTOM_ROUTE)}
                    testID="framework-own"
                />
            </Group>
            <Group title={t('compliance.fw_calendar_title', 'Regulatory calendar')} footer={t('compliance.fw_calendar_hint', 'only frameworks that affect you')}>
                <View style={styles.calendar}>
                    <RegulatoryCalendar milestones={calendar.data?.milestones} failed={calendar.isError} now={now} testID="fw-calendar" />
                </View>
            </Group>
            <FrameworkInfoSheet framework={open} onClose={() => setOpen(null)} />
        </GroupedScroll>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        top: { gap: theme.spacing[2] },
        add: { alignSelf: 'flex-start' },
        calendar: { paddingHorizontal: theme.spacing[3.5], paddingVertical: theme.spacing[2.5] },
    });

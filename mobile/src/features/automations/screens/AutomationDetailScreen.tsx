/**
 * One automation: run it, watch it, understand why it failed — and a way into
 * its flow.
 *
 *   run it        — one button, honest about all three answers the server can
 *                   give (finished / still going / nothing to test against).
 *   watch it      — the live SSE feed, plus a poll for the minutes the socket
 *                   spent in a pocket.
 *   understand it — the last failure's error at the TOP of the screen.
 *   adjust it     — name, description, on/off and the schedule here; the
 *                   steps themselves in the flow editor (Edit flow, the
 *                   header's workflow button), features/flow-editor.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { QueryScreen, type DetailQuery } from '@/shared/patterns';
import { Icon, IconButton, ScreenHeader, useToast } from '@/shared/ui';

import { AutomationDetailBody } from '../components/AutomationDetailBody';
import { AutomationEditSheet } from '../components/AutomationEditSheet';
import { ScheduleSheet } from '../components/ScheduleSheet';
import { useAutomationDetail } from '../hooks/useAutomationDetail';
import { describeTrigger } from '../model/trigger';
import type { Automation } from '../model/types';

export function AutomationDetailScreen({ id }: { id: string }) {
    const theme = useTheme();
    const t = useTranslation();
    const router = useRouter();
    const { toast } = useToast();
    const [editSheet, setEditSheet] = useState(false);
    const [scheduleSheet, setScheduleSheet] = useState(false);
    const state = useAutomationDetail(id);
    const { detail, runs } = state;
    const automation = detail.data?.automation ?? null;

    const query: DetailQuery<Automation> = {
        data: automation ?? undefined,
        isLoading: detail.isLoading,
        isError: detail.isError,
        error: detail.error ?? new Error(t('mobile.automations.not_loaded', 'This automation could not be loaded.')),
        refetch: detail.refetch,
    };

    const header = (loaded: Automation | undefined) =>
        loaded ? (
            <ScreenHeader
                title={loaded.title || t('mobile.automations.untitled', 'Untitled routine')}
                subtitle={describeTrigger(loaded.definition?.trigger ?? null)}
                actions={
                    <>
                        <IconButton
                            icon={<Icon name="Workflow" size={18} color={theme.colors.textSecondary} />}
                            accessibilityLabel={t('mobile.automations.edit_flow', 'Edit flow')}
                            onPress={() => router.push(`/automations/${id}/build`)}
                        />
                        <IconButton
                            icon={<Icon name="Pen" size={18} color={theme.colors.textSecondary} />}
                            accessibilityLabel={t('mobile.automations.edit_details', 'Edit name and description')}
                            onPress={() => setEditSheet(true)}
                        />
                    </>
                }
            />
        ) : (
            <ScreenHeader title={t('mobile.automations.one', 'Automation')} />
        );

    return (
        <>
            <QueryScreen
                query={query}
                header={header}
                refresh={() => Promise.all([detail.refetch(), runs.refetch()])}
            >
                {(loaded) => (
                    <AutomationDetailBody
                        id={id}
                        automation={loaded}
                        state={state}
                        onDecided={() => {
                            state.refresh();
                            toast(t('mobile.automations.decision_sent', 'Decision sent'), 'success');
                        }}
                        onEditSchedule={() => setScheduleSheet(true)}
                    />
                )}
            </QueryScreen>

            {automation ? (
                <>
                    <AutomationEditSheet
                        visible={editSheet}
                        automation={automation}
                        onClose={() => setEditSheet(false)}
                    />
                    <ScheduleSheet
                        id={id}
                        visible={scheduleSheet}
                        automation={automation}
                        onClose={() => setScheduleSheet(false)}
                    />
                </>
            ) : null}
        </>
    );
}

/**
 * "More frameworks" (web: pages/FrameworksPage, the All tab): every built-in
 * framework with a switch — enabling one runs its first sweep and adds its
 * checks, registers and calendar dates; a core framework is always on, and
 * one the plan does not include is shown locked, not hidden.
 *
 * Server: POST /frameworks/:id/enable | disable (NoBody), 403 when the plan
 * lacks the framework (frameworks.js / frameworkPolicy).
 */

import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useConfirm, useUserRefresh } from '@/shared/patterns';
import { ErrorState, Group, GroupedScroll, LoadingState, ToggleRow, useToast } from '@/shared/ui';

import type { Framework } from '../api/readers';
import { useToggleFramework } from '../hooks/mutations';
import { useFrameworks } from '../hooks/queries';
import { formatDate } from '../hooks/useFormatter';

function describe(fw: Framework, t: ReturnType<typeof useTranslation>): string {
    if (fw.locked) return t('compliance.fw_toast_locked', 'This framework is not included in your plan');
    const parts: string[] = [fw.enabled ? t('compliance.fw_enabled', 'Enabled') : t('compliance.fw_candidates', 'Candidates')];
    if (fw.score !== null) parts.push(String(fw.score));
    const since = formatDate(fw.in_force_since);
    if (since) parts.push(t('compliance.fw_in_force_since', 'in force since {date}', { date: since }));
    return parts.join(' · ');
}

export function FrameworksView() {
    const t = useTranslation();
    const { toast } = useToast();
    const confirm = useConfirm();
    const frameworks = useFrameworks(true);
    const toggle = useToggleFramework();
    const refresh = useUserRefresh(() => frameworks.refetch());

    const onToggle = async (fw: Framework, enabled: boolean) => {
        const name = fw.name_key ? t(fw.name_key, fw.id) : fw.id;
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
        } catch (err) {
            toast(describeError(err).message || t('compliance.fw_toast_failed', 'Could not update the framework'), 'error');
        }
    };

    if (frameworks.isLoading) return <LoadingState />;
    if (frameworks.isError || !frameworks.data) return <ErrorState error={frameworks.error} onRetry={() => void frameworks.refetch()} />;
    return (
        <GroupedScroll refresh={refresh}>
            <Group footer={t('compliance.fw_candidates_hint', 'not enabled yet — enabling a framework adds checks, registers and calendar dates')}>
                {frameworks.data.frameworks.map((fw) => (
                    <ToggleRow
                        key={fw.id}
                        testID={`framework-toggle-${fw.id}`}
                        label={fw.name_key ? t(fw.name_key, fw.id) : fw.id}
                        description={describe(fw, t)}
                        value={fw.enabled}
                        disabled={fw.core || Boolean(fw.locked) || toggle.isPending}
                        onValueChange={(next) => void onToggle(fw, next)}
                    />
                ))}
            </Group>
        </GroupedScroll>
    );
}

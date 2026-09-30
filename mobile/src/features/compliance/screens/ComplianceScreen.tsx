/**
 * The Compliance Center's home (web: ComplianceMobile, the hub's own phone
 * frame): "Compliance" with the last run and the open count under it, and
 * three views of one screen — Overview (scores,
 * attention, deadlines, reports, under a labelled run-now button), Frameworks and Registers (the rail's rows
 * with their counts). A section opens as its own screen.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useUserRefresh } from '@/shared/patterns';
import { Button, GroupedScroll, Segmented, useToast } from '@/shared/ui';

import { ComplianceFrame } from '../components/ComplianceFrame';
import { HomeOverview } from '../components/HomeOverview';
import { SectionRows } from '../components/SectionRows';
import { useRunAllChecks } from '../hooks/mutations';
import { useCounts, useFrameworks } from '../hooks/queries';
import { useComplianceAccess } from '../hooks/useComplianceAccess';
import { hubSubtitle } from '../model/counts';

type View = 'overview' | 'frameworks' | 'registers';

export function ComplianceScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const gate = useComplianceAccess();
    const counts = useCounts(gate.open);
    const frameworks = useFrameworks(gate.open);
    const run = useRunAllChecks();
    const [view, setView] = useState<View>('overview');
    const enabled = new Set((frameworks.data?.frameworks ?? []).filter((f) => f.enabled).map((f) => f.id));

    const onRun = async () => {
        try {
            const result = await run.mutateAsync(undefined);
            const score = result.score === null ? '' : ` · ${result.score}/100`;
            toast(`${t('compliance.toast_scan_complete', 'Compliance scan complete')}${score}`, 'success');
        } catch (err) {
            toast(describeError(err).message || t('compliance.toast_scan_failed', 'Scan failed — see server logs'), 'error');
        }
    };

    const segments = [
        { value: 'overview' as const, label: t('compliance.mob_seg_overview', 'Overview') },
        { value: 'frameworks' as const, label: t('compliance.mob_seg_frameworks', 'Frameworks') },
        { value: 'registers' as const, label: t('compliance.mob_seg_registers', 'Registers') },
    ];

    const refresh = useUserRefresh(() => Promise.all([counts.refetch(), frameworks.refetch()]));

    return (
        <ComplianceFrame
            title={t('settings.compliance', 'Compliance')}
            subtitle={hubSubtitle(counts.data, t) ?? undefined}
            gate={gate}
        >
            <GroupedScroll refresh={refresh}>
                <Segmented
                    fullWidth
                    options={segments}
                    value={view}
                    onChange={setView}
                    accessibilityLabel={t('compliance.mob_views_aria', 'Compliance views')}
                />
                {view === 'overview' ? (
                    <>
                        <Button
                            testID="compliance-run"
                            label={run.isPending ? t('compliance.running', 'Running...') : t('compliance.run_now', 'Run checks now')}
                            iconName="Play"
                            variant="secondary"
                            loading={run.isPending}
                            disabled={run.isPending}
                            fullWidth
                            onPress={() => void onRun()}
                        />
                        <HomeOverview counts={counts.data} enabled={enabled} />
                    </>
                ) : null}
                {view === 'frameworks' ? <SectionRows groups={['frameworks']} counts={counts.data} enabled={enabled} /> : null}
                {view === 'registers' ? <SectionRows groups={['registers', 'admin']} counts={counts.data} enabled={enabled} showTitles /> : null}
            </GroupedScroll>
        </ComplianceFrame>
    );
}

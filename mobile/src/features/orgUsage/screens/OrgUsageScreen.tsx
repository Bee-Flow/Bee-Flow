/**
 * Usage & Monitoring for the organisation — the phone's UsageSection.jsx:
 * one range for the whole dashboard, and the report tabs Overview, Feedback
 * and Stopped early (the web's Terminations). The two non-overview reports need the
 * `advanced_usage_monitoring` licence feature; like the web, a plan without
 * it only gets the Overview tab (and never a flash of the others while the
 * entitlements load: a pending gate hides them too).
 *
 * The guardrail and integration reports moved to the Privacy Shield's
 * "What happened" tab on the web, and live there on the phone too.
 */

import React, { useState } from 'react';

import { useGate } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useOrgContext } from '@/features/org';
import { Screen, ScreenHeader, TabBar, type TabBarItem } from '@/shared/ui';

import { AdminOnly } from '../components/AdminOnly';
import { FeedbackPane } from '../components/FeedbackPane';
import { OverviewPane } from '../components/OverviewPane';
import { RangePills } from '../components/RangePills';
import { TerminationsPane } from '../components/TerminationsPane';
import type { RangePreset } from '../model/range';

type ReportTab = 'overview' | 'feedback' | 'terminations';

function Dashboard() {
    const t = useTranslation();
    const advanced = useGate({ license: 'advanced_usage_monitoring' });
    const [tab, setTab] = useState<ReportTab>('overview');
    const [range, setRange] = useState<RangePreset>('30d');
    const tabs: TabBarItem<ReportTab>[] = [
        { id: 'overview', label: t('usage.tab_overview', 'Overview'), icon: 'BarChart3' },
        ...(advanced.visible
            ? ([
                  { id: 'feedback', label: t('usage.tab_feedback', 'Feedback'), icon: 'ThumbsUp' },
                  { id: 'terminations', label: t('mobile.orgUsage.tab_stopped_early', 'Stopped early'), icon: 'TriangleAlert' },
              ] as TabBarItem<ReportTab>[])
            : []),
    ];
    // Bounce to the overview when the licence goes, as the web does.
    const active: ReportTab = advanced.visible ? tab : 'overview';
    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={t('usage.title', 'Usage & Monitoring')} subtitle={t('usage.subtitle', 'Track AI consumption across your organisation')} />
            <RangePills value={range} onChange={setRange} />
            {tabs.length > 1 ? <TabBar items={tabs} value={active} onChange={setTab} /> : null}
            {active === 'overview' ? <OverviewPane range={range} /> : null}
            {active === 'feedback' ? <FeedbackPane range={range} /> : null}
            {active === 'terminations' ? <TerminationsPane range={range} /> : null}
        </Screen>
    );
}

export function OrgUsageScreen() {
    const { orgId, isOrgAdmin } = useOrgContext();
    if (!orgId || !isOrgAdmin) return <AdminOnly />;
    return <Dashboard />;
}

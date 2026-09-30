/**
 * Usage and spend.
 *
 * Two numbers matter on a phone: what has this cost, and how close am I to the
 * point where Bee Flow starts refusing? Everything else — per-agent breakdowns,
 * guardrail events, egress ledgers — is the organisation's Usage & Monitoring,
 * which an org admin reaches from the foot of this screen.
 *
 * The scope switch is not a nicety. `/api/usage/*` scopes to the caller's
 * ORGANISATION when they belong to one, so a member's default view is the
 * whole company's spend. Showing that number without saying whose it is would
 * be the single most misleading thing this app could do, so the scope is a
 * visible control with "Just me" as the default for anyone in an organisation.
 */

import React, { useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { ErrorState, GroupedScroll, ListSkeleton, Screen, ScreenHeader } from '@/shared/ui';

import { LicenceGroup } from '../components/LicenceGroup';
import { ModelBreakdownGroup } from '../components/ModelBreakdownGroup';
import { PlanGroup } from '../components/PlanGroup';
import { UsageFilters } from '../components/UsageFilters';
import { UsageFooter } from '../components/UsageFooter';
import { UsageTotalsGroup } from '../components/UsageTotalsGroup';
import { useUsageOverview } from '../hooks/useUsageOverview';

export function UsageScreen() {
    const t = useTranslation();
    const { user } = useAuth();
    const [days, setDays] = useState(30);
    const inOrg = Boolean(user?.organizationId);
    const [mineOnly, setMineOnly] = useState(true);
    const scopedUserId = inOrg && mineOnly ? (user?.id ?? null) : null;
    const { summary, timeline, models, license, plan, columns, totalCost, flatRate, refresh } =
        useUsageOverview(days, scopedUserId);

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title={t('mobile.usage.title', 'Usage')} subtitle={scopeSubtitle(inOrg, mineOnly, t)} />

            <GroupedScroll refresh={refresh}>
                <UsageFilters
                    days={days}
                    onDays={setDays}
                    inOrg={inOrg}
                    mineOnly={mineOnly}
                    onMineOnly={setMineOnly}
                />

                {summary.isLoading ? (
                    <ListSkeleton rows={4} />
                ) : summary.isError ? (
                    <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
                ) : (
                    <>
                        <UsageTotalsGroup
                            days={days}
                            summary={summary.data}
                            totalCost={totalCost}
                            flatRate={flatRate}
                            planName={plan.data?.limits.plan_name}
                            columns={columns}
                            chartLoading={timeline.isLoading}
                        />
                        {plan.data ? <PlanGroup plan={plan.data} summary={summary.data} /> : null}
                        <LicenceGroup license={license.data} />
                        <ModelBreakdownGroup
                            models={models.data}
                            loading={models.isLoading}
                            wholeOrg={inOrg && !mineOnly}
                            flatRate={flatRate}
                        />
                    </>
                )}

                <UsageFooter />
            </GroupedScroll>
        </Screen>
    );
}

/** Whose numbers these are — said out loud, because the default is not obvious. */
function scopeSubtitle(inOrg: boolean, mineOnly: boolean, t: TranslateFn): string {
    if (!inOrg) return t('mobile.usage.scope_account', 'Your account');
    return mineOnly ? t('mobile.usage.scope_own', 'Your own activity') : t('mobile.usage.scope_everyone', 'Everyone in your organisation');
}

/**
 * Usage and spend.
 *
 * Two numbers matter on a phone: what has this cost, and how close am I to the
 * point where Bee Flow starts refusing? Everything else — per-agent breakdowns,
 * guardrail events, egress ledgers — is a desktop dashboard, and this screen
 * links to that rather than reproducing it badly.
 *
 * The scope switch is not a nicety. `/api/usage/*` scopes to the caller's
 * ORGANISATION when they belong to one (routes/usage.js `attachOrgFilter`), so
 * a member's default view is the whole company's spend. Showing that number
 * without saying whose it is would be the single most misleading thing this
 * app could do, so the scope is a visible control with "Just me" as the
 * default for anyone in an organisation.
 *
 * The chart is drawn by hand in react-native-svg (src/ui/Charts.tsx) — no
 * charting library is installed, and thirty rectangles do not justify one.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import {
    getConsumerUsage,
    getCostTimeline,
    getLicenseStatus,
    getUsageByModel,
    getUsageSummary,
    settingsKeys,
} from '../../src/features/settings/api';
import {
    compactNumber,
    currency,
    fractionOfLimit,
    humanise,
    num,
    shortDay,
    shortModel,
} from '../../src/features/settings/format';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../src/ui/Badge';
import { BarChart, Meter, Stat } from '../../src/ui/Charts';
import { Banner, ErrorState, ListSkeleton } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Divider } from '../../src/ui/Surface';
import { Text } from '../../src/ui/Text';

const RANGES = [
    { days: 7, label: '7 days' },
    { days: 30, label: '30 days' },
    { days: 90, label: '90 days' },
];

export default function UsageScreen() {
    const theme = useTheme();
    const router = useRouter();
    const { user } = useAuth();

    const [days, setDays] = useState(30);
    // Someone with no organisation is force-scoped to themselves server-side,
    // so the switch is meaningless for them and is not shown.
    const inOrg = Boolean(user?.organizationId);
    const [mineOnly, setMineOnly] = useState(true);
    const scopedUserId = inOrg && mineOnly ? (user?.id ?? null) : null;

    const summary = useQuery({
        queryKey: settingsKeys.usageSummary(days, scopedUserId),
        queryFn: ({ signal }) => getUsageSummary({ days, userId: scopedUserId }, signal),
    });

    const timeline = useQuery({
        queryKey: settingsKeys.usageCostTimeline(days, scopedUserId),
        queryFn: ({ signal }) => getCostTimeline({ days, userId: scopedUserId }, signal),
    });

    const models = useQuery({
        queryKey: settingsKeys.usageByModel(days, scopedUserId),
        queryFn: ({ signal }) => getUsageByModel({ days, userId: scopedUserId }, signal),
    });

    const license = useQuery({
        queryKey: settingsKeys.license,
        queryFn: ({ signal }) => getLicenseStatus(signal),
        staleTime: 5 * 60_000,
        retry: false,
    });

    /** Only a consumer account has a plan with hard caps; org plans are billed
     *  through the subscription and this endpoint 403s for them. */
    const plan = useQuery({
        queryKey: settingsKeys.consumerUsage,
        queryFn: ({ signal }) => getConsumerUsage(signal),
        staleTime: 5 * 60_000,
        retry: false,
    });

    const columns = useMemo(
        () =>
            (timeline.data ?? []).map((point) => ({
                label: shortDay(point.period),
                value: num(point.total_cost),
            })),
        [timeline.data],
    );

    const totalCost = num(
        summary.data?.combined_total_cost ?? summary.data?.total_estimated_cost ?? 0,
    );

    // A flat-rate plan bills per seat, not per token. Showing a euro figure
    // there invites "why am I being charged this?" about a number nobody is
    // charged.
    const flatRate = plan.data?.billing_model === 'fixed';

    const refreshing = summary.isRefetching || timeline.isRefetching || models.isRefetching;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader
                title="Usage"
                subtitle={
                    inOrg
                        ? mineOnly
                            ? 'Your own activity'
                            : 'Everyone in your organisation'
                        : 'Your account'
                }
            />

            <ScrollView
                refreshControl={
                    <RefreshControl
                        refreshing={refreshing}
                        onRefresh={() => {
                            void summary.refetch();
                            void timeline.refetch();
                            void models.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                <View style={{ gap: theme.spacing.md }}>
                    <View
                        accessibilityRole="tablist"
                        style={{ flexDirection: 'row', gap: theme.spacing.sm }}
                    >
                        {RANGES.map((range) => (
                            <Chip
                                key={range.days}
                                label={range.label}
                                selected={days === range.days}
                                onPress={() => setDays(range.days)}
                            />
                        ))}
                    </View>
                    {inOrg ? (
                        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                            <Chip
                                label="Just me"
                                selected={mineOnly}
                                onPress={() => setMineOnly(true)}
                            />
                            <Chip
                                label="Whole organisation"
                                selected={!mineOnly}
                                onPress={() => setMineOnly(false)}
                            />
                        </View>
                    ) : null}
                </View>

                {summary.isLoading ? (
                    <ListSkeleton rows={4} />
                ) : summary.isError ? (
                    <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
                ) : (
                    <>
                        <Group title={`Last ${days} days`}>
                            <View
                                style={{
                                    flexDirection: 'row',
                                    paddingHorizontal: theme.spacing.lg,
                                    gap: theme.spacing.md,
                                }}
                            >
                                <Stat
                                    label="Messages"
                                    value={compactNumber(summary.data?.total_calls)}
                                    caption={`${compactNumber(summary.data?.total_tokens)} tokens`}
                                />
                                {flatRate ? (
                                    <Stat
                                        label="Plan"
                                        value={plan.data?.limits.plan_name ?? 'Flat rate'}
                                        caption="Billed per seat, not per token"
                                    />
                                ) : (
                                    <Stat
                                        label="Cost"
                                        value={currency(totalCost)}
                                        caption={
                                            num(summary.data?.azure_services_total_cost) > 0
                                                ? 'Includes Azure services'
                                                : 'Estimated'
                                        }
                                        tone="accent"
                                    />
                                )}
                            </View>

                            <Divider inset={theme.spacing.lg} />

                            <View style={{ padding: theme.spacing.lg }}>
                                {timeline.isLoading ? (
                                    <ListSkeleton rows={2} />
                                ) : (
                                    <BarChart
                                        columns={columns}
                                        summary={`Daily cost over the last ${days} days, totalling ${currency(totalCost)}`}
                                    />
                                )}
                            </View>
                        </Group>

                        {plan.data ? (
                            <Group
                                title="Your plan"
                                footer="When a limit is reached Bee Flow refuses new work with a clear message rather than silently degrading."
                            >
                                <View style={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
                                    <Meter
                                        label="Spend this period"
                                        valueLabel={currency(plan.data.usage.total_billed_cost)}
                                        fraction={fractionOfLimit(
                                            plan.data.usage.total_billed_cost,
                                            plan.data.limits.max_cost_per_month,
                                        )}
                                        capLabel={
                                            plan.data.limits.max_cost_per_month
                                                ? `of ${currency(plan.data.limits.max_cost_per_month)}`
                                                : 'no limit'
                                        }
                                    />
                                    <Meter
                                        label="Messages this period"
                                        valueLabel={compactNumber(summary.data?.total_calls)}
                                        fraction={fractionOfLimit(
                                            num(summary.data?.total_calls),
                                            plan.data.limits.max_messages_per_month,
                                        )}
                                        capLabel={
                                            plan.data.limits.max_messages_per_month
                                                ? `of ${compactNumber(plan.data.limits.max_messages_per_month)}`
                                                : 'no limit'
                                        }
                                    />
                                    <Meter
                                        label="Tokens this period"
                                        valueLabel={compactNumber(summary.data?.total_tokens)}
                                        fraction={fractionOfLimit(
                                            num(summary.data?.total_tokens),
                                            plan.data.limits.max_tokens_per_month,
                                        )}
                                        capLabel={
                                            plan.data.limits.max_tokens_per_month
                                                ? `of ${compactNumber(plan.data.limits.max_tokens_per_month)}`
                                                : 'no limit'
                                        }
                                    />
                                </View>
                                <InfoRow label="Plan" value={plan.data.limits.plan_name} />
                                {plan.data.subscription ? (
                                    <InfoRow
                                        label="Subscription"
                                        value={humanise(plan.data.subscription.status)}
                                        tone={
                                            plan.data.subscription.status === 'active'
                                                ? 'success'
                                                : 'warning'
                                        }
                                    />
                                ) : null}
                            </Group>
                        ) : null}

                        <Group
                            title="Licence"
                            footer="Your tier decides which features are available, independently of how much you use."
                        >
                            <View
                                style={{
                                    flexDirection: 'row',
                                    alignItems: 'center',
                                    gap: theme.spacing.md,
                                    paddingHorizontal: theme.spacing.lg,
                                    paddingVertical: theme.spacing.md,
                                    minHeight: theme.minTouch,
                                }}
                            >
                                <Text variant="body" style={{ flex: 1 }}>
                                    Tier
                                </Text>
                                <Badge
                                    label={humanise(license.data?.tier ?? 'community')}
                                    tone={
                                        license.data && license.data.tier !== 'community'
                                            ? 'accent'
                                            : 'neutral'
                                    }
                                />
                            </View>
                            <InfoRow
                                label="Source"
                                value={licenceSource(license.data?.source)}
                            />
                            {license.data?.license?.expiresAt ? (
                                <InfoRow
                                    label="Valid until"
                                    value={new Date(
                                        license.data.license.expiresAt,
                                    ).toLocaleDateString()}
                                />
                            ) : null}
                        </Group>

                        <Group
                            title="Where it went"
                            footer={
                                mineOnly || !inOrg
                                    ? 'Your own calls, grouped by the model that served them.'
                                    : 'Every call in your organisation, grouped by model.'
                            }
                        >
                            {models.isLoading ? (
                                <NoteRow>
                                    <ListSkeleton rows={3} />
                                </NoteRow>
                            ) : models.data && models.data.length > 0 ? (
                                models.data.slice(0, 10).map((row) => (
                                    <View
                                        key={row.model}
                                        style={{
                                            flexDirection: 'row',
                                            alignItems: 'center',
                                            gap: theme.spacing.md,
                                            paddingHorizontal: theme.spacing.lg,
                                            paddingVertical: theme.spacing.md,
                                            minHeight: theme.minTouch,
                                        }}
                                    >
                                        <View style={{ flex: 1, gap: 2 }}>
                                            <Text variant="body" numberOfLines={1}>
                                                {shortModel(row.model)}
                                            </Text>
                                            <Text variant="caption" tone="tertiary">
                                                {compactNumber(row.calls)} calls ·{' '}
                                                {compactNumber(row.total_tokens)} tokens
                                            </Text>
                                        </View>
                                        {flatRate ? null : (
                                            <Text variant="body" tone="tertiary">
                                                {currency(row.estimated_cost)}
                                            </Text>
                                        )}
                                    </View>
                                ))
                            ) : (
                                <NoteRow>Nothing has been used in this period.</NoteRow>
                            )}
                        </Group>
                    </>
                )}

                <Banner tone="info" icon="monitor">
                    <View
                        style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}
                    >
                        <Text variant="caption" style={{ flex: 1 }}>
                            Per-user, per-agent and guardrail breakdowns live in the web app&rsquo;s
                            Usage &amp; Monitoring dashboard.
                        </Text>
                        <Feather name="external-link" size={14} color={theme.colors.textMuted} />
                    </View>
                </Banner>

                <Group title="Related">
                    <NoteRow>
                        <Text
                            variant="caption"
                            tone="accent"
                            accessibilityRole="link"
                            onPress={() => router.push('/org')}
                        >
                            Open your organisation
                        </Text>
                    </NoteRow>
                </Group>
            </ScrollView>
        </Screen>
    );
}

/** Where the tier came from, in words rather than in the server's enum. */
function licenceSource(source: string | undefined): string {
    switch (source) {
        case 'license_key':
            return 'A licence key';
        case 'stripe_subscription':
            return 'Your subscription';
        case 'server_license':
            return 'This installation’s licence';
        default:
            return 'Bee Flow Community';
    }
}

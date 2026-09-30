/**
 * Usage this period and the plan's limits (OrgLicenseSection.jsx "Usage Bars"
 * and "Plan limits grid"): AI usage as a share of the cost cap only — no euro
 * amount — then the concrete caps, never an "unlimited" tile, and the plan's
 * notes (the per-seat note lives on the billing card). The 80 % nudge sits
 * above them.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Banner, Button, Group, InfoRow, Meter, NoteRow } from '@/shared/ui';

import { costPercent, hasCostCap, limitItems, showUpgradeNudge, type LimitKey } from '../model/subscription';
import type { Subscription } from '../model/types';

function limitLabel(key: LimitKey, t: TranslateFn): string {
    if (key === 'users') return t('org.users', 'Users');
    if (key === 'agents') return t('org.agents', 'Agents');
    return t('org.knowledge_sources', 'Knowledge Sources');
}

export function UsageLimitsGroup({ sub, onUpgrade }: { sub: Subscription; onUpgrade: (() => void) | null }) {
    const t = useTranslation();
    const pct = costPercent(sub);
    const items = limitItems(sub);
    return (
        <>
            {showUpgradeNudge(sub) ? (
                <Banner
                    tone="warning"
                    icon="Sparkles"
                    action={
                        onUpgrade ? (
                            <Button label={t('mobile.billing.upgrade_plan', 'Upgrade plan')} size="sm" onPress={onUpgrade} />
                        ) : undefined
                    }
                >
                    {`${t('mobile.billing.nudge', "You've used {n}% of your AI usage budget this period.", { n: pct })} ${t('mobile.billing.nudge_hint', 'Upgrade to a higher plan for more AI usage.')}`}
                </Banner>
            ) : null}
            <Group title={t('org.usage_this_period', 'Usage this period')}>
                <Meter
                    label={t('org.ai_usage', 'AI usage')}
                    valueLabel={hasCostCap(sub.limits) ? `${pct}%` : '—'}
                    fraction={hasCostCap(sub.limits) ? pct / 100 : null}
                />
            </Group>
            {items.length > 0 || sub.notes ? (
                <Group title={t('org.plan_limits', 'Plan limits')}>
                    {items.map((item) => (
                        <InfoRow key={item.key} label={limitLabel(item.key, t)} value={item.value} tone="primary" />
                    ))}
                    {sub.notes ? <NoteRow>{`${t('org.notes', 'Notes')}: ${sub.notes}`}</NoteRow> : null}
                </Group>
            ) : null}
        </>
    );
}

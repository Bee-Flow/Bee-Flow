// "Integration status" of one organisation: each integration family and each
// catalogue integration with its state for the CHOSEN organisation, and a link
// to the one place that changes it (Access, the licence, the platform page
// that holds its credentials, or the member's own Settings > Connections).
// The rules are in integrationStatusModel.ts; this file only draws them.

import type { ReactNode } from 'react';
import { ArrowRight, RefreshCw } from 'lucide-react';
import NavLink from '@/components/shell/NavLink';
import Disclosure from '@/components/shared/Disclosure';
import { SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { ALERT_INFO, ALERT_WARNING, CHIP, CHIP_INFO, CHIP_SUCCESS, CHIP_WARNING, QUIET_BTN, SECONDARY_BTN } from '@/components/shared/adminUi';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { availabilityReasonText, availabilityUnknownText, type AvailabilityRead } from '@/utils/integrationAvailability';
import {
    TARGETS,
    appStatusGroups,
    familyStatusRows,
    nothingAvailable,
    targetHref,
    type IntegrationState,
    type StatusRow,
    type StatusTarget,
} from './integrationStatusModel';

/** The query result the overview reads (a react-query result fits). */
interface OverviewRead extends AvailabilityRead {
    isLoading?: boolean;
    isFetching?: boolean;
    refetch?: () => unknown;
}

interface IntegrationStatusOverviewProps {
    read: OverviewRead;
    platformAdmin: boolean;
    /** A self-hosted server: a plan question goes to the server licence. */
    selfHosted?: boolean;
}

const STATE_CHIP: Readonly<Record<IntegrationState, string>> = {
    available: CHIP_SUCCESS,
    per_user: CHIP_INFO,
    not_granted: CHIP_WARNING,
    not_in_plan: CHIP,
    not_configured: CHIP_WARNING,
    module_off: CHIP,
    not_bound: CHIP,
    unknown: CHIP,
};

function stateLabel(t: TranslateFn, state: IntegrationState): string {
    switch (state) {
        case 'available': return t('admin_connections.state_available', 'Available');
        case 'per_user': return t('admin_connections.state_per_user', 'Each member connects');
        case 'not_granted': return t('admin_connections.state_not_granted', 'Not granted');
        case 'not_in_plan': return t('admin_connections.state_not_in_plan', 'Not in plan');
        case 'not_configured': return t('admin_connections.state_not_configured', 'Not set up');
        case 'module_off': return t('admin_connections.state_module_off', 'Switched off');
        case 'not_bound': return t('admin_connections.state_not_bound', 'No Nextcloud');
        default: return t('admin_connections.state_unknown', 'Unknown');
    }
}

/** The sentence under a row: why it is in this state, or what a member does. */
function stateHint(t: TranslateFn, row: StatusRow, platformAdmin: boolean): string | undefined {
    if (row.state === 'per_user') return t('admin_connections.hint_per_user', 'Each member connects their own account in Settings › Connections.');
    if (row.state === 'unknown') return availabilityUnknownText(t);
    if (row.state === 'available') return row.description;
    const reason = row.reason ? availabilityReasonText(t, row.reason) : undefined;
    // Only a platform admin can set up the server; anyone else is told who can.
    if (row.state === 'not_configured' && !platformAdmin) {
        return t('admin_connections.hint_ask_platform_admin', '{reason}. Your platform administrator can set it up.', { reason: reason ?? '' });
    }
    return reason;
}

function TargetLink({ target }: { target: StatusTarget }) {
    const { t } = useTranslation();
    const href = targetHref(target, typeof window === 'undefined' ? '' : window.location.search);
    const go = () => {
        try {
            window.history.pushState({}, '', href);
            window.dispatchEvent(new PopStateEvent('popstate'));
        } catch {
            window.location.href = href;
        }
    };
    return (
        <NavLink href={href} onNavigate={go} className={`${QUIET_BTN} [text-decoration:none]!`}>
            {t(target.labelKey, target.labelFallback)}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </NavLink>
    );
}

function StatusRowView({ row, platformAdmin }: { row: StatusRow; platformAdmin: boolean }) {
    const { t } = useTranslation();
    return (
        <SettingRow label={row.label} hint={stateHint(t, row, platformAdmin)}>
            <div className="flex flex-wrap items-center justify-end gap-2" data-testid={`integration-status-${row.id}`} data-state={row.state}>
                <span className={STATE_CHIP[row.state]}>{stateLabel(t, row.state)}</span>
                {row.target && <TargetLink target={row.target} />}
            </div>
        </SettingRow>
    );
}

function categoryLabel(t: TranslateFn, category: string): string {
    switch (category) {
        case 'Google Workspace': return 'Google Workspace';
        case 'Microsoft 365': return 'Microsoft 365';
        case 'Nextcloud': return 'Nextcloud';
        case 'AI & Media': return t('admin_connections.category_ai_media', 'AI & media');
        case 'Developer': return t('admin_connections.category_developer', 'Developer tools');
        case 'Automation': return t('admin_connections.category_automation', 'Automation');
        case 'Productivity': return t('admin_connections.category_productivity', 'Productivity');
        case 'Health': return t('admin_connections.category_health', 'Health');
        case 'Social': return t('admin_connections.category_social', 'Social');
        default: return category;
    }
}

/** Nothing is usable: say so, per audience. */
function EmptyNotice({ platformAdmin }: { platformAdmin: boolean }) {
    const { t } = useTranslation();
    return (
        <div className={ALERT_INFO} role="note" data-testid="integration-status-empty">
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <span>
                    {platformAdmin
                        ? t('admin_connections.empty_platform', 'No integration is available to this organisation yet. Grant integrations in Access, or set them up on this server in Platform services.')
                        : t('admin_connections.empty_org', 'No integration is available to this organisation yet. Ask your platform administrator which integrations your plan includes.')}
                </span>
                <div className="flex flex-wrap gap-2">
                    <TargetLink target={TARGETS.access} />
                    {platformAdmin && <TargetLink target={TARGETS.platformServices} />}
                </div>
            </div>
        </div>
    );
}

function LoadingRows() {
    const { t } = useTranslation();
    return (
        <div role="status" className="flex flex-col gap-2">
            {[0, 1, 2].map(i => <div key={i} className="h-12 animate-pulse rounded-lg bg-[var(--bg-tertiary)]" />)}
            <span className="sr-only">{t('admin_connections.loading', 'Checking which integrations this organisation has…')}</span>
        </div>
    );
}

/** The answer failed or is partial; a platform admin still sees every row (fail open), with this note. */
function UnknownNotice({ read }: { read: OverviewRead }) {
    const { t } = useTranslation();
    return (
        <div className={ALERT_WARNING} role="alert">
            <span className="flex-1">{availabilityUnknownText(t)}</span>
            {read.refetch && (
                <button type="button" className={SECONDARY_BTN} onClick={() => read.refetch?.()} disabled={read.isFetching}>
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    {t('admin_connections.retry', 'Try again')}
                </button>
            )}
        </div>
    );
}

export default function IntegrationStatusOverview({ read, platformAdmin, selfHosted = false }: IntegrationStatusOverviewProps): ReactNode {
    const { t } = useTranslation();
    if (read.isLoading) {
        return (
            <SettingsGroup title={t('admin_connections.families_title', 'Integrations')}>
                <LoadingRows />
            </SettingsGroup>
        );
    }
    const failed = !!read.isError || !read.data;
    // An organisation admin gets nothing they could act on from a failed read.
    if (failed && !platformAdmin) return <UnknownNotice read={read} />;
    const families = familyStatusRows(read, platformAdmin, { selfHosted });
    const groups = appStatusGroups(read, platformAdmin, undefined, { selfHosted });
    return (
        <div className="flex flex-col gap-6">
            {(failed || read.data?.degraded) && <UnknownNotice read={read} />}
            {nothingAvailable(families, groups) && <EmptyNotice platformAdmin={platformAdmin} />}
            <SettingsGroup
                title={t('admin_connections.families_title', 'Integrations')}
                description={t('admin_connections.families_desc', 'What this organisation can use, and where to change it.')}
            >
                <SettingsList>
                    {families.map(row => <StatusRowView key={row.id} row={row} platformAdmin={platformAdmin} />)}
                </SettingsList>
            </SettingsGroup>
            <SettingsGroup
                title={t('admin_connections.apps_title', 'Apps')}
                description={t('admin_connections.apps_desc', 'Every app agents and automations can use, by category.')}
            >
                <div className="flex flex-col gap-2">
                    {groups.map(g => (
                        <Disclosure
                            key={g.category}
                            variant="card"
                            title={categoryLabel(t, g.category)}
                            hint={t('admin_connections.usable_count', '{usable} of {total} available', { usable: g.usable, total: g.rows.length })}
                        >
                            <SettingsList>
                                {g.rows.map(row => <StatusRowView key={row.id} row={row} platformAdmin={platformAdmin} />)}
                            </SettingsList>
                        </Disclosure>
                    ))}
                </div>
            </SettingsGroup>
        </div>
    );
}

import { AlertTriangle, UserCheck } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { useConnectorHealth, type ConnectorHealthProblem } from '@/api/queries/orgAdminReads';
import { useOrgIntegrationAvailability } from '@/api/queries/orgIntegrationAvailability';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { Button } from '@/components/shared/Button';
import { ALERT_ERROR, ALERT_WARNING } from '@/components/shared/adminUi';
import { familyAvailable } from '@/utils/integrationAvailability';
import { nOf } from '@/utils/plural';

/**
 * OrgHealthBanner — org-admin surfacing of connector-health blockers, mounted
 * at the top of the OrgUsersPanel users section.
 *
 * Data: GET /auth/admin/connector-health/mine (org_admin). The server returns
 * sanitized, customer-safe copy — no billing/subscription internals — and this
 * component only adds soft framing on top.
 *
 * Which organisation: /mine answers for the viewer's HOME organisation. In the
 * admin dashboard a platform admin may have chosen another one; the banner then
 * stays away rather than report the home organisation's health on that page.
 *
 * Integration state: the Nextcloud problems (connector.*, the NC sign-in codes)
 * only mean something while the organisation is bound to a Nextcloud. When the
 * organisation's availability (useOrgIntegrationAvailability) says definitely
 * not bound, an open Nextcloud problem left from before is not shown. An
 * unknown answer keeps it (a warning that may be stale beats one that hides).
 *
 * Silent-fail contract: renders null on ANY failure (non-200, network error,
 * malformed body), when health is 'ok', or when there is nothing actionable.
 * It must never break the users panel for non-connector orgs / older servers.
 */
interface OrgHealthBannerProps {
    onJumpToPending?: () => void;
}

/** The Nextcloud sign-in codes outside the connector.* family (server routes/admin/connectorHealth.js). */
const NEXTCLOUD_AUTH_CODES: ReadonlySet<string> = new Set([
    'auth.blocked_onboarding_pending',
    'auth.blocked_manual_mode',
    'auth.missing_email',
    'auth.blocked_nc_uid_conflict',
    'auth.no_matching_tenant_key',
]);

/** A problem about the organisation's Nextcloud connection. */
function isNextcloudProblem(code: string | undefined): boolean {
    return !!code && (code.startsWith('connector.') || NEXTCLOUD_AUTH_CODES.has(code));
}

/** The organisation the banner reports on, or null when the dashboard shows another one. */
function useReportedOrg(): { show: boolean; orgId: string | null } {
    const choice = useAdminOrgChoice();
    if (!choice) return { show: true, orgId: null };
    const home = choice.homeOrganization?.id ?? null;
    if (choice.orgId && choice.orgId !== home) return { show: false, orgId: null };
    return { show: true, orgId: home };
}

export default function OrgHealthBanner({ onJumpToPending }: OrgHealthBannerProps) {
    const { t } = useTranslation();
    const data = useConnectorHealth();
    const { show, orgId } = useReportedOrg();
    const availability = useOrgIntegrationAvailability(orgId, show);
    // An organisation admin's own organisation: a failed read keeps the warning (fail open, platformAdmin: true).
    const nextcloud = familyAvailable(availability, 'nextcloud', { platformAdmin: true });
    const nextcloudGone = !nextcloud.unknown && !nextcloud.available;

    if (!show || !data || data.health === 'ok') return null;

    const pending = Number(data.users?.pending) || 0;
    const problems = Array.isArray(data.problems) ? data.problems : [];
    const blocking = problems.filter((p): p is ConnectorHealthProblem => !!p && (p.severity === 'error' || p.severity === 'critical')
        && !(nextcloudGone && isNextcloudProblem(p.code)));

    if (pending <= 0 && blocking.length === 0) return null;

    return (
        <div className="space-y-3 mb-4">
            {blocking.length > 0 && (
                <div className={`${ALERT_ERROR} p-4`} role="alert">
                    <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-[var(--text-primary)]">
                            {t('admin.org_health_blocked', 'AI chat is not available for your organisation yet — a configuration step is still needed.')}
                        </div>
                        {blocking.map((p, i) => (
                            <div key={`${p.code}-${i}`} className="mt-1.5 text-xs text-[var(--text-secondary)] leading-relaxed">
                                {p.message}
                                {p.remediation && (
                                    <span className="block mt-0.5 text-[var(--text-tertiary)]">{p.remediation}</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {pending > 0 && (
                <div className={`${ALERT_WARNING} p-4`}>
                    <UserCheck className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold text-[var(--text-primary)]">
                            {nOf(
                                t, 'admin_people.health_pending', pending,
                                '{count} person is waiting for approval and cannot use AI yet.',
                                '{count} people are waiting for approval and cannot use AI yet.',
                            )}
                        </div>
                        <div className="mt-0.5 text-xs text-[var(--text-tertiary)]">
                            {t('admin.org_health_pending_hint', 'Approve them in the member list below to unlock access.')}
                        </div>
                    </div>
                    {onJumpToPending && (
                        <Button variant="warning" size="sm" className="shrink-0" onClick={onJumpToPending}>
                            {t('admin.org_health_show_pending', 'Show pending')}
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}

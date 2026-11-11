import { ShieldCheck, Crown } from 'lucide-react';
import React, { useEffect, useMemo, useRef } from 'react';
import CeilingSection from './access/CeilingSection';
import GroupAccessMatrix from './GroupAccessMatrix';
import { useTranslation } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import { mutate, RefusedError } from '@/api/mutate';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import Spinner from '@/components/shared/Spinner';
import ChooseOrgNotice from '@/components/admin/dashboard/ChooseOrgNotice';
import type { AdminCurrentUser } from './userManagement/types';
import { logger } from '@/utils/logger';
import { isPlatformAdmin } from '@/utils/adminAccess';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';

/**
 * AccessPermissionsPanel — the hub for configuring beta / integration / core
 * RIGHTS. A StudioShell with a SectionNav sidebar switches between:
 *   - Grants  : distribute capabilities to All members + per group (the matrix)
 *   - Ceiling : what the subscription plan (cloud) / licence (self-hosted)
 *               permits — editable by super-admins, read-only for org-admins
 *
 * MCP server install/config lives on Admin → Integrations (the MCP section);
 * installed servers are ordinary integrations, granted through the matrix here.
 *
 * A super-admin works on the organisation chosen in the admin dashboard's scope
 * bar (useAdminOrg); with "All organisations" chosen there is no organisation to
 * manage, so the organisation's parts ask for a choice instead of picking one.
 * An org-admin manages their own org via the /me endpoints. Mode comes from the
 * unified entitlements snapshot.
 */

interface AccessPermissionsPanelProps {
    user?: AdminCurrentUser | null;
    activeSection?: string;
    onNavigate?: (path: string) => void;
}

/**
 * PUT /auth/admin/selected-org when the platform admin CHANGES the dashboard's
 * organisation to one organisation while this panel is open: that session
 * setting also binds a platform admin without a home organisation to the chosen
 * organisation's access menu in their own entitlements
 * (core/entitlements/entitlements.js governingOrgId). Never on mount, never for
 * "All organisations" (that keeps the last explicit binding). The snapshot is
 * reloaded so the change applies at once; a failure is not fatal.
 */
function useSelectedOrgOnChange(orgId: string | null, enabled: boolean, reloadEntitlements: (() => void) | undefined) {
    const previous = useRef(orgId);
    useEffect(() => {
        if (previous.current === orgId) return;
        previous.current = orgId;
        if (!enabled || !orgId) return;
        (async () => {
            try {
                await mutate(`${API_BASE}/auth/admin/selected-org`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ orgId }),
                });
            } catch (err) {
                // A refusal still reloads the snapshot, as the unchecked call did.
                if (!(err instanceof RefusedError)) { logger.debug('the panel still works for viewing the organisation', err); return; }
            }
            reloadEntitlements?.();
        })();
    }, [orgId, enabled, reloadEntitlements]);
}

export default function AccessPermissionsPanel({ user, activeSection = 'grants', onNavigate }: AccessPermissionsPanelProps) {
    const { t } = useTranslation();
    const isSuperAdmin = isPlatformAdmin(user);
    const { mode, reload: reloadEntitlements } = useEntitlements();
    const choice = useAdminOrgChoice();
    const orgId = isSuperAdmin ? choice?.orgId ?? null : null;
    const orgName = choice?.orgName ?? orgId;
    useSelectedOrgOnChange(orgId, isSuperAdmin, reloadEntitlements);

    const sections = useMemo(() => ([
        { id: 'grants', label: t('admin_org.ceiling_grants', 'Grants'), icon: ShieldCheck },
        { id: 'ceiling', label: t('admin.access_ceiling', 'Ceiling'), icon: Crown },
    ]), [t]);

    const validIds = sections.map(s => s.id);
    const active = validIds.includes(activeSection) ? activeSection : 'grants';

    const handleSectionClick = (id: string) => { if (onNavigate) onNavigate(`admin/access/${id}`); };

    if (isSuperAdmin && !(choice?.organizationsLoaded ?? true)) {
        return <div className="p-6"><Spinner size="sm" /></div>;
    }

    const chooseOrg = <ChooseOrgNotice noOrgs={(choice?.organizations.length ?? 0) === 0} text={t('admin.scope_access_choose_org', 'Choose an organisation above to manage its access')} />;

    const renderBody = () => {
        if (active === 'grants') {
            if (isSuperAdmin && !orgId) return chooseOrg;
            // Every kind, for an organisation admin as for a platform admin: features,
            // beta and integrations (MCP servers included). The routes behind the matrix
            // take the same org-admin check for each kind.
            return (
                <GroupAccessMatrix
                    key={`grants:${orgId || 'me'}`}
                    orgId={isSuperAdmin ? orgId : undefined}
                />
            );
        }
        if (active === 'ceiling') {
            return (
                <CeilingSection
                    key={`ceiling:${orgId || 'me'}`}
                    mode={mode}
                    isSuperAdmin={isSuperAdmin}
                    orgId={isSuperAdmin ? orgId : undefined}
                    orgName={isSuperAdmin ? orgName : undefined}
                    onCeilingChanged={reloadEntitlements}
                    chooseOrg={chooseOrg}
                />
            );
        }
        return null;
    };

    return (
        <div className="flex h-full flex-col overflow-hidden">
            <div className="min-h-0 flex-1">
                <StudioShell
                    responsive
                    sidebarTitle={t('admin.tab_access', 'Access')}
                    sidebar={<SectionNav label={t('admin.tab_access', 'Access')} items={sections} activeId={active} onSelect={handleSectionClick} />}
                >
                    <div className="p-6 md:p-8">
                        {renderBody()}
                    </div>
                </StudioShell>
            </div>
        </div>
    );
}

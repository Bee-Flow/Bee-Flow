import { ShieldCheck, Crown } from 'lucide-react';
import { useEffect, useMemo, useRef, type ComponentType, type ReactNode } from 'react';
import CeilingSection from './access/CeilingSection';
import GroupAccessMatrix from './GroupAccessMatrix';
import { useTranslation } from '@/hooks/useTranslation';
import { RefusedError } from '@/api/mutate';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import Tabs from '@/components/shared/Tabs';
import Spinner from '@/components/shared/Spinner';
import ChooseOrgNotice from '@/components/admin/dashboard/ChooseOrgNotice';
import type { AdminCurrentUser } from './userManagement/types';
import { logger } from '@/utils/logger';
import { isPlatformAdmin } from '@/utils/adminAccess';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useSelectAdminOrgMutation } from '@/api/queries/adminSelectedOrg';
import { useShellProps } from '@/authedApp/useShellProps';

/**
 * AccessPermissionsPanel — the hub for configuring beta / integration / core
 * RIGHTS: the admin dashboard's Access row (Security & access > Access). Two
 * tabs above the page (`tabs`; without it the same two are a section column)
 * switch between:
 *   - Grants  : distribute capabilities to All members + per group (the matrix)
 *   - Ceiling : what the subscription plan (cloud) / licence (self-hosted)
 *               permits, and per organisation which part of it the organisation
 *               may use — editable by a platform admin, read-only for an
 *               organisation admin
 *
 * MCP servers are installed under Admin dashboard > Connections > MCP servers
 * (the organisation's) and Whole server > MCP servers; installed servers are
 * ordinary integrations, granted through the matrix here.
 *
 * A platform admin works on the organisation chosen in the admin dashboard's
 * scope bar (useAdminOrg); with "All organisations" chosen there is no
 * organisation to manage, so the organisation's parts ask for a choice instead
 * of picking one. An organisation admin manages their own org via the /me endpoints. Mode comes from the
 * unified entitlements snapshot.
 */

interface AccessPermissionsPanelProps {
    user?: AdminCurrentUser | null;
    activeSection?: string;
    onNavigate?: (path: string) => void;
    /** true: Grants and Ceiling as tabs above the page (the admin dashboard, whose rail is the navigation). Left out: a section column. */
    tabs?: boolean;
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
    const { mutate: selectOrg } = useSelectAdminOrgMutation();
    useEffect(() => {
        if (previous.current === orgId) return;
        previous.current = orgId;
        if (!enabled || !orgId) return;
        selectOrg(orgId, {
            onSuccess: () => reloadEntitlements?.(),
            onError: (err) => {
                // A refusal still reloads the snapshot, as the unchecked call did.
                if (err instanceof RefusedError) reloadEntitlements?.();
                else logger.debug('the panel still works for viewing the organisation', err);
            },
        });
    }, [orgId, enabled, reloadEntitlements, selectOrg]);
}

/** The organisation the panel works on: a platform admin's dashboard choice (none: "All organisations"); an organisation admin's own (null: the /me routes). */
function useAccessOrg(isSuperAdmin: boolean) {
    const choice = useAdminOrgChoice();
    const orgId = isSuperAdmin ? choice?.orgId ?? null : null;
    return { choice, orgId, orgName: choice?.orgName ?? orgId };
}

export default function AccessPermissionsPanel({ user: userProp, activeSection = 'grants', onNavigate, tabs = false }: AccessPermissionsPanelProps) {
    const { t } = useTranslation();
    // Inside the app shell the signed-in person and the navigation come from
    // context; a host outside it (a test, a kit) still hands them as props.
    const { user, onNavigate: go } = useShellProps({ user: userProp, onNavigate });
    const isSuperAdmin = isPlatformAdmin(user);
    const { mode, reload: reloadEntitlements } = useEntitlements();
    const { choice, orgId, orgName } = useAccessOrg(isSuperAdmin);
    useSelectedOrgOnChange(orgId, isSuperAdmin, reloadEntitlements);

    const sections = useMemo(() => ([
        { id: 'grants', label: t('admin_org.ceiling_grants', 'Grants'), icon: ShieldCheck },
        { id: 'ceiling', label: t('admin.access_ceiling', 'Ceiling'), icon: Crown },
    ]), [t]);

    const validIds = sections.map(s => s.id);
    const active = validIds.includes(activeSection) ? activeSection : 'grants';

    const handleSectionClick = (id: string) => { if (go) go(`admin/access/${id}`); };

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
                    platformAdmin={isSuperAdmin}
                    // The dashboard's page frame titles the page ("Access") and the tab says
                    // "Grants": the matrix keeps its intro line, not a second heading.
                    hideHeading={tabs}
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

    if (tabs) return <AccessTabsPage sections={sections} active={active} onSelect={handleSectionClick}>{renderBody()}</AccessTabsPage>;

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

interface AccessTabsPageProps {
    sections: readonly { id: string; label: string; icon: ComponentType<{ className?: string }> }[];
    active: string;
    onSelect: (id: string) => void;
    children: ReactNode;
}

/**
 * Grants and Ceiling as tabs above the page (the admin dashboard, whose rail is
 * the navigation). The dashboard's page frame draws the padding, the width and
 * the header, so the tabs open the page.
 */
function AccessTabsPage({ sections, active, onSelect, children }: AccessTabsPageProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-5" data-testid="access-tabs-page">
            <Tabs
                ariaLabel={t('admin.tab_access', 'Access')}
                value={active}
                onChange={onSelect}
                items={sections.map(({ id, label, icon: Icon }) => ({ id, label, icon: <Icon className="h-4 w-4" aria-hidden="true" /> }))}
            />
            {children}
        </div>
    );
}

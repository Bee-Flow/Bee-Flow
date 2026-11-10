import React, { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { ArrowLeft, ChevronDown, Menu } from 'lucide-react';
import ProductWebsitePanel from '../components/admin/product-website/ProductWebsitePanel';
import AdminAccessDenied from '../components/admin/dashboard/AdminAccessDenied';
import AdminRail from '../components/admin/dashboard/AdminRail';
import type { AdminRailGroup } from '../components/admin/dashboard/AdminRail';
import AdminTabContent from '../components/admin/dashboard/AdminTabContent';
import { ADMIN_TABS, canOpenAdminTab, groupAdminTabs, resolveAdminTab, shownAdminScope } from '../components/admin/dashboard/adminTabs';
import type { AdminScope, AdminTab } from '../components/admin/dashboard/adminTabs';
import ScopeBadge from '../components/admin/dashboard/ScopeBadge';
import { AdminScopeOverrideProvider } from '../components/admin/dashboard/useAdminScopeOverride';
import Modal from '../components/shared/Modal';
import { useDeploymentMode } from '../hooks/useDeploymentMode';
import { useLicenseContext } from '../components/licensing/LicenseContext';
import type { AdminCurrentUser } from '../components/admin/org/userManagement/types';


interface AdminDashboardProps {
    user: AdminCurrentUser | null;
    onBack: React.MouseEventHandler<HTMLButtonElement>;
    adminPath?: { seg1?: string; seg2?: string; seg3?: string };
    onNavigate: (path: string, opts?: { replace?: boolean }) => void;
}

/**
 * The global admin dashboard. Wide (lg and up): a Studio-style rail on the
 * left (components/admin/dashboard/AdminRail) and the current tab beside it,
 * edge to edge. Narrower: a slim top bar that names the current tab and
 * opens the same rail as a drawer from the left, so the content keeps the
 * whole width. The tab registry and its gating live in adminTabs.ts.
 */
const AdminDashboard = ({ user, onBack, adminPath = {}, onNavigate }: AdminDashboardProps) => {
    const { t } = useTranslation();
    const { isCloud, isSelfHosted } = useDeploymentMode();
    // A server-wide licence covers the whole install — no org needs a Stripe
    // subscription, so the cloud Subscriptions management surface is moot.
    const { serverOverride, tier } = useLicenseContext();
    const isPlatformAdmin = user?.isAdmin || user?.role === 'admin';
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [scopeOverride, setScopeOverride] = useState<AdminScope | null>(null);

    // Permission helper - checks if user has a specific permission
    const hasPermission = (perm: string) => {
        if (isPlatformAdmin) return true;
        const perms = user?.permissions || [];
        return perms.includes('all') || perms.includes(perm);
    };

    // Platform admin means users.role === 'admin' — NOT the 'all' permission.
    // The server draws the same line (auth/permissions.js requireSuperAdmin),
    // and it deliberately does not honour 'all': that wildcard is reachable
    // from inside a tenant via a role attached to a group. Including it here
    // would render operator-only tabs that then 403 on every request, which
    // reads as a broken console rather than a clean denial.
    const isSuperAdmin = !!isPlatformAdmin;

    const checkTabAccess = (tab: AdminTab | undefined) => canOpenAdminTab(tab, {
        isCloud, isSelfHosted, tier, serverOverride: !!serverOverride, isSuperAdmin, hasPermission,
    });
    const { activeTab, agentSection, firstAllowedTab, isTabAllowed } = resolveAdminTab(adminPath, checkTabAccess);
    const labelOf = (tab: AdminTab) => t(tab.labelKey, tab.labelFallback);

    const handleTabClick = (tabId: string) => {
        setDrawerOpen(false);
        if (onNavigate) {
            onNavigate(`admin/${tabId}`);
        }
    };

    // Check if user has ANY admin permission at all
    const hasAnyAdminPermission = isSuperAdmin || hasPermission('all') || ADMIN_TABS.some(tab => checkTabAccess(tab));
    if (!hasAnyAdminPermission) return <AdminAccessDenied scope="whole" onBack={onBack} />;

    // Product website — full-screen builder. It escapes the admin chrome
    // entirely (no dashboard rail): the builder owns its own TopBar and
    // navigates back / cross-links via onExit / onNavigate. Gating is
    // identical to the tab (checkTabAccess ran above); a forbidden request
    // falls through to the normal chrome + the access-denied state below.
    if (activeTab === 'product-website' && isTabAllowed) {
        return (
            <div className="h-full bg-[var(--bg-primary)]">
                <ProductWebsitePanel
                    onExit={() => handleTabClick(firstAllowedTab?.id || 'agents')}
                    onNavigate={onNavigate}
                />
            </div>
        );
    }

    const groups: AdminRailGroup[] = groupAdminTabs(ADMIN_TABS.filter(tab => checkTabAccess(tab))).map(group => ({
        id: group.id,
        label: t(group.labelKey, group.labelFallback),
        tabs: group.tabs.map(tab => ({ id: tab.id, label: labelOf(tab), icon: tab.icon })),
    }));
    const activeDef = ADMIN_TABS.find(tab => tab.id === activeTab);
    const activeScope = isTabAllowed ? scopeForView(activeDef, scopeOverride, user, activeTab === 'agents' ? agentSection : adminPath.seg2) : null;
    const railProps = {
        title: t('admin.dashboard_title'),
        groups,
        activeTab,
        onSelect: handleTabClick,
        onBack,
        backTitle: t('admin.back_to_chat'),
    };

    return (
        <div className="flex h-full bg-[var(--bg-primary)]">
            <AdminRail {...railProps} className="hidden lg:flex" />
            <div className="flex min-w-0 flex-1 flex-col">
                <AdminTopBar
                    onBack={onBack}
                    backTitle={railProps.backTitle}
                    sectionsLabel={t('admin.nav_sections', 'Admin sections')}
                    currentLabel={activeDef ? labelOf(activeDef) : railProps.title}
                    drawerOpen={drawerOpen}
                    onOpen={() => setDrawerOpen(true)}
                />
                {activeScope && <AdminScopeBar scope={activeScope} isPlatformAdmin={!!isPlatformAdmin} multiOrg={hasSeveralOrgs(user)} />}
                <div className="relative min-h-0 flex-1">
                    {isTabAllowed
                        ? (
                            <AdminScopeOverrideProvider value={setScopeOverride}>
                                <AdminTabContent activeTab={activeTab} user={user} hasPermission={hasPermission} agentSection={agentSection} onNavigate={onNavigate} adminPath={adminPath} />
                            </AdminScopeOverrideProvider>
                        )
                        : <AdminAccessDenied scope="section" />}
                </div>
            </div>
            <Modal
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                placement="left"
                variant="bare"
                size="auto"
                className="w-72 max-w-[85vw] overflow-hidden"
                label={t('admin.nav_sections', 'Admin sections')}
            >
                <AdminRail {...railProps} inDrawer />
            </Modal>
        </div>
    );
};

export default AdminDashboard;

/** Does the viewer have an organisation of their own? */
function hasHomeOrg(user: AdminCurrentUser | null): boolean {
    const id = user?.organizationId ?? user?.orgId;
    return typeof id === 'string' && id !== '';
}

/** Is the viewer in more than one organisation, so their lists are the union? */
function hasSeveralOrgs(user: AdminCurrentUser | null): boolean {
    return (user?.organizations?.length ?? 0) > 1;
}

/** The scope the strip shows for the active tab, or null for none. */
function scopeForView(tab: AdminTab | undefined, override: AdminScope | null, user: AdminCurrentUser | null, section?: string): AdminScope | null {
    return shownAdminScope({ tab, override, section, hasHomeOrg: hasHomeOrg(user) });
}

/** The strip above the tab content that says whose data the section is about. */
function AdminScopeBar({ scope, isPlatformAdmin, multiOrg }: { scope: AdminScope; isPlatformAdmin: boolean; multiOrg: boolean }) {
    return (
        <div className="flex h-9 shrink-0 items-center border-b border-[var(--border-subtle)] px-4 md:px-6" data-testid="admin-scope-bar">
            <ScopeBadge scope={scope} isPlatformAdmin={isPlatformAdmin} multiOrg={multiOrg} />
        </div>
    );
}

interface AdminTopBarProps {
    onBack?: React.MouseEventHandler<HTMLButtonElement>;
    backTitle: string;
    sectionsLabel: string;
    currentLabel: string;
    drawerOpen: boolean;
    onOpen: () => void;
}

/** Below lg: the way back and a button that names the current tab and opens the rail as a drawer. */
function AdminTopBar({ onBack, backTitle, sectionsLabel, currentLabel, drawerOpen, onOpen }: AdminTopBarProps) {
    return (
        <div className="flex h-12 shrink-0 items-center gap-1 border-b border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-2 lg:hidden" data-testid="admin-topbar">
            {onBack && (
                <button
                    type="button"
                    onClick={onBack}
                    title={backTitle}
                    aria-label={backTitle}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-colors hover:bg-[var(--item-hover-bg)] hover:text-[var(--text-primary)]"
                >
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                </button>
            )}
            <button
                type="button"
                onClick={onOpen}
                aria-haspopup="dialog"
                aria-expanded={drawerOpen}
                aria-label={`${sectionsLabel}: ${currentLabel}`}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--item-hover-bg)]"
            >
                <Menu className="h-4 w-4 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                <span className="min-w-0 truncate text-[14px] font-semibold text-[var(--text-primary)]">{currentLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            </button>
        </div>
    );
}

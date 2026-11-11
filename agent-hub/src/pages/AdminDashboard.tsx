import React, { useState } from 'react';
import { useTranslation } from '../hooks/useTranslation';
import { ArrowLeft, ChevronDown, Menu } from 'lucide-react';
import ProductWebsitePanel from '../components/admin/product-website/ProductWebsitePanel';
import AdminAccessDenied from '../components/admin/dashboard/AdminAccessDenied';
import AdminRail from '../components/admin/dashboard/AdminRail';
import AdminTabContent from '../components/admin/dashboard/AdminTabContent';
import { ADMIN_TABS, fixedOrgViewOf, resolveAdminTab, shownAdminScope } from '../components/admin/dashboard/adminTabs';
import type { AdminScope, AdminTab } from '../components/admin/dashboard/adminTabs';
import { activeRailRow, adminRailView, railRowLabel, useOrgRailSections } from '@/components/admin/dashboard/adminRailRows';
import AdminScopeBar from '@/components/admin/dashboard/AdminScopeBar';
import { scopeBarView, type ScopeBarView } from '@/components/admin/dashboard/scopeBarView';
import { AdminOrgProvider, useAdminOrg, type AdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { AdminScopeOverrideProvider } from '../components/admin/dashboard/useAdminScopeOverride';
import Modal from '../components/shared/Modal';
import Spinner from '@/components/shared/Spinner';
import type { AdminCurrentUser } from '../components/admin/org/userManagement/types';
import { useAdminTabAccess } from '@/components/admin/dashboard/useAdminTabAccess';
import { homeOrgIdOf } from '@/utils/adminAccess';


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
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [scopeOverride, setScopeOverride] = useState<AdminScope | null>(null);
    const orgChoice = useAdminOrg(user, [adminPath.seg1, adminPath.seg2, adminPath.seg3].join('/'));

    // The permission test and the tab gates (dashboard/useAdminTabAccess). Platform
    // admin means users.role === 'admin' — NOT the 'all' permission. The server
    // draws the same line (auth/permissions.js requireSuperAdmin), and it
    // deliberately does not honour 'all': that wildcard is reachable from inside
    // a tenant via a role attached to a group. Including it here would render
    // operator-only tabs that then 403 on every request, which reads as a broken
    // console rather than a clean denial.
    const { hasPermission, isSuperAdmin, checkTabAccess, canOpenDashboard } = useAdminTabAccess(user);
    const isPlatformAdmin = isSuperAdmin;
    const { activeTab, agentSection, firstAllowedTab, isTabAllowed } = resolveAdminTab(adminPath, checkTabAccess);
    // The Organisation tab's sections are rows of the rail (adminRailRows).
    const orgSections = useOrgRailSections(user, orgChoice, checkTabAccess(ADMIN_TABS.find(tab => tab.id === 'organisation')));

    const handleTabClick = (rowId: string) => {
        setDrawerOpen(false);
        if (onNavigate) {
            onNavigate(`admin/${rowId}`);
        }
    };

    // The subscription gate sends everyone of a cloud organisation without a plan
    // to its licence page; someone who cannot open it is told whom to ask.
    const onOrgLicensePage = adminPath.seg1 === 'organisation' && adminPath.seg2 === 'license';
    // Check if user has ANY admin permission at all
    if (!canOpenDashboard) return <AdminAccessDenied scope={onOrgLicensePage ? 'no-plan' : 'whole'} onBack={onBack} />;

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

    const sections = adminRailView({ tabs: ADMIN_TABS.filter(tab => checkTabAccess(tab)), orgSections, isPlatformAdmin, choice: orgChoice, t });
    const activeRow = activeRailRow(activeTab, adminPath.seg2, orgSections);
    const activeDef = ADMIN_TABS.find(tab => tab.id === activeTab);
    const barView = isTabAllowed
        ? barViewFor(activeDef, scopeOverride, user, orgChoice, [activeTab === 'agents' ? agentSection : adminPath.seg2, adminPath.seg3])
        : null;
    const railProps = {
        title: t('admin.dashboard_title'),
        sections,
        activeRow,
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
                    currentLabel={railRowLabel(sections, activeRow) ?? (activeDef ? t(activeDef.labelKey, activeDef.labelFallback) : railProps.title)}
                    drawerOpen={drawerOpen}
                    onOpen={() => setDrawerOpen(true)}
                />
                {barView && <AdminScopeBar view={barView} choice={orgChoice} />}
                <div className="relative min-h-0 flex-1">
                    {isTabAllowed
                        ? (
                            <AdminOrgGate choice={orgChoice}>
                                <AdminScopeOverrideProvider value={setScopeOverride}>
                                    <AdminTabContent activeTab={activeTab} user={user} hasPermission={hasPermission} agentSection={agentSection} onNavigate={onNavigate} adminPath={adminPath} />
                                </AdminScopeOverrideProvider>
                            </AdminOrgGate>
                        )
                        : <AdminAccessDenied scope={onOrgLicensePage ? 'no-plan' : 'section'} inSection />}
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
    return homeOrgIdOf(user) !== null;
}

/** What the scope bar says for the active tab (the section and part the URL names), or null for no bar. */
function barViewFor(tab: AdminTab | undefined, override: AdminScope | null, user: AdminCurrentUser | null, choice: AdminOrgChoice, [section, part]: [string?, string?]): ScopeBarView | null {
    const scope = shownAdminScope({ tab, override, section, hasHomeOrg: hasHomeOrg(user) });
    if (!scope || !tab) return null;
    return scopeBarView({
        scope,
        isPlatformAdmin: choice.isPlatformAdmin,
        fixed: fixedOrgViewOf(tab.id, section, part),
        homeOrgName: choice.homeOrganization?.name ?? null,
    });
}

/**
 * The tab content under the dashboard's organisation choice. While an
 * organisation from the URL or this browser is still checked against the
 * organisation list, a spinner stands in, so no section reads with an id that
 * may not exist.
 */
function AdminOrgGate({ choice, children }: { choice: AdminOrgChoice; children: React.ReactNode }) {
    const { t } = useTranslation();
    if (choice.pending) {
        return (
            <div className="flex h-full items-center justify-center p-6" data-testid="admin-org-pending">
                <Spinner size="sm" label={t('common.loading', 'Loading...')} />
            </div>
        );
    }
    return <AdminOrgProvider value={choice}>{children}</AdminOrgProvider>;
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

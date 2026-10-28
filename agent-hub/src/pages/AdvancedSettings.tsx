import { Users, Link2, BarChart2, Cloud, FolderGit2, GraduationCap, FileText, Scale, Plug, ShieldCheck } from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import { SETTINGS_ORG_ID_TO_URL, settingsTabFromPath } from '../authedApp/settingsRoutes';
import ComplianceHub from '../components/admin/compliance';
import useComplianceCounts from '../components/admin/compliance/data/useComplianceCounts';
import { SECTIONS as ORG_SECTIONS } from '../components/admin/org/OrgInfoPanel';
import MemoryPanel from '../components/knowledge/memory/MemoryPanel';
import { useSubscriptionContext } from '../components/licensing/SubscriptionContext';
import NavCountBadge from '../components/shared/NavCountBadge';
import { useTranslation } from '../hooks/useTranslation';
import { useViewport } from '../hooks/useViewport';
import { filterOrgSubItems, groupOrgNavItems } from './settings/shell/orgSubItems';
import { renderSettingsContent } from './settings/shell/renderSettingsContent';
import { SettingsContentPanel, SettingsTitleBar } from './settings/shell/SettingsFrame';
import { findActiveNavItem, getVisibleNavItems, splitNavRows } from './settings/shell/settingsShellData';
import { SettingsSidebar } from './settings/shell/SettingsSidebar';
import { useComplianceNavigation } from './settings/shell/useComplianceNavigation';
import { useDefaultAgentPreference } from './settings/shell/useDefaultAgentPreference';
import { useSettingsAccess } from './settings/shell/useSettingsAccess';
import { useSettingsBounces } from './settings/shell/useSettingsBounces';
import { useSettingsData } from './settings/shell/useSettingsData';
import { useSettingsTab } from './settings/shell/useSettingsTab';
import type { SettingsUser } from './settings/shell/settingsShellTypes';
import type { MemoryView } from '../components/knowledge/memory/memoryTypes';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

export { AvatarDisplay } from './settings/shell/AvatarDisplay';

/* ── Org sub-items (use labelKey for i18n) ────────────────────────────────── */
/* Source order (ids, label keys): pinned row for row by the phone's
 * sections.lockstep.test.ts. The sidebar draws the rows in ORG_NAV_GROUPS
 * below, so reorder there, not here. */
const BASE_ORG_SUB_ITEMS = [
    ...ORG_SECTIONS,                                            // OrgInfoPanel's seven sections (license … info); already use labelKey
    { id: 'org_usage', labelKey: 'settings.usage_monitoring', icon: BarChart2, color: '#f59e0b' },
    // Scale (the balance) is the Compliance Center's own glyph, and its
    // colour is the kind token the whole hub is drawn in — not a hex green
    // that drifts from it on the next palette pass. OrgSubItem passes
    // `section.color` straight into a style, so a var() works there.
    { id: 'org_compliance', labelKey: 'settings.compliance', icon: Scale, color: 'var(--kind-compliance)' },
    { id: 'org_users', labelKey: 'settings.users_groups', icon: Users, color: '#3b82f6' },
    { id: 'org_academy', labelKey: 'settings.academy', icon: GraduationCap, color: '#059669' },
    { id: 'org_integrations', labelKey: 'settings.integrations', icon: Link2, color: '#0ea5e9' },
    // Remote MCP servers for this organisation, and who uses the server-wide
    // ones (pages/settings → components/mcpLibrary). Licence-gated on the
    // server (mcp_marketplace); the page explains a plan without it.
    { id: 'org_mcp', labelKey: 'mcp_library.nav', icon: Plug, color: '#f59e0b' },
    // The org-wide rules every MCP request passes through (IP allow-list, who
    // may use MCP, legacy tokens). Org admins only; named tokens live in the
    // member's own Settings → Security.
    { id: 'org_mcp_access', labelKey: 'mcp_access.nav', icon: ShieldCheck, color: '#ef4444' },
    { id: 'org_github_sync', labelKey: 'settings.github_sync', icon: FolderGit2, color: '#8b5cf6' },
    { id: 'org_nextcloud_sync', labelKey: 'settings.nextcloud_sync', icon: Cloud, color: '#0082C9' },
    { id: 'org_meeting_templates', labelKey: 'settings.meeting_templates', icon: FileText, color: '#a855f7' },
];
const AZURE_SUB_ITEM = { id: 'org_azure', labelKey: 'settings.azure_config', icon: Cloud, color: '#0078D4' };

/* The order the sidebar draws the visible org rows in: topic groups with a
 * thin rule between them, no captions. 1 the organisation and its plan,
 * 2 people and access, 3 privacy and security, 4 AI and data, 5 integrations
 * (MCP access next to the MCP library). A visible row that is not filed here
 * is still drawn, in a group of its own at the end. The phone files the same
 * sections in its own captioned groups (mobile sections.ts ORG_HUB_GROUPS). */
const ORG_NAV_GROUPS = [
    ['info', 'license', 'org_usage'],
    ['org_users', 'auth', 'org_academy'],
    ['privacy', 'encryption', 'org_compliance'],
    ['ai_context', 'integration_cache', 'org_meeting_templates'],
    ['org_integrations', 'org_mcp', 'org_mcp_access', 'org_github_sync', 'org_nextcloud_sync', 'org_azure'],
];

/* Every org sub-tab id, taken from the URL table: each one has an address
 * there (settingsRoutes.js), so this is the same set without a second list. */
const ALL_ORG_IDS: (string | null)[] = Object.keys(SETTINGS_ORG_ID_TO_URL);

/* The Settings → Connections rows whose connected state lives in `statuses`.
 * Their onSaved fires for connect AND disconnect, so the state is re-read
 * rather than forced to true (which showed "Connected" after a Disconnect, or
 * after a partial save). GitHub is here for the org GitHub Sync row, which is
 * drawn on statuses.githubConnected. */
const STATUS_BACKED_KEYS = ['fireflies', 'youtrack', 'signrequest', 'gamma', 'afas-profit', 'vplan', 'scaleway-billing', 'nmbrs', 'linkedin', 'nextcloud', 'github'];

/* ── URL ⟷ activeTab mapping → authedApp/settingsRoutes.js ────────────────
 * The three segment tables and their two readers used to sit here. They live
 * next to appRoutes.js now, frozen by settingsRoutes.test.js — the settings
 * URL space is a published contract (/app/settings/account/license is a Stripe
 * return URL), not a detail of this screen. Two things changed when they
 * moved: 'security' joined the top-level tabs, so the section the artboard
 * opens on is finally addressable (G1), and the empty rename layer is gone, so
 * a tab's segment IS its id and cannot quietly be pointed at the 'account'
 * group parent (G3).
 */

/* ── Main component ──────────────────────────────────────────────────────── */
interface AdvancedSettingsProps {
    onNavigate: (path: string) => void;
    onLogout?: () => void;
    user: SettingsUser | null;
    onUpdateUser?: (patch: Partial<SettingsUser>) => void;
    onClose?: () => void;
    onBack?: (() => void) | null;
}

const AdvancedSettings = ({ onNavigate, onLogout, user, onUpdateUser, onClose }: AdvancedSettingsProps) => {
    const { t } = useTranslation();
    // Phones show a trimmed, user-only settings surface (see MOBILE_VISIBLE_TOP_TABS).
    const { isMobile } = useViewport();
    // Orgs with no active plan are routed to the License tab by SubscriptionGate —
    // keep that one reachable on mobile so they can still subscribe.
    const { hasActiveSub } = useSubscriptionContext();
    const { activeTab, setActiveTab, setActiveTabState, orgDeepSegs, setOrgDeepSegs } = useSettingsTab();
    const [orgExpanded, setOrgExpanded] = useState(() => ALL_ORG_IDS.includes(settingsTabFromPath()) || ALL_ORG_IDS.includes(activeTab));

    const {
        canSeeOrg, canUseLearning, entitlementsLoading, inCeiling, entitlementsUnknown, projectsOn, canSeeCompliance,
        showComplianceNav, canManageUsers, isSelfHosted, isConsumerAccount, isNcConnectorUser, isNcOrg, showNcSync,
    } = useSettingsAccess(user);
    // The badge on the Compliance row: ONE cheap call, no poll, `attention_open`
    // only; an unknown or zero count renders nothing (NavCountBadge): a "0"
    // invented while the endpoint has not answered is a lie.
    const { counts: complianceCounts } = useComplianceCounts({
        enabled: !!showComplianceNav, poll: false, keys: ['attention_open'],
    });
    const complianceBadge = (
        <NavCountBadge tone="warning" count={complianceCounts?.attention_open} testId="nav-compliance-count" />
    );

    const isOrgSubTab = ALL_ORG_IDS.includes(activeTab);
    // The pages a phone may open although their rows are hidden there: the org
    // licence page when the org has no active plan (SubscriptionGate sends it
    // there to subscribe), and the consumer licence page, which is the Stripe
    // return URL /app/settings/account/license and where /app/billing lands.
    const phoneExemptTab = (activeTab === 'license' && !hasActiveSub)
        || (activeTab === 'consumer_license' && isConsumerAccount);

    const isSimpleMode = !!user?.simpleMode;
    useSettingsBounces({
        isSimpleMode, activeTab, setActiveTab, isSelfHosted, entitlementsLoading, canUseLearning, entitlementsUnknown, projectsOn, isMobile, phoneExemptTab,
    });

    // If user navigates to an org sub-tab, keep org expanded
    useAdjustOnChange([isOrgSubTab], () => { if (isOrgSubTab) setOrgExpanded(true); });

    const [showMemoryPanel, setShowMemoryPanel] = useState(false);
    // 'review' when the pending-review row of Settings → Memory opened the panel.
    const [memoryPanelView, setMemoryPanelView] = useState<MemoryView>('active');
    const { memoryStats, memoryStatsStatus, agents, statuses, orgAuthLocked, fetchMemoryStats, fetchSettingsStatuses } = useSettingsData(user, canSeeOrg);
    const orgSubItems = useMemo(() => {
        return filterOrgSubItems(BASE_ORG_SUB_ITEMS, AZURE_SUB_ITEM, {
            canSeeOrg, canManageUsers, canUseLearning, showComplianceNav, isSelfHosted, isNcConnectorUser, isNcOrg, showNcSync,
            githubConnected: statuses.githubConnected, orgAuthLocked, entitlementsLoading, entitlementsUnknown, inCeiling,
        });
    }, [canSeeOrg, canManageUsers, canUseLearning, showComplianceNav, isSelfHosted, isNcConnectorUser, isNcOrg, showNcSync, statuses.githubConnected, orgAuthLocked, entitlementsLoading, entitlementsUnknown, inCeiling]);

    // The rows as the sidebar draws them: ORG_NAV_GROUPS order, empty groups dropped.
    const orgNavGroups = useMemo(() => groupOrgNavItems(orgSubItems, ORG_NAV_GROUPS), [orgSubItems]);
    const firstOrgSubItemId = orgNavGroups[0]?.[0]?.id;

    // The per-org "License & Usage" section is hidden on self-hosted (see the
    // orgSubItems filter above). A default/deep-link can still resolve activeTab
    // to 'license', so bounce it to the first row the sidebar draws. Placed
    // after orgNavGroups so the dependency array can reference it without a
    // TDZ error.
    useEffect(() => {
        if (isSelfHosted && activeTab === 'license') {
            setActiveTab(firstOrgSubItemId || 'org_usage');
        }
    }, [isSelfHosted, activeTab, firstOrgSubItemId, setActiveTab]);

    const { defaultAgentMode, setDefaultAgentMode, defaultAgentId, setDefaultAgentId } = useDefaultAgentPreference();

    const handleIntegrationSaved = (key: string) => {
        if (STATUS_BACKED_KEYS.includes(key)) fetchSettingsStatuses();
    };
    const handleClose = () => {
        if (onClose) onClose();
        else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    };

    const { handleComplianceNavigate } = useComplianceNavigation(canSeeOrg, onNavigate, setOrgDeepSegs, setActiveTabState);

    const renderContent = () => renderSettingsContent({
        user, activeTab, setActiveTab, isMobile, phoneExemptTab, isOrgSubTab, canSeeOrg, canSeeCompliance, canUseLearning,
        isConsumerAccount, isSelfHosted, projectsOn, entitlementsUnknown, orgDeepSegs,
        // On a phone the hub owns the way back to the section list (its own top bar).
        complianceHub: (
            <ComplianceHub
                activeSection={orgDeepSegs.seg1 || 'overview'}
                focusCheckId={orgDeepSegs.seg2 || null}
                onNavigate={handleComplianceNavigate}
                onBack={isMobile ? (() => setMobileDetail(false)) : null}
            />
        ),
        defaultAgentMode, setDefaultAgentMode, defaultAgentId, setDefaultAgentId, agents, onLogout, onUpdateUser,
        memoryStats, memoryStatsStatus, fetchMemoryStats, statuses, handleIntegrationSaved,
        openMemoryPanel: (view) => { setMemoryPanelView(view === 'review' ? 'review' : 'active'); setShowMemoryPanel(true); },
    });

    // Mobile master–detail: the section menu ('list') and a single section's
    // content ('detail') are shown one at a time on phones. Desktop shows both
    // side by side and ignores this flag.
    const [mobileDetail, setMobileDetail] = useState(false);
    // SubscriptionGate routes a no-plan org to the License tab, and a consumer's
    // Stripe return lands on theirs; surface those directly on mobile (their
    // rows are hidden there) so the plan and the checkout result are visible.
    useEffect(() => {
        if (isMobile && phoneExemptTab) setMobileDetail(true);
    }, [isMobile, phoneExemptTab]);

    const handleNavClick = (id: string) => {
        if (id === 'organisation') {
            // The parent row only opens and closes the group; collapsing it
            // keeps the page that is open. Opening it from outside the group
            // selects the first row the sidebar draws.
            const next = !orgExpanded;
            setOrgExpanded(next);
            if (next && !isOrgSubTab && firstOrgSubItemId) setActiveTab(firstOrgSubItemId);
        } else {
            setActiveTab(id);
            if (isMobile) setMobileDetail(true);   // drill into the section
        }
    };

    // Phone title bar shows the section name while in detail view: a top-level
    // row, an org sub-tab (Compliance, the no-plan licence page) or a consumer
    // row (the Stripe return), else the screen title.
    const activeNavItem = findActiveNavItem(activeTab, [...BASE_ORG_SUB_ITEMS, AZURE_SUB_ITEM]);
    const mobileInDetail = isMobile && mobileDetail;
    const titleLabel = mobileInDetail && activeNavItem ? t(activeNavItem.labelKey) : t('settings.title');
    // The Compliance Center draws its OWN top bar on a phone, so in detail view
    // the settings bar is hidden (two back buttons would mean different things).
    const hideTitleBar = mobileInDetail && activeTab === 'org_compliance';

    // The top-level rows this person gets, split into the settings and the
    // resources below a thin rule (SETTINGS_RESOURCE_TABS). Simple Mode keeps
    // only the first row.
    const { settingsNavRows, resourceNavRows } = splitNavRows(getVisibleNavItems({
        isSimpleMode, canUseLearning, projectsOn, entitlementsUnknown, isSelfHosted, isMobile,
    }));

    return (
        <div className="h-full flex flex-col [background:var(--bg-primary)] [position:relative]">
            {/* ── Title bar ── */}
            {!hideTitleBar && (
                <SettingsTitleBar titleLabel={titleLabel} onBack={() => { if (mobileInDetail) setMobileDetail(false); else handleClose(); }} />
            )}

            {/* ── Body ── */}
            {/* Desktop: nav + content side by side. Phone: master–detail — the
                nav list and a section's content are shown one at a time. */}
            <div className="flex-1 flex overflow-hidden">

                {/* ── Sidebar ── */}
                <SettingsSidebar
                    user={user}
                    activeTab={activeTab}
                    isOrgSubTab={isOrgSubTab}
                    isMobile={isMobile}
                    isSimpleMode={isSimpleMode}
                    mobileDetail={mobileDetail}
                    setMobileDetail={setMobileDetail}
                    canSeeOrg={canSeeOrg}
                    showComplianceNav={showComplianceNav}
                    isConsumerAccount={isConsumerAccount}
                    complianceBadge={complianceBadge}
                    orgExpanded={orgExpanded}
                    orgNavGroups={orgNavGroups}
                    settingsNavRows={settingsNavRows}
                    resourceNavRows={resourceNavRows}
                    onNavClick={handleNavClick}
                    setActiveTab={setActiveTab}
                />

                {/* ── Content panel ── */}
                <SettingsContentPanel mobileDetail={mobileDetail} activeTab={activeTab} isOrgSubTab={isOrgSubTab}>
                    {renderContent()}
                </SettingsContentPanel>
            </div>

            {showMemoryPanel && (
                <div className="[position:absolute] [inset:0] [z-index:10] [background:var(--bg-primary)]">
                    <MemoryPanel
                        initialView={memoryPanelView}
                        sensitiveOptIn={user?.memorySensitiveOptIn === true}
                        orgMemoryOff={user?.orgMemoryEnabled === false}
                        onChanged={fetchMemoryStats}
                        onClose={() => { setShowMemoryPanel(false); fetchMemoryStats(); }}
                    />
                </div>
            )}
        </div>
    );
};

export default AdvancedSettings;

import { Users, Link2, BarChart2, Cloud, CreditCard, Shield, FolderGit2, Sparkles, GraduationCap, ArrowLeft, FileText, Scale, Plug, ShieldCheck } from 'lucide-react';
import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
    SETTINGS_ORG_ID_TO_URL,
    settingsTabFromPath,
    settingsPathForTab,
    settingsOrgDeepSegsFromPath,
} from '../authedApp/settingsRoutes';
import ComplianceHub from '../components/admin/compliance';
import useComplianceCounts from '../components/admin/compliance/data/useComplianceCounts';
import { SECTIONS as ORG_SECTIONS } from '../components/admin/org/OrgInfoPanel';
import OrgAzureConfigPanel from '../components/integrations/azure/index';
import MemoryPanel from '../components/knowledge/memory/MemoryPanel';
import { useEntitlements } from '../components/licensing/EntitlementsContext';
import { useCan } from '../components/licensing/Gate';
import { RequireTier } from '../components/licensing/LicenseContext';
import { useSubscriptionContext } from '../components/licensing/SubscriptionContext';
import NavCountBadge from '../components/shared/NavCountBadge';
import { ROW_ACTIVE, ROW_IDLE, SECTION_LBL } from '../components/shell/sidebar/sidebarTokens';
import usePermissionCheck from '../hooks/usePermissionCheck';
import useProjectsAvailable from '../hooks/useProjectsAvailable';
import { useTranslation } from '../hooks/useTranslation';
import { useViewport } from '../hooks/useViewport';
import { formatVersion, formatVersionWithDate } from '../utils/appVersion';
import { API_BASE, authFetch } from '../utils/helpers';
import scopedStorage from '../utils/scopedStorage';
import AppearanceSection from './settings/AppearanceSection';
import { rewriteComplianceNav, rewriteAdminEscape } from './settings/complianceNavAdapter';
import ConsumerBetaFeaturesSection from './settings/ConsumerBetaFeaturesSection';
import ConsumerIntegrationsSection from './settings/ConsumerIntegrationsSection';
import ConsumerLicenseSection from './settings/ConsumerLicenseSection';
import ConsumerPrivacySection from './settings/ConsumerPrivacySection';
import ConsumerUsageSection from './settings/ConsumerUsageSection';
import HelpSupportSection from './settings/HelpSupportSection';
import IntegrationsSection from './settings/IntegrationsSection';
import LearningCenterSection from './settings/LearningCenterSection';
import MemorySection from './settings/MemorySection';
import NotificationsSection from './settings/NotificationsSection';
import OrganisationSection from './settings/OrganisationSection';
import PreferencesSection from './settings/PreferencesSection';
import { roleLabel } from './settings/roleLabel';
import SecuritySection from './settings/SecuritySection';
import { NAV_ITEMS, MOBILE_VISIBLE_TOP_TABS, MOBILE_EXTRA_TABS, SETTINGS_RESOURCE_TABS } from './settings/settingsNavItems';

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
const ALL_ORG_IDS = Object.keys(SETTINGS_ORG_ID_TO_URL);

/* The consumer (org-less cloud) account rows. Ids are settingsRoutes.js's
 * SETTINGS_ACCOUNT_ID_TO_URL keys. */
const CONSUMER_NAV_ITEMS = [
    { id: 'consumer_license', labelKey: 'settings.license_usage', icon: <CreditCard className="w-[15px] h-[15px]" /> },
    { id: 'consumer_privacy', labelKey: 'settings.privacy_shield', icon: <Shield className="w-[15px] h-[15px]" /> },
    { id: 'consumer_usage', labelKey: 'settings.usage_monitoring', icon: <BarChart2 className="w-[15px] h-[15px]" /> },
    { id: 'consumer_integrations', labelKey: 'settings.integrations', icon: <Link2 className="w-[15px] h-[15px]" /> },
    { id: 'consumer_beta', labelKey: 'settings.beta_features', icon: <Sparkles className="w-[15px] h-[15px]" /> },
];

// Stable identity for usePermissionCheck (its memo keys on the array reference).
const COMPLIANCE_PERMS = ['admin_compliance'];

/* The Settings → Connections rows whose connected state lives in `statuses`.
 * Their onSaved fires for connect AND disconnect, so the state is re-read
 * rather than forced to true (which showed "Connected" after a Disconnect, or
 * after a partial save). GitHub is here for the org GitHub Sync row, which is
 * drawn on statuses.githubConnected. */
const STATUS_BACKED_KEYS = ['fireflies', 'youtrack', 'signrequest', 'gamma', 'afas-profit', 'vplan', 'scaleway-billing', 'nmbrs', 'linkedin', 'nextcloud', 'github'];

/* A thin rule between groups of rows. */
const NavDivider = ({ inset = false }) => (
    <div aria-hidden="true" className={`h-px bg-[var(--border-subtle)] ${inset ? 'mt-1 mb-1 ml-9 mr-3' : 'my-1.5 mx-2'}`} />
);

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

export const AvatarDisplay = ({ user, size = 40, className = '' }) => {
    const { t } = useTranslation();
    const sizeStyle = { width: `${size}px`, height: `${size}px`, flexShrink: 0 };
    if (user?.avatarType === 'emoji' && user?.avatar) {
        return (
            <div
                className={`rounded-full flex items-center justify-center ${className}`}
                style={{ ...sizeStyle, background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', fontSize: `${size * 0.5}px`, lineHeight: 1 }}
            >
                {user.avatar}
            </div>
        );
    }
    if (user?.avatarType === 'url' && user?.avatar) {
        return <img src={user.avatar} alt={t('settings.avatar_alt', 'Avatar')} className={`rounded-full object-cover ${className}`} style={sizeStyle} />;
    }
    return (
        <div
            className={`rounded-full flex items-center justify-center font-bold ${className}`}
            style={{ ...sizeStyle, background: 'var(--bg-tertiary)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', fontSize: `${Math.round(size * 0.38)}px` }}
        >
            {(user?.displayName || user?.username || 'U')[0].toUpperCase()}
        </div>
    );
};

/* On phones the settings surface is trimmed to user-only sections: Connections
 * (integrations), Learning Center (learning) and the whole Organisation section
 * are hidden. Both the nav rows and this subset come from
 * settings/settingsNavItems.jsx, which derives them from
 * SETTINGS_TOP_LEVEL_TAB_IDS — a nav row and its address cannot drift apart
 * here anymore, which is what G1 was.
 *
 * MOBILE_EXTRA_TABS is the one deliberate hole in "no org sections on a
 * phone": 'org_compliance' is an org SUB-tab, so it is not in
 * MOBILE_VISIBLE_TOP_TABS and never will be, but the Compliance Center has a
 * phone frame of its own and a DPO carries its deadlines around. It is let
 * through the two gates that read this set (the bounce effect and
 * renderContent) and rendered as a top-level row below, while the Organisation
 * accordion around it stays hidden. Both lists are decided in
 * settingsNavItems.jsx; this file only unions them. */
const MOBILE_VISIBLE_TAB_SET = new Set([...MOBILE_VISIBLE_TOP_TABS, ...MOBILE_EXTRA_TABS]);

const ORG_PARENT_ITEM = {
    id: 'organisation', labelKey: 'settings.organisation',
    icon: <svg fill="none" stroke="currentColor" viewBox="0 0 24 24" width="15" height="15"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /></svg>,
};

/* ── Chevron icon ─────────────────────────────────────────────────────────── */
const Chevron = ({ open }) => (
    <svg
        width="11" height="11" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true"
        className={`flex-shrink-0 transition-transform duration-200 ${open ? 'rotate-90' : ''}`}
    >
        <path d="M9 18l6-6-6-6" />
    </svg>
);

/* ── NavItem ─────────────────────────────────────────────────────────────── */
/* Row states come from the app sidebar's tokens (sidebarTokens.js): a tint of
 * the theme's own accent and text colour, so the active and hover rows stay
 * visible on the dark themes, where a black rgba tint did not. `title` shows
 * the whole label when the narrow sidebar truncates it. */
const NavItem = ({ id, label, icon, isActive, onClick, rightSlot, ariaExpanded, ariaControls }) => (
    <button
        type="button"
        onClick={() => onClick(id)}
        className={`w-full flex items-center gap-2.5 h-8 px-3 rounded-md text-left transition-colors duration-100 ${isActive ? ROW_ACTIVE : ROW_IDLE}`}
        aria-current={isActive ? 'page' : undefined}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        title={label}
        data-testid={`settings-nav-${id}`}
    >
        <span className={`flex flex-shrink-0 ${isActive ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>{icon}</span>
        <span className={`min-w-0 flex-1 text-[13px] truncate text-[var(--text-primary)] ${isActive ? 'font-semibold' : 'font-normal'}`}>
            {label}
        </span>
        {rightSlot}
    </button>
);

/* ── Org sub-menu item ───────────────────────────────────────────────────── */
const OrgSubItem = ({ section, label, isActive, onClick, rightSlot = null }) => {
    const Icon = section.icon;
    return (
        <button
            type="button"
            onClick={() => onClick(section.id)}
            className={`w-full flex items-center gap-2 h-7 pl-9 pr-3 rounded-md text-left transition-colors duration-100 ${isActive ? ROW_ACTIVE : ROW_IDLE}`}
            aria-current={isActive ? 'page' : undefined}
            title={label}
            data-testid={`settings-nav-${section.id}`}
        >
            {/* The row's own accent only while active; `section.color` is a
                per-row value (a hex or a var()), so it stays a style. */}
            <Icon className="w-3 h-3 flex-shrink-0" style={{ color: isActive ? section.color : 'var(--text-muted)' }} />
            <span className={`min-w-0 flex-1 text-[12px] truncate ${isActive ? 'text-[var(--text-primary)] font-medium' : 'text-[var(--text-secondary)] font-normal'}`}>
                {label}
            </span>
            {/* A count pill ('Settings Nav.dc.html': Compliance carries its open
                items). */}
            {rightSlot && <span className="flex items-center">{rightSlot}</span>}
        </button>
    );
};

/* ── Main component ──────────────────────────────────────────────────────── */
const AdvancedSettings = ({ onNavigate, onLogout, user, onUpdateUser, onClose }) => {
    const { t } = useTranslation();
    // Phones show a trimmed, user-only settings surface (see MOBILE_VISIBLE_TOP_TABS).
    const { isMobile } = useViewport();
    // Orgs with no active plan are routed to the License tab by SubscriptionGate —
    // keep that one reachable on mobile so they can still subscribe.
    const { hasActiveSub } = useSubscriptionContext();
    // activeTab can be a top-level id OR an org sub-item id (e.g. 'license', 'org_users')
    // State is kept in sync with the URL: /app/settings/{section} or
    // /app/settings/organisation/{sub}. Back/forward buttons just work.
    const [activeTab, setActiveTabState] = useState(() => settingsTabFromPath() || 'preferences');
    // Extra path segments below the Compliance sub-tab (section + check id).
    const [orgDeepSegs, setOrgDeepSegs] = useState(() => settingsOrgDeepSegsFromPath());
    const setActiveTab = useCallback((id) => {
        setActiveTabState(id);
        setOrgDeepSegs({ seg1: '', seg2: '' });
        const url = settingsPathForTab(id);
        if (window.location.pathname !== url) {
            window.history.pushState({}, '', url);
        }
    }, []);
    useEffect(() => {
        const onPop = () => {
            const tab = settingsTabFromPath();
            if (tab) setActiveTabState(tab);
            setOrgDeepSegs(settingsOrgDeepSegsFromPath());
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, []);
    const [orgExpanded, setOrgExpanded] = useState(() => ALL_ORG_IDS.includes(settingsTabFromPath()));

    const perms = user?.permissions || [];
    const canSeeOrg = perms.includes('all') || perms.includes('org_admin') || user?.orgRole === 'admin' || user?.orgRole === 'org_admin';
    // Learning Center is toggleable per subscription plan (capability
    // `learning_center`). Hide its nav item + page when the org's plan doesn't
    // include it; the /ai/learning API is gated server-side too.
    const canUseLearning = useCan('learning_center');
    // useCan is also false while the snapshot loads; the bounce below must only
    // fire once the answer is known. `inCeiling` is the org's plan ceiling (not
    // this member's grants), the gate for org-admin rows such as Meeting
    // Templates.
    const {
        loading: entitlementsLoading, inCeiling,
        error: entitlementsError, degraded: entitlementsDegraded,
    } = useEntitlements();
    // A failed or degraded snapshot says nothing about the plan: the rows that
    // hide on an entitlement fail OPEN then, like RequireTier/LockedIfBelow do,
    // rather than taking a page away from everyone during a resolver outage.
    const entitlementsUnknown = !!entitlementsError || !!entitlementsDegraded;
    // Notifications holds only project events (NotificationsSection), so it is
    // offered on the same answer as Projects itself. Like useCan, this reads
    // false while the snapshot loads; its bounce waits for it below.
    const projectsOn = useProjectsAvailable(user);
    // Compliance Center — RBAC (org_admin / dpo / custom roles carrying
    // admin_compliance) AND the enterprise licence capability. The capability is
    // implicitly granted to all members of an enterprise org (non-groupTogglable
    // core cap), so useCan is a precise per-org licence gate. Server-side the
    // /api/compliance mount enforces the same pair.
    const canSeeCompliance = usePermissionCheck(user, COMPLIANCE_PERMS);
    const canUseCompliance = useCan('compliance_hub_gdpr');
    const showComplianceNav = canSeeCompliance && canUseCompliance;
    // The badge on the Compliance row. ONE cheap call, no poll: the settings
    // sidebar is not a dashboard, and the hub refetches its own numbers once
    // it is open. `attention_open` is the only key asked for, and an unknown
    // or zero count renders nothing at all (NavCountBadge) — a nav row with a
    // "0" on it is noise, and a "0" invented while the endpoint has not
    // answered is a lie.
    const { counts: complianceCounts } = useComplianceCounts({
        enabled: !!showComplianceNav, poll: false, keys: ['attention_open'],
    });
    const complianceBadge = (
        <NavCountBadge tone="warning" count={complianceCounts?.attention_open} testId="nav-compliance-count" />
    );

    const canManageUsers = perms.includes('all') || perms.includes('manage_users') || user?.orgRole === 'admin' || user?.orgRole === 'org_admin';
    const deploymentMode = user?.featureFlags?.deploymentMode || 'cloud';
    const isSelfHosted = deploymentMode === 'self-hosted';
    const isConsumerAccount = !!user?.isConsumerAccount;
    // Users coming in through the Nextcloud ExApp connector authenticate via
    // their NC session — the Bee Flow "Sign-in Method" panel (password/SSO/
    // OAuth provider config) doesn't apply because identity is delegated to
    // Nextcloud. Hide that section to avoid the false impression that they
    // can configure auth here. We hide based on org-level binding (ncOrg)
    // rather than the current user's provider so the original creator who
    // bootstrapped the NC org also sees the same gated UI.
    const isNcConnectorUser = user?.provider === 'nextcloud_connector';
    const isNcOrg = !!user?.ncOrg?.instanceId;
    // Super-admins (perms 'all' or role 'admin') manage every org in the
    // deployment, so they should see NC-related sections even if their own
    // session isn't tied to an NC-bound org. Org-admins only see the section
    // when their own org is NC-bound.
    const isSuperAdmin = perms.includes('all') || user?.role === 'admin';
    const showNcSync = isNcOrg || isSuperAdmin;

    const isOrgSubTab = ALL_ORG_IDS.includes(activeTab);
    // The pages a phone may open although their rows are hidden there: the org
    // licence page when the org has no active plan (SubscriptionGate sends it
    // there to subscribe), and the consumer licence page, which is the Stripe
    // return URL /app/settings/account/license and where /app/billing lands.
    const phoneExemptTab = (activeTab === 'license' && !hasActiveSub)
        || (activeTab === 'consumer_license' && isConsumerAccount);

    // Simple Mode collapses the settings sidebar to just Preferences. If the
    // user arrives on a deep link (or toggles ON while on another section),
    // bounce them back to Preferences where the toggle now lives.
    const isSimpleMode = !!user?.simpleMode;
    useEffect(() => {
        if (isSimpleMode && activeTab !== 'preferences') {
            setActiveTab('preferences');
        }
    }, [isSimpleMode, activeTab, setActiveTab]);

    // Help & Support is hidden on self-hosted — bounce a deep-link/hard-refresh
    // that lands on it (the nav item is filtered out, but the route still exists).
    useEffect(() => {
        if (isSelfHosted && activeTab === 'help_support') {
            setActiveTab('preferences');
        }
    }, [isSelfHosted, activeTab, setActiveTab]);

    // Learning Center without the capability: the welcome email links straight
    // to /app/settings/learning (BFSF-279), so a plan without it would land on
    // an empty panel. Bounce to Preferences once the entitlements are known.
    useEffect(() => {
        if (activeTab === 'learning' && !entitlementsLoading && !canUseLearning) {
            setActiveTab('preferences');
        }
    }, [activeTab, entitlementsLoading, canUseLearning, setActiveTab]);

    // Notifications without Projects: every switch on it is a project event.
    // The segment keeps parsing; it lands on Preferences once the licence
    // snapshot is known (not while it loads, like the Learning Center bounce).
    useEffect(() => {
        if (activeTab === 'notifications' && !entitlementsLoading && !entitlementsUnknown && !projectsOn) {
            setActiveTab('preferences');
        }
    }, [activeTab, entitlementsLoading, entitlementsUnknown, projectsOn, setActiveTab]);

    // Mobile: bounce hidden tabs (Connections, Learning Center, org/account
    // sub-tabs) to Preferences. Covers deep-links/hard-refresh to e.g.
    // /app/settings/connections or /app/settings/organisation/* and a resize
    // that crosses the breakpoint while sitting on a now-hidden tab. The two
    // licence pages in phoneExemptTab stay, so a subscribe redirect or a
    // Stripe return still lands somewhere usable.
    useEffect(() => {
        if (!isMobile) return;
        if (phoneExemptTab) return;
        if (!MOBILE_VISIBLE_TAB_SET.has(activeTab)) {
            setActiveTab('preferences');
        }
    }, [isMobile, activeTab, phoneExemptTab, setActiveTab]);

    // orgSubItems is computed below — it depends on `statuses.githubConnected`
    // which is hydrated in fetchSettingsStatuses() and the `statuses` state
    // declared further down. The actual filter lives in the useMemo block
    // immediately after `statuses` is declared.

    // If user navigates to an org sub-tab, keep org expanded
    useEffect(() => {
        if (isOrgSubTab) setOrgExpanded(true);
    }, [isOrgSubTab]);

    const [showMemoryPanel, setShowMemoryPanel] = useState(false);
    // 'review' when the pending-review row of Settings → Memory opened the panel.
    const [memoryPanelView, setMemoryPanelView] = useState('active');
    const [memoryStats, setMemoryStats] = useState(null);
    // loading | ok | error — MemorySection must never paint a zero for a
    // pending or failed fetch (see its header comment).
    const [memoryStatsStatus, setMemoryStatsStatus] = useState('loading');
    const [agents, setAgents] = useState([]);
    const [statuses, setStatuses] = useState({
        hasFirefliesKey: false, hasYouTrackConfig: false, hasGammaKey: false, hasAfasConfig: false,
        hasVplanConfig: false, hasScalewayBillingConfig: false,
        hasNmbrsConfig: false, nmbrsApiMode: 'soap', nmbrsSubdomain: '', nmbrsEmail: '', nmbrsEnv: 'production',
        hasSignRequestConfig: false,
        linkedInConnected: false, linkedInName: null, hasLinkedInConfig: false,
        hasNextcloudAppPassword: false, isNextcloudUser: false,
        githubConnected: false,
    });
    // Whether this org has already locked in its sign-in method. Once locked,
    // the "Sign-in Method" sidebar entry is hidden — the panel is a one-time
    // choice and adds no value after the fact.
    const [orgAuthLocked, setOrgAuthLocked] = useState(false);
    const orgSubItems = useMemo(() => {
        const items = BASE_ORG_SUB_ITEMS.filter(s => {
            // Non-org-admins see only the entries their own permission grants:
            // Compliance for pure-DPO users.
            if (!canSeeOrg && s.id !== 'org_compliance') return false;
            // Hidden below Enterprise (deep links still land on UpgradePrompt).
            if (s.id === 'org_compliance') return showComplianceNav;
            // Self-hosted: licensing is governed server-wide from the admin
            // dashboard ("Server licence"), not per-org. Drop the per-org
            // "License & Usage" entry entirely.
            if (s.id === 'license' && isSelfHosted) return false;
            if (s.id === 'org_users') return canManageUsers;
            // Academy overview only makes sense when the plan carries the
            // Learning Center at all (entitlements-gated like the member tab).
            if (s.id === 'org_academy') return canSeeOrg && canUseLearning;
            // Always show Integrations to org admins — the page (who gets which
            // integration, and the integrations' own settings) has empty
            // states for orgs without grants.
            if (s.id === 'org_integrations') return canSeeOrg;
            if (s.id === 'org_mcp') return canSeeOrg;
            if (s.id === 'org_mcp_access') return canSeeOrg;
            // Meeting Templates (and the Meet / Teams meeting-notes panels on
            // the same page) is behind the meeting_notes licence on the
            // server, so without it the page is empty. The org's plan ceiling,
            // not this admin's own grants: a group rollout must not hide it.
            // Not drawn while the snapshot loads; the deep link still renders.
            if (s.id === 'org_meeting_templates') return canSeeOrg && !entitlementsLoading && (entitlementsUnknown || !!inCeiling?.('meeting_notes'));
            // NC-bound orgs: auth is delegated to Nextcloud entirely. The
            // Sign-in Method panel configures username/password + OAuth
            // providers which are no-ops once identity comes from NC, so
            // hide it for everyone — including super-admins.
            if ((isNcOrg || isNcConnectorUser) && s.id === 'auth') return false;
            // Sign-in method is a one-time, locked choice. Once the org has
            // picked one, the cloud panel only shows a "locked" notice with no
            // editable controls — drop the sidebar entry so admins aren't
            // pointed at a dead-end page. Self-hosted keeps it: the same page
            // hosts the Allowed Domains editor, which stays editable after
            // the lock.
            if (orgAuthLocked && s.id === 'auth' && !isSelfHosted) return false;
            // Nextcloud Sync — visible when the user's own org is NC-bound,
            // OR when the user is a super-admin who could be managing NC orgs.
            if (s.id === 'org_nextcloud_sync' && !showNcSync) return false;
            // GitHub Sync only matters once a GitHub account is connected in
            // Settings → Connections. Hide the menu item until then so admins
            // aren't dropped on a "Not connected" stub.
            if (s.id === 'org_github_sync' && !statuses.githubConnected) return false;

            return true;
        });
        // Azure services config — self-hosted operator surface for org admins.
        if (isSelfHosted && canSeeOrg) {
            items.push(AZURE_SUB_ITEM);
        }
        return items;
    }, [canSeeOrg, canManageUsers, canUseLearning, showComplianceNav, isSelfHosted, isNcConnectorUser, isNcOrg, showNcSync, statuses.githubConnected, orgAuthLocked, entitlementsLoading, entitlementsUnknown, inCeiling]);

    // The rows as the sidebar draws them: ORG_NAV_GROUPS order, empty groups dropped.
    const orgNavGroups = useMemo(() => {
        const byId = new Map(orgSubItems.map(s => [s.id, s]));
        const filed = new Set(ORG_NAV_GROUPS.flat());
        return [
            ...ORG_NAV_GROUPS.map(ids => ids.map(id => byId.get(id)).filter(Boolean)),
            orgSubItems.filter(s => !filed.has(s.id)),
        ].filter(g => g.length > 0);
    }, [orgSubItems]);
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

    // User-scoped: these are personal "which agent do I start on?" preferences.
    const [defaultAgentMode, setDefaultAgentMode] = useState(() => scopedStorage.getItem('defaultAgentMode') || 'last-used');
    const [defaultAgentId, setDefaultAgentId] = useState(() => scopedStorage.getItem('defaultAgentId') || '');

    useEffect(() => { fetchMemoryStats(); fetchAgents(); fetchSettingsStatuses(); fetchOrgAuthLocked(); }, []);
    useEffect(() => { scopedStorage.setItem('defaultAgentMode', defaultAgentMode); }, [defaultAgentMode]);
    useEffect(() => { scopedStorage.setItem('defaultAgentId', defaultAgentId); }, [defaultAgentId]);

    const fetchAgents = async () => {
        try { const res = await authFetch(`${API_BASE}/agents/all`); setAgents(await res.json()); }
        catch (err) { console.error('Failed to fetch agents:', err); }
    };
    const fetchMemoryStats = async () => {
        // A refetch with stats already on screen (after import, after the
        // panel closes) updates silently; only a first load or a retry after
        // an error shows the placeholder.
        setMemoryStatsStatus(prev => (prev === 'ok' ? 'ok' : 'loading'));
        try {
            const res = await authFetch(`${API_BASE}/agents/memory/stats`);
            if (!res.ok) { setMemoryStatsStatus('error'); return; }
            const data = await res.json();
            setMemoryStats(data);
            setMemoryStatsStatus('ok');
        } catch (err) {
            console.error('Failed to fetch memory stats:', err);
            setMemoryStatsStatus('error');
        }
    };
    const fetchOrgAuthLocked = async () => {
        if (!canSeeOrg) return;
        try {
            const res = await authFetch(`${API_BASE}/auth/organizations`);
            if (!res.ok) return;
            const orgs = await res.json();
            const myOrg = user?.organizationId
                ? orgs.find(o => o.id === user.organizationId)
                : orgs[0];
            setOrgAuthLocked(!!myOrg?.authMethod);
        } catch (e) { /* non-critical */ }
    };
    const fetchSettingsStatuses = async () => {
        // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- browser-side console log of a failed status fetch; nothing reaches another user or a response
        try {
            const res = await authFetch(`${API_BASE}/ai/user-settings`);
            if (res.ok) {
                const data = await res.json();
                // A merge: the LinkedIn, Nextcloud and GitHub fields below come
                // from their own calls and must survive this one.
                setStatuses(p => ({ ...p, hasFirefliesKey: !!data.hasFirefliesKey, hasYouTrackConfig: !!data.hasYouTrackConfig, hasSignRequestConfig: !!data.hasSignRequestConfig, hasGammaKey: !!data.hasGammaKey, hasAfasConfig: !!data.hasAfasConfig, hasVplanConfig: !!data.hasVplanConfig, hasScalewayBillingConfig: !!data.hasScalewayBillingConfig, hasNmbrsConfig: !!data.hasNmbrsConfig, nmbrsApiMode: data.nmbrsApiMode || 'soap', nmbrsSubdomain: data.nmbrsSubdomain || '', nmbrsEmail: data.nmbrsEmail || '', nmbrsEnv: data.nmbrsEnv || 'production', hasLinkedInConfig: !!data.hasLinkedInConfig }));
            }
        } catch (e) { console.error(e); }
        try {
            const liRes = await authFetch(`${API_BASE}/api/integrations/linkedin/status`);
            if (liRes.ok) { const d = await liRes.json(); setStatuses(p => ({ ...p, linkedInConnected: !!d.connected, linkedInName: d.name })); }
        } catch (e) { }
        try {
            const ncRes = await authFetch(`${API_BASE}/auth/app-password-status`);
            if (ncRes.ok) { const d = await ncRes.json(); setStatuses(p => ({ ...p, hasNextcloudAppPassword: !!d.hasAppPassword, isNextcloudUser: !!d.isNextcloudUser, nextcloudUrl: d.nextcloudUrl || '' })); }
        } catch (e) { }
        // GitHub Sync menu item is hidden until the org-admin connects a
        // GitHub account in Settings → Connections. The org-sync panel
        // itself prompts for that step, but there's no point exposing the
        // sub-tab to admins who haven't reached integration setup yet.
        try {
            const ghRes = await authFetch(`${API_BASE}/api/integrations/github/status`);
            if (ghRes.ok) { const d = await ghRes.json(); setStatuses(p => ({ ...p, githubConnected: !!d.connected })); }
        } catch (e) { }
    };
    const handleIntegrationSaved = (key) => {
        if (STATUS_BACKED_KEYS.includes(key)) fetchSettingsStatuses();
    };
    const handleClose = () => {
        if (onClose) onClose();
        else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    };

    // Map org sub-tab ids to the activeSection prop OrganisationSection expects
    const orgActiveSection = isOrgSubTab
        ? (activeTab === 'org_users' ? 'users' : activeTab === 'org_academy' ? 'academy' : activeTab === 'org_integrations' ? 'integrations' : activeTab === 'org_mcp' ? 'mcp' : activeTab === 'org_mcp_access' ? 'mcp_access' : activeTab === 'org_usage' ? 'usage' : activeTab === 'org_azure' ? 'azure' : activeTab === 'org_github_sync' ? 'github_sync' : activeTab === 'org_nextcloud_sync' ? 'nextcloud_sync' : activeTab === 'org_meeting_templates' ? 'meeting_templates' : activeTab)
        : 'license';

    // Admin-dashboard destinations that have an organisation-settings
    // equivalent (Privacy for guardrails/DLP, Usage → Safety for monitoring)
    // stay on the settings surface — but only when this user can see the
    // target tab; otherwise the caller falls through to the app router,
    // which is today's admin-dashboard behavior.
    const applyAdminEscape = useCallback((path) => {
        const esc = rewriteAdminEscape(path);
        if (!esc) return false;
        if (!canSeeOrg) return false;
        setOrgDeepSegs({ seg1: esc.seg1 || '', seg2: '' });
        setActiveTabState(esc.tab);
        if (window.location.pathname !== esc.url) window.history.pushState({}, '', esc.url);
        return true;
    }, [canSeeOrg]);

    // ComplianceHub always emits admin-dashboard paths. Keep compliance-internal
    // navigation on the settings surface (deep URL incl. section/check id and
    // the header tab in `?tab=`), land remediation links on their settings
    // equivalents where possible, and forward the rest to the app router.
    // `{ replace: true }` is the hub redirecting a legacy link: the old URL
    // must not stay in the history, or Back would land on it again.
    const handleComplianceNavigate = useCallback((path, opts) => {
        const hit = rewriteComplianceNav(path);
        if (hit) {
            setOrgDeepSegs({ seg1: hit.section, seg2: hit.checkId });
            setActiveTabState('org_compliance');
            if (window.location.pathname + window.location.search !== hit.url) {
                if (opts?.replace) window.history.replaceState({}, '', hit.url);
                else window.history.pushState({}, '', hit.url);
            }
            return;
        }
        if (applyAdminEscape(path)) return;
        onNavigate?.(path);
    }, [onNavigate, applyAdminEscape]);

    const renderContent = () => {
        // Mobile: never render a hidden section's panel (covers the one frame
        // before the bounce effect moves activeTab to Preferences). The two
        // licence pages in phoneExemptTab stay renderable.
        if (isMobile && !MOBILE_VISIBLE_TAB_SET.has(activeTab) && !phoneExemptTab) {
            return null;
        }
        // Compliance is reachable for pure-DPO users too (admin_compliance
        // without org-admin), so it must not sit behind the canSeeOrg branch.
        // Below-enterprise deep links get the standard UpgradePrompt.
        if (activeTab === 'org_compliance') {
            if (!canSeeCompliance) return null;
            return (
                <RequireTier tier="enterprise" feature="compliance_hub_gdpr">
                    <ComplianceHub
                        activeSection={orgDeepSegs.seg1 || 'overview'}
                        focusCheckId={orgDeepSegs.seg2 || null}
                        onNavigate={handleComplianceNavigate}
                        // On a phone the hub draws its own top bar (with its own
                        // back chevron) and the settings title bar is suppressed
                        // below — so the hub, not the shell, owns the way back to
                        // the section list.
                        onBack={isMobile ? (() => setMobileDetail(false)) : null}
                    />
                </RequireTier>
            );
        }
        if (activeTab === 'org_azure' && canSeeOrg) return <OrgAzureConfigPanel user={user} />;
        if (isOrgSubTab && canSeeOrg) return <OrganisationSection user={user} activeSection={orgActiveSection} usageInitialReport={activeTab === 'org_usage' ? (orgDeepSegs.seg1 || '') : ''} />;
        // Consumer account tabs
        if (activeTab === 'consumer_license' && isConsumerAccount) return <ConsumerLicenseSection user={user} />;
        if (activeTab === 'consumer_privacy' && isConsumerAccount) return <ConsumerPrivacySection user={user} />;
        if (activeTab === 'consumer_usage' && isConsumerAccount) return <ConsumerUsageSection user={user} />;
        if (activeTab === 'consumer_integrations' && isConsumerAccount) return <ConsumerIntegrationsSection user={user} />;
        if (activeTab === 'consumer_beta' && isConsumerAccount) return <ConsumerBetaFeaturesSection user={user} />;
        switch (activeTab) {
            case 'preferences': return <PreferencesSection defaultAgentMode={defaultAgentMode} setDefaultAgentMode={setDefaultAgentMode} defaultAgentId={defaultAgentId} setDefaultAgentId={setDefaultAgentId} agents={agents} onLogout={onLogout} user={user} onUpdateUser={onUpdateUser} />;
            case 'appearance': return <AppearanceSection />;
            case 'security': return <SecuritySection />;
            case 'memory': return <MemorySection memoryStats={memoryStats} statsStatus={memoryStatsStatus} onRetryStats={fetchMemoryStats} user={user} onUpdateUser={onUpdateUser} onOpenMemory={(view) => { setMemoryPanelView(view === 'review' ? 'review' : 'active'); setShowMemoryPanel(true); }} onImported={fetchMemoryStats} />;
            case 'notifications': return (projectsOn || entitlementsUnknown) ? <NotificationsSection /> : null;
            case 'integrations': return <IntegrationsSection statuses={statuses} onSaved={handleIntegrationSaved} user={user} />;
            case 'learning': return canUseLearning ? <LearningCenterSection user={user} /> : null;
            // The Learning Center link on that page only where its page opens:
            // not on a phone (desktop-only tab) and not without the plan.
            case 'help_support': return isSelfHosted ? null : (
                <HelpSupportSection
                    user={user}
                    showLearningLink={canUseLearning && !isMobile}
                    onOpenLearning={() => setActiveTab('learning')}
                />
            );
            default: return null;
        }
    };

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

    const handleNavClick = (id) => {
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
    const activeNavItem = NAV_ITEMS.find(i => i.id === activeTab)
        || [...BASE_ORG_SUB_ITEMS, AZURE_SUB_ITEM].find(s => s.id === activeTab)
        || CONSUMER_NAV_ITEMS.find(i => i.id === activeTab);
    const mobileInDetail = isMobile && mobileDetail;
    const titleLabel = mobileInDetail && activeNavItem ? t(activeNavItem.labelKey) : t('settings.title');
    // The Compliance Center draws its OWN 44px top bar on a phone (back
    // chevron, kind tile, title, run-now) — stacking the settings bar above it
    // costs 48px of an 844px screen and shows two back buttons that mean
    // different things. Only in detail view: on the section LIST the bar is
    // the way out of Settings.
    const hideTitleBar = mobileInDetail && activeTab === 'org_compliance';

    // The top-level rows this person gets, split into the settings and the
    // resources below a thin rule (SETTINGS_RESOURCE_TABS). Simple Mode keeps
    // only the first row.
    const visibleNavItems = isSimpleMode ? [NAV_ITEMS[0]] : NAV_ITEMS.filter(item => {
        if (item.id === 'learning' && !canUseLearning) return false;
        // Every switch on Notifications is a project event.
        if (item.id === 'notifications' && !projectsOn && !entitlementsUnknown) return false;
        // Help & Support is a Bee Flow Cloud surface (the support
        // inbox talks to the Bee Flow team) — hidden on self-hosted.
        if (item.id === 'help_support' && isSelfHosted) return false;
        // Mobile hides Connections + Learning Center.
        if (isMobile && !MOBILE_VISIBLE_TAB_SET.has(item.id)) return false;
        return true;
    });
    const settingsNavRows = visibleNavItems.filter(item => !SETTINGS_RESOURCE_TABS.includes(item.id));
    const resourceNavRows = visibleNavItems.filter(item => SETTINGS_RESOURCE_TABS.includes(item.id));
    const renderTopRow = (item) => (
        <NavItem
            key={item.id}
            {...item}
            label={t(item.labelKey)}
            isActive={activeTab === item.id && !isOrgSubTab}
            onClick={handleNavClick}
        />
    );
    const effectiveRole = user?.orgRole || user?.role;
    const roleChip = roleLabel(effectiveRole, t);
    const roleIsAdmin = effectiveRole === 'admin' || effectiveRole === 'org_admin';

    return (
        <div className="h-full flex flex-col" style={{ background: 'var(--bg-primary)', position: 'relative' }}>
            {/* ── Title bar ── */}
            {!hideTitleBar && (
            <div
                className="flex-shrink-0 flex items-center gap-2 px-5"
                style={{ height: '48px', background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border-subtle)' }}
            >
                {/* Phone back button. In a section (detail) it returns to the
                    section list; on the list it exits Settings back to chat —
                    phones have no persistent sidebar while Settings is open.
                    Desktop keeps the sidebar, so the button is hidden there. */}
                <button
                    onClick={() => { if (mobileInDetail) setMobileDetail(false); else handleClose(); }}
                    className="md:hidden -ml-2 mr-0.5 p-1.5 rounded-lg"
                    style={{ color: 'var(--text-secondary)' }}
                    aria-label={t('common.back', 'Back')}
                >
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <span className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>{titleLabel}</span>
            </div>
            )}

            {/* ── Body ── */}
            {/* Desktop: nav + content side by side. Phone: master–detail — the
                nav list and a section's content are shown one at a time. */}
            <div className="flex-1 flex overflow-hidden">

                {/* ── Sidebar ── */}
                {/* 180px on laptops <1280, 220px on larger screens — keeps enough room
                    for the settings content area without forcing horizontal scroll.
                    On phones it's the full-screen section list; once a section is
                    opened it's hidden in favour of the content panel. */}
                <div
                    className={`flex-shrink-0 flex-col w-full md:w-[180px] xl:w-[220px] ${mobileDetail ? 'hidden md:flex' : 'flex'}`}
                    style={{ background: 'var(--bg-secondary)', borderRight: '1px solid var(--border-subtle)' }}
                >
                    {/* User mini-card */}
                    <button
                        type="button"
                        onClick={() => { setActiveTab('preferences'); if (isMobile) setMobileDetail(true); }}
                        className="flex items-center gap-3 px-4 py-3.5 transition-colors text-left w-full flex-shrink-0 hover:bg-[var(--item-hover-bg)]"
                    >
                        <AvatarDisplay user={user} size={34} />
                        <div className="flex-1 min-w-0">
                            <p className="text-[13px] font-semibold truncate text-[var(--text-primary)]">
                                {user?.displayName || user?.username || 'User'}
                            </p>
                            {roleChip && (
                                <span
                                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${roleIsAdmin
                                        ? 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]'
                                        : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}`}
                                >
                                    {roleChip}
                                </span>
                            )}
                        </div>
                    </button>

                    <div aria-hidden="true" className="h-px mx-3 bg-[var(--border-subtle)]" />

                    {/* Nav */}
                    <div className="flex-1 overflow-y-auto px-2 py-2 space-y-px" role="navigation" aria-label={t('settings.title')}>
                        <p className={`${SECTION_LBL} px-3 pb-1 pt-1.5`}>
                            {t('settings.personal_section', 'Personal')}
                        </p>

                        {settingsNavRows.map(renderTopRow)}

                        {/* Compliance on a phone. The Organisation group it
                            normally lives in stays hidden here, so the section
                            is promoted to a top-level row rather than being
                            unreachable: artboard frame 1h is a phone frame, and
                            the deadline a DPO is chasing does not wait for a
                            laptop. Same id, same address — only the row moves.
                            It is a setting, so it sits above the resources. */}
                        {!isSimpleMode && isMobile && showComplianceNav && (
                            <NavItem
                                id="org_compliance"
                                label={t('settings.compliance')}
                                icon={<Scale className="w-[15px] h-[15px] text-[var(--kind-compliance)]" />}
                                isActive={activeTab === 'org_compliance'}
                                onClick={handleNavClick}
                                rightSlot={complianceBadge}
                            />
                        )}

                        {/* Learning Center and Help & Support are resources,
                            not settings: a thin rule above the first of them. */}
                        {resourceNavRows.length > 0 && <NavDivider />}
                        {resourceNavRows.map(renderTopRow)}

                        {/* Organisation accordion — only if permitted. Hidden on
                            mobile: phones show user settings only. Pure-DPO users
                            (showComplianceNav without canSeeOrg) get the group
                            with just the Compliance entry. */}
                        {!isSimpleMode && !isMobile && (canSeeOrg || showComplianceNav) && (
                            <>
                                <NavDivider />
                                <p className={`${SECTION_LBL} px-3 pb-1 pt-1`}>
                                    {t('settings.workspace_section')}
                                </p>
                                {/* Parent row: only opens and closes the group.
                                    Active while the group is closed on one of
                                    its pages. */}
                                <NavItem
                                    id="organisation"
                                    label={t(ORG_PARENT_ITEM.labelKey)}
                                    icon={ORG_PARENT_ITEM.icon}
                                    isActive={isOrgSubTab && !orgExpanded}
                                    onClick={handleNavClick}
                                    rightSlot={<Chevron open={orgExpanded} />}
                                    ariaExpanded={orgExpanded}
                                    ariaControls={orgExpanded ? 'settings-org-subnav' : undefined}
                                />

                                {/* Sub-items — animated slide-down, in topic
                                    groups (ORG_NAV_GROUPS) with a thin rule
                                    between them. */}
                                {orgExpanded && (
                                    <div id="settings-org-subnav" className="space-y-px overflow-hidden" style={{ animation: 'fadeIn 120ms ease' }}>
                                        {orgNavGroups.map((group, gi) => (
                                            <React.Fragment key={group[0].id}>
                                                {gi > 0 && <NavDivider inset />}
                                                {group.map(s => (
                                                    <OrgSubItem
                                                        key={s.id}
                                                        section={s}
                                                        label={t(s.labelKey)}
                                                        isActive={activeTab === s.id}
                                                        onClick={setActiveTab}
                                                        rightSlot={s.id === 'org_compliance' ? complianceBadge : null}
                                                    />
                                                ))}
                                            </React.Fragment>
                                        ))}
                                    </div>
                                )}
                            </>
                        )}

                        {/* Consumer Account section — for org-less cloud users.
                            Hidden on mobile (user settings only). */}
                        {!isSimpleMode && !isMobile && isConsumerAccount && !canSeeOrg && (
                            <>
                                <NavDivider />
                                <p className={`${SECTION_LBL} px-3 pb-1 pt-1`}>
                                    {t('settings.account_section', 'Account')}
                                </p>
                                {CONSUMER_NAV_ITEMS.map(item => (
                                    <NavItem
                                        key={item.id}
                                        {...item}
                                        label={t(item.labelKey)}
                                        isActive={activeTab === item.id}
                                        onClick={handleNavClick}
                                    />
                                ))}
                            </>
                        )}
                    </div>

                    {/* Footer — product name + build version (commit SHA is unique per CI deploy). */}
                    <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                        <p
                            className="text-[10px]"
                            style={{ color: 'var(--text-muted)' }}
                            title={formatVersionWithDate()}
                        >
                            Bee Flow <span style={{ opacity: 0.7 }}>{formatVersion()}</span>
                        </p>
                    </div>
                </div>

                {/* ── Content panel ── */}
                <div className={`flex-1 overflow-auto ${mobileDetail ? 'block' : 'hidden md:block'}`} style={{ background: 'var(--bg-primary)' }}>
                    <div
                        // Every organisation page and every consumer account
                        // page gets the wide column: the consumer licence page
                        // is the same plan grid as the org one, and squeezed
                        // into 640px it lost its columns. Personal settings
                        // keep the reading width.
                        className={`mx-auto py-6 md:py-8 px-4 md:px-8 ${(isOrgSubTab || activeTab.startsWith('consumer_')) ? 'max-w-5xl' : 'max-w-[640px]'}`}
                        style={activeTab === 'org_usage' ? { maxWidth: '100%', padding: '24px 32px 32px' }
                            // Sections that own their whole viewport: they bring
                            // their own header, their own scroll region and their
                            // own padding, and they pin a bar to the bottom. The
                            // shared `max-w-5xl` + `py-8 px-8` wrapper fights all
                            // three — it caps a 3355px screen at 1024px (leaving
                            // two thirds of it empty while the content inside
                            // wraps), and `height:100%` is what lets a pinned save
                            // bar actually reach the bottom instead of floating
                            // under the last card.
                            : (activeTab === 'org_compliance' || activeTab === 'learning' || activeTab === 'privacy')
                                ? { maxWidth: '100%', padding: 0, height: '100%' }
                                : undefined}
                    >
                        {renderContent()}
                    </div>
                </div>
            </div>

            {showMemoryPanel && (
                <div style={{ position: 'absolute', inset: 0, zIndex: 10, background: 'var(--bg-primary)' }}>
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
